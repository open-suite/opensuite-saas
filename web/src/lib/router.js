import { signal, computed } from '@preact/signals'

export const path = signal(location.pathname)
export const query = signal(location.search)

export const parts = computed(() => path.value.split('/').filter(Boolean))

export function navigate(to, { replace = false } = {}) {
  const url = new URL(to, location.origin)
  if (url.pathname === path.value && url.search === query.value) return
  history[replace ? 'replaceState' : 'pushState'](null, '', url.pathname + url.search)
  path.value = url.pathname
  query.value = url.search
}

addEventListener('popstate', () => {
  path.value = location.pathname
  query.value = location.search
})

// In-app links are plain <a href>; this turns them into instant navigations.
addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  const a = e.target.closest?.('a[href]')
  if (!a || a.target || a.hasAttribute('download')) return
  const url = new URL(a.href, location.origin)
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return
  e.preventDefault()
  navigate(url.pathname + url.search)
})
