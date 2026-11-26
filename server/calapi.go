package main

// Calendar and contacts in the public API. They live in the mail engine as
// JSCalendar events and JSContact cards, stored exactly as the app stores
// them (lib/calendar.js, apps/calendar-event.jsx, lib/contacts.js), so what
// an agent writes looks the same on a person's screen. Repeating events are
// unrolled, and invitation mails written, by the app's own code running in
// the content engine (content.go), so the API and the app cannot disagree
// about when a meeting happens or what a guest is sent.

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/mail"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata" // events name their zones; the binary must know them all
)

// The properties the engine sets, which the app never writes back (SERVER_SET
// in lib/calendar.js).
var serverSet = map[string]bool{"id": true, "@type": true, "uid": true, "created": true, "updated": true, "sequence": true, "isOrigin": true,
	"isDraft": true, "version": true, "useDefaultAlerts": true, "mayInviteSelf": true, "mayInviteOthers": true, "hideAttendees": true,
	"baseEventId": true, "utcStart": true, "utcEnd": true, "method": true, "iCalendar": true}

type calendarOut struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Color     string `json:"color,omitempty"`
	IsDefault bool   `json:"isDefault"`
}

func (s *Server) calendarOps() []*apiOp {
	id := pathParam("id", "Event id.")
	addrs := array(str("\"jane@example.com\" or \"Jane Doe <jane@example.com>\"."), "")
	event := js{
		"calendar":    str("Calendar id; default is your default calendar."),
		"title":       str(""),
		"description": str(""),
		"location":    str("A place."),
		"allDay":      boolean("An all-day event: start and end are dates (YYYY-MM-DD), end is the last day."),
		"start":       str("Local date and time in `timeZone`, like 2026-12-01T10:00, or an RFC 3339 instant like 2026-12-01T09:00:00Z. A date for all-day events."),
		"end":         str("Same form as start. Give end or duration; default one hour."),
		"duration":    str("ISO 8601 duration, like PT45M or PT1H30M, instead of end."),
		"timeZone":    str("IANA zone, like Europe/Berlin. Default: the zone of an RFC 3339 start, else UTC."),
		"guests":      addrs,
		"meeting":     boolean("Add a video meeting link (a new meeting room); false removes it."),
		"repeat":      anyObject("A JSCalendar RecurrenceRule, e.g. {\"frequency\":\"weekly\",\"byDay\":[{\"day\":\"mo\"}],\"count\":10}. null stops repeating."),
		"reminder":    integer("Minutes before the start to remind; -1 for no reminder. Default 10 for new timed events."),
		"color":       str("A colour for this event, like #0e9f6e."),
	}
	return []*apiOp{
		{Method: "GET", Path: "/api/v1/calendars", ID: "list_calendars", Tag: "Calendar", Summary: "List my calendars",
			Result: object(js{"items": array(ref("Calendar"), "")}), H: s.handleCalendars},
		{Method: "POST", Path: "/api/v1/calendars", ID: "create_calendar", Tag: "Calendar", Summary: "Create a calendar", Write: true,
			Body: object(js{"name": str(""), "color": str("e.g. #7c3aed")}, "name"), Result: ref("Calendar"), H: s.handleCalendarCreate},
		{Method: "GET", Path: "/api/v1/calendar/events", ID: "list_events", Tag: "Calendar", Summary: "What happens between two times",
			Desc: "Every occurrence in the window, repeating events unrolled, in order. Default window: the next 7 days.",
			Params: []apiParam{
				query("from", str("RFC 3339; default now.")),
				query("to", str("RFC 3339; at most 366 days after from.")),
				query("calendar", str("Only this calendar.")),
				query("zone", str("IANA zone to express times in; default UTC.")),
				query("q", str("Only events whose title, description or place contains this.")),
			},
			Result: object(js{"items": array(ref("Occurrence"), "")}), H: s.handleEvents},
		{Method: "GET", Path: "/api/v1/calendar/events/{id}", ID: "get_event", Tag: "Calendar", Summary: "Get an event",
			Params: []apiParam{id}, Result: ref("Event"), H: s.handleEvent},
		{Method: "POST", Path: "/api/v1/calendar/events", ID: "create_event", Tag: "Calendar", Summary: "Create an event and invite guests", Write: true,
			Desc: "Guests get an invitation by mail, which their calendar can accept, as when a person creates the event in the app.",
			Body: object(event, "title", "start"), Result: ref("Event"), H: s.handleEventCreate},
		{Method: "PATCH", Path: "/api/v1/calendar/events/{id}", ID: "update_event", Tag: "Calendar", Summary: "Change an event", Write: true,
			Desc:   "Send only what changes. Guests are told about changes they can see; new guests are invited and removed ones told. A new time asks guests to answer again.",
			Params: []apiParam{id}, Body: object(event), Result: ref("Event"), H: s.handleEventUpdate},
		{Method: "DELETE", Path: "/api/v1/calendar/events/{id}", ID: "delete_event", Tag: "Calendar", Summary: "Delete an event", Write: true,
			Desc:   "As the organiser, guests are told it is cancelled; as a guest, the organiser is told you are not coming.",
			Params: []apiParam{id}, Result: okResult, H: s.handleEventDelete},
		{Method: "POST", Path: "/api/v1/calendar/events/{id}/rsvp", ID: "answer_invitation", Tag: "Calendar", Summary: "Accept, decline or tentatively accept an invitation", Write: true,
			Params: []apiParam{id}, Body: object(js{"status": enum("", "accepted", "declined", "tentative")}, "status"), Result: ref("Event"), H: s.handleRSVP},
		{Method: "POST", Path: "/api/v1/calendar/freebusy", ID: "free_busy", Tag: "Calendar", Summary: "When colleagues are busy",
			Desc: "Busy times only, never what the events are. People outside your organisation are left out.",
			Body: object(js{
				"people": array(str(""), "Member ids or mail addresses, up to 25."),
				"from":   str("RFC 3339."),
				"to":     str("RFC 3339; at most 62 days after from."),
			}, "people", "from", "to"),
			Result: object(js{"busy": anyObject("Member id -> [{s, e, t}]: start and end in Unix milliseconds, t when tentative.")}), H: s.handleFreeBusy},
	}
}

func (s *Server) calendars(w http.ResponseWriter, r *http.Request, u *User) []calendarOut {
	res := s.mailCall(w, r, u, jmapCall{"Calendar/get", map[string]any{"properties": []string{"name", "color", "isDefault"}}})
	if res == nil {
		return nil
	}
	var g struct {
		List []calendarOut `json:"list"`
	}
	json.Unmarshal(res[0].Args, &g)
	sort.SliceStable(g.List, func(i, j int) bool { return g.List[i].IsDefault && !g.List[j].IsDefault })
	if g.List == nil {
		g.List = []calendarOut{}
	}
	return g.List
}

func (s *Server) handleCalendars(w http.ResponseWriter, r *http.Request, u *User) {
	if list := s.calendars(w, r, u); list != nil {
		ok(w, map[string]any{"items": list})
	}
}

func (s *Server) handleCalendarCreate(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct{ Name, Color string }
	if readJSON(r, &in) != nil || strings.TrimSpace(in.Name) == "" {
		fail(w, 400, "Give the calendar a name.")
		return
	}
	cal := map[string]any{"name": strings.TrimSpace(in.Name), "isVisible": true}
	if in.Color != "" {
		cal["color"] = in.Color
	}
	res := s.mailCall(w, r, u, jmapCall{"Calendar/set", map[string]any{"create": map[string]any{"n": cal}}})
	if res == nil {
		return
	}
	var sr struct {
		Created    map[string]struct{ ID string }          `json:"created"`
		NotCreated map[string]struct{ Description string } `json:"notCreated"`
	}
	json.Unmarshal(res[0].Args, &sr)
	if e, failed := sr.NotCreated["n"]; failed {
		fail(w, 400, "That calendar couldn't be created: "+e.Description)
		return
	}
	ok(w, calendarOut{ID: sr.Created["n"].ID, Name: cal["name"].(string), Color: in.Color})
}

// --- reading events -------------------------------------------------------------

type event = map[string]any

func (s *Server) allEvents(w http.ResponseWriter, r *http.Request, u *User) []event {
	res := s.mailCall(w, r, u,
		jmapCall{"CalendarEvent/query", map[string]any{"limit": 5000}},
		jmapCall{"CalendarEvent/get", map[string]any{"#ids": map[string]any{"resultOf": "0", "name": "CalendarEvent/query", "path": "/ids"}}},
	)
	if res == nil {
		return nil
	}
	var g struct {
		List []event `json:"list"`
	}
	json.Unmarshal(res[1].Args, &g)
	if g.List == nil {
		g.List = []event{}
	}
	return g.List
}

func (s *Server) oneEvent(w http.ResponseWriter, r *http.Request, u *User, id string) event {
	res := s.mailCall(w, r, u, jmapCall{"CalendarEvent/get", map[string]any{"ids": []string{id}}})
	if res == nil {
		return nil
	}
	var g struct {
		List []event `json:"list"`
	}
	json.Unmarshal(res[0].Args, &g)
	if len(g.List) == 0 {
		fail(w, 404, "No such event.")
		return nil
	}
	return g.List[0]
}

func strOf(ev event, k string) string {
	v, _ := ev[k].(string)
	return v
}

var durRe = regexp.MustCompile(`^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$`)

func parseDur(d string) (time.Duration, bool) {
	m := durRe.FindStringSubmatch(strings.TrimPrefix(d, "-"))
	if m == nil || d == "P" || d == "PT" {
		return 0, false
	}
	n := func(i int) time.Duration { v, _ := strconv.Atoi(m[i]); return time.Duration(v) }
	return n(1)*7*24*time.Hour + n(2)*24*time.Hour + n(3)*time.Hour + n(4)*time.Minute + n(5)*time.Second, true
}

// formatDur writes a duration as the app does (time.js formatDuration).
func formatDur(d time.Duration) string {
	if d <= 0 {
		return "PT0S"
	}
	if d%(24*time.Hour) == 0 {
		return fmt.Sprintf("P%dD", d/(24*time.Hour))
	}
	out := "PT"
	if h := d / time.Hour; h > 0 {
		out += fmt.Sprintf("%dH", h)
	}
	if m := (d % time.Hour) / time.Minute; m > 0 {
		out += fmt.Sprintf("%dM", m)
	}
	if s := (d % time.Minute) / time.Second; s > 0 {
		out += fmt.Sprintf("%dS", s)
	}
	return out
}

const wallLayout = "2006-01-02T15:04:05"

// span is when a single (non-repeating) event starts and ends.
func span(ev event) (time.Time, time.Time, bool) {
	zone := "UTC"
	if tz := strOf(ev, "timeZone"); tz != "" && ev["showWithoutTime"] != true {
		zone = tz
	}
	loc, err := time.LoadLocation(zone)
	if err != nil {
		return time.Time{}, time.Time{}, false
	}
	start, err := time.ParseInLocation(wallLayout, strOf(ev, "start"), loc)
	if err != nil {
		return time.Time{}, time.Time{}, false
	}
	d, _ := parseDur(strOf(ev, "duration"))
	return start, start.Add(d), true
}

// eventOut is an event as stored, with the fields an agent most often wants
// spelled out.
func eventOut(ev event) event {
	out := event{}
	for k, v := range ev {
		out[k] = v
	}
	if ev["recurrenceRule"] == nil {
		if a, b, found := span(ev); found {
			out["startsAt"], out["endsAt"] = a.Format(time.RFC3339), b.Format(time.RFC3339)
		}
	}
	if vl, _ := ev["virtualLocations"].(map[string]any); len(vl) > 0 {
		for _, v := range vl {
			if m, _ := v.(map[string]any); m != nil {
				out["meetingUrl"] = m["uri"]
			}
		}
	}
	guests := []map[string]string{}
	parts, _ := ev["participants"].(map[string]any)
	for _, p := range parts {
		m, _ := p.(map[string]any)
		addr, _ := m["calendarAddress"].(string)
		name, _ := m["name"].(string)
		status, _ := m["participationStatus"].(string)
		if status == "" {
			status = "needs-action"
		}
		guests = append(guests, map[string]string{"name": name, "email": strings.TrimPrefix(strings.ToLower(addr), "mailto:"), "status": status})
	}
	sort.Slice(guests, func(i, j int) bool { return guests[i]["email"] < guests[j]["email"] })
	out["guests"] = guests
	return out
}

type occurrence struct {
	ID           string  `json:"id"`
	RecurrenceID *string `json:"recurrenceId"`
	Start        int64   `json:"start"`
	End          int64   `json:"end"`
	AllDay       bool    `json:"allDay"`
	Title        string  `json:"title"`
}

func (s *Server) occurrences(w http.ResponseWriter, r *http.Request, u *User, events []event, from, to time.Time, zone string) []map[string]any {
	var res struct {
		Occurrences []occurrence `json:"occurrences"`
	}
	if !s.content(w, r, u, "calendar.occurrences", map[string]any{"events": events, "from": from.UnixMilli(), "to": to.UnixMilli(), "zone": zone}, &res) {
		return nil
	}
	loc, _ := time.LoadLocation(zone)
	out := []map[string]any{}
	for _, o := range res.Occurrences {
		item := map[string]any{"eventId": o.ID, "title": o.Title, "allDay": o.AllDay,
			"start": time.UnixMilli(o.Start).In(loc).Format(time.RFC3339), "end": time.UnixMilli(o.End).In(loc).Format(time.RFC3339)}
		if o.RecurrenceID != nil {
			item["recurrenceId"] = *o.RecurrenceID
		}
		out = append(out, item)
	}
	return out
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request, u *User) {
	p := r.URL.Query()
	from, to := time.Now(), time.Now().Add(7*24*time.Hour)
	var err error
	if v := p.Get("from"); v != "" {
		if from, err = time.Parse(time.RFC3339, v); err != nil {
			fail(w, 400, "from must be an RFC 3339 time, like 2026-12-01T00:00:00Z.")
			return
		}
		to = from.Add(7 * 24 * time.Hour)
	}
	if v := p.Get("to"); v != "" {
		if to, err = time.Parse(time.RFC3339, v); err != nil {
			fail(w, 400, "to must be an RFC 3339 time.")
			return
		}
	}
	if !to.After(from) || to.Sub(from) > 366*24*time.Hour {
		fail(w, 400, "The window must end after it starts and span at most a year.")
		return
	}
	zone := p.Get("zone")
	if zone == "" {
		zone = "UTC"
	}
	if _, err := time.LoadLocation(zone); err != nil {
		fail(w, 400, "Unknown time zone "+zone+".")
		return
	}
	events := s.allEvents(w, r, u)
	if events == nil {
		return
	}
	cal, q := p.Get("calendar"), p.Get("q")
	kept := []event{}
	for _, ev := range events {
		cals, _ := ev["calendarIds"].(map[string]any)
		if cal != "" && cals[cal] != true {
			continue
		}
		if !matches(q, strOf(ev, "title"), strOf(ev, "description"), placeOf(ev)) {
			continue
		}
		kept = append(kept, ev)
	}
	if list := s.occurrences(w, r, u, kept, from, to, zone); list != nil {
		ok(w, map[string]any{"items": list})
	}
}

func placeOf(ev event) string {
	locs, _ := ev["locations"].(map[string]any)
	for _, l := range locs {
		if m, _ := l.(map[string]any); m != nil {
			name, _ := m["name"].(string)
			return name
		}
	}
	return ""
}

func (s *Server) searchEvents(r *http.Request, u *User, q string, limit int) []event {
	out := []event{}
	for _, ev := range s.allEvents(&recorder{header: http.Header{}}, r, u) {
		if len(out) < limit && matches(q, strOf(ev, "title"), strOf(ev, "description"), placeOf(ev)) {
			out = append(out, eventOut(ev))
		}
	}
	return out
}

func (s *Server) handleEvent(w http.ResponseWriter, r *http.Request, u *User) {
	if ev := s.oneEvent(w, r, u, r.PathValue("id")); ev != nil {
		ok(w, eventOut(ev))
	}
}

// --- writing events ---------------------------------------------------------------

type eventInput struct {
	Calendar, Title, Description, Location *string
	AllDay                                 *bool
	Start, End, Duration, TimeZone         *string
	Guests                                 *[]string
	Meeting                                *bool
	Repeat                                 *json.RawMessage
	Reminder                               *int
	Color                                  *string
}

// wallTime reads a start or end: a local date-time in the zone, or an
// instant expressed in that zone (or, with no zone given, in its own offset's
// terms, kept as UTC).
func wallTime(v, zone string) (wall string, tz string, err error) {
	v = strings.TrimSpace(v)
	if t, e := time.Parse(time.RFC3339, v); e == nil {
		if zone == "" {
			zone = "Etc/UTC"
		}
		loc, e := time.LoadLocation(zone)
		if e != nil {
			return "", "", fmt.Errorf("unknown time zone %s", zone)
		}
		return t.In(loc).Format(wallLayout), zone, nil
	}
	if zone == "" {
		zone = "Etc/UTC"
	}
	if _, e := time.LoadLocation(zone); e != nil {
		return "", "", fmt.Errorf("unknown time zone %s", zone)
	}
	for _, layout := range []string{wallLayout, "2006-01-02T15:04"} {
		if t, e := time.Parse(layout, v); e == nil {
			return t.Format(wallLayout), zone, nil
		}
	}
	return "", "", fmt.Errorf("%q is not a date and time like 2026-12-01T10:00", v)
}

// applyEvent writes the input onto an event the way the app's event form
// does (eventOf in apps/calendar-event.jsx).
func (s *Server) applyEvent(r *http.Request, u *User, ev event, in *eventInput, fresh bool) string {
	set := func(k string, v any) {
		if v == nil || v == "" {
			delete(ev, k)
		} else {
			ev[k] = v
		}
	}
	if in.Title != nil {
		ev["title"] = strings.TrimSpace(*in.Title)
	}
	if in.Description != nil {
		set("description", strings.TrimSpace(*in.Description))
	}
	if in.Location != nil {
		if place := strings.TrimSpace(*in.Location); place != "" {
			ev["locations"] = map[string]any{"l1": map[string]any{"@type": "Location", "name": place}}
		} else {
			delete(ev, "locations")
		}
	}
	if in.Color != nil {
		set("color", *in.Color)
	}
	if in.Calendar != nil {
		ev["calendarIds"] = map[string]bool{*in.Calendar: true}
	}
	if in.Start != nil || in.End != nil || in.Duration != nil || in.AllDay != nil || in.TimeZone != nil {
		allDay := ev["showWithoutTime"] == true
		if in.AllDay != nil {
			allDay = *in.AllDay
		}
		start := strOf(ev, "start")
		if in.Start != nil {
			start = *in.Start
		}
		if allDay {
			day, err := time.Parse("2006-01-02", start[:min(10, len(start))])
			if err != nil {
				return "An all-day event starts on a date, like 2026-12-01."
			}
			days := 1
			if in.End != nil {
				last, err := time.Parse("2006-01-02", *in.End)
				if err != nil || last.Before(day) {
					return "An all-day event ends on a date on or after its start."
				}
				days = int(last.Sub(day).Hours()/24) + 1
			} else if d, found := parseDur(strOf(ev, "duration")); found && in.Start == nil && d >= 24*time.Hour {
				days = int(d.Hours() / 24)
			}
			ev["start"], ev["duration"], ev["showWithoutTime"] = day.Format(wallLayout), fmt.Sprintf("P%dD", days), true
			delete(ev, "timeZone")
		} else {
			zone := strOf(ev, "timeZone")
			if in.TimeZone != nil {
				zone = *in.TimeZone
			}
			if in.Start != nil && in.TimeZone == nil && strings.ContainsAny((*in.Start)[min(10, len(*in.Start)):], "Z+-") {
				zone = "" // an instant with its own offset: keep it in UTC unless a zone is named
			}
			wall, tz, err := wallTime(start, zone)
			if err != nil {
				return "start: " + err.Error()
			}
			dur, _ := parseDur(strOf(ev, "duration"))
			if fresh || dur <= 0 || ev["showWithoutTime"] == true {
				dur = time.Hour
			}
			if in.Duration != nil {
				d, found := parseDur(*in.Duration)
				if !found || d <= 0 {
					return "duration must be like PT30M or PT1H30M."
				}
				dur = d
			} else if in.End != nil {
				endWall, _, err := wallTime(*in.End, tz)
				if err != nil {
					return "end: " + err.Error()
				}
				a, _ := time.Parse(wallLayout, wall)
				b, _ := time.Parse(wallLayout, endWall)
				if !b.After(a) {
					return "The event must end after it starts."
				}
				dur = b.Sub(a)
			}
			ev["start"], ev["duration"], ev["timeZone"] = wall, formatDur(dur), tz
			delete(ev, "showWithoutTime")
		}
	}
	if in.Repeat != nil {
		if string(*in.Repeat) == "null" {
			delete(ev, "recurrenceRule")
			delete(ev, "recurrenceOverrides")
		} else {
			var rule map[string]any
			if json.Unmarshal(*in.Repeat, &rule) != nil || rule["frequency"] == nil {
				return "repeat must be a rule like {\"frequency\":\"weekly\"}."
			}
			rule["@type"] = "RecurrenceRule"
			ev["recurrenceRule"] = rule
		}
	}
	if in.Reminder != nil || (fresh && ev["showWithoutTime"] != true) {
		mins := 10
		if in.Reminder != nil {
			mins = *in.Reminder
		}
		if mins < 0 {
			delete(ev, "alerts")
		} else {
			offset := "PT0S"
			if mins > 0 {
				offset = "-" + formatDur(time.Duration(mins)*time.Minute)
			}
			ev["alerts"] = map[string]any{"a1": map[string]any{"@type": "Alert", "trigger": map[string]any{"@type": "OffsetTrigger", "offset": offset}, "action": "display"}}
		}
	}
	if in.Meeting != nil {
		if *in.Meeting {
			if vl, _ := ev["virtualLocations"].(map[string]any); len(vl) == 0 {
				title, _ := ev["title"].(string)
				m, code, msg := s.createMeeting(u, "", title)
				if code != 0 {
					return msg
				}
				ev["virtualLocations"] = map[string]any{"v1": map[string]any{"@type": "VirtualLocation", "name": "Open Suite meeting", "uri": baseURL(r) + "/meet/" + m.Code}}
			}
		} else {
			delete(ev, "virtualLocations")
		}
	}
	if in.Guests != nil {
		old, _ := ev["participants"].(map[string]any)
		if len(*in.Guests) == 0 {
			delete(ev, "participants")
			delete(ev, "organizerCalendarAddress")
		} else {
			me := "mailto:" + strings.ToLower(u.Email)
			parts := map[string]any{}
			keyOf := map[string]string{}
			for k, p := range old {
				if m, _ := p.(map[string]any); m != nil {
					addr, _ := m["calendarAddress"].(string)
					keyOf[strings.ToLower(addr)] = k
				}
			}
			mine := keyOf[me]
			if mine == "" {
				mine = "me"
			}
			parts[mine] = map[string]any{"@type": "Participant", "name": u.Name, "calendarAddress": me, "roles": map[string]bool{"owner": true, "attendee": true}, "participationStatus": "accepted"}
			for i, g := range *in.Guests {
				a, err := mail.ParseAddress(g)
				if err != nil {
					return "\"" + g + "\" is not a mail address."
				}
				addr := "mailto:" + strings.ToLower(a.Address)
				if addr == me {
					continue
				}
				p := map[string]any{}
				key := keyOf[addr]
				if prev, _ := old[key].(map[string]any); prev != nil {
					for k, v := range prev {
						p[k] = v
					}
				} else {
					key = "g" + strconv.FormatInt(time.Now().UnixNano(), 36) + strconv.Itoa(i)
					p["participationStatus"] = "needs-action"
				}
				p["@type"], p["calendarAddress"], p["roles"], p["expectReply"] = "Participant", addr, map[string]bool{"attendee": true}, true
				if a.Name != "" {
					p["name"] = a.Name
				}
				parts[key] = p
			}
			ev["participants"] = parts
			ev["organizerCalendarAddress"] = me
		}
	}
	return ""
}

func isOrganizer(ev event, u *User) bool {
	parts, _ := ev["participants"].(map[string]any)
	if len(parts) == 0 {
		return true
	}
	return strings.EqualFold(strings.TrimPrefix(strings.ToLower(strOf(ev, "organizerCalendarAddress")), "mailto:"), u.Email)
}

// sendCalendarMail sends the invitations, updates, cancellations and answers
// the app would send for a change, written by the app's own code.
func (s *Server) sendCalendarMail(w http.ResponseWriter, r *http.Request, u *User, kind string, ev, prev event, status string) bool {
	var res struct {
		Mails []struct {
			To  []jmapAddress `json:"to"`
			Raw string        `json:"raw"`
		} `json:"mails"`
	}
	if !s.content(w, r, u, "calendar.mails", map[string]any{"kind": kind, "ev": ev, "prev": prev, "status": status,
		"me": map[string]string{"name": u.Name, "email": u.Email}, "zone": zoneOf(ev, prev)}, &res) {
		return false
	}
	if len(res.Mails) == 0 {
		return true
	}
	boxes := s.mailboxes(w, r, u)
	if boxes == nil {
		return false
	}
	identity := s.identityOf(w, r, u)
	if identity == "" {
		return false
	}
	for _, m := range res.Mails {
		raw, err := base64.StdEncoding.DecodeString(m.Raw)
		if err != nil {
			fail(w, 500, "The invitation couldn't be written.")
			return false
		}
		blob, code, msg := s.mailUpload(r, u, "message/rfc822", raw)
		if code != 0 {
			fail(w, code, msg)
			return false
		}
		rcpt := []map[string]string{}
		for _, t := range m.To {
			rcpt = append(rcpt, map[string]string{"email": t.Email})
		}
		calls := []jmapCall{
			{"Email/import", map[string]any{"emails": map[string]any{"m": map[string]any{"blobId": blob, "mailboxIds": map[string]bool{mailboxRole(boxes, "sent"): true}, "keywords": map[string]bool{"$seen": true}}}}},
			{"EmailSubmission/set", map[string]any{
				"create":                map[string]any{"s": map[string]any{"identityId": identity, "emailId": "#m", "envelope": map[string]any{"mailFrom": map[string]string{"email": u.Email}, "rcptTo": rcpt}}},
				"onSuccessDestroyEmail": []string{"#s"},
			}},
		}
		if !s.recipientsAllowed(u, rawCalls(calls)) {
			fail(w, 403, "The event was saved, but your organisation's plan sends mail only to addresses on Open Suite, so the guests were not told.")
			return false
		}
		out := s.mailCall(w, r, u, calls...)
		if out == nil {
			return false
		}
		var imp, sub struct {
			NotCreated map[string]struct{ Description string } `json:"notCreated"`
		}
		json.Unmarshal(out[0].Args, &imp)
		json.Unmarshal(out[1].Args, &sub)
		for _, e := range []map[string]struct{ Description string }{imp.NotCreated, sub.NotCreated} {
			for _, x := range e {
				fail(w, 502, "The invitation could not be sent: "+x.Description)
				return false
			}
		}
	}
	return true
}

func zoneOf(evs ...event) string {
	for _, ev := range evs {
		if tz := strOf(ev, "timeZone"); tz != "" {
			return tz
		}
	}
	return "UTC"
}

// mailUpload stores bytes in the member's mailbox and returns the blob id.
func (s *Server) mailUpload(r *http.Request, u *User, ctype string, data []byte) (string, int, string) {
	req, err := http.NewRequestWithContext(r.Context(), "POST", s.cfg.MailURL+"/jmap/upload/"+url.PathEscape(u.MailID)+"/", strings.NewReader(string(data)))
	if err != nil {
		return "", 500, "mail error"
	}
	req.SetBasicAuth(u.Email, u.MailSecret)
	req.Header.Set("Content-Type", ctype)
	res, err := mailClient.Do(req)
	if err != nil {
		return "", 502, "The mail service is not responding."
	}
	defer res.Body.Close()
	var up struct {
		BlobID string `json:"blobId"`
	}
	if res.StatusCode >= 300 || json.NewDecoder(res.Body).Decode(&up) != nil || up.BlobID == "" {
		return "", 502, "The mail service refused the invitation."
	}
	return up.BlobID, 0, ""
}

func (s *Server) handleEventCreate(w http.ResponseWriter, r *http.Request, u *User) {
	var in eventInput
	if readJSON(r, &in) != nil {
		fail(w, 400, "bad request")
		return
	}
	if in.Title == nil || in.Start == nil {
		fail(w, 400, "An event needs a title and a start.")
		return
	}
	ev := event{"@type": "Event", "uid": newUUID() + "@" + s.cfg.MailDomain, "title": ""}
	if in.Calendar == nil {
		cals := s.calendars(w, r, u)
		if cals == nil {
			return
		}
		if len(cals) == 0 {
			fail(w, 503, "The calendar is being set up. Try again in a minute.")
			return
		}
		in.Calendar = &cals[0].ID
	}
	if msg := s.applyEvent(r, u, ev, &in, true); msg != "" {
		fail(w, 400, msg)
		return
	}
	res := s.mailCall(w, r, u, jmapCall{"CalendarEvent/set", map[string]any{"create": map[string]any{"n": ev}}})
	if res == nil {
		return
	}
	var sr struct {
		Created    map[string]event                        `json:"created"`
		NotCreated map[string]struct{ Description string } `json:"notCreated"`
	}
	json.Unmarshal(res[0].Args, &sr)
	if e, failed := sr.NotCreated["n"]; failed {
		fail(w, 400, "That event couldn't be saved: "+e.Description)
		return
	}
	for k, v := range sr.Created["n"] {
		ev[k] = v
	}
	if s.sendCalendarMail(w, r, u, "save", ev, nil, "") {
		ok(w, eventOut(ev))
	}
}

// eventPatch is what changed, as the app computes it (diff in calendar.js).
func eventPatch(prev, next event) map[string]any {
	patch := map[string]any{}
	keys := map[string]bool{}
	for k := range prev {
		keys[k] = true
	}
	for k := range next {
		keys[k] = true
	}
	for k := range keys {
		if serverSet[k] {
			continue
		}
		a, _ := json.Marshal(prev[k])
		b, _ := json.Marshal(next[k])
		if string(a) != string(b) {
			patch[k] = next[k]
		}
	}
	return patch
}

func (s *Server) saveEvent(w http.ResponseWriter, r *http.Request, u *User, prev, next event) {
	// A new time needs new answers from the guests; the app's own rule says
	// whose.
	var re struct{ Ev event }
	if !s.content(w, r, u, "calendar.reanswer", map[string]any{"ev": next, "prev": prev, "me": map[string]string{"name": u.Name, "email": u.Email}}, &re) {
		return
	}
	next = re.Ev
	id := strOf(prev, "id")
	patch := eventPatch(prev, next)
	if len(patch) > 0 {
		res := s.mailCall(w, r, u, jmapCall{"CalendarEvent/set", map[string]any{"update": map[string]any{id: patch}}})
		if res == nil {
			return
		}
		var sr struct {
			NotUpdated map[string]struct{ Description string } `json:"notUpdated"`
		}
		json.Unmarshal(res[0].Args, &sr)
		if e, failed := sr.NotUpdated[id]; failed {
			fail(w, 400, "That change couldn't be saved: "+e.Description)
			return
		}
		if !s.sendCalendarMail(w, r, u, "save", next, prev, "") {
			return
		}
	}
	ok(w, eventOut(next))
}

func (s *Server) handleEventUpdate(w http.ResponseWriter, r *http.Request, u *User) {
	var in eventInput
	if readJSON(r, &in) != nil {
		fail(w, 400, "bad request")
		return
	}
	prev := s.oneEvent(w, r, u, r.PathValue("id"))
	if prev == nil {
		return
	}
	next := event{}
	for k, v := range prev {
		next[k] = v
	}
	if (in.Guests != nil || in.Start != nil || in.End != nil || in.Duration != nil) && !isOrganizer(prev, u) {
		fail(w, 403, "Only the organiser can change the time or the guests.")
		return
	}
	if msg := s.applyEvent(r, u, next, &in, false); msg != "" {
		fail(w, 400, msg)
		return
	}
	s.saveEvent(w, r, u, prev, next)
}

func (s *Server) handleEventDelete(w http.ResponseWriter, r *http.Request, u *User) {
	ev := s.oneEvent(w, r, u, r.PathValue("id"))
	if ev == nil {
		return
	}
	if !s.sendCalendarMail(w, r, u, "delete", ev, nil, "") {
		return
	}
	res := s.mailCall(w, r, u, jmapCall{"CalendarEvent/set", map[string]any{"destroy": []string{strOf(ev, "id")}}})
	if res != nil {
		ok(w, map[string]bool{"ok": true})
	}
}

func (s *Server) handleRSVP(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct{ Status string }
	if readJSON(r, &in) != nil || (in.Status != "accepted" && in.Status != "declined" && in.Status != "tentative") {
		fail(w, 400, "status is accepted, declined or tentative.")
		return
	}
	ev := s.oneEvent(w, r, u, r.PathValue("id"))
	if ev == nil {
		return
	}
	parts, _ := ev["participants"].(map[string]any)
	key := ""
	for k, p := range parts {
		m, _ := p.(map[string]any)
		if addr, _ := m["calendarAddress"].(string); strings.EqualFold(addr, "mailto:"+u.Email) {
			key = k
		}
	}
	if key == "" {
		fail(w, 409, "You are not a guest of this event.")
		return
	}
	id := strOf(ev, "id")
	res := s.mailCall(w, r, u, jmapCall{"CalendarEvent/set", map[string]any{"update": map[string]any{id: map[string]any{"participants/" + key + "/participationStatus": in.Status}}}})
	if res == nil {
		return
	}
	var sr struct {
		NotUpdated map[string]struct{ Description string } `json:"notUpdated"`
	}
	json.Unmarshal(res[0].Args, &sr)
	if e, failed := sr.NotUpdated[id]; failed {
		fail(w, 400, "Your answer couldn't be saved: "+e.Description)
		return
	}
	me := map[string]any{}
	for k, v := range parts[key].(map[string]any) {
		me[k] = v
	}
	me["participationStatus"] = in.Status
	parts[key] = me
	if s.sendCalendarMail(w, r, u, "rsvp", ev, nil, in.Status) {
		ok(w, eventOut(ev))
	}
}

func newUUID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6], b[8] = b[6]&0x0f|0x40, b[8]&0x3f|0x80
	h := hex.EncodeToString(b)
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// --- contacts -----------------------------------------------------------------------

type contactInput struct {
	GivenName, Surname, Company, JobTitle, Address, Notes *string
	Emails, Phones                                        *[]string
}

func (s *Server) contactOps() []*apiOp {
	id := pathParam("id", "Contact id.")
	card := js{
		"givenName": str(""), "surname": str(""),
		"emails":  array(str(""), "Mail addresses."),
		"phones":  array(str(""), "Phone numbers."),
		"company": str(""), "jobTitle": str(""), "address": str("A postal address on one or more lines."), "notes": str(""),
	}
	return []*apiOp{
		{Method: "GET", Path: "/api/v1/contacts", ID: "list_contacts", Tag: "Contacts", Summary: "List or find contacts",
			Desc:   "Your own address book, by name. Colleagues are in list_people.",
			Params: append([]apiParam{query("q", str("Only contacts whose name, address, phone or company contains this."))}, pageParams...), Result: list(ref("Contact")), H: s.handleContacts},
		{Method: "GET", Path: "/api/v1/contacts/{id}", ID: "get_contact", Tag: "Contacts", Summary: "Get a contact", Params: []apiParam{id}, Result: ref("Contact"), H: s.handleContact},
		{Method: "POST", Path: "/api/v1/contacts", ID: "create_contact", Tag: "Contacts", Summary: "Add a contact", Write: true, Body: object(card), Result: ref("Contact"), H: s.handleContactCreate},
		{Method: "PATCH", Path: "/api/v1/contacts/{id}", ID: "update_contact", Tag: "Contacts", Summary: "Change a contact", Write: true,
			Desc: "Send only what changes; a list replaces the whole list.", Params: []apiParam{id}, Body: object(card), Result: ref("Contact"), H: s.handleContactUpdate},
		{Method: "DELETE", Path: "/api/v1/contacts/{id}", ID: "delete_contact", Tag: "Contacts", Summary: "Delete a contact", Write: true, Params: []apiParam{id}, Result: okResult, H: s.handleContactDelete},
	}
}

func cardValues(card map[string]any, field, key string) []string {
	out := []string{}
	m, _ := card[field].(map[string]any)
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if e, _ := m[k].(map[string]any); e != nil {
			if v, _ := e[key].(string); v != "" {
				out = append(out, v)
			}
		}
	}
	return out
}

func first(list []string) string {
	if len(list) == 0 {
		return ""
	}
	return list[0]
}

// contactOut is a card as stored, with the fields read the way the app reads
// them (nameOf, emailsOf, ... in lib/contacts.js).
func contactOut(card map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range card {
		out[k] = v
	}
	name, _ := card["name"].(map[string]any)
	full, _ := name["full"].(string)
	if full == "" {
		var parts []string
		comps, _ := name["components"].([]any)
		for _, c := range comps {
			if m, _ := c.(map[string]any); m != nil && (m["kind"] == "given" || m["kind"] == "surname") {
				parts = append(parts, m["value"].(string))
			}
		}
		full = strings.Join(parts, " ")
	}
	out["fullName"] = full
	out["emails"] = cardValues(card, "emails", "address")
	out["phones"] = cardValues(card, "phones", "number")
	out["company"] = first(cardValues(card, "organizations", "name"))
	out["jobTitle"] = first(cardValues(card, "titles", "name"))
	return out
}

func (s *Server) allContacts(w http.ResponseWriter, r *http.Request, u *User) []map[string]any {
	res := s.mailCall(w, r, u,
		jmapCall{"ContactCard/query", map[string]any{"limit": 20000}},
		jmapCall{"ContactCard/get", map[string]any{"#ids": map[string]any{"resultOf": "0", "name": "ContactCard/query", "path": "/ids"}}},
	)
	if res == nil {
		return nil
	}
	var g struct {
		List []map[string]any `json:"list"`
	}
	json.Unmarshal(res[1].Args, &g)
	out := []map[string]any{}
	for _, c := range g.List {
		out = append(out, contactOut(c))
	}
	sort.SliceStable(out, func(i, j int) bool {
		return strings.ToLower(out[i]["fullName"].(string)) < strings.ToLower(out[j]["fullName"].(string))
	})
	return out
}

func contactMatches(c map[string]any, q string) bool {
	fields := []string{c["fullName"].(string), c["company"].(string)}
	fields = append(fields, c["emails"].([]string)...)
	fields = append(fields, c["phones"].([]string)...)
	return matches(q, fields...)
}

func (s *Server) handleContacts(w http.ResponseWriter, r *http.Request, u *User) {
	all := s.allContacts(w, r, u)
	if all == nil {
		return
	}
	out := []map[string]any{}
	for _, c := range all {
		if contactMatches(c, r.URL.Query().Get("q")) {
			out = append(out, c)
		}
	}
	ok(w, page(r, out))
}

func (s *Server) searchContacts(r *http.Request, u *User, q string, limit int) []map[string]any {
	out := []map[string]any{}
	for _, c := range s.allContacts(&recorder{header: http.Header{}}, r, u) {
		if len(out) < limit && contactMatches(c, q) {
			out = append(out, c)
		}
	}
	return out
}

func (s *Server) oneContact(w http.ResponseWriter, r *http.Request, u *User) map[string]any {
	res := s.mailCall(w, r, u, jmapCall{"ContactCard/get", map[string]any{"ids": []string{r.PathValue("id")}}})
	if res == nil {
		return nil
	}
	var g struct {
		List []map[string]any `json:"list"`
	}
	json.Unmarshal(res[0].Args, &g)
	if len(g.List) == 0 {
		fail(w, 404, "No such contact.")
		return nil
	}
	return g.List[0]
}

func (s *Server) handleContact(w http.ResponseWriter, r *http.Request, u *User) {
	if c := s.oneContact(w, r, u); c != nil {
		ok(w, contactOut(c))
	}
}

// cardFields builds the parts of a card the input names, as fromForm does.
func cardFields(in *contactInput, prev map[string]any) map[string]any {
	out := map[string]any{}
	keyed := func(list []string, prefix, key string) any {
		m := map[string]any{}
		for _, v := range list {
			if v = strings.TrimSpace(v); v != "" {
				m[prefix+strconv.Itoa(len(m)+1)] = map[string]any{key: v}
			}
		}
		if len(m) == 0 {
			return nil
		}
		return m
	}
	one := func(v *string, field, prefix string, make func(string) map[string]any) {
		if v == nil {
			return
		}
		if t := strings.TrimSpace(*v); t != "" {
			out[field] = map[string]any{prefix: make(t)}
		} else {
			out[field] = nil
		}
	}
	if in.GivenName != nil || in.Surname != nil {
		prevForm := contactOut(prev)
		given, surname := "", ""
		if name, _ := prev["name"].(map[string]any); name != nil {
			comps, _ := name["components"].([]any)
			for _, c := range comps {
				if m, _ := c.(map[string]any); m != nil {
					if m["kind"] == "given" {
						given, _ = m["value"].(string)
					} else if m["kind"] == "surname" {
						surname, _ = m["value"].(string)
					}
				}
			}
			if given == "" && surname == "" {
				given = prevForm["fullName"].(string)
			}
		}
		if in.GivenName != nil {
			given = strings.TrimSpace(*in.GivenName)
		}
		if in.Surname != nil {
			surname = strings.TrimSpace(*in.Surname)
		}
		if given == "" && surname == "" {
			out["name"] = nil
		} else {
			comps := []map[string]string{}
			if given != "" {
				comps = append(comps, map[string]string{"kind": "given", "value": given})
			}
			if surname != "" {
				comps = append(comps, map[string]string{"kind": "surname", "value": surname})
			}
			out["name"] = map[string]any{"full": strings.TrimSpace(given + " " + surname), "components": comps, "isOrdered": true}
		}
	}
	if in.Emails != nil {
		out["emails"] = keyed(*in.Emails, "e", "address")
	}
	if in.Phones != nil {
		out["phones"] = keyed(*in.Phones, "p", "number")
	}
	one(in.Company, "organizations", "o1", func(v string) map[string]any { return map[string]any{"name": v} })
	one(in.JobTitle, "titles", "t1", func(v string) map[string]any { return map[string]any{"name": v, "kind": "title"} })
	one(in.Address, "addresses", "a1", func(v string) map[string]any { return map[string]any{"full": v} })
	one(in.Notes, "notes", "n1", func(v string) map[string]any { return map[string]any{"note": v} })
	return out
}

func (s *Server) handleContactCreate(w http.ResponseWriter, r *http.Request, u *User) {
	var in contactInput
	if readJSON(r, &in) != nil {
		fail(w, 400, "bad request")
		return
	}
	card := map[string]any{"@type": "Card", "version": "1.0"}
	for k, v := range cardFields(&in, map[string]any{}) {
		if v != nil {
			card[k] = v
		}
	}
	if len(card) == 2 {
		fail(w, 400, "A contact needs at least a name, an address, a phone number or a company.")
		return
	}
	res := s.mailCall(w, r, u,
		jmapCall{"AddressBook/get", map[string]any{"properties": []string{"isDefault"}}})
	if res == nil {
		return
	}
	var books struct {
		List []struct {
			ID        string
			IsDefault bool
		} `json:"list"`
	}
	json.Unmarshal(res[0].Args, &books)
	if len(books.List) == 0 {
		fail(w, 503, "The address book is being set up. Try again in a minute.")
		return
	}
	book := books.List[0].ID
	for _, b := range books.List {
		if b.IsDefault {
			book = b.ID
		}
	}
	card["addressBookIds"] = map[string]bool{book: true}
	res = s.mailCall(w, r, u, jmapCall{"ContactCard/set", map[string]any{"create": map[string]any{"n": card}}})
	if res == nil {
		return
	}
	var sr struct {
		Created    map[string]map[string]any               `json:"created"`
		NotCreated map[string]struct{ Description string } `json:"notCreated"`
	}
	json.Unmarshal(res[0].Args, &sr)
	if e, failed := sr.NotCreated["n"]; failed {
		fail(w, 400, "That contact couldn't be saved: "+e.Description)
		return
	}
	for k, v := range sr.Created["n"] {
		card[k] = v
	}
	ok(w, contactOut(card))
}

func (s *Server) handleContactUpdate(w http.ResponseWriter, r *http.Request, u *User) {
	var in contactInput
	if readJSON(r, &in) != nil {
		fail(w, 400, "bad request")
		return
	}
	prev := s.oneContact(w, r, u)
	if prev == nil {
		return
	}
	patch := cardFields(&in, prev)
	id := r.PathValue("id")
	if len(patch) > 0 {
		res := s.mailCall(w, r, u, jmapCall{"ContactCard/set", map[string]any{"update": map[string]any{id: patch}}})
		if res == nil {
			return
		}
		var sr struct {
			NotUpdated map[string]struct{ Description string } `json:"notUpdated"`
		}
		json.Unmarshal(res[0].Args, &sr)
		if e, failed := sr.NotUpdated[id]; failed {
			fail(w, 400, "That change couldn't be saved: "+e.Description)
			return
		}
	}
	for k, v := range patch {
		if v == nil {
			delete(prev, k)
		} else {
			prev[k] = v
		}
	}
	ok(w, contactOut(prev))
}

func (s *Server) handleContactDelete(w http.ResponseWriter, r *http.Request, u *User) {
	res := s.mailCall(w, r, u, jmapCall{"ContactCard/set", map[string]any{"destroy": []string{r.PathValue("id")}}})
	if res == nil {
		return
	}
	var sr struct {
		NotDestroyed map[string]struct{ Description string } `json:"notDestroyed"`
	}
	json.Unmarshal(res[0].Args, &sr)
	for _, e := range sr.NotDestroyed {
		fail(w, 404, "That contact couldn't be deleted: "+e.Description)
		return
	}
	ok(w, map[string]bool{"ok": true})
}
