// Who owns / is the registered keeper of which cars.
//  - "My cars" (any user, from the profile page, or an admin editing someone else's cars)
//  - "Edit owners and keepers" for one car (admins)
(function () {
  'use strict';

  var el = UI.el;
  var Views = (window.Views = window.Views || {});

  function carLine(c) {
    return c.registration + ' · ' + c.make + ' ' + c.model + (c.year ? ' (' + c.year + ')' : '');
  }

  function loading() { return el('p', { class: 'muted center pad', text: 'Loading…' }); }

  function roleBoxes(owner, keeper) {
    var o = el('input', { type: 'checkbox' });
    var k = el('input', { type: 'checkbox' });
    o.checked = !!owner;
    k.checked = !!keeper;
    return {
      owner: o, keeper: k,
      node: el('div', { class: 'role-boxes' }, [
        el('label', { class: 'check' }, [o, el('span', { text: 'Owner' })]),
        el('label', { class: 'check' }, [k, el('span', { text: 'Registered keeper' })]),
      ]),
    };
  }

  // ---------- a user's cars ----------
  Views.userCars = function (ctx, root) {
    var userId = ctx.params.userId || '';
    var me = FleetAuth.getUser();
    var msg = el('div');
    var body = el('div', { class: 'stack' }, [loading()]);
    var card = el('section', { class: 'card' }, [msg, body]);
    root.replaceChildren(card);

    FleetApi.call('getUserCars', userId ? { userId: userId } : {}).then(function (r) {
      var self = !userId || userId === me.id;
      var rows = r.data.cars.map(function (c) {
        var boxes = roleBoxes(c.owner, c.keeper);
        return { car: c, boxes: boxes, node: el('div', { class: 'person-row' }, [el('div', { class: 'person-car', text: carLine(c) }), boxes.node]) };
      });
      var saveBtn = el('button', { type: 'button', class: 'btn block save-gap', text: 'Save' });
      saveBtn.addEventListener('click', function () {
        msg.replaceChildren();
        var cars = rows.map(function (x) { return { carId: x.car.carId, owner: x.boxes.owner.checked, keeper: x.boxes.keeper.checked }; });
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
        el('p', { class: 'muted', text: 'Tick the cars ' + (self ? 'you own' : 'they own') + ' and the cars ' + (self ? 'you are' : 'they are') +
          ' the registered keeper of. The registered keeper is the person named on the car\'s registration as responsible for it. Tick neither if it is not ' + (self ? 'yours' : 'theirs') + '.' }),
        rows.length ? el('div', { class: 'stack' }, rows.map(function (x) { return x.node; })) : el('p', { class: 'muted', text: 'There are no cars in the fleet yet.' }),
        rows.length ? saveBtn : null
      );
    }).catch(function (e) {
      body.replaceChildren();
      if (e.code !== 'unauthorized') msg.replaceChildren(UI.notice('error', UI.errorText(e)));
    });
  };

  // ---------- one car's owners and keepers (admin) ----------
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
        var boxes = roleBoxes(
          people.owners.some(function (x) { return x.userId === u.id; }),
          people.keepers.some(function (x) { return x.userId === u.id; })
        );
        return {
          user: u, boxes: boxes,
          node: el('div', { class: 'person-row' }, [
            el('div', { class: 'person-car' }, [el('div', { text: u.name }), el('div', { class: 'muted small-text', text: u.email })]),
            boxes.node,
          ]),
        };
      });
      var saveBtn = el('button', { type: 'button', class: 'btn block save-gap', text: 'Save' });
      saveBtn.addEventListener('click', function () {
        msg.replaceChildren();
        var list = rows.map(function (x) { return { userId: x.user.id, owner: x.boxes.owner.checked, keeper: x.boxes.keeper.checked }; });
        UI.busy(saveBtn, 'Saving…', FleetApi.call('setCarPeople', { carId: car.id, people: list }))
          .then(function () { Views.invalidateCars(); FleetApp.go('/car/' + car.id); })
          .catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
      });
      body.replaceChildren(
        el('a', { class: 'back', href: '#/car/' + car.id, text: '← ' + car.registration }),
        el('h1', { text: 'Owners and keepers' }),
        el('p', { class: 'muted', text: car.make + ' ' + car.model + '. Choose who owns it and who is the registered keeper. For people who are not app users, use the "Other owner" and "Other registered keeper" boxes when editing the car.' }),
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
