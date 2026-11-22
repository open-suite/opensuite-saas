// Open Suite: one binary that owns identity, organisations, documents and the
// glue to the three headless engines (mail, chat, video). Everything the
// browser touches lives on one origin behind one session cookie.
package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

type Config struct {
	Domain     string // primary web host, e.g. office.opensuite.online
	MailDomain string // default mailbox domain
	Listen     string
	DataDir    string
	WebDir     string
	Secret     []byte
	Signup     string // open | code | closed
	SignupCode string
	PublicIPs  []string // addresses a custom domain must resolve to
	Operators  []string // platform operator logins

	LiveKitKey    string
	LiveKitSecret string

	MatrixURL    string // internal, e.g. http://127.0.0.1:8008
	MatrixName   string // server_name
	MatrixSecret string // shared JWT secret

	MailURL   string // internal Stalwart HTTP, e.g. http://127.0.0.1:8446
	MailAdmin string // user:password of the engine admin
	MailHost  string // public MX host name, e.g. mail.opensuite.online

	AcmeEmail string
	AcmeURL   string
	CertDir   string
}

type Server struct {
	cfg  Config
	w    *sql.DB // single writer
	r    *sql.DB // readers
	hub  *Hub
	tls  *CertManager
	lim  *limiter
	http *http.Client
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, strings.ToLower(p))
		}
	}
	return out
}

// derive gives each subsystem its own key from the one master secret.
func (s *Server) derive(purpose string) []byte {
	m := hmac.New(sha256.New, s.cfg.Secret)
	m.Write([]byte(purpose))
	return m.Sum(nil)
}

func (s *Server) deriveHex(purpose string) string { return hex.EncodeToString(s.derive(purpose)) }

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	cfg := Config{
		Domain:        strings.ToLower(env("OS_DOMAIN", "localhost")),
		Listen:        env("OS_LISTEN", "127.0.0.1:8600"),
		DataDir:       env("OS_DATA", "./data"),
		WebDir:        env("OS_WEB", "../web/dist"),
		Secret:        []byte(env("OS_SECRET", "")),
		Signup:        env("OS_SIGNUP", "open"),
		SignupCode:    env("OS_SIGNUP_CODE", ""),
		PublicIPs:     splitList(env("OS_PUBLIC_IPS", "")),
		Operators:     splitList(env("OS_OPERATORS", "")),
		LiveKitKey:    env("OS_LIVEKIT_KEY", ""),
		LiveKitSecret: env("OS_LIVEKIT_SECRET", ""),
		MatrixURL:     strings.TrimRight(env("OS_MATRIX_URL", ""), "/"),
		MatrixSecret:  env("OS_MATRIX_SECRET", ""),
		MailURL:       strings.TrimRight(env("OS_MAIL_URL", ""), "/"),
		MailAdmin:     env("OS_MAIL_ADMIN", ""),
		AcmeEmail:     env("OS_ACME_EMAIL", ""),
		AcmeURL:       env("OS_ACME_URL", "https://acme-v02.api.letsencrypt.org/directory"),
	}
	cfg.MailDomain = strings.ToLower(env("OS_MAIL_DOMAIN", cfg.Domain))
	cfg.MatrixName = env("OS_MATRIX_NAME", cfg.Domain)
	cfg.MailHost = env("OS_MAIL_HOST", cfg.Domain)
	cfg.CertDir = env("OS_CERTS", cfg.DataDir+"/certs")
	if len(cfg.Secret) < 32 {
		log.Fatal("OS_SECRET must be set to at least 32 characters")
	}
	for _, d := range []string{cfg.DataDir, cfg.DataDir + "/blobs", cfg.CertDir} {
		if err := os.MkdirAll(d, 0o750); err != nil {
			log.Fatal(err)
		}
	}
	w, r, err := openDB(cfg.DataDir)
	if err != nil {
		log.Fatal(err)
	}
	s := &Server{cfg: cfg, w: w, r: r, lim: newLimiter(), http: &http.Client{Timeout: 20 * time.Second}}
	s.hub = newHub(s)
	s.tls = newCertManager(s)

	// "opensuite mail-setup <engine url>" is run once by the installer.
	if len(os.Args) == 3 && os.Args[1] == "mail-setup" {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		if err := s.mailSetup(ctx, strings.TrimRight(os.Args[2], "/")); err != nil {
			log.Fatal(err)
		}
		log.Print("mail engine configured")
		return
	}

	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           s.routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go s.tls.run(ctx)
	go s.janitor(ctx)
	go func() {
		log.Printf("opensuite listening on %s for %s", cfg.Listen, cfg.Domain)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()
	<-ctx.Done()
	sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv.Shutdown(sctx)
	w.Close()
	r.Close()
}

func (s *Server) routes() http.Handler {
	m := http.NewServeMux()

	// identity
	m.HandleFunc("GET /api/boot", s.handleBoot)
	m.HandleFunc("GET /api/signup/check", s.handleSignupCheck)
	m.HandleFunc("POST /api/signup", s.handleSignup)
	m.HandleFunc("POST /api/login", s.handleLogin)
	m.HandleFunc("POST /api/logout", s.handleLogout)
	m.HandleFunc("POST /api/account/password", s.auth(s.handleSetPassword))
	m.HandleFunc("POST /api/account/profile", s.auth(s.handleSetProfile))

	// organisation admin
	m.HandleFunc("GET /api/admin/overview", s.admin(s.handleAdminOverview))
	m.HandleFunc("POST /api/admin/users", s.admin(s.handleUserCreate))
	m.HandleFunc("PATCH /api/admin/users/{id}", s.admin(s.handleUserUpdate))
	m.HandleFunc("DELETE /api/admin/users/{id}", s.admin(s.handleUserDelete))
	m.HandleFunc("PATCH /api/admin/org", s.admin(s.handleOrgUpdate))
	m.HandleFunc("POST /api/admin/domains", s.admin(s.handleDomainAdd))
	m.HandleFunc("POST /api/admin/domains/{domain}/verify", s.admin(s.handleDomainVerify))
	m.HandleFunc("DELETE /api/admin/domains/{domain}", s.admin(s.handleDomainDelete))

	// platform operator
	m.HandleFunc("GET /api/operator/orgs", s.operator(s.handleOperatorOrgs))
	m.HandleFunc("PATCH /api/operator/orgs/{id}", s.operator(s.handleOperatorOrgUpdate))

	// documents and spreadsheets
	m.HandleFunc("GET /api/docs", s.auth(s.handleDocList))
	m.HandleFunc("POST /api/docs", s.auth(s.handleDocCreate))
	m.HandleFunc("PATCH /api/docs/{id}", s.auth(s.handleDocUpdate))
	m.HandleFunc("DELETE /api/docs/{id}", s.auth(s.handleDocDelete))
	m.HandleFunc("GET /api/docs/{id}/sync", s.auth(s.handleDocSync))
	m.HandleFunc("GET /api/docs/{id}/state", s.auth(s.handleDocState))
	m.HandleFunc("GET /api/search", s.auth(s.handleSearch))
	m.HandleFunc("POST /api/convert", s.auth(s.handleConvert))
	m.HandleFunc("POST /api/blobs", s.auth(s.handleBlobPut))
	m.HandleFunc("GET /api/blobs/{id}", s.auth(s.handleBlobGet))

	// meetings (join is open to guests holding the link)
	m.HandleFunc("GET /api/meet", s.auth(s.handleMeetList))
	m.HandleFunc("POST /api/meet", s.auth(s.handleMeetCreate))
	m.HandleFunc("DELETE /api/meet/{code}", s.auth(s.handleMeetDelete))
	m.HandleFunc("GET /api/meet/{code}", s.handleMeetInfo)
	m.HandleFunc("POST /api/meet/{code}/join", s.handleMeetJoin)

	m.HandleFunc("POST /api/chat/token", s.auth(s.handleChatToken))

	// mail: one JMAP endpoint, proxied with the caller's mailbox credentials
	m.HandleFunc("POST /api/mail/jmap", s.auth(s.handleJMAP))
	m.HandleFunc("GET /api/mail/blob/{blob}/{name}", s.auth(s.handleMailBlob))
	m.HandleFunc("POST /api/mail/upload", s.auth(s.handleMailUpload))
	m.HandleFunc("GET /api/mail/events", s.auth(s.handleMailEvents))

	// ACME HTTP-01 and nginx on-demand hooks
	m.HandleFunc("GET /.well-known/acme-challenge/{token}", s.tls.handleChallenge)
	m.HandleFunc("GET /.well-known/matrix/client", s.handleWellKnownClient)
	m.HandleFunc("GET /.well-known/matrix/server", s.handleWellKnownServer)

	m.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { fail(w, 404, "not found") })
	m.HandleFunc("/", s.handleApp)
	return s.guard(m)
}

// janitor drops expired sessions and compacts document logs nobody is
// editing any more.
func (s *Server) janitor(ctx context.Context) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.w.Exec(`DELETE FROM sessions WHERE expires < ?`, now())
			s.w.Exec(`DELETE FROM docs WHERE trashed > 0 AND trashed < ?`, now()-30*86400)
			s.w.Exec(`DELETE FROM doc_updates WHERE doc_id NOT IN (SELECT id FROM docs)`)
		}
	}
}
