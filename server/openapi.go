package main

// The API's description of itself, written from the operation table
// (api.go): an OpenAPI 3.1 document for tools, and a reference page for
// people. Both are served by every installation at its own address.

import (
	"encoding/json"
	"html"
	"net/http"
	"slices"
	"strings"
)

const apiIntro = "Everything a member can do in Open Suite, a program can do through this API: mail, calendar, contacts, chat, meetings, " +
	"files, documents, spreadsheets, presentations, search and, for administrators, the organisation itself. " +
	"Send a token as `Authorization: Bearer <token>`. A token acts as the member it belongs to, with their permissions; a read-only token can only read. " +
	"People create tokens in Account settings; administrators create them for agents. Apps can also ask a person to connect them with OAuth 2.1. " +
	"Errors are JSON `{\"error\": \"...\"}` with an HTTP status. Lists are paged: pass the `next` value of one page as `cursor` to get the next. " +
	"The same operations are tools of the MCP server at `/mcp`."

var tagOrder = []string{"Account", "People", "Mail", "Calendar", "Contacts", "Chat", "Meetings", "Files", "Documents", "Document content",
	"Spreadsheet content", "Presentation content", "Search", "Administration"}

func (s *Server) openAPI(r *http.Request) map[string]any {
	base := baseURL(r)
	paths := map[string]map[string]any{}
	for _, op := range s.ops {
		item := paths[op.Path]
		if item == nil {
			item = map[string]any{}
			paths[op.Path] = item
		}
		params := []map[string]any{}
		for _, p := range op.Params {
			params = append(params, map[string]any{"name": p.Name, "in": p.In, "description": p.Desc, "required": p.Required, "schema": p.Schema})
		}
		ok := map[string]any{"description": "OK"}
		if op.File {
			ok["content"] = map[string]any{"application/octet-stream": map[string]any{"schema": js{"type": "string", "format": "binary"}}}
		} else if op.Result != nil {
			ok["content"] = map[string]any{"application/json": map[string]any{"schema": op.Result}}
		}
		errResp := map[string]any{"description": "An error, in words that can be shown to a person.",
			"content": map[string]any{"application/json": map[string]any{"schema": ref("Error")}}}
		desc := op.Desc
		var notes []string
		if op.Write {
			notes = append(notes, "Changes data: needs a token with full access.")
		}
		if op.Admin {
			notes = append(notes, "Administrators only.")
		}
		if len(notes) > 0 {
			desc = strings.TrimSpace(desc + "\n\n" + strings.Join(notes, " "))
		}
		o := map[string]any{
			"operationId": op.ID, "summary": op.Summary, "description": desc, "tags": []string{op.Tag},
			"parameters": params,
			"responses":  map[string]any{"200": ok, "default": errResp},
		}
		if op.Body != nil {
			o["requestBody"] = map[string]any{"required": true, "content": map[string]any{"application/json": map[string]any{"schema": op.Body}}}
		}
		if op.Raw != "" {
			o["requestBody"] = map[string]any{"required": true, "description": op.Raw,
				"content": map[string]any{"*/*": map[string]any{"schema": js{"type": "string", "format": "binary"}}}}
		}
		item[strings.ToLower(op.Method)] = o
	}
	tags := []map[string]string{}
	for _, t := range tagOrder {
		tags = append(tags, map[string]string{"name": t})
	}
	return map[string]any{
		"openapi": "3.1.0",
		"info": map[string]any{
			"title": "Open Suite API", "version": "1.0.0", "description": apiIntro,
			"license": map[string]string{"name": "MIT", "identifier": "MIT"},
		},
		"servers": []map[string]string{{"url": base}},
		"tags":    tags,
		"paths":   paths,
		"components": map[string]any{
			"schemas": components,
			"securitySchemes": map[string]any{
				"token": map[string]any{"type": "http", "scheme": "bearer", "description": "An API token from Account settings, or an OAuth access token."},
				"oauth": map[string]any{"type": "oauth2", "flows": map[string]any{"authorizationCode": map[string]any{
					"authorizationUrl": base + "/oauth/authorize", "tokenUrl": base + "/oauth/token", "refreshUrl": base + "/oauth/token",
					"scopes": map[string]string{"read": "Read everything the member can read.", "write": "Make changes as the member."},
				}}},
			},
		},
		"security": []map[string][]string{{"token": {}}, {"oauth": {"read", "write"}}},
	}
}

func (s *Server) handleOpenAPI(w http.ResponseWriter, r *http.Request) {
	allowCORS(w)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=300")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	enc.Encode(s.openAPI(r))
}

// schemaText describes a schema in a line, for the reference page.
func schemaText(v js) string {
	if r, has := v["$ref"].(string); has {
		return strings.TrimPrefix(r, "#/components/schemas/")
	}
	switch v["type"] {
	case "array":
		if items, has := v["items"].(js); has {
			return "array of " + schemaText(items)
		}
	case "object":
		return "object"
	}
	if e, has := v["enum"].([]string); has {
		return strings.Join(e, " | ")
	}
	if t, has := v["type"].(string); has {
		return t
	}
	return "any"
}

func fieldRows(b *strings.Builder, props js, required []string) {
	names := make([]string, 0, len(props))
	for k := range props {
		names = append(names, k)
	}
	slices.Sort(names)
	for _, k := range names {
		v, _ := props[k].(js)
		desc, _ := v["description"].(string)
		req := ""
		if slices.Contains(required, k) {
			req = " <em>required</em>"
		}
		b.WriteString("<tr><td><code>" + html.EscapeString(k) + "</code>" + req + "</td><td>" + html.EscapeString(schemaText(v)) + "</td><td>" + inlineCode(desc) + "</td></tr>")
	}
}

// inlineCode escapes text and shows `quoted` parts as code.
func inlineCode(s string) string {
	parts := strings.Split(html.EscapeString(s), "`")
	for i := 1; i < len(parts); i += 2 {
		parts[i] = "<code>" + parts[i] + "</code>"
	}
	return strings.Join(parts, "")
}

// handleReference is the human-readable reference: one self-contained page,
// no scripts, nothing loaded from elsewhere.
func (s *Server) handleReference(w http.ResponseWriter, r *http.Request) {
	base := baseURL(r)
	var b strings.Builder
	b.WriteString(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open Suite API reference</title><style>
:root{color-scheme:light dark;--ink:#102033;--muted:#617385;--line:#e2e8ef;--soft:#f4f7fa;--accent:#1269e8}
@media (prefers-color-scheme:dark){:root{--ink:#e6edf5;--muted:#93a4b6;--line:#2a3746;--soft:#18212b;--accent:#6aa6ff}body{background:#0f161d}}
body{font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:var(--ink);margin:0}
main{max-width:980px;margin:0 auto;padding:32px 20px 80px}nav{columns:3 200px;margin:16px 0 32px}nav a{display:block}
a{color:var(--accent)}h1{font-size:28px;margin:0 0 8px}h2{margin:48px 0 8px;padding-top:8px;border-top:1px solid var(--line)}
h3{font-size:16px;margin:28px 0 4px}.m{display:inline-block;min-width:58px;font:600 12px ui-monospace,monospace;color:var(--accent)}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--soft);padding:1px 4px;border-radius:4px}
table{border-collapse:collapse;width:100%;margin:6px 0;font-size:14px}td{border-top:1px solid var(--line);padding:5px 8px 5px 0;vertical-align:top}
td:first-child{white-space:nowrap}.muted{color:var(--muted)}em{color:var(--muted);font-size:12px;font-style:normal}
</style></head><body><main><h1>Open Suite API</h1>`)
	b.WriteString("<p>" + inlineCode(apiIntro) + "</p>")
	b.WriteString(`<p>Base address: <code>` + html.EscapeString(base) + `</code>. Machine-readable: <a href="/api/v1/openapi.json">OpenAPI 3.1</a>. MCP server: <code>` + html.EscapeString(base) + `/mcp</code>.</p><nav>`)
	for _, t := range tagOrder {
		b.WriteString(`<a href="#` + strings.ReplaceAll(strings.ToLower(t), " ", "-") + `">` + t + `</a>`)
	}
	b.WriteString("</nav>")
	for _, t := range tagOrder {
		b.WriteString(`<h2 id="` + strings.ReplaceAll(strings.ToLower(t), " ", "-") + `">` + t + `</h2>`)
		for _, op := range s.ops {
			if op.Tag != t {
				continue
			}
			b.WriteString(`<h3 id="` + op.ID + `">` + html.EscapeString(op.Summary) + `</h3><p><span class="m">` + op.Method + `</span><code>` + html.EscapeString(op.Path) + `</code> <span class="muted">· tool <code>` + op.ID + `</code>`)
			if op.Write {
				b.WriteString(" · changes data")
			}
			if op.Admin {
				b.WriteString(" · administrators")
			}
			b.WriteString("</span></p>")
			if op.Desc != "" {
				b.WriteString("<p>" + inlineCode(op.Desc) + "</p>")
			}
			if len(op.Params) > 0 || op.Body != nil {
				b.WriteString("<table>")
				for _, p := range op.Params {
					req := ""
					if p.Required {
						req = " <em>required</em>"
					}
					b.WriteString("<tr><td><code>" + p.Name + "</code>" + req + "</td><td>" + p.In + "</td><td>" + inlineCode(p.Desc) + "</td></tr>")
				}
				if op.Body != nil {
					req, _ := op.Body["required"].([]string)
					fieldRows(&b, op.Body["properties"].(js), req)
				}
				b.WriteString("</table>")
			}
			if op.Raw != "" {
				b.WriteString("<p class=\"muted\">Request body: " + html.EscapeString(op.Raw) + "</p>")
			}
			switch {
			case op.File:
				b.WriteString("<p class=\"muted\">Returns the file.</p>")
			case op.Result != nil:
				b.WriteString("<p class=\"muted\">Returns " + html.EscapeString(schemaText(op.Result)) + ".</p>")
			}
		}
	}
	b.WriteString("<h2 id=\"schemas\">Objects</h2>")
	names := make([]string, 0, len(components))
	for k := range components {
		names = append(names, k)
	}
	slices.Sort(names)
	for _, name := range names {
		c := components[name]
		b.WriteString("<h3 id=\"schema-" + name + "\">" + name + "</h3>")
		if props, has := c["properties"].(js); has {
			req, _ := c["required"].([]string)
			b.WriteString("<table>")
			fieldRows(&b, props, req)
			b.WriteString("</table>")
		} else if d, has := c["description"].(string); has {
			b.WriteString("<p>" + inlineCode(d) + "</p>")
		}
	}
	b.WriteString("</main></body></html>")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.Write([]byte(b.String()))
}
