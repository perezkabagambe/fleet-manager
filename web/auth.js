// Client-side session holder. The session token lives in localStorage (with an
// in-memory fallback if storage is blocked). The server is the real authority:
// every request is re-checked there, and tokens can be revoked at any time.
(function () {
  'use strict';

  var KEY = 'fleet.session';
  var memory = null;
  var user = null;

  function read() {
    var s = memory;
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) s = JSON.parse(raw);
    } catch (e) { /* storage unavailable: use memory */ }
    if (s && s.token && Date.parse(s.expiresAt) > Date.now()) return s;
    return null;
  }

  function save(session) {
    memory = session;
    try { localStorage.setItem(KEY, JSON.stringify(session)); } catch (e) { /* ignore */ }
  }

  function clear() {
    memory = null;
    user = null;
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
  }

  window.FleetAuth = {
    token: function () { var s = read(); return s ? s.token : ''; },
    hasSession: function () { return !!read(); },
    save: save,
    clear: clear,
    getUser: function () { return user; },
    setUser: function (u) { user = u; },
    isAdmin: function () { return !!user && user.role === 'admin'; },
  };
})();
