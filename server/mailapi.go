package main

// Mail in the public API: the same mailbox the app shows, through the same
// engine and the same rules. The app speaks JMAP to /api/mail/jmap; the API
// speaks plain JSON and turns each operation into the JMAP calls the app
// itself makes (lib/mail.js), so sending, replying and filing behave alike.
// Every message sent passes recipientsAllowed, exactly as the app's do.

import (
	"context"
	"encoding/json"
	"html"
	"net/http"
	"net/mail"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var mailSummaryProps = []string{"id", "threadId", "mailboxIds", "keywords", "from", "to", "cc", "subject", "receivedAt", "preview", "hasAttachment"}
var mailFullProps = append([]string{"bcc", "replyTo", "messageId", "inReplyTo", "references", "sentAt", "htmlBody", "textBody", "bodyValues", "attachments"}, mailSummaryProps...)

type jmapEmail struct {
	ID            string                            `json:"id"`
	ThreadID      string                            `json:"threadId"`
	MailboxIDs    map[string]bool                   `json:"mailboxIds"`
	Keywords      map[string]bool                   `json:"keywords"`
	From          []jmapAddress                     `json:"from"`
	To            []jmapAddress                     `json:"to"`
	Cc            []jmapAddress                     `json:"cc"`
	Bcc           []jmapAddress                     `json:"bcc"`
	ReplyTo       []jmapAddress                     `json:"replyTo"`
	Subject       string                            `json:"subject"`
	ReceivedAt    string                            `json:"receivedAt"`
	SentAt        string                            `json:"sentAt"`
	Preview       string                            `json:"preview"`
	HasAttachment bool                              `json:"hasAttachment"`
	MessageID     []string                          `json:"messageId"`
	InReplyTo     []string                          `json:"inReplyTo"`
	References    []string                          `json:"references"`
	TextBody      []jmapPart                        `json:"textBody"`
	HTMLBody      []jmapPart                        `json:"htmlBody"`
	BodyValues    map[string]struct{ Value string } `json:"bodyValues"`
	Attachments   []jmapPart                        `json:"attachments"`
}

type jmapAddress struct {
	Name  string `json:"name"`
	Email string `json:"email"`
}

type jmapPart struct {
	PartID string `json:"partId,omitempty"`
	BlobID string `json:"blobId,omitempty"`
	Name   string `json:"name,omitempty"`
	Type   string `json:"type,omitempty"`
	Size   int64  `json:"size,omitempty"`
}

type mailbox struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Role   string `json:"role"`
	Total  int    `json:"total"`
	Unread int    `json:"unread"`
}

type messageSummary struct {
	ID            string        `json:"id"`
	ThreadID      string        `json:"threadId"`
	Mailboxes     []string      `json:"mailboxes"`
	From          []jmapAddress `json:"from"`
	To            []jmapAddress `json:"to"`
	Cc            []jmapAddress `json:"cc"`
	Subject       string        `json:"subject"`
	ReceivedAt    string        `json:"receivedAt"`
	Preview       string        `json:"preview"`
	Unread        bool          `json:"unread"`
	Flagged       bool          `json:"flagged"`
	Draft         bool          `json:"draft"`
	HasAttachment bool          `json:"hasAttachment"`
}

type message struct {
	messageSummary
	Bcc         []jmapAddress `json:"bcc"`
	ReplyTo     []jmapAddress `json:"replyTo"`
	SentAt      string        `json:"sentAt"`
	MessageID   string        `json:"messageId"`
	Text        string        `json:"text"`
	HTML        string        `json:"html,omitempty"`
	Attachments []jmapPart    `json:"attachments"`
}

func nonNil(a []jmapAddress) []jmapAddress {
	if a == nil {
		return []jmapAddress{}
	}
	return a
}

func (e *jmapEmail) summary() messageSummary {
	boxes := []string{}
	for id, in := range e.MailboxIDs {
		if in {
			boxes = append(boxes, id)
		}
	}
	return messageSummary{
		ID: e.ID, ThreadID: e.ThreadID, Mailboxes: boxes, From: nonNil(e.From), To: nonNil(e.To), Cc: nonNil(e.Cc),
		Subject: e.Subject, ReceivedAt: e.ReceivedAt, Preview: e.Preview, Unread: !e.Keywords["$seen"],
		Flagged: e.Keywords["$flagged"], Draft: e.Keywords["$draft"], HasAttachment: e.HasAttachment,
	}
}

func (e *jmapEmail) bodyOf(parts []jmapPart) string {
	var out []string
	for _, p := range parts {
		if v, found := e.BodyValues[p.PartID]; found {
			out = append(out, v.Value)
		}
	}
	return strings.Join(out, "\n")
}

var (
	tagRe   = regexp.MustCompile(`(?s)<(script|style|head)\b.*?</(script|style|head)>|<[^>]*>`)
	blockRe = regexp.MustCompile(`(?i)<(br|/p|/div|/li|/tr|/h[1-6]|/blockquote)\b[^>]*>`)
	blankRe = regexp.MustCompile(`\n{3,}`)
)

// htmlText reads an HTML body as plain text, for messages without a text part.
func htmlText(h string) string {
	h = blockRe.ReplaceAllString(h, "\n$0")
	t := html.UnescapeString(tagRe.ReplaceAllString(h, ""))
	return strings.TrimSpace(blankRe.ReplaceAllString(t, "\n\n"))
}

func (e *jmapEmail) full() message {
	m := message{messageSummary: e.summary(), Bcc: nonNil(e.Bcc), ReplyTo: nonNil(e.ReplyTo), SentAt: e.SentAt, Attachments: e.Attachments}
	if len(e.MessageID) > 0 {
		m.MessageID = e.MessageID[0]
	}
	m.HTML = e.bodyOf(e.HTMLBody)
	m.Text = e.bodyOf(e.TextBody)
	// A message with only an HTML part reports it as its text part too.
	if m.Text == "" || m.Text == m.HTML {
		m.Text = htmlText(m.HTML)
	}
	if m.HTML == m.Text {
		m.HTML = ""
	}
	if m.Attachments == nil {
		m.Attachments = []jmapPart{}
	}
	return m
}

// mailCall runs JMAP calls as the member, failing the request in words a
// person can act on when the mailbox is not reachable.
func (s *Server) mailCall(w http.ResponseWriter, r *http.Request, u *User, calls ...jmapCall) []jmapResult {
	if !u.MailReady || s.cfg.MailURL == "" {
		fail(w, 503, "The mailbox is being set up. Try again in a minute.")
		return nil
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	for i := range calls {
		if args, isMap := calls[i].args.(map[string]any); isMap {
			args["accountId"] = u.MailID
		}
	}
	res, err := s.jmapAs(ctx, u, jmapUsing, calls...)
	if err != nil {
		fail(w, 502, "The mail service could not do that: "+err.Error())
		return nil
	}
	return res
}

func (s *Server) mailboxes(w http.ResponseWriter, r *http.Request, u *User) []mailbox {
	res := s.mailCall(w, r, u, jmapCall{"Mailbox/get", map[string]any{"properties": []string{"name", "role", "totalEmails", "unreadEmails"}}})
	if res == nil {
		return nil
	}
	var g struct {
		List []struct {
			ID, Name, Role            string
			TotalEmails, UnreadEmails int
		} `json:"list"`
	}
	json.Unmarshal(res[0].Args, &g)
	out := []mailbox{}
	for _, b := range g.List {
		out = append(out, mailbox{b.ID, b.Name, b.Role, b.TotalEmails, b.UnreadEmails})
	}
	return out
}

// mailboxID accepts a mailbox id or a role name ("inbox", "archive", ...).
func mailboxID(boxes []mailbox, key string) string {
	for _, b := range boxes {
		if b.ID == key || (b.Role != "" && strings.EqualFold(b.Role, key)) || strings.EqualFold(b.Name, key) {
			return b.ID
		}
	}
	return ""
}

var roleNames = map[string]string{"archive": "Archive", "trash": "Trash", "junk": "Junk", "sent": "Sent", "drafts": "Drafts"}

// ensureMailbox finds a mailbox, creating a standard one (Archive, Trash...)
// the first time it is wanted, as the app does (ensureMailbox in lib/mail.js).
func (s *Server) ensureMailbox(w http.ResponseWriter, r *http.Request, u *User, boxes []mailbox, key string) string {
	if id := mailboxID(boxes, key); id != "" {
		return id
	}
	role := strings.ToLower(key)
	name, standard := roleNames[role]
	if !standard {
		fail(w, 404, "No such mailbox. list_mailboxes shows them.")
		return ""
	}
	res := s.mailCall(w, r, u, jmapCall{"Mailbox/set", map[string]any{"create": map[string]any{"n": map[string]string{"name": name, "role": role}}}})
	if res == nil {
		return ""
	}
	var sr struct {
		Created map[string]struct{ ID string } `json:"created"`
	}
	json.Unmarshal(res[0].Args, &sr)
	if sr.Created["n"].ID == "" {
		fail(w, 502, "The "+name+" folder couldn't be created.")
	}
	return sr.Created["n"].ID
}

func mailboxRole(boxes []mailbox, role string) string {
	for _, b := range boxes {
		if b.Role == role {
			return b.ID
		}
	}
	return ""
}

func (s *Server) mailOps() []*apiOp {
	id := pathParam("id", "Message id.")
	addrs := array(str("An address: \"jane@example.com\" or \"Jane Doe <jane@example.com>\"."), "")
	attachments := array(object(js{
		"blobId": str("An attachment uploaded with upload_mail_attachment, or one from a message."),
		"fileId": str("Or a file from Files, by id."),
		"name":   str("File name (for blobId)."),
		"type":   str("Content type (for blobId)."),
	}), "Files to attach.")
	compose := js{
		"to": addrs, "cc": addrs, "bcc": addrs,
		"subject":     str(""),
		"text":        str("The message as plain text."),
		"html":        str("The message as HTML; optional. Without it the text is sent as is."),
		"attachments": attachments,
	}
	sent := object(js{"id": str("The sent message's id."), "threadId": str("")}, "id")
	return []*apiOp{
		{Method: "GET", Path: "/api/v1/mail/mailboxes", ID: "list_mailboxes", Tag: "Mail", Summary: "List mail folders",
			Desc: "Inbox, drafts, sent, archive, junk, trash and folders of your own, with counts.", Result: object(js{"items": array(ref("Mailbox"), "")}), H: s.handleMailboxes},
		{Method: "GET", Path: "/api/v1/mail/messages", ID: "list_messages", Tag: "Mail", Summary: "List or search messages",
			Desc: "Newest first. Without `mailbox` or `q`, lists the inbox.",
			Params: append([]apiParam{
				query("mailbox", str("Mailbox id or role: inbox, drafts, sent, archive, junk, trash.")),
				query("q", str("Search the whole mailbox (sender, recipients, subject, text).")),
				query("unread", boolean("Only unread messages.")),
				query("flagged", boolean("Only flagged (starred) messages.")),
			}, pageParams...),
			Result: with(list(ref("MessageSummary")), js{"total": integer("How many match in all.")}), H: s.handleMessages},
		{Method: "GET", Path: "/api/v1/mail/messages/{id}", ID: "get_message", Tag: "Mail", Summary: "Read a message",
			Desc: "The whole message with its text, HTML and attachments. Reading does not mark it read; use update_message.", Params: []apiParam{id}, Result: ref("Message"), H: s.handleMessage},
		{Method: "GET", Path: "/api/v1/mail/threads/{id}", ID: "get_thread", Tag: "Mail", Summary: "Read a conversation",
			Params: []apiParam{pathParam("id", "Thread id (threadId of a message).")}, Result: object(js{"id": str(""), "messages": array(ref("Message"), "Oldest first.")}), H: s.handleThread},
		{Method: "POST", Path: "/api/v1/mail/send", ID: "send_mail", Tag: "Mail", Summary: "Send a message", Write: true,
			Desc: "Sends from your own address and files a copy in Sent. On the free plan, mail can only go to addresses hosted on this installation.",
			Body: object(compose, "to", "subject"), Result: sent, H: s.handleSend},
		{Method: "POST", Path: "/api/v1/mail/messages/{id}/reply", ID: "reply_to_message", Tag: "Mail", Summary: "Reply to a message", Write: true,
			Desc:   "Replies to the sender (or Reply-To), or with `all` to everyone else on it too, in the same conversation, quoting the original.",
			Params: []apiParam{id}, Body: object(js{"text": str(""), "html": str("Optional."), "all": boolean("Reply to all."), "attachments": attachments}, "text"), Result: sent, H: s.handleReply},
		{Method: "POST", Path: "/api/v1/mail/messages/{id}/forward", ID: "forward_message", Tag: "Mail", Summary: "Forward a message", Write: true,
			Desc:   "Sends the message on with its attachments, below your own text.",
			Params: []apiParam{id}, Body: object(js{"to": addrs, "cc": addrs, "bcc": addrs, "text": str("Your note above the forwarded message.")}, "to"), Result: sent, H: s.handleForward},
		{Method: "PATCH", Path: "/api/v1/mail/messages/{id}", ID: "update_message", Tag: "Mail", Summary: "Move, mark read or unread, flag or unflag a message", Write: true,
			Params: []apiParam{id}, Body: object(js{"mailbox": str("Mailbox id or role to move it to, e.g. archive."), "unread": boolean(""), "flagged": boolean("")}), Result: okResult, H: s.handleMessageUpdate},
		{Method: "DELETE", Path: "/api/v1/mail/messages/{id}", ID: "delete_message", Tag: "Mail", Summary: "Delete a message", Write: true,
			Desc:   "Moves it to the trash; with permanent=true it is destroyed at once.",
			Params: []apiParam{id, query("permanent", boolean("Destroy instead of moving to the trash."))}, Result: okResult, H: s.handleMessageDelete},
		{Method: "POST", Path: "/api/v1/mail/drafts", ID: "create_draft", Tag: "Mail", Summary: "Save a draft", Write: true,
			Desc: "Saves a message in Drafts without sending it. It shows in the app's Drafts, where a person can finish it.",
			Body: with(object(compose), js{"replyTo": str("Id of a message this answers, to keep it in that conversation.")}), Result: sent, H: s.handleDraftCreate},
		{Method: "PUT", Path: "/api/v1/mail/drafts/{id}", ID: "update_draft", Tag: "Mail", Summary: "Replace a draft", Write: true,
			Desc:   "Messages cannot change once stored, so this saves a new draft and removes the old one. Use the returned id from now on.",
			Params: []apiParam{pathParam("id", "Draft id.")}, Body: object(compose), Result: sent, H: s.handleDraftUpdate},
		{Method: "POST", Path: "/api/v1/mail/drafts/{id}/send", ID: "send_draft", Tag: "Mail", Summary: "Send a draft", Write: true,
			Params: []apiParam{pathParam("id", "Draft id.")}, Result: sent, H: s.handleDraftSend},
		{Method: "POST", Path: "/api/v1/mail/attachments", ID: "upload_mail_attachment", Tag: "Mail", Summary: "Upload an attachment", Write: true,
			Desc: "The request body is the file's bytes (up to 50 MB) with its Content-Type. Use the returned blobId in attachments when sending.",
			Raw:  "The file's bytes.", Result: object(js{"blobId": str(""), "type": str(""), "size": integer("")}, "blobId"), H: s.handleMailUpload},
		{Method: "GET", Path: "/api/v1/mail/attachments/{blobId}", ID: "get_mail_attachment", Tag: "Mail", Summary: "Download an attachment",
			Params: []apiParam{pathParam("blobId", "From a message's attachments."), query("name", str("File name to give the download."))}, File: true, H: s.handleAttachmentV1},
		{Method: "POST", Path: "/api/v1/mail/attachments/{blobId}/save", ID: "save_mail_attachment", Tag: "Mail", Summary: "Save an attachment to Files", Write: true,
			Params: []apiParam{pathParam("blobId", "From a message's attachments.")},
			Body:   object(js{"name": str("File name."), "type": str("Content type."), "folder": str("Folder id; absent for your top level.")}, "name"),
			Result: ref("Node"), H: s.handleAttachmentSave},
	}
}

func (s *Server) handleMailboxes(w http.ResponseWriter, r *http.Request, u *User) {
	if boxes := s.mailboxes(w, r, u); boxes != nil {
		ok(w, map[string]any{"items": boxes})
	}
}

func (s *Server) getEmails(w http.ResponseWriter, r *http.Request, u *User, ids []string, full bool) []jmapEmail {
	args := map[string]any{"ids": ids, "properties": mailSummaryProps}
	if full {
		args = map[string]any{"ids": ids, "properties": mailFullProps, "fetchTextBodyValues": true, "fetchHTMLBodyValues": true, "maxBodyValueBytes": 1500000}
	}
	res := s.mailCall(w, r, u, jmapCall{"Email/get", args})
	if res == nil {
		return nil
	}
	var g struct {
		List []jmapEmail `json:"list"`
	}
	json.Unmarshal(res[0].Args, &g)
	return g.List
}

// queryMail runs one Email/query and returns the summaries in order.
func (s *Server) queryMail(w http.ResponseWriter, r *http.Request, u *User, filter map[string]any, position, limit int) ([]messageSummary, int, bool) {
	res := s.mailCall(w, r, u,
		jmapCall{"Email/query", map[string]any{"filter": filter, "sort": []any{map[string]any{"property": "receivedAt", "isAscending": false}}, "position": position, "limit": limit, "calculateTotal": true}},
		jmapCall{"Email/get", map[string]any{"#ids": map[string]any{"resultOf": "0", "name": "Email/query", "path": "/ids"}, "properties": mailSummaryProps}},
	)
	if res == nil {
		return nil, 0, false
	}
	var q struct {
		IDs   []string `json:"ids"`
		Total int      `json:"total"`
	}
	var g struct {
		List []jmapEmail `json:"list"`
	}
	json.Unmarshal(res[0].Args, &q)
	json.Unmarshal(res[1].Args, &g)
	byID := map[string]*jmapEmail{}
	for i := range g.List {
		byID[g.List[i].ID] = &g.List[i]
	}
	out := []messageSummary{}
	for _, id := range q.IDs {
		if e := byID[id]; e != nil {
			out = append(out, e.summary())
		}
	}
	return out, q.Total, true
}

func (s *Server) handleMessages(w http.ResponseWriter, r *http.Request, u *User) {
	p := r.URL.Query()
	var conds []any
	if search := strings.TrimSpace(p.Get("q")); search != "" {
		conds = append(conds, map[string]any{"text": search})
	}
	if box := p.Get("mailbox"); box != "" || len(conds) == 0 {
		boxes := s.mailboxes(w, r, u)
		if boxes == nil {
			return
		}
		if box == "" {
			box = "inbox"
		}
		id := mailboxID(boxes, box)
		if id == "" {
			fail(w, 404, "No such mailbox. list_mailboxes shows them.")
			return
		}
		conds = append(conds, map[string]any{"inMailbox": id})
	}
	if p.Get("unread") == "true" {
		conds = append(conds, map[string]any{"notKeyword": "$seen"})
	}
	if p.Get("flagged") == "true" {
		conds = append(conds, map[string]any{"hasKeyword": "$flagged"})
	}
	limit, _ := strconv.Atoi(p.Get("limit"))
	if limit < 1 || limit > 200 {
		limit = 50
	}
	from, _ := strconv.Atoi(p.Get("cursor"))
	items, total, done := s.queryMail(w, r, u, map[string]any{"operator": "AND", "conditions": conds}, max(0, from), limit)
	if !done {
		return
	}
	out := map[string]any{"items": items, "total": total}
	if from+len(items) < total && len(items) > 0 {
		out["next"] = strconv.Itoa(from + len(items))
	}
	ok(w, out)
}

func (s *Server) searchMail(r *http.Request, u *User, q string, limit int) []messageSummary {
	items, _, done := s.queryMail(&recorder{header: http.Header{}}, r, u, map[string]any{"text": q}, 0, limit)
	if !done {
		return []messageSummary{}
	}
	return items
}

func (s *Server) oneEmail(w http.ResponseWriter, r *http.Request, u *User, id string) *jmapEmail {
	list := s.getEmails(w, r, u, []string{id}, true)
	if list == nil {
		return nil
	}
	if len(list) == 0 {
		fail(w, 404, "No such message.")
		return nil
	}
	return &list[0]
}

func (s *Server) handleMessage(w http.ResponseWriter, r *http.Request, u *User) {
	if e := s.oneEmail(w, r, u, r.PathValue("id")); e != nil {
		ok(w, e.full())
	}
}

func (s *Server) handleThread(w http.ResponseWriter, r *http.Request, u *User) {
	res := s.mailCall(w, r, u,
		jmapCall{"Thread/get", map[string]any{"ids": []string{r.PathValue("id")}}},
		jmapCall{"Email/get", map[string]any{"#ids": map[string]any{"resultOf": "0", "name": "Thread/get", "path": "/list/*/emailIds"},
			"properties": mailFullProps, "fetchTextBodyValues": true, "fetchHTMLBodyValues": true, "maxBodyValueBytes": 1500000}},
	)
	if res == nil {
		return
	}
	var t struct {
		List []struct {
			EmailIDs []string `json:"emailIds"`
		} `json:"list"`
	}
	var g struct {
		List []jmapEmail `json:"list"`
	}
	json.Unmarshal(res[0].Args, &t)
	json.Unmarshal(res[1].Args, &g)
	if len(t.List) == 0 {
		fail(w, 404, "No such conversation.")
		return
	}
	byID := map[string]*jmapEmail{}
	for i := range g.List {
		byID[g.List[i].ID] = &g.List[i]
	}
	msgs := []message{}
	for _, id := range t.List[0].EmailIDs {
		if e := byID[id]; e != nil {
			msgs = append(msgs, e.full())
		}
	}
	ok(w, map[string]any{"id": r.PathValue("id"), "messages": msgs})
}

// --- writing --------------------------------------------------------------

type outgoing struct {
	To, Cc, Bcc []string
	Subject     string
	Text, HTML  string
	Attachments []struct{ BlobID, FileID, Name, Type string }

	inReplyTo, references []string
	attach                []jmapPart // resolved attachments
}

func parseAddresses(list []string) ([]jmapAddress, string) {
	out := []jmapAddress{}
	for _, a := range list {
		if strings.TrimSpace(a) == "" {
			continue
		}
		p, err := mail.ParseAddress(a)
		if err != nil {
			return nil, "\"" + a + "\" is not a mail address."
		}
		out = append(out, jmapAddress{p.Name, strings.ToLower(p.Address)})
	}
	return out, ""
}

// resolveAttachments turns attachment references into the engine's blobs,
// copying files from Files into the mail engine as the app does.
func (s *Server) resolveAttachments(w http.ResponseWriter, r *http.Request, u *User, m *outgoing) bool {
	for _, a := range m.Attachments {
		switch {
		case a.FileID != "":
			p, code, msg := s.fileToMail(r.Context(), u, a.FileID)
			if code != 0 {
				fail(w, code, msg)
				return false
			}
			m.attach = append(m.attach, *p)
		case a.BlobID != "":
			if a.Type == "" {
				a.Type = "application/octet-stream"
			}
			m.attach = append(m.attach, jmapPart{BlobID: a.BlobID, Name: cleanName(a.Name), Type: a.Type})
		default:
			fail(w, 400, "Each attachment needs a blobId or a fileId.")
			return false
		}
	}
	return true
}

// emailObject is the message as the app builds it in lib/mail.js send().
func (s *Server) emailObject(u *User, m *outgoing, drafts string) (map[string]any, string) {
	to, bad := parseAddresses(m.To)
	if bad != "" {
		return nil, bad
	}
	cc, bad := parseAddresses(m.Cc)
	if bad != "" {
		return nil, bad
	}
	bcc, bad := parseAddresses(m.Bcc)
	if bad != "" {
		return nil, bad
	}
	text, htm := m.Text, m.HTML
	if text == "" && htm != "" {
		text = htmlText(htm)
	}
	e := map[string]any{
		"mailboxIds": map[string]bool{drafts: true},
		"keywords":   map[string]bool{"$draft": true, "$seen": true},
		"from":       []jmapAddress{{u.Name, u.Email}},
		"to":         to, "cc": cc, "bcc": bcc,
		"subject":    m.Subject,
		"bodyValues": map[string]any{"t": map[string]string{"value": text}},
		"textBody":   []jmapPart{{PartID: "t", Type: "text/plain"}},
	}
	if htm != "" {
		e["bodyValues"].(map[string]any)["h"] = map[string]string{"value": htm}
		e["htmlBody"] = []jmapPart{{PartID: "h", Type: "text/html"}}
	}
	parts := []map[string]any{}
	for _, a := range m.attach {
		parts = append(parts, map[string]any{"blobId": a.BlobID, "type": a.Type, "name": a.Name, "disposition": "attachment"})
	}
	e["attachments"] = parts
	if len(m.inReplyTo) > 0 {
		e["inReplyTo"] = m.inReplyTo
		e["references"] = m.references
	}
	return e, ""
}

// mailSendsPerHour limits how much one member can send through the API, so
// a leaked token cannot turn a mailbox into a spam cannon. A person writing
// by hand never gets near it, and neither does a well-behaved agent.
const mailSendsPerHour = 200

// sendEmail stores and submits a message in one request, then checks the
// result, as the app does. It returns the stored message's ids.
func (s *Server) sendEmail(w http.ResponseWriter, r *http.Request, u *User, m *outgoing) (string, string, bool) {
	if len(m.To)+len(m.Cc)+len(m.Bcc) == 0 {
		fail(w, 400, "Say who the message is for.")
		return "", "", false
	}
	if !s.lim.allow("send:"+u.ID, mailSendsPerHour, time.Hour) {
		w.Header().Set("Retry-After", "3600")
		fail(w, 429, "That's a lot of mail in one hour. Try again later.")
		return "", "", false
	}
	if !s.resolveAttachments(w, r, u, m) {
		return "", "", false
	}
	boxes := s.mailboxes(w, r, u)
	if boxes == nil {
		return "", "", false
	}
	drafts, sent := mailboxRole(boxes, "drafts"), mailboxRole(boxes, "sent")
	identity := s.identityOf(w, r, u)
	if identity == "" {
		return "", "", false
	}
	email, bad := s.emailObject(u, m, drafts)
	if bad != "" {
		fail(w, 400, bad)
		return "", "", false
	}
	calls := []jmapCall{
		{"Email/set", map[string]any{"create": map[string]any{"m": email}}},
		{"EmailSubmission/set", map[string]any{
			"create":               map[string]any{"s": map[string]any{"identityId": identity, "emailId": "#m"}},
			"onSuccessUpdateEmail": map[string]any{"#s": map[string]any{"mailboxIds/" + drafts: nil, "mailboxIds/" + sent: true, "keywords/$draft": nil}},
		}},
	}
	if !s.recipientsAllowed(u, rawCalls(calls)) {
		fail(w, 403, "Your organisation's plan sends mail only to addresses on Open Suite.")
		return "", "", false
	}
	res := s.mailCall(w, r, u, calls...)
	if res == nil {
		return "", "", false
	}
	var set, sub struct {
		Created    map[string]struct{ ID, ThreadID string } `json:"created"`
		NotCreated map[string]struct{ Description string }  `json:"notCreated"`
	}
	json.Unmarshal(res[0].Args, &set)
	json.Unmarshal(res[1].Args, &sub)
	if e, failed := set.NotCreated["m"]; failed {
		fail(w, 400, "That message couldn't be sent: "+e.Description)
		return "", "", false
	}
	if e, failed := sub.NotCreated["s"]; failed {
		fail(w, 400, "That message couldn't be sent: "+e.Description)
		return "", "", false
	}
	return set.Created["m"].ID, set.Created["m"].ThreadID, true
}

// rawCalls gives built calls the shape recipientsAllowed reads, which is
// how the app's own requests arrive.
func rawCalls(calls []jmapCall) [][]json.RawMessage {
	out := make([][]json.RawMessage, len(calls))
	for i, c := range calls {
		name, _ := json.Marshal(c.name)
		args, _ := json.Marshal(c.args)
		out[i] = []json.RawMessage{name, args, json.RawMessage(`"` + itoa(i) + `"`)}
	}
	return out
}

func (s *Server) identityOf(w http.ResponseWriter, r *http.Request, u *User) string {
	res := s.mailCall(w, r, u, jmapCall{"Identity/get", map[string]any{}})
	if res == nil {
		return ""
	}
	var g struct {
		List []struct{ ID, Email string } `json:"list"`
	}
	json.Unmarshal(res[0].Args, &g)
	for _, i := range g.List {
		if strings.EqualFold(i.Email, u.Email) {
			return i.ID
		}
	}
	if len(g.List) > 0 {
		return g.List[0].ID
	}
	fail(w, 503, "The mailbox has no sending identity yet. Try again in a minute.")
	return ""
}

func sentResult(w http.ResponseWriter, id, thread string) {
	ok(w, map[string]string{"id": id, "threadId": thread})
}

func (s *Server) handleSend(w http.ResponseWriter, r *http.Request, u *User) {
	var m outgoing
	if readJSON(r, &m) != nil {
		fail(w, 400, "bad request")
		return
	}
	if id, thread, done := s.sendEmail(w, r, u, &m); done {
		sentResult(w, id, thread)
	}
}

func addrText(a []jmapAddress) string {
	var out []string
	for _, x := range a {
		out = append(out, (&mail.Address{Name: x.Name, Address: x.Email}).String())
	}
	return strings.Join(out, ", ")
}

func addrStrings(a []jmapAddress) []string {
	out := []string{}
	for _, x := range a {
		out = append(out, (&mail.Address{Name: x.Name, Address: x.Email}).String())
	}
	return out
}

func prefixed(p, subject string) string {
	if strings.HasPrefix(strings.ToLower(subject), strings.ToLower(p)+":") {
		return subject
	}
	return p + ": " + subject
}

// quoted puts the original below a reply, the way the app does.
func quoted(e *jmapEmail) (string, string) {
	when := e.ReceivedAt
	if t, err := time.Parse(time.RFC3339, e.ReceivedAt); err == nil {
		when = t.UTC().Format("Mon, 2 Jan 2006 at 15:04 UTC")
	}
	who := addrText(e.From)
	orig := e.full().Text
	lines := strings.Split(orig, "\n")
	for i, l := range lines {
		lines[i] = "> " + l
	}
	text := "\n\nOn " + when + ", " + who + " wrote:\n" + strings.Join(lines, "\n")
	htm := "<br><br><div>On " + html.EscapeString(when) + ", " + html.EscapeString(who) + " wrote:</div><blockquote>" +
		strings.ReplaceAll(html.EscapeString(orig), "\n", "<br>") + "</blockquote>"
	return text, htm
}

func asHTML(text, htm string) string {
	if htm != "" {
		return htm
	}
	return strings.ReplaceAll(html.EscapeString(text), "\n", "<br>")
}

func (s *Server) handleReply(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct {
		Text, HTML  string
		All         bool
		Attachments []struct{ BlobID, FileID, Name, Type string }
	}
	if readJSON(r, &in) != nil {
		fail(w, 400, "bad request")
		return
	}
	e := s.oneEmail(w, r, u, r.PathValue("id"))
	if e == nil {
		return
	}
	to := e.ReplyTo
	if len(to) == 0 {
		to = e.From
	}
	m := &outgoing{To: addrStrings(to), Subject: prefixed("Re", e.Subject), Attachments: in.Attachments}
	if in.All {
		for _, a := range append(append([]jmapAddress{}, e.To...), e.Cc...) {
			mine := strings.EqualFold(a.Email, u.Email)
			for _, t := range to {
				mine = mine || strings.EqualFold(t.Email, a.Email)
			}
			if !mine {
				m.Cc = append(m.Cc, (&mail.Address{Name: a.Name, Address: a.Email}).String())
			}
		}
	}
	qt, qh := quoted(e)
	m.Text = in.Text + qt
	m.HTML = asHTML(in.Text, in.HTML) + qh
	m.inReplyTo = e.MessageID
	m.references = append(append([]string{}, e.References...), e.MessageID...)
	if id, thread, done := s.sendEmail(w, r, u, m); done {
		sentResult(w, id, thread)
	}
}

func (s *Server) handleForward(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct {
		To, Cc, Bcc []string
		Text        string
	}
	if readJSON(r, &in) != nil {
		fail(w, 400, "bad request")
		return
	}
	e := s.oneEmail(w, r, u, r.PathValue("id"))
	if e == nil {
		return
	}
	m := &outgoing{To: in.To, Cc: in.Cc, Bcc: in.Bcc, Subject: prefixed("Fwd", e.Subject)}
	qt, qh := quoted(e)
	m.Text = in.Text + qt
	m.HTML = asHTML(in.Text, "") + qh
	for _, a := range e.Attachments {
		m.Attachments = append(m.Attachments, struct{ BlobID, FileID, Name, Type string }{BlobID: a.BlobID, Name: a.Name, Type: a.Type})
	}
	if id, thread, done := s.sendEmail(w, r, u, m); done {
		sentResult(w, id, thread)
	}
}

func (s *Server) handleMessageUpdate(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct {
		Mailbox         *string
		Unread, Flagged *bool
	}
	if readJSON(r, &in) != nil {
		fail(w, 400, "bad request")
		return
	}
	patch := map[string]any{}
	if in.Mailbox != nil {
		boxes := s.mailboxes(w, r, u)
		if boxes == nil {
			return
		}
		to := s.ensureMailbox(w, r, u, boxes, *in.Mailbox)
		if to == "" {
			return
		}
		patch["mailboxIds"] = map[string]bool{to: true}
	}
	if in.Unread != nil {
		patch["keywords/$seen"] = keyword(!*in.Unread)
	}
	if in.Flagged != nil {
		patch["keywords/$flagged"] = keyword(*in.Flagged)
	}
	s.updateEmail(w, r, u, map[string]any{"update": map[string]any{r.PathValue("id"): patch}})
}

func keyword(on bool) any {
	if on {
		return true
	}
	return nil
}

func (s *Server) updateEmail(w http.ResponseWriter, r *http.Request, u *User, set map[string]any) {
	res := s.mailCall(w, r, u, jmapCall{"Email/set", set})
	if res == nil {
		return
	}
	var sr struct {
		NotUpdated   map[string]struct{ Description string } `json:"notUpdated"`
		NotDestroyed map[string]struct{ Description string } `json:"notDestroyed"`
	}
	json.Unmarshal(res[0].Args, &sr)
	for _, e := range sr.NotUpdated {
		fail(w, 404, "That message couldn't be changed: "+e.Description)
		return
	}
	for _, e := range sr.NotDestroyed {
		fail(w, 404, "That message couldn't be deleted: "+e.Description)
		return
	}
	ok(w, map[string]bool{"ok": true})
}

func (s *Server) handleMessageDelete(w http.ResponseWriter, r *http.Request, u *User) {
	id := r.PathValue("id")
	if r.URL.Query().Get("permanent") == "true" {
		s.updateEmail(w, r, u, map[string]any{"destroy": []string{id}})
		return
	}
	boxes := s.mailboxes(w, r, u)
	if boxes == nil {
		return
	}
	trash := s.ensureMailbox(w, r, u, boxes, "trash")
	if trash == "" {
		return
	}
	s.updateEmail(w, r, u, map[string]any{"update": map[string]any{id: map[string]any{"mailboxIds": map[string]bool{trash: true}}}})
}

// --- drafts -----------------------------------------------------------------

func (s *Server) saveDraft(w http.ResponseWriter, r *http.Request, u *User, m *outgoing, replace string) {
	if !s.resolveAttachments(w, r, u, m) {
		return
	}
	boxes := s.mailboxes(w, r, u)
	if boxes == nil {
		return
	}
	email, bad := s.emailObject(u, m, mailboxRole(boxes, "drafts"))
	if bad != "" {
		fail(w, 400, bad)
		return
	}
	set := map[string]any{"create": map[string]any{"m": email}}
	if replace != "" {
		set["destroy"] = []string{replace}
	}
	res := s.mailCall(w, r, u, jmapCall{"Email/set", set})
	if res == nil {
		return
	}
	var sr struct {
		Created    map[string]struct{ ID, ThreadID string } `json:"created"`
		NotCreated map[string]struct{ Description string }  `json:"notCreated"`
	}
	json.Unmarshal(res[0].Args, &sr)
	if e, failed := sr.NotCreated["m"]; failed {
		fail(w, 400, "That draft couldn't be saved: "+e.Description)
		return
	}
	sentResult(w, sr.Created["m"].ID, sr.Created["m"].ThreadID)
}

func (s *Server) handleDraftCreate(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct {
		outgoing
		ReplyTo string
	}
	if readJSON(r, &in) != nil {
		fail(w, 400, "bad request")
		return
	}
	if in.ReplyTo != "" {
		e := s.oneEmail(w, r, u, in.ReplyTo)
		if e == nil {
			return
		}
		in.inReplyTo = e.MessageID
		in.references = append(append([]string{}, e.References...), e.MessageID...)
	}
	s.saveDraft(w, r, u, &in.outgoing, "")
}

// draft reads a stored draft back into an outgoing message.
func (s *Server) draft(w http.ResponseWriter, r *http.Request, u *User) (*outgoing, string) {
	id := r.PathValue("id")
	e := s.oneEmail(w, r, u, id)
	if e == nil {
		return nil, ""
	}
	if !e.Keywords["$draft"] {
		fail(w, 409, "That message is not a draft.")
		return nil, ""
	}
	m := &outgoing{To: addrStrings(e.To), Cc: addrStrings(e.Cc), Bcc: addrStrings(e.Bcc), Subject: e.Subject,
		Text: e.bodyOf(e.TextBody), HTML: e.bodyOf(e.HTMLBody), inReplyTo: e.InReplyTo, references: e.References}
	if m.HTML == m.Text {
		m.HTML = ""
	}
	for _, a := range e.Attachments {
		m.Attachments = append(m.Attachments, struct{ BlobID, FileID, Name, Type string }{BlobID: a.BlobID, Name: a.Name, Type: a.Type})
	}
	return m, id
}

func (s *Server) handleDraftUpdate(w http.ResponseWriter, r *http.Request, u *User) {
	var in outgoing
	if readJSON(r, &in) != nil {
		fail(w, 400, "bad request")
		return
	}
	old, id := s.draft(w, r, u)
	if old == nil {
		return
	}
	in.inReplyTo, in.references = old.inReplyTo, old.references
	s.saveDraft(w, r, u, &in, id)
}

// handleDraftSend sends a draft's content as a new message, through the same
// checks as any other, then removes the draft.
func (s *Server) handleDraftSend(w http.ResponseWriter, r *http.Request, u *User) {
	m, id := s.draft(w, r, u)
	if m == nil {
		return
	}
	sentID, thread, done := s.sendEmail(w, r, u, m)
	if !done {
		return
	}
	s.mailCall(&recorder{header: http.Header{}}, r, u, jmapCall{"Email/set", map[string]any{"destroy": []string{id}}})
	sentResult(w, sentID, thread)
}

// --- attachments --------------------------------------------------------------

func (s *Server) handleAttachmentV1(w http.ResponseWriter, r *http.Request, u *User) {
	name := cleanName(r.URL.Query().Get("name"))
	r.SetPathValue("blob", r.PathValue("blobId"))
	r.SetPathValue("name", name)
	r.URL.RawQuery = url.Values{"dl": {"1"}}.Encode()
	s.handleMailBlob(w, r, u)
}

func (s *Server) handleAttachmentSave(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct{ Name, Type, Folder string }
	if readJSON(r, &in) != nil {
		fail(w, 400, "bad request")
		return
	}
	s.copyFromMail(w, r, u, r.PathValue("blobId"), "", in.Name, in.Type, in.Folder)
}
