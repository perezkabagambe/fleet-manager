// Small DOM helpers. Text is always set via textContent / text nodes, never as HTML.
(function () {
  'use strict';

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

  function notice(kind, text) {
    return el('div', { class: 'notice ' + kind, role: kind === 'error' ? 'alert' : 'status', text: text });
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
    last_admin: 'There must always be at least one admin.',
    registration_required: 'Please enter the registration number.',
    make_required: 'Please enter the make.',
    model_required: 'Please enter the model.',
    year_required: 'Please enter the year of the vehicle.',
    invalid_year: 'The year must be a four-digit year, such as 2015.',
    invalid_vin: 'The VIN or chassis number may only contain letters, numbers and hyphens (5 to 25 characters).',
    invalid_country: 'Please choose a location from the list.',
    invalid_document_type: 'Please choose what kind of document this is.',
    invalid_market: 'Please choose a market from the list.',
    invalid_drive_side: 'Please choose left-hand drive or right-hand drive.',
    invalid_fuel_capacity: 'The fuel capacity must be a number of litres between 1 and 999, such as 87 or 45.5.',
    invalid_currency: 'Please choose a currency from the list.',
    invalid_unit: 'Please choose miles or kilometres.',
    invalid_status: 'Please choose a status from the list.',
    invalid_catalogue_url: 'The catalogue link must be a secure web address starting with https://, for example a partsouq.com page.',
    invalid_photo: 'That photo could not be read. Please try a different one.',
    photo_too_large: 'That photo is too large. Please try a smaller one.',
    no_photo: 'This car has no photo yet.',
    invalid_odometer: 'Please enter the odometer as a whole number.',
    invalid_cost: 'Please enter the cost as a plain number, such as 4500 or 4500.50.',
    invalid_date: 'Please enter a real date that is not in the future: a year (2021), a month and year (Mar 2021) or a full date (12/03/2021).',
    odometer_lower: 'The odometer cannot go down. Check the reading, or ask an admin to correct it.',
    conflict: 'Someone else changed this car while you were editing. Go back to the car and try again to see their changes.',
    fluid_name_required: 'Every fluid needs a name.',
    invalid_input: 'Something in that form was not valid. Please check it and try again.',
    title_required: 'Please enter a title.',
    date_required: 'Please enter the date.',
    invalid_type: 'That kind of entry is not recognised.',
    invalid_quantity: 'The quantity must be a number above zero, such as 1 or 4.5.',
    invalid_hours: 'Hours must be a number, such as 2 or 1.5.',
    invalid_cost_mode: 'Please choose itemised or invoice total.',
    unit_cost_required: 'Please enter the cost of each item.',
    invalid_url: 'The link must be a secure web address starting with https://.',
    part_name_required: 'Every part needs a name.',
    not_enough_stock: 'You are using more of a purchased item than is left. Check the quantities.',
    quantity_below_used: 'You have already used more than that quantity in maintenance entries.',
    purchase_in_use: 'That purchase is used in a maintenance entry. Remove it from there first.',
    too_many_attachments: 'This entry already has the maximum number of attachments.',
    invalid_attachment: 'That file is not a photo or a PDF that can be attached.',
    attachment_too_large: 'That file is too large. Photos are shrunk automatically; PDFs can be up to 2.5 MB.',
    name_required: 'Please give the reminder a name.',
    invalid_kind: 'Please choose maintenance or renewal.',
    invalid_interval: 'Repeat intervals must be whole numbers (months up to 240).',
    invalid_lead: 'The heads-up must be a whole number of days or miles/km.',
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

  var LINK_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"/></svg>';
  var TICK_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>';

  /**
   * A button that copies `url`. With a label it is a normal button ("Copy link to this car");
   * without one it is a small icon-only button. Shows "Copied" for a moment afterwards.
   */
  function copyLinkButton(url, opts) {
    opts = opts || {};
    var iconOnly = !opts.label;
    var btn = el('button', {
      type: 'button',
      class: iconOnly ? 'copy-icon' : 'btn small secondary copy-link',
      'aria-label': opts.aria || opts.label || 'Copy link',
      title: opts.aria || opts.label || 'Copy link',
    });
    var icon = el('span', { class: 'copy-glyph' });
    icon.innerHTML = LINK_ICON;
    var text = iconOnly ? null : el('span', { text: opts.label });
    btn.append.apply(btn, [icon, text].filter(Boolean));
    var timer = null;
    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      copyText(url).then(function (ok) {
        clearTimeout(timer);
        icon.innerHTML = ok ? TICK_ICON : LINK_ICON;
        btn.classList.toggle('copied', ok);
        if (text) text.textContent = ok ? 'Link copied' : 'Could not copy';
        if (!ok) window.prompt('Copy this link:', url);
        timer = setTimeout(function () {
          icon.innerHTML = LINK_ICON;
          btn.classList.remove('copied');
          if (text) text.textContent = opts.label;
        }, 2000);
      });
    });
    return btn;
  }

  window.UI = { el: el, field: field, notice: notice, errorText: errorText, busy: busy, copyText: copyText, copyLinkButton: copyLinkButton };
})();
