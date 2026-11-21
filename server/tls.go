package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"golang.org/x/crypto/acme"
)

// CertManager obtains and renews certificates for the primary domain and for
// every customer domain that points at us. nginx reads them per handshake
// from <CertDir>/<server name>.crt, so a new custom domain needs no reload.
type CertManager struct {
	s      *Server
	mu     sync.Mutex
	tokens map[string]string
	kick   chan struct{}
	// mailSynced records that the mail engine has been told about the
	// certificate since this process started.
	mailSynced bool
}

func newCertManager(s *Server) *CertManager {
	return &CertManager{s: s, tokens: map[string]string{}, kick: make(chan struct{}, 1)}
}

func (c *CertManager) handleChallenge(w http.ResponseWriter, r *http.Request) {
	c.mu.Lock()
	v, found := c.tokens[r.PathValue("token")]
	c.mu.Unlock()
	if !found {
		http.NotFound(w, r)
		return
	}
	w.Write([]byte(v))
}

// poke asks the manager to look for missing certificates now.
func (c *CertManager) poke() {
	select {
	case c.kick <- struct{}{}:
	default:
	}
}

func (c *CertManager) run(ctx context.Context) {
	if c.s.cfg.AcmeEmail == "" {
		log.Print("tls: OS_ACME_EMAIL not set, certificate management is off")
		return
	}
	t := time.NewTicker(12 * time.Hour)
	defer t.Stop()
	for {
		c.sweep(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-c.kick:
		}
	}
}

func (c *CertManager) domains() []string {
	out := []string{c.s.cfg.Domain}
	if h := c.s.cfg.MailHost; h != "" && h != c.s.cfg.Domain {
		out = append(out, h)
	}
	rows, err := c.s.r.Query(`SELECT domain FROM domains WHERE web_ok = 1`)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var d string
		rows.Scan(&d)
		out = append(out, d)
	}
	return out
}

func (c *CertManager) sweep(ctx context.Context) {
	issued := false
	for _, d := range c.domains() {
		if c.fresh(d) {
			continue
		}
		if err := c.issue(ctx, d); err != nil {
			log.Printf("tls: %s: %v", d, err)
		} else {
			log.Printf("tls: issued certificate for %s", d)
			issued = issued || d == c.s.cfg.MailHost
		}
	}
	if issued || !c.mailSynced {
		c.s.mailSyncCert(ctx)
		c.mailSynced = true
	}
}

func (c *CertManager) fresh(domain string) bool {
	b, err := os.ReadFile(filepath.Join(c.s.cfg.CertDir, domain+".crt"))
	if err != nil {
		return false
	}
	blk, _ := pem.Decode(b)
	if blk == nil {
		return false
	}
	crt, err := x509.ParseCertificate(blk.Bytes)
	return err == nil && time.Until(crt.NotAfter) > 30*24*time.Hour
}

func (c *CertManager) accountKey() (*ecdsa.PrivateKey, error) {
	p := filepath.Join(c.s.cfg.CertDir, "account.key")
	if b, err := os.ReadFile(p); err == nil {
		if blk, _ := pem.Decode(b); blk != nil {
			return x509.ParseECPrivateKey(blk.Bytes)
		}
	}
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	der, _ := x509.MarshalECPrivateKey(k)
	return k, os.WriteFile(p, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}), 0o600)
}

func (c *CertManager) issue(ctx context.Context, domain string) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	key, err := c.accountKey()
	if err != nil {
		return err
	}
	cl := &acme.Client{Key: key, DirectoryURL: c.s.cfg.AcmeURL}
	if _, err := cl.Register(ctx, &acme.Account{Contact: []string{"mailto:" + c.s.cfg.AcmeEmail}}, acme.AcceptTOS); err != nil && err != acme.ErrAccountAlreadyExists {
		return err
	}
	order, err := cl.AuthorizeOrder(ctx, acme.DomainIDs(domain))
	if err != nil {
		return err
	}
	for _, zurl := range order.AuthzURLs {
		z, err := cl.GetAuthorization(ctx, zurl)
		if err != nil {
			return err
		}
		if z.Status == acme.StatusValid {
			continue
		}
		var chal *acme.Challenge
		for _, ch := range z.Challenges {
			if ch.Type == "http-01" {
				chal = ch
			}
		}
		if chal == nil {
			return errf("no http-01 challenge offered")
		}
		resp, err := cl.HTTP01ChallengeResponse(chal.Token)
		if err != nil {
			return err
		}
		c.mu.Lock()
		c.tokens[chal.Token] = resp
		c.mu.Unlock()
		defer func(t string) { c.mu.Lock(); delete(c.tokens, t); c.mu.Unlock() }(chal.Token)
		if _, err := cl.Accept(ctx, chal); err != nil {
			return err
		}
		if _, err := cl.WaitAuthorization(ctx, zurl); err != nil {
			return err
		}
	}
	if order, err = cl.WaitOrder(ctx, order.URI); err != nil {
		return err
	}
	ck, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	csr, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: domain}, DNSNames: []string{domain}}, ck)
	if err != nil {
		return err
	}
	chain, _, err := cl.CreateOrderCert(ctx, order.FinalizeURL, csr, true)
	if err != nil {
		return err
	}
	var crt []byte
	for _, der := range chain {
		crt = append(crt, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})...)
	}
	kder, _ := x509.MarshalECPrivateKey(ck)
	kpem := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kder})
	// Key first, certificate last: nginx only uses the pair once the
	// certificate file exists.
	if err := writeAtomic(filepath.Join(c.s.cfg.CertDir, domain+".key"), kpem); err != nil {
		return err
	}
	return writeAtomic(filepath.Join(c.s.cfg.CertDir, domain+".crt"), crt)
}

func writeAtomic(path string, b []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o640); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
