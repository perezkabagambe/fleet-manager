// Guest access: what a garage or visitor sees after scanning a car's QR code (no account needed),
// and the admin card on the car page that switches it on and off.
(function () {
  'use strict';

  var el = UI.el;
  var Views = (window.Views = window.Views || {});

  function fmt() { return Views.fmt; }
  var DAYS = 14;

  function signInLink(next) {
    return el('p', { class: 'center' }, [el('a', { href: '#/login' + (next ? '?next=' + encodeURIComponent(next) : ''), text: 'I have an account: sign in' })]);
  }

  function dateText(iso) { return iso ? fmt().date(iso) : ''; }

  function mileageText(e) {
    return e.mileage === null || e.mileage === undefined ? '' : fmt().num(e.mileage) + ' ' + (e.mileageUnit || '');
  }

  // ---------- 1. the page a scan lands on (before a name is given) ----------
  Views.guestEntry = function (ctx, root) {
    var carId = ctx.params.id;
    var secret = ctx.query.g;
    if (FleetGuest.get(carId)) { FleetApp.go('/guest/' + carId); return; }
    root.replaceChildren(el('section', { class: 'card narrow' }, [fmt().loading()]));

    FleetApi.call('guestInfo', { carId: carId, secret: secret }).then(function (r) {
      var car = r.data.car;
      var msg = el('div');
      var name = el('input', { type: 'text', name: 'guestName', autocomplete: 'organization', maxlength: '40', required: true, placeholder: 'e.g. Bob\'s Garage, Entebbe' });
      var trap = el('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off' }); // honeypot
      var btn = el('button', { type: 'submit', class: 'btn block big', text: 'Continue' });
      var form = el('form', { novalidate: true }, [
        UI.field('Your name or your garage\'s name', name, 'This is shown next to everything you add, and it cannot be changed or used by anyone else.'),
        el('div', { class: 'hp', 'aria-hidden': 'true' }, [trap]),
        btn,
      ]);
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        msg.replaceChildren();
        UI.busy(btn, 'Please wait…', FleetApi.call('guestJoin', { carId: carId, secret: secret, name: name.value, website: trap.value }))
          .then(function (res) {
            FleetGuest.save(carId, { token: res.data.guestToken, expiresAt: res.data.expiresAt, name: res.data.name });
            FleetApp.go('/guest/' + carId);
          })
          .catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
      });
      root.replaceChildren(el('section', { class: 'card narrow' }, [
        el('h1', { text: car.registration }),
        el('div', { class: 'muted', text: [car.make, car.model, car.year].filter(Boolean).join(' ') }),
        el('p', { text: 'Welcome. You can see this car\'s maintenance history and add the work you have done or the parts you have supplied, without an account.' }),
        el('ul', { class: 'plain-list' }, [
          el('li', { text: 'You will only see maintenance history. Costs and purchases are not shown.' }),
          el('li', { text: 'You can delete only what you add yourself.' }),
          el('li', { text: 'Your access lasts ' + DAYS + ' days on this phone.' }),
        ]),
        msg, form,
        el('div', { class: 'or', text: 'or' }),
        el('a', { class: 'btn block secondary', href: '#/login?next=' + encodeURIComponent('/car/' + carId), text: 'I have an account: sign in' }),
        el('p', { class: 'muted small-text center', text: 'After signing in you come straight back to this car.' }),
      ]));
    }).catch(function (e) {
      // Guest access is off for this car: the only way in is to sign in, and that leads straight back here.
      if (e.code === 'guest_unavailable') { FleetApp.go('/login', { next: '/car/' + carId }); return; }
      root.replaceChildren(el('section', { class: 'card narrow' }, [
        el('h1', { text: 'Guest access' }),
        UI.notice('error', UI.errorText(e)),
        signInLink('/car/' + carId),
      ]));
    });
  };

  // ---------- 2. the guest's car page ----------
  function ended(root, carId, e) {
    root.replaceChildren(el('section', { class: 'card narrow' }, [
      el('h1', { text: 'Guest access' }),
      UI.notice('error', UI.errorText(e || { code: 'guest_unauthorized' })),
      signInLink('/car/' + carId),
    ]));
  }

  Views.guestHome = function (ctx, root) {
    var carId = ctx.params.id;
    var me = FleetGuest.get(carId);
    if (!me) { ended(root, carId); return; }
    root.replaceChildren(el('section', { class: 'card' }, [fmt().loading()]));

    FleetApi.callGuest(carId, 'guestListEntries').then(function (r) {
      render(r.data.car, r.data.entries);
    }).catch(function (e) { ended(root, carId, e); });

    function render(car, entries) {
      var msg = el('div');
      var flash = FleetApp.takeFlash();
      if (flash) msg.append(UI.notice(flash.kind, flash.text));

      var leave = el('button', { type: 'button', class: 'btn small secondary', text: 'Leave guest mode' });
      leave.addEventListener('click', function () {
        if (!window.confirm('Leave guest mode on this phone? Your name stays reserved, so you would need to scan the QR code again and use a new name.')) return;
        FleetGuest.clear(carId);
        FleetApp.go('/login');
      });

      function photos(e) {
        var box = el('div');
        var btn = el('button', { type: 'button', class: 'btn small secondary', text: 'Show photos (' + e.attachmentCount + ')' });
        btn.addEventListener('click', function () {
          UI.busy(btn, 'Loading…', FleetApi.callGuest(carId, 'guestListAttachments', { entryId: e.id }).then(function (res) {
            return Promise.all(res.data.attachments.map(function (a) {
              return FleetApi.callGuest(carId, 'guestGetAttachment', { id: a.id }).then(function (att) {
                return el('img', { class: 'attach-img', src: Photos.toBlobUrl(att.data), alt: att.filename });
              });
            }));
          })).then(function (imgs) {
            btn.remove();
            box.replaceChildren.apply(box, imgs);
          }).catch(function (err) { msg.replaceChildren(UI.notice('error', UI.errorText(err))); });
        });
        return box.appendChild(btn) && box;
      }

      function row(e) {
        var meta = [dateText(e.date)];
        var m = mileageText(e);
        if (m) meta.push(m);
        if (e.vendor) meta.push(e.vendor);
        var tags = [];
        if (e.type === 'Purchase') tags.push(el('span', { class: 'chip t-purchase', text: 'Purchased item' }));
        if (e.mine) tags.push(el('span', { class: 'chip g-guest', text: 'You' }));
        else if (e.guestName) tags.push(el('span', { class: 'chip g-guest', text: 'Guest: ' + e.guestName }));
        var extra = [];
        if (e.mine && e.type === 'Maintenance' && e.totalCost !== null && e.totalCost !== undefined) extra.push('Total: ' + fmt().money(e.totalCost, e.totalCurrency));
        if (e.mine && e.type === 'Purchase') {
          if (e.quantity !== null && e.quantity !== undefined) extra.push('Quantity: ' + e.quantity);
          if (e.unitCost !== null && e.unitCost !== undefined) extra.push('Each: ' + fmt().money(e.unitCost, e.currency));
          if (e.partNumber) extra.push('Part number: ' + e.partNumber);
        }
        var del = null;
        if (e.mine) {
          del = el('button', { type: 'button', class: 'btn small danger', text: 'Delete' });
          del.addEventListener('click', function () {
            if (!window.confirm('Delete "' + e.title + '"? Only you and the administrators can see that it existed.')) return;
            UI.busy(del, 'Deleting…', FleetApi.callGuest(carId, 'guestDeleteEntry', { id: e.id }))
              .then(function () { FleetApp.setFlash('ok', 'Deleted.'); FleetApp.go('/guest/' + carId); })
              .catch(function (err) { msg.replaceChildren(UI.notice('error', UI.errorText(err))); });
          });
        }
        return el('div', { class: 'entry-line guest-entry' }, [
          el('div', { class: 'entry-row guest-row' }, [
            el('div', { class: 'entry-main' }, [
              el('div', { class: 'entry-title', text: e.title }),
              el('div', { class: 'muted small-text', text: meta.join(' · ') }),
              extra.length ? el('div', { class: 'small-text', text: extra.join(' · ') }) : null,
              e.notes ? el('div', { class: 'small-text guest-notes', text: e.notes }) : null,
              e.attachmentCount ? photos(e) : null,
              del ? el('div', { class: 'btn-row' }, [del]) : null,
            ]),
            el('div', { class: 'entry-tags' }, tags),
          ]),
        ]);
      }

      root.replaceChildren(
        el('section', { class: 'card' }, [
          el('div', { class: 'page-head' }, [
            el('div', {}, [el('h1', { text: car.registration }), el('div', { class: 'muted', text: [car.make, car.model, car.year].filter(Boolean).join(' ') })]),
            el('span', { class: 'chip g-guest', text: 'Guest' }),
          ]),
          msg,
          el('p', { class: 'muted small-text', text: 'You are using this car as a guest called "' + me.name + '". Your access ends on ' + dateText(me.expiresAt.slice(0, 10)) + '.' }),
          el('div', { class: 'stack' }, [
            el('a', { class: 'btn block big', href: '#/guest/' + carId + '/add/maintenance', text: 'Add maintenance' }),
            el('a', { class: 'btn block secondary', href: '#/guest/' + carId + '/add/purchase', text: 'Add a purchased item' }),
          ]),
        ]),
        el('section', { class: 'card' }, [
          el('h2', { text: 'Maintenance history' }),
          el('div', { class: 'history' }, entries.length ? entries.map(row)
            : [el('p', { class: 'muted', text: 'Nothing recorded yet.' })]),
        ]),
        el('p', { class: 'center' }, [leave])
      );
    }
  };

  // ---------- 3. the guest's add form ----------
  Views.guestForm = function (ctx, root) {
    var carId = ctx.params.id;
    var type = ctx.params.type === 'purchase' ? 'Purchase' : 'Maintenance';
    var me = FleetGuest.get(carId);
    if (!me) { ended(root, carId); return; }
    root.replaceChildren(el('section', { class: 'card' }, [fmt().loading()]));
    FleetApi.callGuest(carId, 'guestMe').then(function (r) { build(r.data.car); }).catch(function (e) { ended(root, carId, e); });

    function build(car) {
      var f = {};
      var msg = el('div');
      var today = new Date().toISOString().slice(0, 10);
      var defaultCurrency = car.country === 'UG' ? 'UGX' : 'GBP';
      function text(name, value, attrs) {
        f[name] = el('input', Object.assign({ type: 'text', name: name, value: value || '', autocomplete: 'off' }, attrs || {}));
        return f[name];
      }
      function select(name, options, value) {
        var s = el('select', { name: name }, options.map(function (o) { return el('option', { value: o[0], text: o[1], selected: o[0] === value }); }));
        f[name] = s;
        return s;
      }
      function currency(name) {
        var s = select(name, fmt().currencyOptions, defaultCurrency);
        s.setAttribute('aria-label', 'Currency');
        return s;
      }
      function moneyField(label, input, cur, hint) {
        return UI.field(label, el('div', { class: 'odo-row' }, [input, cur]), hint);
      }

      var fields = [];
      if (type === 'Maintenance') {
        fields.push(
          UI.field('What was done? *', text('title', '', { maxlength: '120', required: true, placeholder: 'e.g. Oil and filter change' })),
          UI.field('Date *', text('date', today, { type: 'date', max: today, required: true })),
          UI.field('Mileage', el('div', { class: 'odo-row' }, [
            text('mileage', '', { inputmode: 'numeric', placeholder: 'Optional' }),
            select('mileageUnit', [['mi', 'Miles'], ['km', 'Kilometres']], car.distanceUnit || 'mi'),
          ])),
          UI.field('Garage or who did the work', text('vendor', '', { maxlength: '80', placeholder: me.name }), 'Optional.'),
          moneyField('Total cost', text('totalCost', '', { inputmode: 'decimal', placeholder: 'Optional' }), currency('totalCurrency'), 'Optional. Only you and the car\'s team can see it.')
        );
      } else {
        fields.push(
          UI.field('Item *', text('title', '', { maxlength: '120', required: true, placeholder: 'e.g. Front brake pads (set)' })),
          UI.field('Date *', text('date', today, { type: 'date', max: today, required: true })),
          UI.field('Quantity *', text('quantity', '1', { inputmode: 'decimal' })),
          moneyField('Price of each *', text('unitCost', '', { inputmode: 'decimal' }), currency('currency')),
          UI.field('Part number', text('partNumber', '', { maxlength: '60' })),
          UI.field('Supplier', text('vendor', '', { maxlength: '80' }), 'Optional.')
        );
      }
      f.notes = el('textarea', { name: 'notes', rows: '3', maxlength: '2000' });
      fields.push(UI.field('Notes', f.notes));

      // photos: up to three, taken now or chosen from the phone
      var staged = [];
      var stagedBox = el('div', { class: 'stack' });
      var pickMsg = el('div');
      function drawStaged() {
        stagedBox.replaceChildren.apply(stagedBox, staged.map(function (s, i) {
          var rm = el('button', { type: 'button', class: 'btn small danger', text: 'Remove' });
          rm.addEventListener('click', function () { staged.splice(i, 1); drawStaged(); });
          return el('div', { class: 'attach-row' }, [el('div', { class: 'attach-name', text: '📷 ' + s.name }), rm]);
        }));
        picker.take.hidden = picker.choose.hidden = staged.length >= 3;
      }
      var picker = Photos.picker(function (file) {
        pickMsg.replaceChildren();
        if (staged.length >= 3) return;
        staged.push({ file: file, name: file.name || 'photo.jpg' });
        drawStaged();
      });
      fields.push(el('div', { class: 'field' }, [
        el('label', { text: 'Photos (up to 3)' }),
        el('div', { class: 'hint', text: 'For example the work done, or the receipt or part.' }),
        pickMsg, stagedBox, el('div', { class: 'btn-row' }, [picker.take, picker.choose]),
      ]));
      drawStaged();

      var btn = el('button', { type: 'submit', class: 'btn block big save-gap', text: type === 'Purchase' ? 'Add purchased item' : 'Add maintenance' });
      var form = el('form', { novalidate: true }, fields.concat([btn]));
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        msg.replaceChildren();
        var vals = {};
        Object.keys(f).forEach(function (k) { vals[k] = f[k].value; });
        var work = FleetApi.callGuest(carId, 'guestSaveEntry', { type: type, fields: vals }).then(function (res) {
          var entryId = res.data.entry.id;
          // photos one at a time; if one fails the entry is still saved
          return staged.reduce(function (chain, s) {
            return chain.then(function (failed) {
              if (failed) return failed;
              return Photos.prepareAttachment(s.file).then(function (a) {
                return FleetApi.callGuest(carId, 'guestUploadAttachment', { entryId: entryId, mime: a.mime, data: a.data, filename: a.filename }).then(function () { return ''; });
              }).catch(function (e) { return 'The entry was saved, but "' + s.name + '" could not be attached: ' + UI.errorText(e); });
            });
          }, Promise.resolve('')).then(function (failed) {
            FleetApp.setFlash(failed ? 'error' : 'ok', failed || 'Added. Thank you.');
            FleetApp.go('/guest/' + carId);
          });
        });
        UI.busy(btn, 'Saving…', work).catch(function (e) {
          msg.replaceChildren(UI.notice('error', UI.errorText(e)));
          window.scrollTo(0, 0);
        });
      });

      root.replaceChildren(el('section', { class: 'card' }, [
        fmt().backLink('#/guest/' + carId, car.registration),
        el('h1', { text: type === 'Purchase' ? 'Add a purchased item' : 'Add maintenance' }),
        el('p', { class: 'muted', text: 'Recorded as "' + me.name + '". You can delete it later, but not edit it, so check it before you save.' }),
        msg, form,
      ]));
    }
  };

  // ---------- 4. the admin card on the car page ----------
  function guestCard(car) {
    var isAdmin = FleetAuth.isAdmin();
    var body = el('div');
    var msg = el('div');
    var state = { enabled: !!car.guestEnabled };

    function explain() {
      return state.enabled
        ? 'On (this is the default). Anyone who scans this car\'s QR code without being signed in opens it as a guest. They can see its maintenance history (no costs and no purchases) and add maintenance or purchased items under a name they choose. Their access lasts ' + DAYS + ' days, they cannot edit, and they can delete only what they added. Everything they add is marked "Guest: name".'
        : 'Off. Anyone who scans this car\'s QR code is asked to sign in. Switch it on to let garages use the QR code without an account.';
    }

    function guestRow(g) {
      var status = g.blocked ? 'Blocked' : g.active ? 'Active' : 'Expired';
      var btn = null;
      if (isAdmin && (g.blocked || g.active)) {
        btn = el('button', { type: 'button', class: 'btn small ' + (g.blocked ? 'secondary' : 'danger'), text: g.blocked ? 'Unblock' : 'Block' });
        btn.addEventListener('click', function () {
          if (!g.blocked && !window.confirm('Block "' + g.name + '"? They are signed out at once, and their name stays reserved.')) return;
          UI.busy(btn, '…', FleetApi.call('setGuestBlocked', { id: g.id, blocked: !g.blocked })).then(loadGuests)
            .catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
        });
      }
      return el('div', { class: 'entry-line' }, [el('div', { class: 'entry-row' }, [
        el('div', { class: 'entry-main' }, [
          el('div', { class: 'entry-title', text: g.name }),
          el('div', { class: 'muted small-text', text: 'Joined ' + dateText(g.joinedAt.slice(0, 10)) + ' · ' + g.entries + (g.entries === 1 ? ' entry' : ' entries') }),
        ]),
        el('div', { class: 'entry-tags' }, [el('span', { class: 'chip ' + (g.blocked ? 's-overdue' : g.active ? 's-ok' : 's-paused'), text: status }), btn]),
      ])]);
    }

    var guestsBox = el('div', { class: 'history' });
    function loadGuests() {
      if (!isAdmin) return Promise.resolve();
      return FleetApi.call('listGuests', { carId: car.id }).then(function (r) {
        var gs = r.data.guests;
        guestsBox.replaceChildren.apply(guestsBox, gs.length
          ? [el('h3', { text: 'Guests' })].concat(gs.map(guestRow))
          : [el('p', { class: 'muted small-text', text: 'No guest has used this car yet.' })]);
      }).catch(function (e) { guestsBox.replaceChildren(UI.notice('error', UI.errorText(e))); });
    }

    function draw() {
      var note = el('p', { class: 'muted', text: explain() });
      var kids = [note];
      if (isAdmin) {
        var toggle = el('button', { type: 'button', class: 'btn small' + (state.enabled ? ' danger' : ''), text: state.enabled ? 'Switch off guest access' : 'Switch on guest access' });
        toggle.addEventListener('click', function () {
          msg.replaceChildren();
          if (state.enabled && !window.confirm('Switch off guest access? Guests are locked out at once. You can switch it back on later.')) return;
          UI.busy(toggle, 'Saving…', FleetApi.call('setGuestAccess', { carId: car.id, enabled: !state.enabled })).then(function (r) {
            state.enabled = r.data.enabled;
            Views.invalidateCars();
            draw();
          }).catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
        });
        var replace = el('button', { type: 'button', class: 'btn small secondary', text: 'Replace QR code' });
        replace.addEventListener('click', function () {
          msg.replaceChildren();
          if (!window.confirm('Make a new QR code for this car? Labels already printed stop working for guests until you print the new one. Signed-in people can still use the old label, and guests already in are not signed out.')) return;
          UI.busy(replace, 'Replacing…', FleetApi.call('replaceGuestSecret', { carId: car.id })).then(function () {
            FleetApp.setFlash('ok', 'A new QR code has been made. Print a new label for this car.');
            FleetApp.go('/car/' + car.id);
          }).catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
        });
        kids.push(el('div', { class: 'btn-row' }, [toggle, replace]));
      } else {
        kids.push(el('p', { class: 'muted small-text', text: 'An administrator can change this.' }));
      }
      kids.push(msg, guestsBox);
      body.replaceChildren.apply(body, kids);
    }
    draw();
    loadGuests();
    return el('section', { class: 'card' }, [el('h2', { text: 'Guest access' }), body]);
  }

  // The guest flag shown on the staff timeline.
  function guestChip(e) {
    return e.guestName ? el('span', { class: 'chip g-guest', text: 'Guest: ' + e.guestName }) : null;
  }

  window.GuestUI = { card: guestCard, chip: guestChip };
})();
