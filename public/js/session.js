// Who is signed in (shared by every page), and what they're allowed to do.
let current = { id: 0, username: 'local', name: 'You', role: 'owner', perms: [] };
export const me = () => current;
export const setMe = u => { if (u) { current = u; applyPerms(); } };
export const has = p => current.role === 'owner' || (current.perms || []).includes(p);
export const canEdit = () => has('jackets.review');
export const isOwner = () => current.role === 'owner';

// Hide every element marked data-perm="area.action" the person doesn't have
function applyPerms() {
  let st = document.getElementById('permStyle');
  if (!st) { st = document.createElement('style'); st.id = 'permStyle'; document.head.appendChild(st); }
  const seen = ['overview.view', 'jackets.view', 'jackets.review', 'jackets.edit', 'jackets.delete', 'jackets.download', 'hunts.view', 'hunts.run', 'boards.view', 'boards.edit', 'boards.share',
    'comments.view', 'comments.write', 'insights.view', 'shopify.push', 'settings.view', 'settings.edit', 'team.view', 'team.manage', 'activity.view', 'backups.manage', 'health.view'];
  st.textContent = seen.filter(p => !has(p)).map(p => `[data-perm="${p}"]`).join(',') + (seen.some(p => !has(p)) ? '{display:none!important}' : '');
}
