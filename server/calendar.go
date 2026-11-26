package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Calendars and contacts live in the mail engine, next to each person's
// mailbox, and reach the browser through the same pinned /api/mail/jmap
// endpoint as mail. Two things stay on the server because they cross
// accounts: the engine's own settings, and colleagues' free/busy times.

// jmapGroupware lists the calendar and contact methods a browser may call.
var jmapGroupware = []string{"Calendar/", "CalendarEvent/", "AddressBook/", "ContactCard/"}

// groupwareCallOK vets one calendar or contact call before it is forwarded.
// Sharing with another account is refused, since the engine's accounts span
// every organisation on the server. Invitations are written and sent by the
// suite itself, so the engine is never asked to send its own.
func groupwareCallOK(name string, args map[string]json.RawMessage) bool {
	mine := false
	for _, p := range jmapGroupware {
		mine = mine || strings.HasPrefix(name, p)
	}
	if !mine {
		return true
	}
	delete(args, "sendSchedulingMessages")
	for _, op := range []string{"create", "update"} {
		raw, has := args[op]
		if !has {
			continue
		}
		var objs map[string]map[string]json.RawMessage
		if json.Unmarshal(raw, &objs) != nil {
			continue // not an object map: the engine will reject it
		}
		for _, o := range objs {
			for k := range o {
				if k == "shareWith" || strings.HasPrefix(k, "shareWith/") {
					return false
				}
			}
		}
	}
	return true
}

// mailGroupware sets the engine's calendar behaviour. It runs at every start
// and is safe to repeat. Invitations that arrive by mail are added to the
// person's calendar awaiting an answer; the engine's own reply pages and
// reminder mails stay off because they carry the engine's branding.
func (s *Server) mailGroupware(ctx context.Context) {
	if s.cfg.MailURL == "" || s.cfg.MailAdmin == "" {
		return
	}
	one := func(v map[string]any) map[string]any {
		return map[string]any{"update": map[string]any{"singleton": v}}
	}
	for attempt := 0; attempt < 30; attempt++ {
		_, err := s.jmapAdmin(ctx, s.cfg.MailURL,
			jmapCall{"x:CalendarScheduling/set", one(map[string]any{"enable": true, "autoAddInvitations": true, "httpRsvpEnable": false})},
			jmapCall{"x:CalendarAlarm/set", one(map[string]any{"enable": false})},
			jmapCall{"x:Calendar/set", one(map[string]any{"defaultDisplayName": "Calendar"})},
			jmapCall{"x:AddressBook/set", one(map[string]any{"defaultDisplayName": "Contacts"})},
		)
		if err == nil {
			return
		}
		if attempt == 29 {
			log.Printf("calendar: engine settings: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(10 * time.Second):
		}
	}
}

// jmapAs runs calls as one person, with their own credential.
func (s *Server) jmapAs(ctx context.Context, u *User, using []string, calls ...jmapCall) ([]jmapResult, error) {
	mc := make([][]any, len(calls))
	for i, c := range calls {
		mc[i] = []any{c.name, c.args, itoa(i)}
	}
	body, _ := json.Marshal(map[string]any{"using": using, "methodCalls": mc})
	req, err := http.NewRequestWithContext(ctx, "POST", s.cfg.MailURL+"/jmap/", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(u.Email, u.MailSecret)
	req.Header.Set("Content-Type", "application/json")
	res, err := s.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if res.StatusCode != 200 {
		return nil, errf("mail engine: %d", res.StatusCode)
	}
	var out struct {
		MethodResponses [][]json.RawMessage `json:"methodResponses"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	results := make([]jmapResult, len(out.MethodResponses))
	for i, r := range out.MethodResponses {
		if len(r) < 2 {
			return nil, errf("mail engine: malformed response")
		}
		json.Unmarshal(r[0], &results[i].Name)
		results[i].Args = r[1]
		if results[i].Name == "error" {
			return results, errf("mail engine: %s", r[1])
		}
	}
	return results, nil
}

type busyPeriod struct {
	Start     int64 `json:"s"` // unix milliseconds
	End       int64 `json:"e"`
	Tentative bool  `json:"t,omitempty"`
}

var availabilityUsing = []string{"urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars", "urn:ietf:params:jmap:principals", "urn:ietf:params:jmap:principals:availability"}

// busyFor asks the engine, as the person themself, when they are busy. Only
// the times leave this function: never titles, places or guests.
func (s *Server) busyFor(ctx context.Context, t *User, from, to time.Time) ([]busyPeriod, error) {
	res, err := s.jmapAs(ctx, t, availabilityUsing, jmapCall{"Principal/getAvailability", map[string]any{
		"accountId": t.MailID, "id": t.MailID,
		"utcStart": from.UTC().Format("2006-01-02T15:04:05Z"), "utcEnd": to.UTC().Format("2006-01-02T15:04:05Z")}})
	if err != nil {
		return nil, err
	}
	var av struct {
		List []struct {
			UTCStart   string `json:"utcStart"`
			UTCEnd     string `json:"utcEnd"`
			BusyStatus string `json:"busyStatus"`
		} `json:"list"`
	}
	json.Unmarshal(res[0].Args, &av)
	out := make([]busyPeriod, 0, len(av.List))
	for _, p := range av.List {
		a, err1 := time.Parse(time.RFC3339, p.UTCStart)
		b, err2 := time.Parse(time.RFC3339, p.UTCEnd)
		if err1 != nil || err2 != nil || p.BusyStatus == "free" {
			continue
		}
		out = append(out, busyPeriod{a.UnixMilli(), b.UnixMilli(), p.BusyStatus == "tentative"})
	}
	return out, nil
}

// handleFreeBusy returns when colleagues are busy, for scheduling. People
// outside the caller's organisation are silently left out, so the endpoint
// cannot be used to probe who else lives on the server.
func (s *Server) handleFreeBusy(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct {
		People   []string
		From, To string
	}
	if readJSON(r, &in) != nil {
		fail(w, 400, "bad request")
		return
	}
	from, err1 := time.Parse(time.RFC3339, in.From)
	to, err2 := time.Parse(time.RFC3339, in.To)
	if err1 != nil || err2 != nil || !to.After(from) || to.Sub(from) > 62*24*time.Hour || len(in.People) > 25 {
		fail(w, 400, "bad request")
		return
	}
	out := map[string][]busyPeriod{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, key := range in.People {
		// The app names people by id; the API also by address.
		var t *User
		if p := s.personIn(u.OrgID, key); p != nil {
			t = s.userByID(p.ID)
		}
		if t == nil || t.Status != "active" || !t.MailReady || s.cfg.MailURL == "" {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			periods, err := s.busyFor(r.Context(), t, from, to)
			if err != nil {
				return
			}
			mu.Lock()
			out[t.ID] = periods
			mu.Unlock()
		}()
	}
	wg.Wait()
	ok(w, map[string]any{"busy": out})
}
