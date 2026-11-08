// Who owns, or is the custodian of, which cars.
//  - "My cars" (any user, from the profile page, or an admin editing someone else's cars)
(function () {
  'use strict';

  var el = UI.el;
  var Views = (window.Views = window.Views || {});

  function carLine(c) {
    return c.registration + ' · ' + c.make + ' ' + c.model + (c.year ? ' (' + c.year + ')' : '');
  }

  function loading() { return el('p', { class: 'muted center pad', text: 'Loading…' }); }

  function ownerBox(checked, label) {
    var box = el('input', { type: 'checkbox' });
    box.checked = !!checked;
    return { box: box, node: el('label', { class: 'check' }, [box, el('span', { text: label })]) };
  }

  // ---------- a user's cars ----------
  Views.userCars = function (ctx, root) {
    var userId = ctx.params.userId || '';
    var me = FleetAuth.getUser();
    var msg = el('div');
    var body = el('div', { class: 'stack' }, [loading()]);
    root.replaceChildren(el('section', { class: 'card' }, [msg, body]));

    FleetApi.call('getUserCars', userId ? { userId: userId } : {}).then(function (r) {
      var self = !userId || userId === me.id;
      var rows = r.data.cars.map(function (c) {
        var o = ownerBox(c.owner, 'Owner/Custodian');
        return { car: c, box: o.box, node: el('div', { class: 'person-row' }, [el('div', { class: 'person-car', text: carLine(c) }), o.node]) };
      });
      var saveBtn = el('button', { type: 'button', class: 'btn block save-gap', text: 'Save' });
      saveBtn.addEventListener('click', function () {
        msg.replaceChildren();
        var cars = rows.map(function (x) { return { carId: x.car.carId, owner: x.box.checked }; });
        UI.busy(saveBtn, 'Saving…', FleetApi.call('saveUserCars', userId ? { userId: userId, cars: cars } : { cars: cars }))
          .then(function () {
            Views.invalidateCars();
            msg.replaceChildren(UI.notice('ok', 'Saved.'));
          })
          .catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
      });
      body.replaceChildren(
        el('a', { class: 'back', href: self ? '#/profile' : '#/admin/users', text: '← ' + (self ? 'Profile' : 'Users') }),
        el('h1', { text: self ? 'My cars' : 'Cars for ' + r.data.user.name }),
        el('p', { class: 'muted', text: 'Tick the cars ' + (self ? 'you own or look after' : 'they own or look after') + '. Leave a car unticked if it is not ' + (self ? 'yours' : 'theirs') + '.' }),
        rows.length ? el('div', { class: 'stack' }, rows.map(function (x) { return x.node; })) : el('p', { class: 'muted', text: 'There are no cars in the fleet yet.' }),
        rows.length ? saveBtn : null,
        // Not in the list yet? Add it here. It will be ticked as yours automatically.
        self ? el('div', { class: 'add-car' }, [
          el('p', { class: 'muted', text: 'Is your car not listed?' }),
          el('a', { class: 'btn secondary', href: '#/car/new?mine=1', text: 'Add a new car' }),
        ]) : null
      );
    }).catch(function (e) {
      body.replaceChildren();
      if (e.code !== 'unauthorized') msg.replaceChildren(UI.notice('error', UI.errorText(e)));
    });
  };
})();
