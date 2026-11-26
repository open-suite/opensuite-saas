// Groups: shared mailboxes with an address of their own (sales@, support@).
// Everyone in the organisation sees them in the boot object; changes go
// through the public API, which applies the same rules to the app as to
// programs, and the boot object is refreshed after each.
import { computed } from '@preact/signals'
import { boot, isAdmin } from './store.js'
import { api, refreshBoot } from './api.js'

export const groups = computed(() => boot.value?.groups || [])

export const roleName = { viewer: 'Viewer', user: 'User', admin: 'Group admin' }
export const roleHelp = {
  viewer: 'Reads the group’s mail',
  user: 'Reads, and sends and replies as the group',
  admin: 'Also manages viewers and users',
}

export const postingName = (orgName) => ({
  anyone: 'Anyone, including people outside ' + orgName,
  organisation: 'Only people in ' + orgName,
  members: 'Only the group’s members',
})

// mayManage: the organisation's administrators manage every group, group
// admins their own.
export const mayManage = (g) => isAdmin.value || g.role === 'admin'

// mayAppoint: only the organisation's administrators make or unmake group
// admins.
export const mayAppoint = () => isAdmin.value

async function change(method, path, body) {
  const out = await api(method, '/api/v1/groups' + path, body)
  await refreshBoot()
  return out
}

export const createGroup = (form) => change('POST', '', form)
export const updateGroup = (g, patch) => change('PATCH', '/' + g.id, patch)
export const deleteGroup = (g) => change('DELETE', '/' + g.id)
export const setMember = (g, id, role) => change('PUT', `/${g.id}/members/${id}`, { role })
export const removeMember = (g, id) => change('DELETE', `/${g.id}/members/${id}`)
