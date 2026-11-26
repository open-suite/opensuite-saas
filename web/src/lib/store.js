// One store for the whole suite. Everything a view needs to paint is already
// here when it mounts: inlined by the server on a cold visit, restored from
// the device on a return visit, then refreshed in the background.
import { signal, computed } from '@preact/signals'

const KEY = 'os:boot'

function initial() {
  if (window.__BOOT__) {
    persist(window.__BOOT__)
    return window.__BOOT__
  }
  try {
    return JSON.parse(localStorage.getItem(KEY)) || null
  } catch {
    return null
  }
}

function persist(b) {
  try {
    if (b?.user) localStorage.setItem(KEY, JSON.stringify(b))
    else localStorage.removeItem(KEY)
  } catch {}
}

export const boot = signal(initial())
// True once the server has confirmed who we are in this page load.
export const confirmed = signal(!!window.__BOOT__)

export const user = computed(() => boot.value?.user || null)
export const org = computed(() => boot.value?.org || null)
export const people = computed(() => boot.value?.people || [])
export const docs = computed(() => boot.value?.docs || [])
export const meetings = computed(() => boot.value?.meetings || [])
export const isAdmin = computed(() => ['owner', 'admin'].includes(user.value?.role))

export const peopleById = computed(() => Object.fromEntries(people.value.map((p) => [p.id, p])))
export const peopleByMx = computed(() => Object.fromEntries(people.value.map((p) => [p.mx, p])))
export const peopleByEmail = computed(() => Object.fromEntries(people.value.map((p) => [p.email.toLowerCase(), p])))

// A colleague's profile picture, by id, address or chat id; null for none.
// The version in the address lets the browser keep a picture for good.
export function photoFor(key) {
  if (!key) return null
  const p = peopleById.value[key] || peopleByEmail.value[String(key).toLowerCase()] || peopleByMx.value[key]
  return p?.photo ? `/api/v1/people/${p.id}/photo?v=${p.photo}` : null
}

export function setBoot(b) {
  boot.value = b
  confirmed.value = true
  persist(b)
}

export function patchBoot(patch) {
  if (!boot.value) return
  boot.value = { ...boot.value, ...patch }
  persist(boot.value)
}

export function upsertDoc(doc) {
  const rest = docs.value.filter((d) => d.id !== doc.id)
  patchBoot({ docs: [doc, ...rest].sort((a, b) => b.updated - a.updated) })
}

export function removeDoc(id) {
  patchBoot({ docs: docs.value.filter((d) => d.id !== id) })
}

// Badges on the navigation rail, fed by the mail and chat engines.
export const unread = signal({ mail: 0, chat: 0 })

// Transient messages.
export const toasts = signal([])
let toastId = 0
export function toast(text, kind = 'info') {
  const id = ++toastId
  toasts.value = [...toasts.value, { id, text, kind }]
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }, kind === 'error' ? 6000 : 3200)
}
