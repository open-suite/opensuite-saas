package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"html"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Word and OpenDocument files keep what pandoc cannot: the page (paper,
// margins, header and footer) and the formatting the editor names as styles
// (web/src/apps/doc-format.js exportCopy). On the way out the styles get
// their formatting and the page its setup; on the way in the page setup is
// read back and handed to the editor as a <meta> (doc-page.js pageFromHTML).
// pandoc itself carries the style names in both directions.

// convertFile is the one way documents are converted.
func convertFile(ctx context.Context, from, to string, in []byte) ([]byte, error) {
	c, found := conversions[from+">"+to]
	if !found {
		return nil, engineError("That conversion isn't supported.")
	}
	out, err := runPandoc(ctx, c, from, bytes.NewReader(in))
	if err != nil {
		return nil, err
	}
	switch {
	case from == "html" && (to == "docx" || to == "odt"):
		if done, err := finishExport(to, in, out); err == nil {
			return done, nil
		}
		// A file pandoc made but this could not finish is still a good file.
		return out, nil
	case (from == "docx" || from == "odt") && to == "html":
		if p := readPageSetup(from, in); p != nil {
			b, _ := json.Marshal(p)
			out = append([]byte(`<meta name="os-page" content="`+html.EscapeString(string(b))+`">`), out...)
		}
	}
	return out, nil
}

// --- page setup -----------------------------------------------------------------

type pageSetup struct {
	Size        string   `json:"size,omitempty"`
	Orientation string   `json:"orientation,omitempty"`
	Top         *float64 `json:"top,omitempty"`
	Right       *float64 `json:"right,omitempty"`
	Bottom      *float64 `json:"bottom,omitempty"`
	Left        *float64 `json:"left,omitempty"`
	Header      string   `json:"header,omitempty"`
	HeaderAlign string   `json:"headerAlign,omitempty"`
	Footer      string   `json:"footer,omitempty"`
	FooterAlign string   `json:"footerAlign,omitempty"`
}

// Paper sizes in millimetres, as in doc-page.js.
var papers = map[string][2]float64{
	"a4": {210, 297}, "letter": {215.9, 279.4}, "legal": {215.9, 355.6}, "a5": {148, 210}, "a3": {297, 420},
}

const defaultMargin = 25.4

func (p pageSetup) margins() (top, right, bottom, left float64) {
	get := func(v *float64) float64 {
		if v == nil {
			return defaultMargin
		}
		return *v
	}
	return get(p.Top), get(p.Right), get(p.Bottom), get(p.Left)
}

func (p pageSetup) paper() (w, h float64) {
	sz, ok := papers[p.Size]
	if !ok {
		sz = papers["a4"]
	}
	if p.Orientation == "landscape" {
		return sz[1], sz[0]
	}
	return sz[0], sz[1]
}

func align(a string) string {
	if a == "left" || a == "right" {
		return a
	}
	return "center"
}

var metaPage = regexp.MustCompile(`<meta name="os-page" content="([^"]*)"`)
var titleTag = regexp.MustCompile(`(?s)<title>(.*?)</title>`)

func pageOf(in []byte) (pageSetup, string) {
	var p pageSetup
	if m := metaPage.FindSubmatch(in); m != nil {
		json.Unmarshal([]byte(html.UnescapeString(string(m[1]))), &p)
	}
	title := ""
	if m := titleTag.FindSubmatch(in); m != nil {
		title = html.UnescapeString(string(m[1]))
	}
	return p, title
}

// tokens splits header or footer text into text and the {page}, {pages} and
// {title} fields.
var tokenRe = regexp.MustCompile(`\{(page|pages|title)\}`)

func tokens(text, title string, emit func(kind, text string)) {
	last := 0
	for _, m := range tokenRe.FindAllStringSubmatchIndex(text, -1) {
		if m[0] > last {
			emit("text", text[last:m[0]])
		}
		switch k := text[m[2]:m[3]]; k {
		case "title":
			emit("text", title)
		default:
			emit(k, "")
		}
		last = m[1]
	}
	if last < len(text) {
		emit("text", text[last:])
	}
}

// --- styles named by the editor ---------------------------------------------------

type format struct {
	color, highlight, font string
	size, lineHeight       float64
	indent                 int
	align                  string
}

// parseStyle reads a name written by styleName in doc-format.js.
func parseStyle(name string) (format, bool) {
	var f format
	if !strings.HasPrefix(name, "OS_") {
		return f, false
	}
	hexRe := regexp.MustCompile(`^[0-9a-fA-F]{6}$`)
	for _, part := range strings.Split(name[3:], "_") {
		k, v, found := strings.Cut(part, "-")
		if !found {
			continue
		}
		n, _ := strconv.ParseFloat(v, 64)
		switch k {
		case "c":
			if hexRe.MatchString(v) {
				f.color = strings.ToUpper(v)
			}
		case "h":
			if hexRe.MatchString(v) {
				f.highlight = strings.ToUpper(v)
			}
		case "f":
			f.font = strings.Map(func(r rune) rune {
				if r == '.' {
					return ' '
				}
				if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == ' ' {
					return r
				}
				return -1
			}, v)
		case "s":
			if n > 0 && n <= 400 {
				f.size = n
			}
		case "lh":
			if n > 0 && n <= 4 {
				f.lineHeight = n
			}
		case "in":
			if n > 0 && n <= 8 {
				f.indent = int(n)
			}
		case "al":
			if v == "left" || v == "center" || v == "right" || v == "justify" {
				f.align = v
			}
		}
	}
	return f, true
}

func xmlText(s string) string {
	var b bytes.Buffer
	xml.EscapeText(&b, []byte(s))
	return b.String()
}

const indentTwips = 540 // 36 px, the editor's indent step

func twips(mm float64) int { return int(math.Round(mm / 25.4 * 1440)) }

// --- Word ---------------------------------------------------------------------------

func docxRunProps(f format) string {
	var b strings.Builder
	if f.font != "" {
		n := xmlText(f.font)
		fmt.Fprintf(&b, `<w:rFonts w:ascii="%s" w:hAnsi="%s" w:cs="%s"/>`, n, n, n)
	}
	if f.color != "" {
		fmt.Fprintf(&b, `<w:color w:val="%s"/>`, f.color)
	}
	if f.size > 0 {
		hp := int(math.Round(f.size * 2))
		fmt.Fprintf(&b, `<w:sz w:val="%d"/><w:szCs w:val="%d"/>`, hp, hp)
	}
	if f.highlight != "" {
		fmt.Fprintf(&b, `<w:shd w:val="clear" w:color="auto" w:fill="%s"/>`, f.highlight)
	}
	return b.String()
}

func docxParaProps(f format) string {
	var b strings.Builder
	if f.lineHeight > 0 {
		fmt.Fprintf(&b, `<w:spacing w:line="%d" w:lineRule="auto"/>`, int(math.Round(f.lineHeight*240)))
	}
	if f.indent > 0 {
		fmt.Fprintf(&b, `<w:ind w:left="%d"/>`, f.indent*indentTwips)
	}
	if f.align != "" {
		jc := f.align
		if jc == "justify" {
			jc = "both"
		}
		fmt.Fprintf(&b, `<w:jc w:val="%s"/>`, jc)
	}
	return b.String()
}

var (
	docxStyle      = regexp.MustCompile(`(?s)<w:style w:type="(paragraph|character)"[^>]*>\s*<w:name w:val="(OS_[^"]*)"\s*/>.*?</w:style>`)
	docxHeading    = regexp.MustCompile(`(<w:bookmarkStart w:id="\d+" w:name="h\d+-(OS_[^"]+)"\s*/>\s*<w:p>\s*<w:pPr>\s*<w:pStyle w:val="[^"]*"\s*/>)`)
	docxSectPr     = regexp.MustCompile(`(?s)<w:sectPr>(.*?)</w:sectPr>(\s*</w:body>)`)
	docxFootnotePr = regexp.MustCompile(`(?s)<w:footnotePr>.*?</w:footnotePr>`)
)

const wNS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`

func docxPart(tag, text, al, title string) string {
	var runs strings.Builder
	tokens(text, title, func(kind, t string) {
		switch kind {
		case "text":
			fmt.Fprintf(&runs, `<w:r><w:t xml:space="preserve">%s</w:t></w:r>`, xmlText(t))
		case "page":
			runs.WriteString(`<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>`)
		case "pages":
			runs.WriteString(`<w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>1</w:t></w:r></w:fldSimple>`)
		}
	})
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`+"\n"+`<w:%s %s><w:p><w:pPr><w:jc w:val="%s"/></w:pPr>%s</w:p></w:%s>`, tag, wNS, align(al), runs.String(), tag)
}

func finishDocx(in, out []byte) ([]byte, error) {
	p, title := pageOf(in)
	return rewriteZip(out, func(name string, data []byte) ([]byte, map[string][]byte) {
		switch name {
		case "word/styles.xml":
			return docxStyle.ReplaceAllFunc(data, func(m []byte) []byte {
				sub := docxStyle.FindSubmatch(m)
				f, _ := parseStyle(string(sub[2]))
				var props string
				switch {
				case string(sub[2]) == "OS_PageBreak":
					// The paragraph that carries the break is made as small as a
					// paragraph can be.
					props = `<w:pPr><w:pageBreakBefore/><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr><w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr>`
				case string(sub[1]) == "character":
					props = "<w:rPr>" + docxRunProps(f) + "</w:rPr>"
				default:
					props = "<w:pPr>" + docxParaProps(f) + "</w:pPr>"
				}
				return bytes.Replace(m, []byte("</w:style>"), []byte(props+"</w:style>"), 1)
			}), nil
		case "word/document.xml":
			data = docxHeading.ReplaceAllFunc(data, func(m []byte) []byte {
				sub := docxHeading.FindSubmatch(m)
				f, _ := parseStyle(string(sub[2]))
				return append(append([]byte{}, m...), []byte(docxParaProps(f))...)
			})
			extra := map[string][]byte{}
			data = docxSectPr.ReplaceAllFunc(data, func(m []byte) []byte {
				sub := docxSectPr.FindSubmatch(m)
				var b strings.Builder
				b.WriteString("<w:sectPr>")
				if p.Header != "" {
					b.WriteString(`<w:headerReference w:type="default" r:id="rIdOsHeader"/>`)
					extra["word/header-os.xml"] = []byte(docxPart("hdr", p.Header, p.HeaderAlign, title))
				}
				if p.Footer != "" {
					b.WriteString(`<w:footerReference w:type="default" r:id="rIdOsFooter"/>`)
					extra["word/footer-os.xml"] = []byte(docxPart("ftr", p.Footer, p.FooterAlign, title))
				}
				b.Write(docxFootnotePr.Find(sub[1]))
				w, h := p.paper()
				orient := ""
				if p.Orientation == "landscape" {
					orient = ` w:orient="landscape"`
				}
				fmt.Fprintf(&b, `<w:pgSz w:w="%d" w:h="%d"%s/>`, twips(w), twips(h), orient)
				t, r, bo, l := p.margins()
				fmt.Fprintf(&b, `<w:pgMar w:top="%d" w:right="%d" w:bottom="%d" w:left="%d" w:header="%d" w:footer="%d" w:gutter="0"/>`,
					twips(t), twips(r), twips(bo), twips(l), twips(min(12.5, t/2)), twips(min(12.5, bo/2)))
				b.WriteString("</w:sectPr>")
				b.Write(sub[2])
				return []byte(b.String())
			})
			return data, extra
		}
		return data, nil
	}, func(added map[string]bool, name string, data []byte) []byte {
		switch name {
		case "word/_rels/document.xml.rels":
			var rels strings.Builder
			if added["word/header-os.xml"] {
				rels.WriteString(`<Relationship Id="rIdOsHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header-os.xml"/>`)
			}
			if added["word/footer-os.xml"] {
				rels.WriteString(`<Relationship Id="rIdOsFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer-os.xml"/>`)
			}
			return bytes.Replace(data, []byte("</Relationships>"), []byte(rels.String()+"</Relationships>"), 1)
		case "[Content_Types].xml":
			var types strings.Builder
			if added["word/header-os.xml"] {
				types.WriteString(`<Override PartName="/word/header-os.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>`)
			}
			if added["word/footer-os.xml"] {
				types.WriteString(`<Override PartName="/word/footer-os.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>`)
			}
			return bytes.Replace(data, []byte("</Types>"), []byte(types.String()+"</Types>"), 1)
		}
		return data
	})
}

// --- OpenDocument ---------------------------------------------------------------------

var (
	odtUsed       = regexp.MustCompile(`<text:(span|p) text:style-name="(OS_[^"]+)"`)
	odtHeading    = regexp.MustCompile(`<text:h text:style-name="([^"]+)"([^>]*)>(<text:bookmark-start text:name="h\d+-(OS_[^"]+)"\s*/>)`)
	odtLayoutProp = regexp.MustCompile(`<style:page-layout-properties [^>]*?(/?)>`)
	odtMaster     = regexp.MustCompile(`(?s)<style:master-page style:name="Standard"([^>]*?)(/>|>(.*?)</style:master-page>)`)
)

func odtTextProps(f format) string {
	var b strings.Builder
	b.WriteString("<style:text-properties")
	if f.color != "" {
		fmt.Fprintf(&b, ` fo:color="#%s"`, strings.ToLower(f.color))
	}
	if f.highlight != "" {
		fmt.Fprintf(&b, ` fo:background-color="#%s"`, strings.ToLower(f.highlight))
	}
	if f.font != "" {
		fmt.Fprintf(&b, ` fo:font-family="%s"`, xmlText(f.font))
	}
	if f.size > 0 {
		fmt.Fprintf(&b, ` fo:font-size="%gpt"`, f.size)
	}
	b.WriteString("/>")
	return b.String()
}

func odtParaProps(f format) string {
	var b strings.Builder
	b.WriteString("<style:paragraph-properties")
	if f.lineHeight > 0 {
		fmt.Fprintf(&b, ` fo:line-height="%d%%"`, int(math.Round(f.lineHeight*100)))
	}
	if f.indent > 0 {
		fmt.Fprintf(&b, ` fo:margin-left="%gin"`, float64(f.indent)*0.375)
	}
	if f.align != "" {
		a := f.align
		if a == "left" {
			a = "start"
		} else if a == "right" {
			a = "end"
		}
		fmt.Fprintf(&b, ` fo:text-align="%s"`, a)
	}
	b.WriteString("/>")
	return b.String()
}

func odtPart(tag, text, al, title string) string {
	var b strings.Builder
	fmt.Fprintf(&b, `<style:%s><text:p text:style-name="OS_%s_%s">`, tag, tag, align(al))
	tokens(text, title, func(kind, t string) {
		switch kind {
		case "text":
			b.WriteString(xmlText(t))
		case "page":
			b.WriteString(`<text:page-number text:select-page="current">1</text:page-number>`)
		case "pages":
			b.WriteString(`<text:page-count>1</text:page-count>`)
		}
	})
	fmt.Fprintf(&b, `</text:p></style:%s>`, tag)
	return b.String()
}

func finishOdt(in, out []byte) ([]byte, error) {
	p, title := pageOf(in)
	// Which styles the text uses, and as what, is known from content.xml,
	// which comes before styles.xml in pandoc's files; read it first.
	zr, err := zip.NewReader(bytes.NewReader(out), int64(len(out)))
	if err != nil {
		return nil, err
	}
	var content []byte
	for _, f := range zr.File {
		if f.Name == "content.xml" {
			rc, err := f.Open()
			if err != nil {
				return nil, err
			}
			content, _ = io.ReadAll(rc)
			rc.Close()
		}
	}
	used := map[string]string{}
	for _, m := range odtUsed.FindAllSubmatch(content, -1) {
		used[string(m[2])] = string(m[1])
	}
	return rewriteZip(out, func(name string, data []byte) ([]byte, map[string][]byte) {
		switch name {
		case "content.xml":
			var auto strings.Builder
			n := 0
			data = odtHeading.ReplaceAllFunc(data, func(m []byte) []byte {
				sub := odtHeading.FindSubmatch(m)
				f, _ := parseStyle(string(sub[4]))
				n++
				fmt.Fprintf(&auto, `<style:style style:name="OSH%d" style:family="paragraph" style:parent-style-name="%s">%s</style:style>`, n, sub[1], odtParaProps(f))
				return []byte(fmt.Sprintf(`<text:h text:style-name="OSH%d"%s>%s`, n, sub[2], sub[3]))
			})
			if auto.Len() > 0 {
				if bytes.Contains(data, []byte("<office:automatic-styles/>")) {
					data = bytes.Replace(data, []byte("<office:automatic-styles/>"), []byte("<office:automatic-styles>"+auto.String()+"</office:automatic-styles>"), 1)
				} else {
					data = bytes.Replace(data, []byte("</office:automatic-styles>"), []byte(auto.String()+"</office:automatic-styles>"), 1)
				}
			}
			return data, nil
		case "styles.xml":
			var defs strings.Builder
			for style, el := range used {
				f, _ := parseStyle(style)
				switch {
				case style == "OS_PageBreak":
					fmt.Fprintf(&defs, `<style:style style:name="%s" style:family="paragraph"><style:paragraph-properties fo:break-before="page" fo:margin-top="0in" fo:margin-bottom="0in" fo:line-height="1pt"/><style:text-properties fo:font-size="1pt"/></style:style>`, style)
				case el == "span":
					fmt.Fprintf(&defs, `<style:style style:name="%s" style:family="text">%s</style:style>`, style, odtTextProps(f))
				default:
					fmt.Fprintf(&defs, `<style:style style:name="%s" style:family="paragraph" style:parent-style-name="Text_20_body">%s</style:style>`, style, odtParaProps(f))
				}
			}
			for _, part := range []string{"header", "footer"} {
				for _, a := range []string{"left", "center", "right"} {
					odtA := map[string]string{"left": "start", "center": "center", "right": "end"}[a]
					fmt.Fprintf(&defs, `<style:style style:name="OS_%s_%s" style:family="paragraph"><style:paragraph-properties fo:text-align="%s"/><style:text-properties fo:font-size="9pt" fo:color="#555555"/></style:style>`, part, a, odtA)
				}
			}
			data = bytes.Replace(data, []byte("</office:styles>"), []byte(defs.String()+"</office:styles>"), 1)
			w, h := p.paper()
			t, r, bo, l := p.margins()
			orient := "portrait"
			if p.Orientation == "landscape" {
				orient = "landscape"
			}
			data = odtLayoutProp.ReplaceAllFunc(data, func(m []byte) []byte {
				end := "/>"
				if !bytes.HasSuffix(m, []byte("/>")) {
					end = ">"
				}
				return []byte(fmt.Sprintf(`<style:page-layout-properties fo:page-width="%gmm" fo:page-height="%gmm" style:print-orientation="%s" fo:margin-top="%gmm" fo:margin-right="%gmm" fo:margin-bottom="%gmm" fo:margin-left="%gmm" style:num-format="1" style:writing-mode="lr-tb" style:footnote-max-height="0in"%s`, w, h, orient, t, r, bo, l, end))
			})
			if p.Header != "" || p.Footer != "" {
				var hf strings.Builder
				if p.Header != "" {
					hf.WriteString(odtPart("header", p.Header, p.HeaderAlign, title))
				}
				if p.Footer != "" {
					hf.WriteString(odtPart("footer", p.Footer, p.FooterAlign, title))
				}
				data = odtMaster.ReplaceAllFunc(data, func(m []byte) []byte {
					sub := odtMaster.FindSubmatch(m)
					return []byte(fmt.Sprintf(`<style:master-page style:name="Standard"%s>%s%s</style:master-page>`, sub[1], hf.String(), sub[3]))
				})
				spacing := `<style:header-style><style:header-footer-properties fo:min-height="0in" fo:margin-bottom="0.15in"/></style:header-style><style:footer-style><style:header-footer-properties fo:min-height="0in" fo:margin-top="0.15in"/></style:footer-style>`
				data = bytes.Replace(data, []byte("</style:page-layout>"), []byte(spacing+"</style:page-layout>"), 1)
			}
			return data, nil
		}
		return data, nil
	}, nil)
}

func finishExport(to string, in, out []byte) ([]byte, error) {
	if to == "docx" {
		return finishDocx(in, out)
	}
	return finishOdt(in, out)
}

// rewriteZip copies a zip file, letting edit change each part and add new
// ones, and then finish change parts that depend on what was added. Order and
// compression are kept, which OpenDocument needs (its mimetype comes first,
// stored).
func rewriteZip(in []byte, edit func(name string, data []byte) ([]byte, map[string][]byte), finish func(added map[string]bool, name string, data []byte) []byte) ([]byte, error) {
	zr, err := zip.NewReader(bytes.NewReader(in), int64(len(in)))
	if err != nil {
		return nil, err
	}
	type part struct {
		hdr  zip.FileHeader
		data []byte
	}
	var parts []part
	added := map[string][]byte{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		data, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			return nil, err
		}
		data, extra := edit(f.Name, data)
		for k, v := range extra {
			added[k] = v
		}
		parts = append(parts, part{zip.FileHeader{Name: f.Name, Method: f.Method, Modified: f.Modified}, data})
	}
	names := map[string]bool{}
	for k := range added {
		names[k] = true
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	write := func(hdr zip.FileHeader, data []byte) error {
		w, err := zw.CreateHeader(&hdr)
		if err != nil {
			return err
		}
		_, err = w.Write(data)
		return err
	}
	for _, p := range parts {
		data := p.data
		if finish != nil {
			data = finish(names, p.hdr.Name, data)
		}
		if err := write(p.hdr, data); err != nil {
			return nil, err
		}
	}
	for _, name := range []string{"word/header-os.xml", "word/footer-os.xml"} {
		if data, found := added[name]; found {
			if err := write(zip.FileHeader{Name: name, Method: zip.Deflate}, data); err != nil {
				return nil, err
			}
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// --- reading a file's page setup -------------------------------------------------------

func zipPart(zr *zip.Reader, name string) []byte {
	for _, f := range zr.File {
		if f.Name == name {
			rc, err := f.Open()
			if err != nil {
				return nil
			}
			defer rc.Close()
			data, _ := io.ReadAll(io.LimitReader(rc, 20<<20))
			return data
		}
	}
	return nil
}

func ptr(v float64) *float64 {
	v = math.Round(v*10) / 10
	return &v
}

// paperFor names the paper a size is, in either orientation.
func paperFor(w, h float64) (string, string) {
	orient := "portrait"
	if w > h {
		w, h = h, w
		orient = "landscape"
	}
	for name, sz := range papers {
		if math.Abs(sz[0]-w) < 3 && math.Abs(sz[1]-h) < 3 {
			return name, orient
		}
	}
	return "", orient
}

var (
	attrRe     = func(name string) *regexp.Regexp { return regexp.MustCompile(name + `="([^"]*)"`) }
	wW, wH     = attrRe(`w:w`), attrRe(`w:h`)
	wTop, wBot = attrRe(`w:top`), attrRe(`w:bottom`)
	wLeft      = attrRe(`w:left`)
	wRight     = attrRe(`w:right`)
	wOrient    = attrRe(`w:orient`)
	pgSzRe     = regexp.MustCompile(`<w:pgSz [^>]*>`)
	pgMarRe    = regexp.MustCompile(`<w:pgMar [^>]*>`)
	lastSect   = regexp.MustCompile(`(?s).*(<w:sectPr[ >].*?</w:sectPr>)`)
	hdrRefRe   = regexp.MustCompile(`<w:(header|footer)Reference [^>]*w:type="default"[^>]*>`)
	ridRe      = attrRe(`r:id`)
)

func attrNum(re *regexp.Regexp, s []byte) (float64, bool) {
	m := re.FindSubmatch(s)
	if m == nil {
		return 0, false
	}
	v, err := strconv.ParseFloat(string(m[1]), 64)
	return v, err == nil
}

func readPageSetup(from string, in []byte) *pageSetup {
	zr, err := zip.NewReader(bytes.NewReader(in), int64(len(in)))
	if err != nil {
		return nil
	}
	if from == "odt" {
		return odtPageSetup(zr)
	}
	doc := zipPart(zr, "word/document.xml")
	m := lastSect.FindSubmatch(doc)
	if m == nil {
		return nil
	}
	sect := m[1]
	p := &pageSetup{}
	if sz := pgSzRe.Find(sect); sz != nil {
		w, ok1 := attrNum(wW, sz)
		h, ok2 := attrNum(wH, sz)
		if ok1 && ok2 {
			p.Size, p.Orientation = paperFor(w/1440*25.4, h/1440*25.4)
		}
	}
	if mar := pgMarRe.Find(sect); mar != nil {
		for _, x := range []struct {
			re  *regexp.Regexp
			dst **float64
		}{{wTop, &p.Top}, {wRight, &p.Right}, {wBot, &p.Bottom}, {wLeft, &p.Left}} {
			if v, ok := attrNum(x.re, mar); ok && v >= 0 {
				*x.dst = ptr(v / 1440 * 25.4)
			}
		}
	}
	rels := zipPart(zr, "word/_rels/document.xml.rels")
	for _, ref := range hdrRefRe.FindAll(sect, -1) {
		id := ridRe.FindSubmatch(ref)
		if id == nil {
			continue
		}
		target := regexp.MustCompile(`Id="` + regexp.QuoteMeta(string(id[1])) + `"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="` + regexp.QuoteMeta(string(id[1])) + `"`).FindSubmatch(rels)
		if target == nil {
			continue
		}
		t := string(target[1]) + string(target[2])
		text, al := docxPartText(zipPart(zr, "word/"+strings.TrimPrefix(t, "/word/")))
		if bytes.Contains(ref, []byte("headerReference")) {
			p.Header, p.HeaderAlign = text, al
		} else {
			p.Footer, p.FooterAlign = text, al
		}
	}
	return p
}

// docxPartText reads a header or footer as text, with page fields as
// {page} and {pages}.
func docxPartText(data []byte) (string, string) {
	if data == nil {
		return "", ""
	}
	dec := xml.NewDecoder(bytes.NewReader(data))
	var b strings.Builder
	al := ""
	inField, inText := false, false
	paras := 0
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "p":
				if paras++; paras > 1 {
					b.WriteString(" ")
				}
			case "jc":
				for _, a := range t.Attr {
					if a.Name.Local == "val" && al == "" {
						al = map[string]string{"left": "left", "start": "left", "center": "center", "right": "right", "end": "right"}[a.Value]
					}
				}
			case "fldSimple":
				for _, a := range t.Attr {
					if a.Name.Local == "instr" {
						b.WriteString(fieldToken(a.Value))
					}
				}
				dec.Skip()
			case "fldChar":
				for _, a := range t.Attr {
					if a.Name.Local == "fldCharType" {
						switch a.Value {
						case "begin":
							inField = true
						case "end":
							inField = false
						}
					}
				}
			case "instrText":
				var s string
				dec.DecodeElement(&s, &t)
				b.WriteString(fieldToken(s))
			case "t":
				inText = !inField
			}
		case xml.EndElement:
			if t.Name.Local == "t" {
				inText = false
			}
		case xml.CharData:
			if inText {
				b.Write(t)
			}
		}
	}
	return strings.TrimSpace(b.String()), al
}

func fieldToken(instr string) string {
	switch strings.ToUpper(strings.Fields(instr + " x")[0]) {
	case "PAGE":
		return "{page}"
	case "NUMPAGES":
		return "{pages}"
	}
	return ""
}

var (
	odtProps   = regexp.MustCompile(`<style:page-layout style:name="([^"]+)"[^>]*>\s*<style:page-layout-properties [^>]*>`)
	odtMasterL = regexp.MustCompile(`<style:master-page style:name="Standard"[^>]*style:page-layout-name="([^"]+)"`)
	odtLen     = func(attr string) *regexp.Regexp { return regexp.MustCompile(attr + `="([0-9.]+)(mm|cm|in|pt)"`) }
	foW, foH   = odtLen(`fo:page-width`), odtLen(`fo:page-height`)
	foTop      = odtLen(`fo:margin-top`)
	foRight    = odtLen(`fo:margin-right`)
	foBottom   = odtLen(`fo:margin-bottom`)
	foLeft     = odtLen(`fo:margin-left`)
	odtHF      = regexp.MustCompile(`(?s)<style:(header|footer)>(.*?)</style:(?:header|footer)>`)
)

func mmOf(re *regexp.Regexp, s []byte) (float64, bool) {
	m := re.FindSubmatch(s)
	if m == nil {
		return 0, false
	}
	v, _ := strconv.ParseFloat(string(m[1]), 64)
	return v * map[string]float64{"mm": 1, "cm": 10, "in": 25.4, "pt": 25.4 / 72}[string(m[2])], true
}

func odtPageSetup(zr *zip.Reader) *pageSetup {
	styles := zipPart(zr, "styles.xml")
	layout := ""
	if m := odtMasterL.FindSubmatch(styles); m != nil {
		layout = string(m[1])
	}
	var props []byte
	for _, m := range odtProps.FindAllSubmatch(styles, -1) {
		if layout == "" || string(m[1]) == layout {
			props = m[0]
			break
		}
	}
	p := &pageSetup{}
	if props != nil {
		w, ok1 := mmOf(foW, props)
		h, ok2 := mmOf(foH, props)
		if ok1 && ok2 {
			p.Size, p.Orientation = paperFor(w, h)
		}
		for _, x := range []struct {
			re  *regexp.Regexp
			dst **float64
		}{{foTop, &p.Top}, {foRight, &p.Right}, {foBottom, &p.Bottom}, {foLeft, &p.Left}} {
			if v, ok := mmOf(x.re, props); ok {
				*x.dst = ptr(v)
			}
		}
	}
	if m := odtMaster.FindSubmatch(styles); m != nil {
		for _, hf := range odtHF.FindAllSubmatch(m[3], -1) {
			text := odtPartText(hf[2])
			if string(hf[1]) == "header" {
				p.Header = text
			} else {
				p.Footer = text
			}
		}
	}
	return p
}

func odtPartText(data []byte) string {
	dec := xml.NewDecoder(bytes.NewReader([]byte("<x>" + string(data) + "</x>")))
	dec.Strict = false
	var b strings.Builder
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "page-number":
				b.WriteString("{page}")
				dec.Skip()
			case "page-count":
				b.WriteString("{pages}")
				dec.Skip()
			}
		case xml.CharData:
			b.Write(t)
		}
	}
	return strings.TrimSpace(b.String())
}
