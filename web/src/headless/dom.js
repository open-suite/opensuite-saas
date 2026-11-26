// The browser objects the app's own code expects: Tiptap and ProseMirror
// parse and write HTML through a document, and PowerPoint import reads XML
// with DOMParser. Imported first, so they exist before any other module runs.
// Nothing here loads or runs anything a document refers to (scripts, styles,
// pictures, frames).
//
// HTML goes through happy-dom, which Tiptap's parser works with (element
// styles included). XML goes through linkedom: happy-dom 21 keeps only one of
// two attributes with the same local name, and PowerPoint writes
// <p:sldId id="256" r:id="rId2"/>, so r:id would be lost.
import { Window } from 'happy-dom'
import { DOMParser as XMLDOMParser } from 'linkedom'

const window = new Window({ settings: { disableJavaScriptFileLoading: true, navigation: { disableMainFrameNavigation: true, disableChildFrameNavigation: true, disableChildPageNavigation: true } } })
const HTMLDOMParser = window.DOMParser

class DOMParser {
  parseFromString(text, type) {
    return type === 'text/html' ? new HTMLDOMParser().parseFromString(text, type) : new XMLDOMParser().parseFromString(text, type)
  }
}

window.DOMParser = DOMParser
globalThis.window = window
globalThis.document = window.document
globalThis.DOMParser = DOMParser
