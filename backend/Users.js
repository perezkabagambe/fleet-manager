/** Admin-only user management. */

function summarizeUser_(u) {
  return {
    id: u.id, name: u.name, email: u.email, status: u.status, role: u.role,
    requestedAt: u.requested_at, approvedAt: u.approved_at, lastLogin: u.last_login,
  };
}

function listUsers_() {
  const order = { Pending: 0, Approved: 1, Revoked: 2, Rejected: 3 };
  const users = Db.all('Users')
    .filter(function (u) { return !isTrue_(u.deleted); })
    .map(summarizeUser_)
    .sort(function (a, b) {
      return (order[a.status] - order[b.status]) || a.name.localeCompare(b.name);
    });
  return { users: users };
}

/** Any signed-in user can change their own display name. */
function updateMyName_(p, ctx) {
  const name = cleanStr_(p.name, 80);
  if (!name) fail_('invalid_name');
  const row = findUserById_(ctx.user.id);
  if (!row) fail_('not_found');
  patchUser_(row, { name: name }, ctx.user);
  audit_(ctx.user, 'name_changed', 'User', row.id, 'Display name changed', { name: row.name }, { name: name });
  return { user: publicUser_(Object.assign({}, row, { name: name })) };
}

const STATUS_TRANSITIONS = {
  Pending: ['Approved', 'Rejected'],
  Approved: ['Revoked'],
  Rejected: ['Approved'],
  Revoked: ['Approved'],
};

function setUserStatus_(p, ctx) {
  const target = findUserById_(cleanStr_(p.userId, 64));
  if (!target) fail_('not_found');
  const status = cleanStr_(p.status, 20);
  if ((STATUS_TRANSITIONS[target.status] || []).indexOf(status) === -1) fail_('invalid_transition');

  if (status === 'Revoked') {
    if (target.id === ctx.user.id) fail_('cannot_revoke_self');
    if (target.role === 'admin' && activeAdmins_().length <= 1) fail_('last_admin');
  }

  const before = { status: target.status };
  const patch = { status: status };
  if (status === 'Approved') {
    patch.approved_by = ctx.user.id;
    patch.approved_at = nowIso_();
  }
  patchUser_(target, patch, ctx.user);
  if (status === 'Revoked') revokeSessions_(target.id);
  if (status === 'Approved') sendApprovedEmail_(target);

  audit_(ctx.user, 'user_' + status.toLowerCase(), 'User', target.id,
    target.name + ' (' + target.email + '): ' + before.status + ' to ' + status, before, { status: status });
  return { user: summarizeUser_(Object.assign({}, target, patch)) };
}

function setUserRole_(p, ctx) {
  const target = findUserById_(cleanStr_(p.userId, 64));
  if (!target) fail_('not_found');
  const role = cleanStr_(p.role, 10);
  if (role !== 'user' && role !== 'admin') fail_('invalid_role');
  if (target.status !== 'Approved') fail_('invalid_transition');
  if (target.role === role) return { user: summarizeUser_(target) };
  if (role === 'user' && target.role === 'admin' && activeAdmins_().length <= 1) fail_('last_admin');

  const before = { role: target.role };
  patchUser_(target, { role: role }, ctx.user);
  audit_(ctx.user, 'role_changed', 'User', target.id,
    target.name + ' (' + target.email + '): ' + before.role + ' to ' + role, before, { role: role });
  return { user: summarizeUser_(Object.assign({}, target, { role: role })) };
}
