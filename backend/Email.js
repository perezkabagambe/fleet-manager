/** Outgoing email. All dynamic text is HTML-escaped. Sent as the app's Google account. */

function sendMail_(to, subject, html, text, options) {
  try {
    if (MailApp.getRemainingDailyQuota() < 1) {
      console.error('email quota exhausted');
      return false;
    }
    const message = {
      to: to,
      subject: String(subject).replace(/[\r\n]+/g, ' '),
      htmlBody: html,
      body: text,
      name: 'Fleet Manager',
    };
    if (options && options.replyTo) message.replyTo = options.replyTo;
    MailApp.sendEmail(message);
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
    '<p>Tap the button below and you\'ll be signed in straight away. The link works once and expires in ' + LOGIN_MINUTES + ' minutes.</p>' +
    button_(link, 'Sign in to Fleet Manager') +
    '<p><strong>On an iPhone with Fleet Manager on your home screen?</strong> The link opens in Safari, not in the app. To sign in on the app instead, open it and enter this code:</p>' +
    '<p style="font-size:28px;letter-spacing:6px;font-weight:700;margin:8px 0">' + esc_(code) + '</p>' +
    '<p style="color:#5d6b79">If you didn\'t ask to sign in, you can ignore this email.</p>');
  const text = 'Hi ' + user.name + ',\n\nTap this link and you\'ll be signed in straight away (it works once and expires in ' + LOGIN_MINUTES + ' minutes):\n' + link +
    '\n\nOn an iPhone with Fleet Manager on your home screen? The link opens in Safari, not in the app. To sign in on the app instead, open it and enter this code in the app: ' + code +
    '\n\nIf you didn\'t ask to sign in, you can ignore this email.';
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

function sendInviteEmail_(user, link, inviter) {
  const who = inviter && inviter.name ? esc_(inviter.name) : 'An administrator';
  const html = layout_('You\'re invited',
    '<p>Hi ' + esc_(user.name) + ',</p>' +
    '<p>' + who + ' has invited you to Fleet Manager, the app we use to look after our cars: service history, odometer readings, reminders and more.</p>' +
    '<p>Tap the button and you will be signed in straight away. The link works once and stays valid for ' + INVITE_DAYS + ' days.</p>' +
    button_(link, 'Join Fleet Manager') +
    '<p>After that, you can add the app to your phone\'s home screen. If the link has expired, open the app and enter this email address on the sign-in page to get a new one.</p>' +
    '<p style="color:#5d6b79">Please don\'t forward this email: the link signs in as you.</p>');
  const text = 'Hi ' + user.name + ',\n\n' + (inviter && inviter.name ? inviter.name : 'An administrator') +
    ' has invited you to Fleet Manager. Open this link to be signed in straight away (works once, valid for ' + INVITE_DAYS + ' days):\n' +
    link + '\n\nIf it has expired, enter this email address on the sign-in page at ' + SITE_URL + ' to get a new one.\nPlease do not forward this email: the link signs in as you.';
  return sendMail_(user.email, 'You\'re invited to Fleet Manager', html, text);
}

/** The announcement about the Android app (sent by an admin from the Users page). Plain and personal, and it links to the website, not to the file. */
function sendAndroidAnnouncementEmail_(user) {
  const html = layout_('Fleet Manager now has an Android app',
    '<p>Hi ' + esc_(user.name) + ',</p>' +
    '<p>Fleet Manager now has an Android app. It is the best way to use Fleet Manager on an Android phone: links to a car open straight in the app, and you can share a receipt or invoice from another app into the AI Inbox.</p>' +
    '<p><strong>If you use Fleet Manager on an Android phone:</strong></p>' +
    '<ol style="padding-left:20px"><li>Remove the Fleet Manager shortcut you added to your home screen earlier (touch and hold it, then choose Uninstall or Remove).</li>' +
    '<li>Open the link below on your phone, tap <strong>Install app</strong>, then <strong>Download the APK</strong>.</li>' +
    '<li>Open the downloaded file to install it. If your phone asks, allow installing from your browser. Then sign in with your email address as usual.</li></ol>' +
    button_(SITE_URL, 'Get the Android app') +
    '<p>If you use an iPhone or a computer, nothing changes. Keep using Fleet Manager as you do now.</p>');
  const text = 'Hi ' + user.name + ',\n\nFleet Manager now has an Android app. It is the best way to use Fleet Manager on an Android phone: links to a car open straight in the app, and you can share a receipt or invoice from another app into the AI Inbox.' +
    '\n\nIf you use Fleet Manager on an Android phone:\n1. Remove the Fleet Manager shortcut you added to your home screen earlier (touch and hold it, then choose Uninstall or Remove).' +
    '\n2. Open ' + SITE_URL + ' on your phone, tap Install app, then Download the APK.' +
    '\n3. Open the downloaded file to install it. If your phone asks, allow installing from your browser. Then sign in with your email address as usual.' +
    '\n\nIf you use an iPhone or a computer, nothing changes. Keep using Fleet Manager as you do now.';
  return sendMail_(user.email, 'Fleet Manager now has an Android app', html, text);
}
