/**
 * "Report a bug or request a feature": one form for both. The message goes by email to the app's own account
 * and to every admin, with the sender as the reply-to address so an admin can answer straight away.
 *
 * Only signed-in people and guests can send one (so the inboxes cannot be flooded by strangers), and there are
 * limits per person and per day. What the browser adds (page, app version, device) is cleaned before it is used,
 * and the page address never includes anything after a "?" (that is where guest secrets would be).
 */

const FEEDBACK_KINDS = ['Bug', 'Feature request'];
const APP_EMAIL_FALLBACK = 'potentiafleetmanager@gmail.com';

/** The account the app runs as. */
function appEmail_() {
  try {
    const e = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
    if (e) return e;
  } catch (err) { /* not available: use the known address */ }
  return APP_EMAIL_FALLBACK;
}

/** The app's own address plus every approved admin, each once. */
function feedbackRecipients_() {
  const seen = {};
  return [appEmail_()].concat(activeAdmins_().map(function (a) { return String(a.email || '').toLowerCase(); }))
    .filter(function (e) { if (!e || seen[e]) return false; seen[e] = true; return true; });
}

/** who: { id, actor, label, email, replyTo, note } */
function submitFeedback_(p, who) {
  const kind = oneOf_(p.kind, FEEDBACK_KINDS, '', 'invalid_kind');
  if (!kind) fail_('invalid_kind');
  const title = cleanStr_(p.title, 120);
  if (!title) fail_('title_required');
  const details = cleanText_(p.details, 3000);
  const page = cleanStr_(String(p.page || '').split('?')[0], 200);
  const appRev = cleanStr_(p.appRev, 40);
  const device = cleanStr_(p.device, 200);

  if (!rateLimit_('feedback:' + who.id, 5, 3600)) fail_('try_later');
  if (!dailyCap_('feedback', 40)) fail_('try_later');

  const when = Utilities.formatDate(new Date(), TZ, 'd MMM yyyy, HH:mm');
  const rows = [
    ['From', who.label + (who.email ? ' (' + who.email + ')' : '')],
    who.note ? ['Car', who.note] : null,
    ['Sent', when + ' (London time)'],
    page ? ['Screen', page] : null,
    ['App version', (appRev || 'unknown') + ' / backend ' + (typeof BACKEND_REV === 'string' ? BACKEND_REV : '')],
    device ? ['Device', device] : null,
  ].filter(Boolean);

  const html = layout_(kind + ': ' + title,
    '<p style="white-space:pre-wrap;margin:0 0 16px">' + (details ? esc_(details) : '<em>No further details given.</em>') + '</p>' +
    '<table style="border-collapse:collapse;font-size:13px;color:#5d6b79">' +
    rows.map(function (r) { return '<tr><td style="padding:2px 12px 2px 0;vertical-align:top;white-space:nowrap">' + esc_(r[0]) + '</td><td style="padding:2px 0;color:#17212b;word-break:break-word">' + esc_(r[1]) + '</td></tr>'; }).join('') +
    '</table>' + (who.replyTo ? '<p style="color:#5d6b79;font-size:13px">Reply to this email to answer ' + esc_(who.label) + ' directly.</p>' : ''));
  const text = kind + ': ' + title + '\n\n' + (details || '(no further details)') + '\n\n' +
    rows.map(function (r) { return r[0] + ': ' + r[1]; }).join('\n') + (who.replyTo ? '\n\nReply to this email to answer ' + who.label + ' directly.' : '');

  const subject = '[Fleet Manager] ' + kind + ': ' + title;
  if (!sendMail_(feedbackRecipients_().join(','), subject, html, text, who.replyTo ? { replyTo: who.replyTo } : null)) fail_('email_failed');
  audit_(who.actor, 'feedback_sent', 'Feedback', '', kind + ' sent: ' + title);
  return { sent: true };
}

function sendFeedback_(p, ctx) {
  return submitFeedback_(p, { id: ctx.user.id, actor: ctx.user, label: ctx.user.name, email: ctx.user.email, replyTo: ctx.user.email, note: '' });
}

/** A guest can report too; they are named as "Guest: name" and cannot be replied to. */
function guestSendFeedback_(p, ctx) {
  const car = ctx.guest.car;
  return submitFeedback_(p, { id: ctx.user.id, actor: ctx.user, label: 'Guest: ' + ctx.guest.name, email: '', replyTo: '', note: car.registration + ' ' + car.make + ' ' + car.model });
}
