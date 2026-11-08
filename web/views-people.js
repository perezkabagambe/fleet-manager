// Who owns, or is the custodian of, which cars.
//  - "My cars" (any user, from the profile page, or an admin editing someone else's cars)
//  - "Edit owners/custodians" for one car (admins)
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
            if (self) Views.skipCarPrompt(me.id); // answered, so the nudge on the fleet screen can stop
            msg.replaceChildren(UI.notice('ok', 'Saved.'));
          })
          .catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
      });
      body.replaceChildren(
        el('a', { class: 'back', href: self ? '#/profile' : '#/admin/users', text: '← ' + (self ? 'Profile' : 'Users') }),
        el('h1', { text: self ? 'My cars' : 'Cars for ' + r.data.user.name }),
        el('p', { class: 'muted', text: 'Tick the cars ' + (self ? 'you own or look after' : 'they own or look after') + '. Leave a car unticked if it is not ' + (self ? 'yours' : 'theirs') + '.' }),
        rows.length ? el('div', { class: 'stack' }, rows.map(function (x) { return x.node; })) : el('p', { class: 'muted', text: 'There are no cars in the fleet yet.' }),
        rows.length ? saveBtn : null
      );
    }).catch(function (e) {
      body.replaceChildren();
      if (e.code !== 'unauthorized') msg.replaceChildren(UI.notice('error', UI.errorText(e)));
    });
  };

  // ---------- one car's owners/custodians (admin) ----------
  Views.carPeople = function (ctx, root) {
    var carId = ctx.params.id;
    var msg = el('div');
    var body = el('div', { class: 'stack' }, [loading()]);
    root.replaceChildren(el('section', { class: 'card' }, [msg, body]));

    Promise.all([FleetApi.call('getCar', { id: carId }), FleetApi.call('listUsers')]).then(function (res) {
      var car = res[0].data.car;
      var people = res[0].data.people;
      var users = res[1].data.users.filter(function (u) { return u.status === 'Approved'; });
      var rows = users.map(function (u) {
        var o = ownerBox(people.owners.some(function (x) { return x.userId === u.id; }), 'Owner/Custodian');
        return {
          user: u, box: o.box,
          node: el('div', { class: 'person-row' }, [
            el('div', { class: 'person-car' }, [el('div', { text: u.name }), el('div', { class: 'muted small-text', text: u.email })]),
            o.node,
          ]),
        };
      });
      var saveBtn = el('button', { type: 'button', class: 'btn block save-gap', text: 'Save' });
      saveBtn.addEventListener('click', function () {
        msg.replaceChildren();
        var list = rows.map(function (x) { return { userId: x.user.id, owner: x.box.checked }; });
        UI.busy(saveBtn, 'Saving…', FleetApi.call('setCarPeople', { carId: car.id, people: list }))
          .then(function () { Views.invalidateCars(); FleetApp.go('/car/' + car.id); })
          .catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
      });
      body.replaceChildren(
        el('a', { class: 'back', href: '#/car/' + car.id, text: '← ' + car.registration }),
        el('h1', { text: 'Owners/Custodians' }),
        el('p', { class: 'muted', text: car.make + ' ' + car.model + '. Choose who owns or looks after it. For people who are not app users, use the "Other owner/custodian" box when editing the car.' }),
        el('div', { class: 'stack' }, rows.map(function (x) { return x.node; })),
        saveBtn
      );
    }).catch(function (e) {
      body.replaceChildren();
      if (e.code === 'not_found') msg.replaceChildren(UI.notice('error', 'That car could not be found.'));
      else if (e.code !== 'unauthorized') msg.replaceChildren(UI.notice('error', UI.errorText(e)));
    });
  };
})();
