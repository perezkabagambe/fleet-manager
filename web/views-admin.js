// Admin: user management.
(function () {
  'use strict';

  var el = UI.el;
  var Views = (window.Views = window.Views || {});

  function fmt(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  Views.adminUsers = function (ctx, root) {
    var focus = ctx.query.focus || '';
    var me = FleetAuth.getUser();
    var msg = el('div');
    var listBox = el('div', { class: 'stack' });
    root.replaceChildren(el('section', { class: 'card' }, [el('h1', { text: 'Users' }), msg, listBox]));

    function act(btn, label, action, params, confirmText) {
      function go() {
        msg.replaceChildren();
        UI.busy(btn, label, FleetApi.call(action, params))
          .then(load)
          .catch(function (e) { msg.append(UI.notice('error', UI.errorText(e))); });
      }
      if (!confirmText) return go();
      UI.confirm(confirmText, { okLabel: 'Yes', danger: true }).then(function (yes) { if (yes) go(); });
    }

    function userCard(u) {
      var isSelf = me && u.id === me.id;
      var actions = [];
      function button(text, cls, fn) {
        var b = el('button', { type: 'button', class: 'btn small ' + cls, text: text });
        b.addEventListener('click', function () { fn(b); });
        actions.push(b);
      }
      if (u.status === 'Pending') {
        button('Approve', '', function (b) { act(b, 'Approving…', 'setUserStatus', { userId: u.id, status: 'Approved' }); });
        button('Reject', 'secondary', function (b) { act(b, 'Rejecting…', 'setUserStatus', { userId: u.id, status: 'Rejected' }, 'Reject the request from ' + u.name + '?'); });
      } else if (u.status === 'Approved') {
        if (u.role === 'admin') button('Make regular user', 'secondary', function (b) { act(b, 'Saving…', 'setUserRole', { userId: u.id, role: 'user' }, 'Remove admin rights from ' + u.name + '?'); });
        else button('Make admin', 'secondary', function (b) { act(b, 'Saving…', 'setUserRole', { userId: u.id, role: 'admin' }, 'Make ' + u.name + ' an admin? Admins can approve users and delete cars.'); });
        actions.push(el('a', { class: 'btn small secondary', href: '#/admin/users/' + u.id + '/cars', text: 'Cars' }));
        if (!isSelf) button('Revoke access', 'danger', function (b) { act(b, 'Revoking…', 'setUserStatus', { userId: u.id, status: 'Revoked' }, 'Revoke access for ' + u.name + '? They will be signed out immediately.'); });
      } else {
        button('Approve again', '', function (b) { act(b, 'Approving…', 'setUserStatus', { userId: u.id, status: 'Approved' }); });
      }

      var meta = [];
      if (u.status === 'Pending') meta.push('Requested ' + fmt(u.requestedAt));
      else if (u.lastLogin) meta.push('Last signed in ' + fmt(u.lastLogin));
      else meta.push('Never signed in');

      return el('article', { class: 'user' + (u.id === focus ? ' focus' : ''), id: 'user-' + u.id }, [
        el('div', { class: 'user-head' }, [
          el('div', {}, [
            el('div', { class: 'user-name', text: u.name + (isSelf ? ' (you)' : '') }),
            el('div', { class: 'muted small-text', text: u.email }),
          ]),
          el('div', { class: 'badges' }, [
            u.role === 'admin' && u.status === 'Approved' ? el('span', { class: 'badge admin', text: 'Admin' }) : null,
            el('span', { class: 'badge ' + u.status.toLowerCase(), text: u.status }),
          ]),
        ]),
        el('div', { class: 'muted small-text', text: meta.join(' · ') }),
        el('div', { class: 'actions' }, actions),
      ]);
    }

    function section(title, users) {
      if (!users.length) return null;
      return el('div', {}, [el('h2', { class: 'section-title', text: title + ' (' + users.length + ')' })].concat(users.map(userCard)));
    }

    function load() {
      return FleetApi.call('listUsers').then(function (r) {
        var u = r.data.users;
        function by(s) { return u.filter(function (x) { return x.status === s; }); }
        listBox.replaceChildren.apply(listBox, [
          section('Waiting for approval', by('Pending')),
          section('Active users', by('Approved')),
          section('Revoked', by('Revoked')),
          section('Rejected', by('Rejected')),
        ].filter(Boolean));
        if (!u.length) listBox.append(el('p', { class: 'muted', text: 'No users yet.' }));
        var f = focus && document.getElementById('user-' + focus);
        if (f) f.scrollIntoView({ block: 'center' });
      }).catch(function (e) {
        msg.replaceChildren(UI.notice('error', UI.errorText(e)));
      });
    }

    listBox.append(el('p', { class: 'muted', text: 'Loading…' }));
    load();
  };
})();
