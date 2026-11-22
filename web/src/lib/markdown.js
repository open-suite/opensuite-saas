// A small Markdown reader for previews. Everything is escaped first and only
// a fixed set of tags is produced, so the result carries no markup from the
// file itself. It is shown inside a script-less frame all the same.
import { escapeHtml } from './util.js'

function inline(s) {
  const code = []
  s = escapeHtml(s).replace(/`([^`]+)`/g, (_, c) => `\u0000${code.push(c) - 1}\u0000`)
  s = s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\s][^_]*)_(?=$|[\s).,;:!?])/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${code[i]}</code>`)
}

export function markdownToHtml(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let para = []
  let list = null
  const flush = () => {
    if (para.length) out.push('<p>' + inline(para.join(' ')) + '</p>')
    para = []
    if (list) out.push(`</${list}>`)
    list = null
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = line.match(/^\s*(```|~~~)/)
    if (fence) {
      flush()
      const body = []
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++) body.push(lines[i])
      out.push('<pre><code>' + escapeHtml(body.join('\n')) + '</code></pre>')
      continue
    }
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*$/)
    const item = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/)
    if (h) {
      flush()
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`)
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush()
      out.push('<hr>')
    } else if (item) {
      const kind = /\d/.test(item[1]) ? 'ol' : 'ul'
      if (para.length || (list && list !== kind)) flush()
      if (!list) out.push(`<${(list = kind)}>`)
      const box = item[2].match(/^\[([ xX])\]\s+(.*)$/)
      out.push('<li>' + (box ? (box[1] === ' ' ? '☐ ' : '☑ ') + inline(box[2]) : inline(item[2])) + '</li>')
    } else if (/^\s*>/.test(line)) {
      flush()
      const body = []
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) body.push(lines[i].replace(/^\s*>\s?/, ''))
      i--
      out.push('<blockquote>' + markdownToHtml(body.join('\n')) + '</blockquote>')
    } else if (!line.trim()) flush()
    else {
      if (list) flush()
      para.push(line.trim())
    }
  }
  flush()
  return out.join('\n')
}
