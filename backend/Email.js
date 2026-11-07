/** Outgoing email. All dynamic text is HTML-escaped. Sent as the app's Google account. */

function sendMail_(to, subject, html, text) {
  try {
    if (MailApp.getRemainingDailyQuota() < 1) {
      console.error('email quota exhausted');
      return false;
    }
    MailApp.sendEmail({
      to: to,
      subject: String(subject).replace(/[\r\n]+/g, ' '),
      htmlBody: html,
      body: text,
      name: 'Fleet Manager',
    });
    return true;
  } catch (e) {
    console.error('email failed: ' + (e && e.message));
    return false;
  }
}

function layout_(heading, innerHtml) {
  return '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#17212b;line-height:1.5">' +
    '<div style="font-size:20px;font-weight:700;color:#0f3d5e;margin-bottom:16px">Fleet Manager</div>' +
    '<h2 style="font-size:18px;margin:0 0 12px">' + esc_(heading) + '</h2>' +
    innerHtml +
    '<p style="color:#5d6b79;font-size:12px;margin-top:28px">This is an automated message from Fleet Manager.</p>' +
    '</div>';
}

function button_(url, label) {
  return '<p style="margin:20px 0"><a href="' + esc_(url) + '" style="display:inline-block;background:#1b7fc4;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">' + esc_(label) + '</a></p>';
}

function sendLoginEmail_(user, link, code) {
  const html = layout_('Your sign-in link',
    '<p>Hi ' + esc_(user.name) + ',</p>' +
    '<p>Tap the button to sign in. The link works once and expires in ' + LOGIN_MINUTES + ' minutes.</p>' +
    button_(link, 'Sign in') +
    '<p>Using the installed app on an iPhone? Open the app and enter this code instead:</p>' +
    '<p style="font-size:28px;letter-spacing:6px;font-weight:700;margin:8px 0">' + esc_(code) + '</p>' +
    '<p style="color:#5d6b79">If you didn\'t ask to sign in, you can ignore this email.</p>');
  const text = 'Hi ' + user.name + ',\n\nSign in (single use, expires in ' + LOGIN_MINUTES + ' minutes):\n' + link +
    '\n\nOr enter this code in the app: ' + code + '\n\nIf you didn\'t ask to sign in, ignore this email.';
  return sendMail_(user.email, 'Your Fleet Manager sign-in link', html, text);
}

function sendAdminRequestEmail_(adminEmails, requester, reviewUrl) {
  const html = layout_('New account request',
    '<p><strong>' + esc_(requester.name) + '</strong> (' + esc_(requester.email) + ') has asked for access.</p>' +
    '<p>Review the request in the app. You will be asked to sign in first. Nothing is approved until you approve it there.</p>' +
    button_(reviewUrl, 'Review request'));
  const text = requester.name + ' (' + requester.email + ') has asked for access.\nReview it here (sign-in required):\n' + reviewUrl;
  return sendMail_(adminEmails.join(','), 'New Fleet Manager account request', html, text);
}

function sendApprovedEmail_(user) {
  const url = SITE_URL + '#/login';
  const html = layout_('You\'re approved',
    '<p>Hi ' + esc_(user.name) + ',</p>' +
    '<p>Your access to Fleet Manager has been approved. To sign in, enter your email address on the sign-in page and we\'ll send you a one-time link.</p>' +
    button_(url, 'Go to sign in'));
  const text = 'Hi ' + user.name + ',\n\nYour access to Fleet Manager has been approved. Sign in here: ' + url;
  return sendMail_(user.email, 'Your Fleet Manager access has been approved', html, text);
}
