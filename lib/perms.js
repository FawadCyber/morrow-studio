// Every permission a person can be given, grouped by area, plus ready-made sets.
// The owner always has everything. Everyone else has exactly the boxes ticked for them.
const AREAS = [
  { key: 'overview', label: 'Overview', actions: [['view', 'View']] },
  { key: 'jackets', label: 'Jackets', actions: [['view', 'View'], ['review', 'Approve / reject'], ['edit', 'Notes, cost & price watch'], ['delete', 'Delete'], ['download', 'Download photos & CSV']] },
  { key: 'hunts', label: 'Hunts', actions: [['view', 'View'], ['run', 'Run hunts']] },
  { key: 'boards', label: 'Boards', actions: [['view', 'View'], ['edit', 'Create / edit'], ['share', 'Share links']] },
  { key: 'comments', label: 'Comments', actions: [['view', 'View'], ['write', 'Write']] },
  { key: 'insights', label: 'Insights', actions: [['view', 'View']] },
  { key: 'shopify', label: 'Shopify', actions: [['push', 'Send drafts to Shopify']] },
  { key: 'settings', label: 'Settings', actions: [['view', 'View'], ['edit', 'Change']] },
  { key: 'team', label: 'Team', actions: [['view', 'View people'], ['manage', 'Add / edit / remove people']] },
  { key: 'activity', label: 'Activity log', actions: [['view', 'View']] },
  { key: 'backups', label: 'Backups', actions: [['manage', 'Create / download / restore']] },
  { key: 'health', label: 'Health', actions: [['view', 'View']] }
];
const ALL = AREAS.flatMap(a => a.actions.map(([k]) => `${a.key}.${k}`));
const VIEWS = ALL.filter(p => p.endsWith('.view'));

const PRESETS = {
  owner: ALL,
  reviewer: [...VIEWS.filter(p => !['settings.view', 'team.view'].includes(p)), 'jackets.review', 'jackets.edit', 'jackets.download', 'hunts.run', 'boards.edit', 'boards.share', 'comments.write'],
  viewer: [...VIEWS.filter(p => !['settings.view', 'team.view', 'activity.view', 'health.view'].includes(p)), 'comments.write']
};
const ROLES = { owner: 'Owner', reviewer: 'Reviewer', viewer: 'Viewer', custom: 'Custom' };

const clean = list => [...new Set((Array.isArray(list) ? list : []).filter(p => ALL.includes(p)))];
// What a person can actually do
function effective(u) {
  if (!u) return [];
  if (u.role === 'owner') return ALL.slice();
  if (Array.isArray(u.perms)) return clean(u.perms);
  return (PRESETS[u.role] || PRESETS.viewer).slice();
}
const has = (u, p) => !!u && (u.role === 'owner' || effective(u).includes(p));

module.exports = { AREAS, ALL, PRESETS, ROLES, clean, effective, has };
