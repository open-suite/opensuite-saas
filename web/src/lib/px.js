// Inline styles in this codebase write lengths as plain numbers
// (style={{ width: 240 }}). Preact 11 passes numbers through untouched, which
// CSS ignores, so this hook gives them the px unit, once, for every element.
import { options } from 'preact'

const unitless = /^(fontWeight|lineHeight|opacity|order|zIndex|zoom|flex|flexGrow|flexShrink|gridRow|gridColumn|gridArea|columnCount|tabSize|scale|aspectRatio)$/

const next = options.vnode
options.vnode = (vnode) => {
  const style = typeof vnode.type === 'string' && vnode.props.style
  if (style && typeof style === 'object') {
    let fixed
    for (const k in style) {
      const v = style[k]
      if (typeof v === 'number' && v !== 0 && !unitless.test(k)) (fixed ??= { ...style })[k] = v + 'px'
    }
    if (fixed) vnode.props.style = fixed
  }
  next?.(vnode)
}
