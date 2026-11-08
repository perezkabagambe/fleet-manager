// "Report a bug or request a feature": one form for both, emailed to the app's account and every admin.
(function () {
  'use strict';

  var el = UI.el;
  var Views = (window.Views = window.Views || {});

  var KINDS = [
    { value: 'Bug', label: 'Report a bug', hint: 'What did you do, what did you expect, and what happened instead?' },
    { value: 'Feature request', label: 'Request a feature', hint: 'What would you like the app to do, and what would it help with?' },
  ];

  Views.feedback = function (ctx, root) {
    var signedIn = FleetAuth.hasSession();
    var guest = signedIn ? null : FleetGuest.any();
    var back = '#' + (FleetApp.previousPage() || '/');

    if (!signedIn && !guest) {
      root.replaceChildren(el('section', { class: 'card narrow' }, [
        el('h1', { text: 'Report a bug or request a feature' }),
        el('p', { text: 'Please sign in first, so we know who to reply to.' }),
        el('a', { class: 'btn block', href: '#/login?next=' + encodeURIComponent('/feedback'), text: 'Sign in' }),
      ]));
      return;
    }

    var msg = el('div');
    var kind = el('select', { name: 'kind' }, KINDS.map(function (k) { return el('option', { value: k.value, text: k.label }); }));
    var title = el('input', { type: 'text', name: 'title', maxlength: '120', required: true, autocomplete: 'off' });
    var details = el('textarea', { name: 'details', rows: '6', maxlength: '3000' });
    var detailsField = UI.field('Details', details, KINDS[0].hint);
    var hint = detailsField.querySelector('.hint');
    kind.addEventListener('change', function () {
      var k = KINDS.filter(function (x) { return x.value === kind.value; })[0];
      hint.textContent = k.hint;
      title.placeholder = kind.value === 'Bug' ? 'e.g. Photo will not upload' : 'e.g. Show costs in a chart';
    });
    title.placeholder = 'e.g. Photo will not upload';
    var btn = el('button', { type: 'submit', class: 'btn block big save-gap', text: 'Send' });

    var form = el('form', { novalidate: true }, [
      UI.field('What is this?', kind),
      UI.field('Title *', title, 'A few words.'),
      detailsField,
      el('p', { class: 'muted small-text', text: 'We add the screen you came from, the app version and your device type, so the problem is easier to reproduce. Nothing else is sent.' }),
      btn,
    ]);

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      msg.replaceChildren();
      var payload = {
        kind: kind.value, title: title.value, details: details.value,
        page: FleetApp.previousPage(), appRev: (window.FLEET_CONFIG && window.FLEET_CONFIG.commit) || '', device: navigator.userAgent,
      };
      var call = signedIn ? FleetApi.call('sendFeedback', payload) : FleetApi.callGuest(guest.carId, 'guestSendFeedback', payload);
      UI.busy(btn, 'Sending…', call).then(function () {
        root.replaceChildren(el('section', { class: 'card narrow' }, [
          el('h1', { text: 'Thank you' }),
          el('p', { text: kind.value === 'Bug' ? 'Your bug report has been sent to the administrators.' : 'Your idea has been sent to the administrators.' }),
          signedIn ? el('p', { class: 'muted', text: 'If they need more detail they will reply to your email address.' }) : null,
          el('a', { class: 'btn block', href: back, text: 'Back' }),
        ]));
      }).catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
    });

    root.replaceChildren(el('section', { class: 'card narrow' }, [
      el('a', { class: 'back', href: back, text: '← Back' }),
      el('h1', { text: 'Report a bug or request a feature' }),
      el('p', { class: 'muted', text: 'This is emailed to the administrators.' }),
      msg, form,
    ]));
  };
})();
