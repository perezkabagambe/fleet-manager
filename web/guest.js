// Guest sessions: a garage or visitor who scanned a car's QR code and gave a name.
// One small record per car in this browser. The server is the real authority: the token can be
// blocked, expire (14 days) or be switched off at any time.
(function () {
  'use strict';

  var KEY = 'fleet.guests';
  var memory = {};

  function readAll() {
    var all = memory;
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) all = JSON.parse(raw) || {};
    } catch (e) { /* storage unavailable: use memory */ }
    return all;
  }

  function writeAll(all) {
    memory = all;
    try { localStorage.setItem(KEY, JSON.stringify(all)); } catch (e) { /* ignore */ }
  }

  window.FleetGuest = {
    /** { token, expiresAt, name } for this car, or null if there is none or it has run out. */
    get: function (carId) {
      var g = readAll()[carId];
      return g && g.token && Date.parse(g.expiresAt) > Date.now() ? g : null;
    },
    /** Any current guest session on this phone, as { carId, token, expiresAt, name }, or null. */
    any: function () {
      var all = readAll();
      var id = Object.keys(all).filter(function (k) { return all[k] && all[k].token && Date.parse(all[k].expiresAt) > Date.now(); })[0];
      return id ? Object.assign({ carId: id }, all[id]) : null;
    },
    save: function (carId, g) {
      var all = readAll();
      all[carId] = { token: g.token, expiresAt: g.expiresAt, name: g.name };
      writeAll(all);
    },
    clear: function (carId) {
      var all = readAll();
      delete all[carId];
      writeAll(all);
    },
  };
})();
