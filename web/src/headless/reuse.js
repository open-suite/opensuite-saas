// Writing new content into a shared document as an edit, not a rewrite.
// updateYFragment (y-tiptap) brings the shared document in line with a
// ProseMirror node and leaves alone every part that is the very node it read
// from the document. So new content is first rebuilt out of the current one:
// wherever the two agree, the current node is used, and whatever hangs on it
// survives untouched, such as a comment's anchor or a colleague typing there
// at that moment.
import { Fragment } from '@tiptap/pm/model'

// reuse returns the children of `next`, taking the child of `cur` in its
// place wherever `key` says the two are the same. A block that changed is
// paired with the one it most likely replaces (the next one in `cur` that
// nothing else wants): a list or table of the same kind is rebuilt the same
// way inside, and a textblock is handed to `edited(old, block)`, which may
// carry things over from the old one.
export function reuse(cur, next, key, edited = (old, block) => block) {
  const keys = []
  cur.forEach((c) => keys.push(key(c)))
  const wanted = new Set()
  next.forEach((n) => wanted.add(key(n)))
  const out = []
  let j = 0
  next.forEach((n) => {
    const at = keys.indexOf(key(n), j)
    if (at >= 0) {
      out.push(cur.child(at))
      j = at + 1
      return
    }
    const old = j < keys.length && !wanted.has(keys[j]) ? cur.child(j++) : null
    if (!old || old.type !== n.type || n.isLeaf) out.push(n)
    else if (n.isTextblock) out.push(edited(old, n))
    else out.push(n.type.create(n.attrs, reuse(old, n, key, edited), n.marks))
  })
  return Fragment.fromArray(out)
}

// plainKey treats nodes as the same when they have the same structure and
// words, whatever their formatting: for writes made from plain text.
export const plainKey = (n) => (n.isText ? n.text : n.type.name + '(' + n.content.content.map(plainKey).join('') + ')')
