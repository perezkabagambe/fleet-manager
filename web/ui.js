// Small DOM helpers. Text is always set via textContent / text nodes, never as HTML.
(function () {
  'use strict';

  // The browser turns a null, undefined or false argument of append / prepend / replaceChildren into the text "null" (or "false").
  // Skip them instead, so a conditional child that is not needed can simply be null.
  ['append', 'prepend', 'replaceChildren'].forEach(function (method) {
    [Element.prototype, DocumentFragment.prototype].forEach(function (proto) {
      var original = proto[method];
      if (!original) return;
      proto[method] = function () {
        var args = [];
        for (var i = 0; i < arguments.length; i++) { if (arguments[i] !== null && arguments[i] !== undefined && arguments[i] !== false) args.push(arguments[i]); }
        return original.apply(this, args);
      };
    });
  });

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === false || v === null || v === undefined) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    });
    (children || []).forEach(function (c) { if (c) node.append(c); });
    return node;
  }

  /** Labelled form field. `input` is an <input>/<select>/<textarea> element. */
  function field(label, input, hint) {
    var id = 'f' + Math.random().toString(36).slice(2, 9);
    input.id = id;
    return el('div', { class: 'field' }, [
      el('label', { for: id, text: label }),
      input,
      hint ? el('div', { class: 'hint', text: hint }) : null,
    ]);
  }

  /** A small Edit / Done button for a section. `onChange(editing)` is called each time it is pressed. */
  function editToggle(onChange, label) {
    var editing = false;
    var b = el('button', { type: 'button', class: 'btn small secondary section-edit', text: label || 'Edit', 'aria-pressed': 'false' });
    b.addEventListener('click', function () {
      editing = !editing;
      b.textContent = editing ? 'Done' : (label || 'Edit');
      b.setAttribute('aria-pressed', editing ? 'true' : 'false');
      onChange(editing);
    });
    return b;
  }

  // A Yes/No question shown inside the page. (The browser's own pop-up is blocked or answered "no" at once in some
  // browsers and home-screen apps, which made Remove and Delete buttons do nothing.) Resolves true for OK, false otherwise.
  function confirmDialog(message, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var previous = document.activeElement;
      var ok = el('button', { type: 'button', class: 'btn' + (opts.danger ? ' danger' : ''), text: opts.okLabel || 'OK' });
      var cancel = el('button', { type: 'button', class: 'btn secondary', text: opts.cancelLabel || 'Cancel' });
      var box = el('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true' }, [
        el('p', { class: 'dialog-text', text: message }),
        el('div', { class: 'dialog-actions' }, [cancel, ok]),
      ]);
      var overlay = el('div', { class: 'dialog-overlay' }, [box]);
      function close(answer) {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        if (previous && previous.focus) { try { previous.focus(); } catch (e) { /* ignore */ } }
        resolve(answer);
      }
      function onKey(ev) {
        if (ev.key === 'Escape') { ev.preventDefault(); close(false); }
        else if (ev.key === 'Tab') { // keep the focus inside the dialog
          ev.preventDefault();
          (document.activeElement === cancel ? ok : cancel).focus();
        }
      }
      ok.addEventListener('click', function () { close(true); });
      cancel.addEventListener('click', function () { close(false); });
      overlay.addEventListener('click', function (ev) { if (ev.target === overlay) close(false); });
      document.addEventListener('keydown', onKey, true);
      document.body.append(overlay);
      cancel.focus(); // the safe choice is the one under the thumb
    });
  }

  function notice(kind, text) {
    return el('div', { class: 'notice ' + kind, role: kind === 'error' ? 'alert' : 'status', text: text });
  }

  /** The blue "AI is working" panel: bouncing dots, the message, and a sliding bar. Used for every AI lookup in the app. */
  function waiting(text) {
    var dots = el('span', { class: 'ai-wait-dots', 'aria-hidden': 'true' }, [el('i'), el('i'), el('i')]);
    return el('div', { class: 'ai-wait', role: 'status', 'aria-live': 'polite' }, [
      el('div', { class: 'ai-wait-row' }, [dots, el('span', { class: 'ai-wait-text', text: text })]),
      el('div', { class: 'ai-wait-bar', 'aria-hidden': 'true' }, [el('span')]),
    ]);
  }

  var MESSAGES = {
    invalid_or_expired: 'That link or code is invalid or has expired. Please request a new one.',
    too_many_attempts: 'Too many wrong codes. Please request a new sign-in email.',
    invalid_email: 'Please enter a valid email address.',
    invalid_name: 'Please enter your name.',
    try_later: 'We are getting a lot of requests right now. Please try again later.',
    unauthorized: 'Your session has ended. Please sign in again.',
    forbidden: 'You do not have permission to do that.',
    busy: 'The server is busy. Please try again in a moment.',
    google_not_configured: 'Google sign-in is not available yet.',
    invalid_google_token: 'Google sign-in could not be verified. Please try again.',
    not_approved: 'That Google account has not been approved yet. You can request an account first.',
    not_found: 'That user no longer exists.',
    invalid_transition: 'That change is not allowed for this user.',
    cannot_revoke_self: 'You cannot revoke your own access.',
    invite_email_failed: 'The invitation email could not be sent. Please try again in a little while.',
    last_admin: 'There must always be at least one admin.',
    registration_required: 'Please enter the registration number.',
    make_required: 'Please enter the make.',
    model_required: 'Please enter the model.',
    year_required: 'Please enter the year of the vehicle.',
    invalid_year: 'The year must be a four-digit year, such as 2015.',
    ai_not_set_up: 'AI is not set up yet (or its key was refused). An administrator needs to add the Gemini key to the app.',
    too_many_photos: 'A car can have up to 15 photos. Remove one to add another.',
    receipt_closed: 'That receipt has already been dealt with.',
    inbox_full: 'The AI Inbox is full. Check or dismiss some receipts first.',
    ai_busy: 'The AI service is busy right now. Please try again in a minute.',
    ai_unavailable: 'The AI did not answer in time, or could not be reached. Nothing was used up. Please try again.',
    ai_limit_user: 'You have used all of your AI lookups for today. They come back tomorrow.',
    ai_limit_app: 'The app has reached its daily limit of AI lookups. They come back tomorrow.',
    ai_bad_answer: 'The AI could not work out this car, or its answer could not be read. Nothing was used up. You can fill the form in by hand.',
    ai_need_more: 'Enter the VIN, or at least the make and the model, so AI has something to look up.',
    invalid_vin: 'The VIN or chassis number may only contain letters, numbers and hyphens (5 to 25 characters).',
    invalid_country: 'Please choose a location from the list.',
    invalid_document_type: 'Please choose what kind of document this is.',
    invalid_market: 'Please choose a market from the list.',
    mail_quota: 'There is not enough of today\'s email allowance left to send to everyone. Try again tomorrow.',
    changes_required: 'Write what the update adds (one change per line).',
    announcement_recent: 'The announcement was already sent a few minutes ago.',
    invalid_transmission: 'Please choose manual, automatic or CVT.',
    invalid_fuel_type: 'Please choose a fuel type from the list.',
    logbook_pdf_only: 'Please choose the log book as a PDF file.',
    logbook_unreadable: 'AI could not read a vehicle log book in that file. Try a clearer, flatter copy, or add the car manually.',
    invalid_drive_side: 'Please choose left-hand drive or right-hand drive.',
    invalid_fuel_capacity: 'The fuel capacity must be a number of litres between 1 and 999, such as 87 or 45.5.',
    invalid_currency: 'Please choose a currency from the list.',
    invalid_status: 'Please choose a status from the list.',
    invalid_catalogue_url: 'The catalogue link must be a secure web address starting with https://, for example a partsouq.com page.',
    invalid_photo: 'That photo could not be read. Please try a different one.',
    photo_too_large: 'That photo is too large. Please try a smaller one.',
    no_photo: 'This car has no photo yet.',
    invalid_odometer: 'Please enter the odometer as a whole number.',
    invalid_cost: 'Please enter the cost as a plain number, such as 4500 or 4500.50.',
    invalid_date: 'Please enter a real date that is not in the future: a year (2021), a month and year (Mar 2021) or a full date (12/03/2021).',
    odometer_lower: 'The odometer cannot go down. Check the reading, or ask an admin to correct it.',
    conflict: 'Someone else changed this while you were editing. Go back and try again to see their changes.',
    filename_required: 'Please give the document a name.',
    fluid_name_required: 'Every fluid needs a name.',
    invalid_input: 'Something in that form was not valid. Please check it and try again.',
    title_required: 'Please enter a title.',
    date_required: 'Please enter the date.',
    invalid_type: 'That kind of entry is not recognised.',
    invalid_quantity: 'The quantity must be a number above zero, such as 1 or 4.5.',
    invalid_hours: 'Hours must be a number, such as 2 or 1.5.',
    invalid_cost_mode: 'Please choose itemised or invoice total.',
    unit_cost_required: 'Please enter the cost of each item.',
    item_name_required: 'Please name every item in the purchase.',
    item_in_use: 'An item in this purchase has been used in a maintenance entry, so it cannot be removed. Remove it from that entry first.',
    invalid_url: 'The link must be a secure web address starting with https://.',
    part_name_required: 'Every part needs a name.',
    not_enough_stock: 'You are using more of a purchased item than is left. Check the quantities.',
    quantity_below_used: 'You have already used more than that quantity in maintenance entries.',
    purchase_in_use: 'That purchase is used in a maintenance entry. Remove it from there first.',
    too_many_attachments: 'This entry already has the maximum number of attachments.',
    invalid_attachment: 'That file could not be attached. It may be empty or damaged.',
    file_type_not_allowed: 'For safety, program and script files (such as .exe, .bat or .js) cannot be attached.',
    attachment_too_large: 'That file is too large. Photos are shrunk automatically; other files can be up to 5 MB.',
    name_required: 'Please give the reminder a name.',
    invalid_kind: 'Please choose maintenance or renewal.',
    invalid_interval: 'Repeat intervals must be whole numbers (months up to 240).',
    invalid_lead: 'The heads-up must be a whole number of days or miles.',
    task_needs_due: 'Give it a next due date or distance, or a repeat so one can be worked out.',
    duplicate_task: 'This car already has a reminder with that name.',
    email_failed: 'Your message could not be emailed just now. Please try again in a little while.',
    guest_unavailable: 'Guest access is not available for this car. If you have an account, please sign in instead.',
    guest_name_required: 'Please enter your name or your garage\'s name (at least two letters or numbers).',
    guest_name_taken: 'That name is already in use. Please add something to make it your own, such as your town: "Bob\'s Garage, Entebbe".',
    guest_disabled: 'Guest access has been switched off for this car.',
    guest_unauthorized: 'Your guest session has ended. Please scan the car\'s QR code again.',
    network: 'Could not reach the server. Check your connection and try again.',
    timeout: 'The server took too long to respond. Please try again.',
  };

  function errorText(err) {
    var code = err && err.code;
    return MESSAGES[code] || 'Something went wrong. Please try again.';
  }

  /** Disable a button and show a busy label while `work` (a promise) runs. */
  function busy(btn, label, work) {
    var original = btn.textContent;
    btn.disabled = true;
    btn.textContent = label;
    return work.finally(function () {
      btn.disabled = false;
      btn.textContent = original;
    });
  }

  /** Copy text to the clipboard. Resolves true/false. Falls back to a hidden textarea where the clipboard API is missing. */
  function copyText(text) {
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, text.length);
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch (e) { return false; }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallback(); });
    }
    return Promise.resolve(fallback());
  }

  /** A small button that copies a short value (such as an entry's reference) and says "Copied" for a moment. */
  function copyValueButton(value, label) {
    var btn = el('button', { type: 'button', class: 'linklike copy-value', text: 'Copy', 'aria-label': label || 'Copy ' + value });
    var timer = null;
    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      copyText(value).then(function (ok) {
        clearTimeout(timer);
        btn.textContent = ok ? 'Copied' : 'Could not copy';
        timer = setTimeout(function () { btn.textContent = 'Copy'; }, 1800);
      });
    });
    return btn;
  }

  // The share symbol: three joined circles.
  var SHARE_ICON = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="18" cy="5" r="2.8"/><circle cx="6" cy="12" r="2.8"/><circle cx="18" cy="19" r="2.8"/>' +
    '<path d="M8.5 10.7l7-4.2"/><path d="M8.5 13.3l7 4.2"/></svg>';
  var TICK_ICON = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>';

  /**
   * A small share symbol. Tapping it opens the phone's own share sheet (messages, WhatsApp, email, copy...) so the
   * person chooses how to share `url`. Where the browser has no share sheet (some desktops) it copies the link instead
   * and shows a tick for a moment.
   * opts.title: the name of what is being shared (used by the share sheet); opts.aria: the button's spoken label.
   */
  function shareButton(url, opts) {
    opts = opts || {};
    var label = opts.aria || 'Share';
    var btn = el('button', { type: 'button', class: 'copy-icon share-btn', 'aria-label': label, title: label });
    var icon = el('span', { class: 'copy-glyph' });
    icon.innerHTML = SHARE_ICON;
    btn.append(icon);
    var timer = null;
    function flash() {
      clearTimeout(timer);
      icon.innerHTML = TICK_ICON;
      btn.classList.add('copied');
      timer = setTimeout(function () { icon.innerHTML = SHARE_ICON; btn.classList.remove('copied'); }, 2000);
    }
    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (navigator.share) {
        navigator.share({ title: opts.title || 'Fleet Manager', url: url }).catch(function (e) {
          if (e && e.name === 'AbortError') return; // they closed the share sheet: nothing to do
          copyText(url).then(function (ok) { if (ok) flash(); else window.prompt('Copy this link:', url); });
        });
        return;
      }
      copyText(url).then(function (ok) { if (ok) flash(); else window.prompt('Copy this link:', url); });
    });
    return btn;
  }

  window.UI = { el: el, field: field, notice: notice, waiting: waiting, errorText: errorText, busy: busy, copyValueButton: copyValueButton, confirm: confirmDialog, editToggle: editToggle, copyText: copyText, shareButton: shareButton };
})();
