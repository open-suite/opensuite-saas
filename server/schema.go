package main

// JSON Schema in Go literals, for the API's one description of itself: the
// same values become the OpenAPI document (openapi.go), the human-readable
// reference and the MCP tools' input schemas (mcp.go), so none of them can
// drift from what the handlers accept.

type js = map[string]any

func str(desc string) js     { return js{"type": "string", "description": desc} }
func integer(desc string) js { return js{"type": "integer", "description": desc} }
func boolean(desc string) js { return js{"type": "boolean", "description": desc} }
func number(desc string) js  { return js{"type": "number", "description": desc} }

func enum(desc string, values ...string) js {
	return js{"type": "string", "enum": values, "description": desc}
}

func array(items js, desc string) js { return js{"type": "array", "items": items, "description": desc} }

// object describes an object with the given properties; the names listed
// after it are required.
func object(props js, required ...string) js {
	o := js{"type": "object", "properties": props}
	if len(required) > 0 {
		o["required"] = required
	}
	return o
}

// anyObject is an object whose shape is defined elsewhere (a calendar event
// in JSCalendar, a contact card in JSContact).
func anyObject(desc string) js {
	return js{"type": "object", "description": desc, "additionalProperties": true}
}

func ref(name string) js { return js{"$ref": "#/components/schemas/" + name} }

// list is the shape of every paged list: the items and, when there are more,
// the cursor that fetches the next page.
func list(item js) js {
	return object(js{
		"items": array(item, ""),
		"next":  str("Pass as `cursor` to fetch the next page. Absent on the last page."),
	}, "items")
}

var okResult = object(js{"ok": boolean("Always true.")}, "ok")

// with adds properties to a shape: merged into an inline object, or beside a
// named one.
func with(base js, extra js) js {
	if _, named := base["$ref"]; named {
		return js{"allOf": []any{base, object(extra)}}
	}
	props := js{}
	for k, v := range base["properties"].(js) {
		props[k] = v
	}
	for k, v := range extra {
		props[k] = v
	}
	out := object(props)
	if req, has := base["required"]; has {
		out["required"] = req
	}
	return out
}

// resolveRefs inlines component references, for MCP clients that do not
// resolve $ref themselves.
func resolveRefs(v any) any {
	switch x := v.(type) {
	case js:
		if r, has := x["$ref"].(string); has && len(x) == 1 {
			name := r[len("#/components/schemas/"):]
			return resolveRefs(components[name])
		}
		out := js{}
		for k, val := range x {
			out[k] = resolveRefs(val)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, val := range x {
			out[i] = resolveRefs(val)
		}
		return out
	}
	return v
}

var shareSchema = object(js{
	"user": str("A member's id."),
	"role": enum("What they may do.", "view", "comment", "edit"),
}, "user", "role")

// components are the named shapes the API returns.
var components = map[string]js{
	"Error": object(js{"error": str("What went wrong, in words that can be shown to a person.")}, "error"),
	"Person": object(js{
		"id":     str("Member id."),
		"name":   str("Display name."),
		"email":  str("Mail address; also what they sign in with."),
		"role":   enum("Role in the organisation.", "owner", "admin", "member"),
		"status": enum("Suspended members cannot sign in or use tokens.", "active", "suspended"),
		"agent":  boolean("True for an agent: a member without a password that acts through API tokens."),
		"seen":   integer("When they last signed in (Unix seconds)."),
	}, "id", "name", "email", "role", "status"),
	"Group": object(js{
		"id":          str("Group id."),
		"name":        str("Display name; mail from the group is sent under it."),
		"email":       str("The group's address."),
		"description": str("What the group is for."),
		"posting":     enum("Who may send mail to it.", postingRules...),
		"created":     integer("Unix seconds."),
		"members":     array(object(js{"id": str("Member id."), "role": enum("", groupRoles...)}, "id", "role"), "Its members and their roles."),
		"role":        enum("The caller's role in it; absent if they are not a member.", groupRoles...),
		"accountId":   str("For members: the mailbox's id in the mail engine."),
	}, "id", "name", "email", "posting", "members"),
	"Token": object(js{
		"id":       str("Token id, used to revoke it."),
		"name":     str("What it is for."),
		"prefix":   str("The first characters of the secret, to recognise it."),
		"readOnly": boolean("A read-only token can read but not change anything."),
		"kind":     enum("A token made by hand, or an app connected through OAuth.", "token", "connection"),
		"created":  integer("Unix seconds."),
		"lastUsed": integer("Unix seconds; 0 if never used."),
		"expires":  integer("Unix seconds; 0 for no expiry."),
		"secret":   str("The token itself. Returned once, when it is created."),
	}, "id", "name", "prefix", "readOnly", "kind", "created"),
	"Doc": object(js{
		"id":      str("Document id."),
		"kind":    enum("Text document, spreadsheet or presentation.", "doc", "sheet", "slides"),
		"title":   str("Title."),
		"folder":  str("Id of the folder it is filed in; empty for the owner's top level."),
		"access":  enum("private: owner and named people; org: everyone in the organisation may edit.", "private", "org"),
		"owner":   str("Owner's member id."),
		"role":    enum("What the caller may do.", "owner", "edit", "comment", "view"),
		"created": integer("Unix seconds."),
		"updated": integer("Unix seconds."),
		"trashed": integer("When it was put in the trash (Unix seconds); absent if not."),
		"shares":  array(shareSchema, "People it is shared with by name."),
		"url":     str("Where it opens in the app."),
	}, "id", "kind", "title", "role"),
	"Node": object(js{
		"id":      str("File or folder id."),
		"kind":    enum("", "folder", "file"),
		"name":    str("Name."),
		"parent":  str("Containing folder id; empty at the top level."),
		"owner":   str("Owner's member id."),
		"role":    enum("What the caller may do, inherited from folders.", "owner", "edit", "view"),
		"access":  enum("", "private", "org"),
		"mime":    str("Content type of a file."),
		"size":    integer("Bytes."),
		"created": integer("Unix seconds."),
		"updated": integer("Unix seconds."),
		"trashed": integer("Unix seconds; absent if not in the trash."),
		"link":    str("Public link token, shown to the owner only."),
		"shares":  array(shareSchema, ""),
	}, "id", "kind", "name", "role"),
	"Meeting": object(js{
		"code":    str("Room code, like abc-defg-hij."),
		"title":   str("Title."),
		"owner":   str("Owner's member id."),
		"created": integer("Unix seconds."),
		"used":    integer("When someone last joined (Unix seconds)."),
		"url":     str("The link to join. Anyone with it can join; guests give a name."),
	}, "code", "url"),
	"Version": object(js{
		"id":      str("Version id."),
		"seq":     integer("The point in the document's history it records."),
		"created": integer("Unix seconds."),
		"name":    str("A name given by hand; empty for automatic versions."),
		"auto":    boolean("Taken automatically."),
		"editors": array(str(""), "Member ids of who changed the document since the previous version."),
		"size":    integer("Bytes."),
	}, "id", "created"),
	"Domain": object(js{
		"domain":  str(""),
		"webOk":   boolean("The suite opens at this address."),
		"mailOk":  boolean("Mail for this domain is handled here."),
		"records": array(object(js{"purpose": str(""), "type": str(""), "name": str(""), "value": str("")}), "DNS records to publish."),
		"created": integer(""),
	}, "domain"),
	"Mailbox": object(js{
		"id":     str("Mailbox (folder) id."),
		"name":   str(""),
		"role":   str("inbox, drafts, sent, archive, junk, trash, or empty for a folder of one's own."),
		"total":  integer("Messages in it."),
		"unread": integer("Unread messages."),
	}, "id", "name"),
	"Address": object(js{"name": str(""), "email": str("")}, "email"),
	"Attachment": object(js{
		"blobId": str("Download with get_mail_attachment, or file into Files with save_mail_attachment."),
		"name":   str(""),
		"type":   str("Content type."),
		"size":   integer("Bytes."),
	}, "blobId"),
	"MessageSummary": object(js{
		"id":            str("Message id."),
		"threadId":      str("Conversation id."),
		"mailboxes":     array(str(""), "Ids of the mailboxes it is in."),
		"from":          array(ref("Address"), ""),
		"to":            array(ref("Address"), ""),
		"cc":            array(ref("Address"), ""),
		"subject":       str(""),
		"receivedAt":    str("RFC 3339."),
		"preview":       str("The start of the text."),
		"unread":        boolean(""),
		"flagged":       boolean(""),
		"draft":         boolean(""),
		"hasAttachment": boolean(""),
		"readBy":        array(str(""), "In a group's mailbox: ids of the members who have read it."),
		"repliedBy":     array(str(""), "In a group's mailbox: ids of the members who answered it."),
	}, "id", "threadId", "subject"),
	"Message": object(js{
		"id":          str(""),
		"threadId":    str(""),
		"mailboxes":   array(str(""), ""),
		"from":        array(ref("Address"), ""),
		"to":          array(ref("Address"), ""),
		"cc":          array(ref("Address"), ""),
		"bcc":         array(ref("Address"), ""),
		"replyTo":     array(ref("Address"), ""),
		"subject":     str(""),
		"receivedAt":  str(""),
		"sentAt":      str(""),
		"messageId":   str("The Message-ID header."),
		"unread":      boolean(""),
		"flagged":     boolean(""),
		"draft":       boolean(""),
		"readBy":      array(str(""), "In a group's mailbox: ids of the members who have read it."),
		"repliedBy":   array(str(""), "In a group's mailbox: ids of the members who answered it."),
		"text":        str("The plain-text body (converted from HTML when the message has no text part)."),
		"html":        str("The HTML body, when there is one. Untrusted content from the sender."),
		"attachments": array(ref("Attachment"), ""),
	}, "id", "threadId", "subject"),
	"Calendar": object(js{
		"id":        str(""),
		"name":      str(""),
		"color":     str(""),
		"isDefault": boolean("New events go here unless another calendar is named."),
	}, "id", "name"),
	"Event": anyObject("A calendar event in JSCalendar (RFC 8984) as stored, plus convenience fields: `startsAt`/`endsAt` (RFC 3339, for an event that does not repeat), `meetingUrl` and `guests`."),
	"Occurrence": object(js{
		"eventId":      str("The event it belongs to."),
		"recurrenceId": str("For a repeating event, which occurrence (local date-time)."),
		"title":        str(""),
		"start":        str("RFC 3339."),
		"end":          str("RFC 3339."),
		"allDay":       boolean(""),
	}, "eventId", "start", "end"),
	"Contact": anyObject("A contact card in JSContact (RFC 9553) as stored, plus convenience fields `fullName`, `emails`, `phones`, `company` and `jobTitle`."),
	"Room": object(js{
		"id":      str("Conversation id."),
		"name":    str("Title: the other person's name for a direct conversation."),
		"direct":  boolean("A one-to-one conversation."),
		"members": array(object(js{"id": str("Member id, when they are in this organisation."), "name": str(""), "email": str("")}), ""),
	}, "id", "name"),
	"ChatMessage": object(js{
		"id":     str("Message id."),
		"sender": object(js{"id": str("Member id."), "name": str(""), "email": str("")}),
		"at":     str("RFC 3339."),
		"text":   str(""),
		"file":   object(js{"name": str(""), "type": str(""), "size": integer(""), "url": str("Download address (needs the same authorisation).")}),
	}, "id", "at"),
}
