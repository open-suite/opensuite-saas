// The page behind a public link: a file or a folder someone chose to open to
// anyone who has the address. No account, nothing else of the suite.
import { useEffect, useState } from 'preact/hooks'
import { Download, ChevronRight, Link2Off, X } from 'lucide-preact'
import './files.css'
import { get } from '../lib/api.js'
import { bytes, when } from '../lib/util.js'
import { Empty, Logo } from '../ui.jsx'
import { ItemIcon, PreviewBody } from './files.jsx'

const asItem = (n) => ({ ...n, type: n.kind })

export function PublicLink({ token, at }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    setError('')
    get(`/api/public/${encodeURIComponent(token)}${at ? '?at=' + encodeURIComponent(at) : ''}`, { quiet: true }).then(setData, (e) => setError(e.message))
  }, [token, at])
  useEffect(() => {
    if (data) document.title = data.at.name + ' · Open Suite'
  }, [data])
  const base = '/f/' + token
  const content = (id, dl) => `/api/public/${token}/content/${id}${dl ? '?dl=1' : ''}`
  const here = data?.at
  const shown = here && (here.id === at || (!at && here.id === data.root.id)) ? here : null
  return (
    <div class="public">
      <header class="public-bar">
        <a class="public-brand" href="/" aria-label="Open Suite"><Logo size={26} /><span class="wide-only">Open Suite</span></a>
        {shown && (
          <>
            <ItemIcon item={asItem(shown)} />
            <div class="grow" style={{ minWidth: 0 }}>
              <div class="ellipsis name">{shown.name}</div>
              <div class="sub ellipsis">Shared by {data.org}{shown.kind === 'file' ? ' · ' + bytes(shown.size) : ''}</div>
            </div>
            {shown.kind === 'file' && shown.id !== data.root.id && <a class="icon-btn" href={base + (data.parent ? '/' + data.parent : '')} aria-label="Back to the folder" title="Back to the folder"><X size={18} /></a>}
            {shown.kind === 'file' && <a class="btn btn-primary" href={content(shown.id, true)} download={shown.name}><Download size={16} /> Download</a>}
          </>
        )}
      </header>
      <div class="public-body">
        {error ? (
          <Empty icon={Link2Off} title="This link isn't available" text={error} />
        ) : !shown ? null : shown.kind === 'file' ? (
          <PreviewBody key={shown.id} item={asItem(shown)} src={content(shown.id)} download={content(shown.id, true)} />
        ) : (
          <div class="page-inner">
            {data.path.length > 0 && (
              <div class="page-head">
                <h1 class="crumbs">
                  <a href={base}>{data.root.name}</a>
                  {data.path.map((c, i) => (
                    <>
                      <ChevronRight size={16} class="sep" />
                      {i === data.path.length - 1 ? <span class="ellipsis">{c.name}</span> : <a class="ellipsis" href={base + '/' + c.id}>{c.name}</a>}
                    </>
                  ))}
                </h1>
              </div>
            )}
            <div class="card">
              {data.items.length === 0 && <Empty title="This folder is empty" />}
              {data.items.map((n) => (
                <a class="list-row" key={n.id} href={base + '/' + n.id}>
                  <ItemIcon item={asItem(n)} />
                  <span class="grow ellipsis" style={{ fontWeight: 550 }}>{n.name}</span>
                  <span class="muted">{n.kind === 'file' ? bytes(n.size) : ''}</span>
                  <span class="muted" style={{ width: 90, textAlign: 'right' }}>{when(n.updated * 1000)}</span>
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
