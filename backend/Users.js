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

/**
 * Admin invites someone by email. A new address gets an approved account straight away; a pending, rejected or
 * revoked one is approved; an approved one is simply sent a fresh link. The emailed link is single use, valid for
 * INVITE_DAYS, and signs the invitee in without any further step.
 */
function inviteUser_(p, ctx) {
  const email = normEmail_(p.email);
  if (!email) fail_('invalid_email');
  if (!rateLimit_('invite:' + hash_(email), 5, 3600)) fail_('try_later');
  if (!dailyCap_('invites', 50)) fail_('try_later');

  let user = findUserByEmail_(email);
  let created = false;
  const now = nowIso_();
  if (!user) {
    const name = cleanStr_(p.name, 80);
    if (!name) fail_('invalid_name');
    user = {
      id: Utilities.getUuid(), created_at: now, created_by: ctx.user.id, updated_at: now, updated_by: ctx.user.id, version: 1,
      deleted: false, name: name, email: email, status: 'Approved', role: 'user', requested_at: now,
      approved_by: ctx.user.id, approved_at: now,
    };
    Db.insert('Users', user);
    created = true;
  } else if (user.status !== 'Approved') {
    const patch = { status: 'Approved', approved_by: ctx.user.id, approved_at: now };
    patchUser_(user, patch, ctx.user);
    user = Object.assign({}, user, patch);
  }

  const link = createInviteLink_(user);
  const emailed = sendInviteEmail_(user, link, ctx.user);
  audit_(ctx.user, created ? 'user_invited' : 'invite_resent', 'User', user.id,
    (created ? 'Invited ' : 'Re-sent the invitation to ') + user.name + ' (' + user.email + ')' + (emailed ? '' : ' - email could not be sent'));
  if (!emailed) fail_('invite_email_failed');
  return { user: summarizeUser_(user), created: created };
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

const ANNOUNCE_GAP_MS = 30 * 60 * 1000; // a second full send within this time is refused (a double tap)

/**
 * Admin: email the Android app announcement. `testOnly` sends it to the admin alone; otherwise it goes to every approved user,
 * one personal email each (never a visible list of everyone). Refused if there is not enough of today's email allowance left.
 */
function sendAppAnnouncement_(p, ctx) {
  const test = p.testOnly === true || p.testOnly === 'true';
  const users = test ? [ctx.user] : Db.all('Users').filter(function (u) { return !isTrue_(u.deleted) && u.status === 'Approved' && u.email; });
  if (!users.length) fail_('not_found');
  if (!test) {
    const last = Number(props_().getProperty('ANNOUNCE_LAST') || 0);
    if (last && Date.now() - last < ANNOUNCE_GAP_MS) fail_('announcement_recent');
  }
  if (MailApp.getRemainingDailyQuota() < users.length) fail_('mail_quota');
  let sent = 0;
  users.forEach(function (u) { if (sendAndroidAnnouncementEmail_(u)) sent++; });
  if (!test && sent) props_().setProperty('ANNOUNCE_LAST', String(Date.now()));
  audit_(ctx.user, test ? 'announce_test' : 'announce_all', 'User', '', 'Android app announcement ' + (test ? 'test sent to the admin' : 'sent to ' + sent + ' of ' + users.length + ' users'));
  return { sent: sent, total: users.length, test: test };
}
