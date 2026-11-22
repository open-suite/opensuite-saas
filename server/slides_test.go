package main

import "testing"

// A presentation is one more kind of synced document; anything else is refused.
func TestSlidesKind(t *testing.T) {
	_, ts := newTestServer(t, nil)
	a := newClient(t, ts)
	a.signup("Alpha", "alice")

	var deck Doc
	if code := a.do("POST", "/api/docs", map[string]string{"kind": "slides", "title": "Roadmap"}, &deck); code != 200 {
		t.Fatalf("create presentation: %d", code)
	}
	if deck.Kind != "slides" || deck.Role != "owner" {
		t.Errorf("created %+v", deck)
	}
	var listed []Doc
	a.do("GET", "/api/docs", nil, &listed)
	if len(listed) != 1 || listed[0].Kind != "slides" || listed[0].Title != "Roadmap" {
		t.Errorf("listed %+v", listed)
	}
	if code := a.do("GET", "/api/docs/"+deck.ID+"/state", nil, nil); code != 200 {
		t.Errorf("state of a presentation: %d", code)
	}
	if code := a.do("POST", "/api/docs", map[string]string{"kind": "video"}, nil); code != 400 {
		t.Errorf("unknown kind: %d, want 400", code)
	}

	// Another organisation cannot reach it.
	b := newClient(t, ts)
	b.signup("Beta", "bob")
	if code := b.do("GET", "/api/docs/"+deck.ID+"/state", nil, nil); code != 403 {
		t.Errorf("presentation state from another organisation: %d, want 403", code)
	}
}
