// Sign-in, account request and magic-link landing views.
(function () {
  'use strict';

  var el = UI.el;
  var Views = (window.Views = window.Views || {});
  var cfg = window.FLEET_CONFIG;

  function signedIn(res, next) {
    FleetAuth.save(res.session);
    FleetAuth.setUser(res.user);
    window.FleetApp.refreshNav();
    window.FleetApp.go(next || '/');
  }

  // ---------- sign in ----------
  Views.login = function (ctx, root) {
    var next = ctx.query.next || '';
    var card = el('section', { class: 'card narrow' });
    root.replaceChildren(card);

    function stepEmail(prefill) {
      var msg = el('div');
      var email = el('input', { type: 'email', name: 'email', autocomplete: 'email', inputmode: 'email', required: true, value: prefill || '', autocapitalize: 'off', spellcheck: 'false' });
      var btn = el('button', { type: 'submit', class: 'btn block', text: 'Email me a sign-in link' });
      var form = el('form', { novalidate: true }, [UI.field('Email address', email), btn]);

      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        msg.replaceChildren();
        if (!email.value.trim()) { msg.append(UI.notice('error', UI.errorText({ code: 'invalid_email' }))); return; }
        UI.busy(btn, 'Sending…', FleetApi.call('requestLogin', { email: email.value.trim() }))
          .then(function () { stepCode(email.value.trim()); })
          .catch(function (e) { msg.append(UI.notice('error', UI.errorText(e))); });
      });

      var google = el('div', { class: 'google-box' });
      card.replaceChildren.apply(card, [
        el('h1', { text: 'Sign in' }),
        el('p', { class: 'muted', text: 'No password needed. We email you a one-time link.' }),
        msg, form,
        cfg.googleClientId ? el('div', { class: 'or', text: 'or' }) : null,
        cfg.googleClientId ? google : null,
        el('p', { class: 'center' }, [el('span', { class: 'muted', text: 'New here? ' }), el('a', { href: '#/request', text: 'Request an account' })]),
      ].filter(Boolean));
      if (cfg.googleClientId) renderGoogle(google, msg, next);
    }

    function stepCode(emailAddr) {
      var msg = el('div');
      var code = el('input', { type: 'text', name: 'code', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '6', autocomplete: 'one-time-code', required: true, class: 'code-input' });
      var btn = el('button', { type: 'submit', class: 'btn block', text: 'Sign in with code' });
      var form = el('form', { novalidate: true }, [UI.field('6-digit code', code), btn]);

      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        msg.replaceChildren();
        UI.busy(btn, 'Checking…', FleetApi.call('verifyCode', { email: emailAddr, code: code.value }))
          .then(function (r) { signedIn(r.data, next); })
          .catch(function (e) { msg.append(UI.notice('error', UI.errorText(e))); });
      });

      card.replaceChildren(
        el('h1', { text: 'Check your email' }),
        el('p', { text: 'If ' + emailAddr + ' has an account, we have sent a link and a code. They expire in 15 minutes.' }),
        el('p', { class: 'muted', text: 'Nothing yet? Check your junk folder and mark the email as "not junk".' }),
        msg, form,
        el('p', { class: 'center' }, [el('button', { type: 'button', class: 'linklike', text: 'Use a different email', onclick: function () { stepEmail(emailAddr); } })])
      );
      code.focus();
    }

    stepEmail('');
  };

  // ---------- Google button ----------
  var googleLoading = null;
  function loadGoogle() {
    if (window.google && window.google.accounts) return Promise.resolve();
    if (!googleLoading) {
      googleLoading = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.async = true;
        s.onload = resolve;
        s.onerror = reject;
        document.head.append(s);
      });
    }
    return googleLoading;
  }

  function renderGoogle(box, msg, next) {
    loadGoogle().then(function () {
      window.google.accounts.id.initialize({
        client_id: cfg.googleClientId,
        callback: function (resp) {
          msg.replaceChildren();
          FleetApi.call('googleLogin', { credential: resp.credential })
            .then(function (r) { signedIn(r.data, next); })
            .catch(function (e) { msg.append(UI.notice('error', UI.errorText(e))); });
        },
      });
      window.google.accounts.id.renderButton(box, { theme: 'outline', size: 'large', text: 'signin_with', shape: 'rectangular', width: 280 });
    }).catch(function () { /* Google unavailable: email sign-in still works */ });
  }

  // ---------- profile ----------
  Views.profile = function (ctx, root) {
    var user = FleetAuth.getUser();
    var msg = el('div');
    var name = el('input', { type: 'text', name: 'name', autocomplete: 'name', maxlength: '80', required: true, value: user.name });
    var btn = el('button', { type: 'submit', class: 'btn', text: 'Save name' });
    var form = el('form', { novalidate: true }, [UI.field('Your name', name, 'Shown to other users, for example when you edit a car.'), btn]);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      msg.replaceChildren();
      UI.busy(btn, 'Saving…', FleetApi.call('updateMyName', { name: name.value }))
        .then(function (r) {
          FleetAuth.setUser(Object.assign({}, FleetAuth.getUser(), { name: r.data.user.name }));
          window.FleetApp.refreshNav();
          msg.append(UI.notice('ok', 'Saved.'));
        })
        .catch(function (e) { msg.append(UI.notice('error', UI.errorText(e))); });
    });
    root.replaceChildren(el('section', { class: 'card narrow' }, [
      el('h1', { text: 'Your profile' }),
      el('p', { class: 'muted', text: user.email + (user.role === 'admin' ? ' · Administrator' : '') }),
      msg, form,
    ]));
  };

  // ---------- request an account ----------
  Views.request = function (ctx, root) {
    var msg = el('div');
    var name = el('input', { type: 'text', name: 'name', autocomplete: 'name', required: true, maxlength: '80' });
    var email = el('input', { type: 'email', name: 'email', autocomplete: 'email', inputmode: 'email', required: true, autocapitalize: 'off', spellcheck: 'false' });
    // Honeypot: hidden from people, tempting to bots.
    var trap = el('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off' });
    var btn = el('button', { type: 'submit', class: 'btn block', text: 'Request account' });
    var form = el('form', { novalidate: true }, [
      UI.field('Your name', name),
      UI.field('Email address', email, 'We use this to send your sign-in links. Nothing else is collected.'),
      el('div', { class: 'hp', 'aria-hidden': 'true' }, [trap]),
      btn,
    ]);
    var card = el('section', { class: 'card narrow' }, [
      el('h1', { text: 'Request an account' }),
      el('p', { class: 'muted', text: 'An administrator will review your request. You will get an email when it is approved.' }),
      msg, form,
      el('p', { class: 'center' }, [el('a', { href: '#/login', text: 'Back to sign in' })]),
    ]);

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      msg.replaceChildren();
      UI.busy(btn, 'Sending…', FleetApi.call('requestAccount', { name: name.value, email: email.value, website: trap.value }))
        .then(function () {
          card.replaceChildren(
            el('h1', { text: 'Request received' }),
            el('p', { text: 'Thank you. If this is a new request, an administrator has been notified and you will get an email once you are approved.' }),
            el('a', { class: 'btn', href: '#/login', text: 'Back to sign in' })
          );
        })
        .catch(function (e) { msg.append(UI.notice('error', UI.errorText(e))); });
    });
    root.replaceChildren(card);
  };

  // ---------- magic link landing ----------
  // Email scanners often open links automatically. Nothing happens until the
  // person taps the button, so a scanner cannot use up the one-time link.
  Views.verify = function (ctx, root) {
    var token = ctx.query.t || '';
    var msg = el('div');
    var btn = el('button', { type: 'button', class: 'btn block', text: 'Tap to sign in' });
    var card = el('section', { class: 'card narrow' }, [
      el('h1', { text: 'Sign in to Fleet Manager' }),
      el('p', { class: 'muted', text: 'Tap the button below to finish signing in on this device.' }),
      msg, btn,
      el('p', { class: 'center' }, [el('a', { href: '#/login', text: 'Back to sign in' })]),
    ]);
    root.replaceChildren(card);
    if (!token) { msg.append(UI.notice('error', UI.errorText({ code: 'invalid_or_expired' }))); btn.disabled = true; return; }

    btn.addEventListener('click', function () {
      msg.replaceChildren();
      UI.busy(btn, 'Signing in…', FleetApi.call('verifyLink', { token: token }))
        .then(function (r) { signedIn(r.data, ''); })
        .catch(function (e) { msg.append(UI.notice('error', UI.errorText(e))); });
    });
  };
})();
