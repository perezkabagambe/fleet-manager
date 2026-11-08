// Fleet list, car page, add/edit form, fluids editor and printable QR label.
(function () {
  'use strict';

  var el = UI.el;
  var Views = (window.Views = window.Views || {});
  var cfg = window.FLEET_CONFIG;

  var FLUID_TEMPLATE = [
    'Engine oil', 'Gearbox oil / ATF', 'Front differential oil', 'Rear differential oil', 'Transfer case oil',
    'Coolant', 'Brake fluid', 'Power steering fluid', 'Washer fluid', 'AC refrigerant',
  ];

  // Greyed-out examples shown in an empty Specification / Capacity box. They are
  // only suggestions of a typical standard for that kind of fluid, never saved.
  // Order matters: the first pattern that matches the fluid name wins.
  var FLUID_HINTS = [
    [/transfer/i, { spec: 'e.g. 75W-90 API GL-4', cap: 'e.g. 1 L' }],
    [/differential|diff\b/i, { spec: 'e.g. 75W-90 API GL-5', cap: 'e.g. 1.2 L' }],
    [/engine|motor oil/i, { spec: 'e.g. 5W-30 ACEA C3', cap: 'e.g. 5.5 L' }],
    [/gearbox|transmission|\batf\b|gear oil/i, { spec: 'e.g. ATF Dexron VI, or 75W-80 GL-4', cap: 'e.g. 7 L' }],
    [/coolant|antifreeze/i, { spec: 'e.g. OAT coolant (G12+), 50/50', cap: 'e.g. 8 L' }],
    [/brake|clutch/i, { spec: 'e.g. DOT 4', cap: 'e.g. 1 L' }],
    [/steering/i, { spec: 'e.g. ATF Dexron III, or CHF 11S', cap: 'e.g. 1 L' }],
    [/washer|screen/i, { spec: 'e.g. screenwash, ready mixed', cap: 'e.g. 3 L' }],
    [/refrigerant|a\/c|\bac\b|air con/i, { spec: 'e.g. R134a or R1234yf', cap: 'e.g. 450 g' }],
  ];
  var FLUID_HINT_DEFAULT = { spec: 'e.g. grade or standard', cap: 'e.g. 1 L' };
  function fluidHint(name) {
    for (var i = 0; i < FLUID_HINTS.length; i++) {
      if (FLUID_HINTS[i][0].test(name || '')) return FLUID_HINTS[i][1];
    }
    return FLUID_HINT_DEFAULT;
  }

  var CURRENCY_OPTIONS = [['GBP', 'GBP (£)'], ['UGX', 'UGX (USh)'], ['USD', 'USD ($)'], ['KES', 'KES (KSh)'], ['EUR', 'EUR (€)']];

  var carsCache = null; // last fleet list: shown instantly while a fresh copy loads

  // Other screens call these to keep the fleet list fresh and to remember a "Not now" on the nudge.
  Views.invalidateCars = function () { carsCache = null; };
  Views.skipCarPrompt = function (userId) {
    try { localStorage.setItem('fleet.skipCars.' + userId, '1'); } catch (e) { /* remembered only for this visit */ }
  };
  Views.carPromptSkipped = function (userId) {
    try { return localStorage.getItem('fleet.skipCars.' + userId) === '1'; } catch (e) { return false; }
  };

  // ---------- helpers ----------
  function num(n) { return n === null || n === undefined ? '–' : Number(n).toLocaleString('en-GB'); }
  function carTitle(c) { return c.make + ' ' + c.model + (c.year ? ' (' + c.year + ')' : ''); }
  // The date is stored as YYYY, YYYY-MM or YYYY-MM-DD; show only the precision that is known.
  function fmtAcquired(s) {
    if (!s) return '';
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var p = s.split('-');
    if (p.length === 1) return p[0];
    if (p.length === 2) return months[Number(p[1]) - 1] + ' ' + p[0];
    return Number(p[2]) + ' ' + months[Number(p[1]) - 1] + ' ' + p[0];
  }
  // Show where a link goes (e.g. partsouq.com) so nobody taps it blind.
  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return 'link'; }
  }
  function money(n, currency) {
    try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency }).format(n); }
    catch (e) { return currency + ' ' + n; }
  }
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function chip(status) {
    return el('span', { class: 'chip ' + status.toLowerCase().replace(/[^a-z]/g, ''), text: status });
  }
  // Thumbnail on the fleet list, full-size on the car page. Falls back to a placeholder.
  function photo(car, cls, kind) {
    return Photos.element(car, kind || 'thumb', cls);
  }
  function loading() { return el('p', { class: 'muted center pad', text: 'Loading…' }); }
  function backLink(href, text) { return el('a', { class: 'back', href: href, text: '← ' + text }); }
  function notFound(root) {
    root.replaceChildren(el('section', { class: 'card' }, [
      el('h1', { text: 'Car not found' }),
      el('p', { class: 'muted', text: 'It may have been deleted.' }),
      el('a', { class: 'btn', href: '#/', text: 'Back to fleet' }),
    ]));
  }

  function qrDataUrl(text) {
    var qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }));
  }
  function carUrl(id) { return (cfg.siteUrl || location.origin + location.pathname) + '#/car/' + id; }

  // ---------- fleet ----------
  Views.fleet = function (ctx, root) {
    var msg = el('div');
    var grid = el('div', { class: 'car-grid' });
    var deletedBox = el('div');
    var promptBox = el('div');
    root.replaceChildren(el('section', { class: 'card' }, [
      el('div', { class: 'page-head' }, [
        el('h1', { text: 'Fleet' }),
        el('a', { class: 'btn small', href: '#/car/new', text: 'Add car' }),
      ]),
      msg, promptBox, grid, deletedBox,
    ]));

    function card(c, mine) {
      return el('a', { class: 'car-card', href: '#/car/' + c.id }, [
        photo(c),
        el('div', { class: 'car-card-body' }, [
          el('div', { class: 'reg', text: c.registration }),
          el('div', { class: 'muted small-text', text: carTitle(c) }),
          el('div', { class: 'car-card-foot' }, [
            chip(c.status),
            el('span', { class: 'muted small-text', text: c.odometer === null ? '' : num(c.odometer) + ' ' + c.distanceUnit }),
          ]),
          mine && mine.owner ? el('div', { class: 'mine' }, [el('span', { class: 'chip sold', text: 'Yours' })]) : null,
        ]),
      ]);
    }

    // First-time nudge: asks which cars you own or keep, until you answer or tap "Not now".
    function prompt(data) {
      var me = FleetAuth.getUser();
      var answered = Object.keys(data.mine || {}).length > 0;
      if (!me || answered || !data.cars.length || Views.carPromptSkipped(me.id)) return null;
      var skip = el('button', { type: 'button', class: 'btn small secondary', text: 'Not now' });
      var box = el('div', { class: 'prompt' }, [
        el('strong', { text: 'Do you own or look after any of these cars?' }),
        el('p', { class: 'muted small-text', text: 'Tell us which ones you own or are the custodian of, or add a car that is not here yet.' }),
        el('div', { class: 'btn-row' }, [
          el('a', { class: 'btn small', href: '#/profile/cars', text: 'Choose my cars' }),
          el('a', { class: 'btn small secondary', href: '#/car/new?mine=1', text: 'Add a new car' }),
          skip,
        ]),
      ]);
      skip.addEventListener('click', function () { Views.skipCarPrompt(me.id); box.remove(); });
      return box;
    }

    function render(data) {
      promptBox.replaceChildren();
      var pr = prompt(data);
      if (pr) promptBox.append(pr);
      grid.replaceChildren.apply(grid, data.cars.length
        ? data.cars.map(function (c) { return card(c, (data.mine || {})[c.id]); })
        : [el('div', { class: 'empty' }, [
          el('p', { text: 'No cars yet.' }),
          el('a', { class: 'btn', href: '#/car/new?mine=1', text: 'Add your first car' }),
        ])]);
      deletedBox.replaceChildren();
      if (data.deleted && data.deleted.length) {
        var list = data.deleted.map(function (c) {
          var b = el('button', { type: 'button', class: 'btn small secondary', text: 'Restore' });
          b.addEventListener('click', function () {
            UI.busy(b, 'Restoring…', FleetApi.call('restoreCar', { id: c.id }))
              .then(function () { carsCache = null; Views.fleet(ctx, root); })
              .catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
          });
          return el('div', { class: 'deleted-row' }, [
            el('span', { text: c.registration + ' · ' + carTitle(c) }), b,
          ]);
        });
        deletedBox.append(el('details', { class: 'deleted' }, [el('summary', { text: 'Deleted cars (' + data.deleted.length + ')' })].concat(list)));
      }
    }

    if (carsCache) render(carsCache); else grid.append(loading());
    FleetApi.call('listCars').then(function (r) {
      carsCache = r.data;
      render(r.data);
    }).catch(function (e) {
      if (e.code !== 'unauthorized') msg.replaceChildren(UI.notice('error', UI.errorText(e)));
      if (!carsCache) grid.replaceChildren();
    });
  };

  // ---------- car page ----------
  Views.car = function (ctx, root) {
    var id = ctx.params.id;
    root.replaceChildren(el('section', { class: 'card' }, [loading()]));

    FleetApi.call('getCar', { id: id }).then(function (r) {
      render(r.data.car, r.data.fluids, r.data.people || { owners: [] });
    }).catch(function (e) {
      if (e.code === 'not_found') notFound(root);
      else if (e.code !== 'unauthorized') root.replaceChildren(el('section', { class: 'card' }, [UI.notice('error', UI.errorText(e)), backLink('#/', 'Fleet')]));
    });

    function render(car, fluids, people) {
      var msg = el('div');

      // odometer
      var odoInput = el('input', { type: 'text', inputmode: 'numeric', name: 'odometer', autocomplete: 'off', placeholder: 'New reading' });
      var odoBtn = el('button', { type: 'submit', class: 'btn small', text: 'Update' });
      var odoForm = el('form', { class: 'inline-form', novalidate: true }, [
        el('label', { class: 'sr-only', for: 'odo-input', text: 'New odometer reading in ' + car.distanceUnit }), odoInput, odoBtn,
      ]);
      odoInput.id = 'odo-input';
      function sendOdometer(force) {
        return FleetApi.call('updateOdometer', { id: car.id, odometer: odoInput.value, forceOdometer: !!force }).then(function () {
          carsCache = null;
          Views.car(ctx, root);
        });
      }
      odoForm.addEventListener('submit', function (ev) {
        ev.preventDefault();
        msg.replaceChildren();
        UI.busy(odoBtn, 'Saving…', sendOdometer(false)).catch(function (e) {
          if (e.code === 'odometer_lower' && FleetAuth.isAdmin() &&
              window.confirm('That is lower than the current reading (' + num(car.odometer) + '). Correct it anyway?')) {
            UI.busy(odoBtn, 'Saving…', sendOdometer(true)).catch(function (e2) { msg.replaceChildren(UI.notice('error', UI.errorText(e2))); });
            return;
          }
          msg.replaceChildren(UI.notice('error', UI.errorText(e)));
        });
      });

      var flash = FleetApp.takeFlash();
      if (flash) msg.append(UI.notice(flash.kind, flash.text));

      // photo: take with the camera, choose from the gallery, or remove
      var photoStatus = el('div', { class: 'muted small-text', role: 'status' });
      var photoPicker = Photos.picker(function (file) {
        msg.replaceChildren();
        photoPicker.setBusy(true);
        photoStatus.textContent = 'Preparing photo…';
        Photos.prepare(file).then(function (p) {
          photoStatus.textContent = 'Uploading…';
          return FleetApi.call('uploadCarPhoto', { carId: car.id, full: p.full, thumb: p.thumb });
        }).then(function () {
          carsCache = null;
          Views.car(ctx, root);
        }).catch(function (e) {
          photoStatus.textContent = '';
          photoPicker.setBusy(false);
          msg.replaceChildren(UI.notice('error', UI.errorText(e)));
        });
      });
      var removePhotoBtn = null;
      if (car.photoThumbId) {
        removePhotoBtn = el('button', { type: 'button', class: 'btn small secondary', text: 'Remove photo' });
        removePhotoBtn.addEventListener('click', function () {
          if (!window.confirm('Remove this photo?')) return;
          UI.busy(removePhotoBtn, 'Removing…', FleetApi.call('removeCarPhoto', { carId: car.id }))
            .then(function () { carsCache = null; Views.car(ctx, root); })
            .catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
        });
      }

      // delete (admin)
      var deleteBtn = null;
      if (FleetAuth.isAdmin()) {
        deleteBtn = el('button', { type: 'button', class: 'btn small danger', text: 'Delete' });
        deleteBtn.addEventListener('click', function () {
          if (!window.confirm('Delete ' + car.registration + '? You can restore it later from the fleet page.')) return;
          UI.busy(deleteBtn, 'Deleting…', FleetApi.call('deleteCar', { id: car.id }))
            .then(function () { carsCache = null; FleetApp.go('/'); })
            .catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
        });
      }

      function detail(label, value) {
        return value ? [el('dt', { text: label }), el('dd', { text: value })] : [];
      }
      var details = [].concat(
        detail('Make and model', carTitle(car)),
        detail('Colour', car.colour),
        detail('VIN / chassis', car.vin),
        detail('Country', car.country === 'UG' ? 'Uganda' : 'United Kingdom'),
        detail('Acquired', fmtAcquired(car.acquisitionDate)),
        detail('Acquisition cost', car.acquisitionCost === null || car.acquisitionCost === undefined ? '' : money(car.acquisitionCost, car.acquisitionCurrency || car.currency))
      );

      // owner/custodian: names from app users, plus any free-text person who is not a user (change them with Edit car)
      var ownerNames = people.owners.map(function (x) { return x.name; }).concat(car.ownerOther ? [car.ownerOther] : []);
      var peopleCard = el('section', { class: 'card' }, [
        el('h2', { text: 'Owner/Custodian' }),
        el('p', { class: ownerNames.length ? '' : 'muted', text: ownerNames.length ? ownerNames.join(', ') : 'Not recorded yet.' }),
      ]);

      var fluidRows = fluids.map(function (f) {
        return el('li', { class: 'fluid' }, [
          el('div', { class: 'fluid-name', text: f.fluid }),
          el('div', { text: [f.specification, f.capacity].filter(Boolean).join(' · ') || '–' }),
          f.notes ? el('div', { class: 'muted small-text', text: f.notes }) : null,
        ]);
      });

      var editTop = el('a', { class: 'btn block big edit-top', href: '#/car/' + car.id + '/edit', text: 'Edit car' });
      var editBottom = el('a', { class: 'btn block big edit-bottom', href: '#/car/' + car.id + '/edit', text: 'Edit car' });

      root.replaceChildren(
        editTop,
        el('section', { class: 'card' }, [
          backLink('#/', 'Fleet'),
          el('div', { class: 'page-head' }, [
            el('div', {}, [
              el('h1', { text: car.registration }),
              el('div', { class: 'muted', text: [car.nickname, carTitle(car)].filter(Boolean).join(' · ') }),
            ]),
            chip(car.status),
          ]),
          msg,
          photo(car, 'big', 'full'),
          el('div', { class: 'btn-row' }, [photoPicker.take, photoPicker.choose, removePhotoBtn]),
          photoStatus,
          deleteBtn ? el('div', { class: 'btn-row' }, [deleteBtn]) : null,
        ]),
        el('section', { class: 'card' }, [
          el('h2', { text: 'Odometer' }),
          el('div', { class: 'big-number', text: car.odometer === null ? 'Not set' : num(car.odometer) + ' ' + car.distanceUnit }),
          car.odometerUpdatedAt ? el('div', { class: 'muted small-text', text: 'Updated ' + fmtDate(car.odometerUpdatedAt) }) : null,
          odoForm,
        ]),
        el('section', { class: 'card' }, [
          el('h2', { text: 'Details' }),
          el('dl', { class: 'details' }, details),
          car.notes ? el('p', { class: 'notes', text: car.notes }) : null,
        ]),
        peopleCard,
        el('section', { class: 'card' }, [
          el('h2', { text: 'Fluids and specs' }),
          fluids.length ? el('ul', { class: 'fluids' }, fluidRows) : el('p', { class: 'muted', text: 'No fluid specs recorded yet. Tap Edit car to add them.' }),
          el('div', { class: 'catalogue' }, car.partsouqUrl
            ? [el('a', { class: 'btn small secondary', href: car.partsouqUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Parts catalogue: ' + hostOf(car.partsouqUrl) })]
            : [el('span', { class: 'muted', text: 'No parts catalogue link yet. Tap Edit car to add one.' })]),
        ]),
        el('section', { class: 'card' }, [
          el('h2', { text: 'QR label' }),
          el('p', { class: 'muted', text: 'Stick this on the windscreen or glovebox. Scanning it opens this car (sign-in required).' }),
          el('img', { class: 'qr', src: qrDataUrl(carUrl(car.id)), alt: 'QR code for ' + car.registration, width: '140', height: '140' }),
          el('p', {}, [el('a', { class: 'btn small secondary', href: '#/car/' + car.id + '/label', text: 'Print label' })]),
        ]),
        el('section', { class: 'card muted' }, [
          el('p', { text: 'Issues, repairs, maintenance and costs for this car are coming in the next phases.' }),
          el('p', { class: 'small-text', text: 'Last changed ' + fmtDate(car.updatedAt) }),
        ]),
        editBottom
      );
    }
  };

  // ---------- fluids editor (one part of the car form) ----------
  function fluidsEditor(initial) {
    var rows = initial.map(function (f) { return Object.assign({}, f); });
    var list = el('div', { class: 'stack' });
    var datalist = el('datalist', { id: 'fluid-names' }, FLUID_TEMPLATE.map(function (n) { return el('option', { value: n }); }));

    function rowEl(row, i) {
      function inp(key, attrs) {
        var input = el('input', Object.assign({ type: 'text', value: row[key] || '', autocomplete: 'off' }, attrs || {}));
        input.addEventListener('input', function () { row[key] = input.value; });
        return input;
      }
      var fluidIn = inp('fluid', { list: 'fluid-names', maxlength: '40' });
      var specIn = inp('specification', { maxlength: '120' });
      var capIn = inp('capacity', { maxlength: '40' });
      // The examples follow the fluid name, so a differential oil never suggests an engine oil grade.
      function showHints() {
        var h = fluidHint(fluidIn.value);
        specIn.placeholder = h.spec;
        capIn.placeholder = h.cap;
      }
      fluidIn.addEventListener('input', showHints);
      showHints();
      var remove = el('button', { type: 'button', class: 'btn small danger', text: 'Remove' });
      remove.addEventListener('click', function () { rows.splice(i, 1); draw(); });
      return el('div', { class: 'fluid-edit' }, [
        UI.field('Fluid', fluidIn),
        UI.field('Specification', specIn),
        UI.field('Capacity', capIn),
        UI.field('Notes', inp('notes', { maxlength: '200' })),
        remove,
      ]);
    }

    function draw() {
      list.replaceChildren.apply(list, rows.length
        ? rows.map(rowEl)
        : [el('p', { class: 'muted', text: 'No fluids yet. Add one, or add the standard set.' })]);
    }

    var addBtn = el('button', { type: 'button', class: 'btn small secondary', text: 'Add fluid' });
    addBtn.addEventListener('click', function () { rows.push({ fluid: '', specification: '', capacity: '', notes: '' }); draw(); });
    var stdBtn = el('button', { type: 'button', class: 'btn small secondary', text: 'Add standard fluids' });
    stdBtn.addEventListener('click', function () {
      var have = rows.map(function (r) { return (r.fluid || '').toLowerCase(); });
      FLUID_TEMPLATE.forEach(function (n) {
        if (have.indexOf(n.toLowerCase()) === -1) rows.push({ fluid: n, specification: '', capacity: '', notes: '' });
      });
      draw();
    });

    // Rows with nothing in them are ignored when saving.
    function payload() {
      return rows
        .filter(function (r) { return (r.fluid || '').trim() || (r.specification || '').trim() || (r.capacity || '').trim(); })
        .map(function (r) { return { id: r.id, fluid: r.fluid || '', specification: r.specification || '', capacity: r.capacity || '', notes: r.notes || '' }; });
    }
    var snapshot = JSON.stringify(payload());
    draw();

    return {
      node: el('div', {}, [datalist, list, el('div', { class: 'btn-row' }, [addBtn, stdBtn])]),
      payload: payload,
      dirty: function () { return JSON.stringify(payload()) !== snapshot; },
      // After a save the server gives every row its id; keep them so a retry never duplicates a row.
      markSaved: function (saved) {
        rows = saved.map(function (f) { return Object.assign({}, f); });
        snapshot = JSON.stringify(payload());
        draw();
      },
    };
  }

  // ---------- owner/custodian editor (one part of the car form) ----------
  // Admins tick any approved user. Everyone else can only tick or untick themselves.
  function ownersEditor(people, users) {
    var me = FleetAuth.getUser();
    if (users) {
      var boxes = users.map(function (u) {
        var b = el('input', { type: 'checkbox' });
        b.checked = people.owners.some(function (x) { return x.userId === u.id; });
        return { user: u, box: b };
      });
      var ids = function () { return boxes.filter(function (x) { return x.box.checked; }).map(function (x) { return x.user.id; }).sort().join(','); };
      var snap = ids();
      return {
        node: el('div', { class: 'stack' }, boxes.map(function (x) {
          return el('label', { class: 'check' }, [x.box, el('span', { text: x.user.name + ' (' + x.user.email + ')' })]);
        })),
        dirty: function () { return ids() !== snap; },
        save: function (carId) {
          return FleetApi.call('setCarPeople', {
            carId: carId, people: boxes.map(function (x) { return { userId: x.user.id, owner: x.box.checked }; }),
          }).then(function () { snap = ids(); });
        },
      };
    }
    var meBox = el('input', { type: 'checkbox' });
    var savedMe = people.owners.some(function (x) { return x.userId === me.id; });
    meBox.checked = savedMe;
    var others = people.owners.filter(function (x) { return x.userId !== me.id; }).map(function (x) { return x.name; });
    return {
      node: el('div', {}, [
        el('label', { class: 'check' }, [meBox, el('span', { text: 'I am an owner/custodian of this car' })]),
        others.length ? el('p', { class: 'muted small-text', text: 'Also: ' + others.join(', ') }) : null,
      ]),
      dirty: function () { return meBox.checked !== savedMe; },
      save: function (carId) {
        return FleetApi.call('setMyCarRole', { carId: carId, owner: meBox.checked }).then(function () { savedMe = meBox.checked; });
      },
    };
  }

  // ---------- add / edit form: everything about a car in one place ----------
  Views.carForm = function (ctx, root) {
    var id = ctx.params.id || '';
    root.replaceChildren(el('section', { class: 'card' }, [loading()]));
    if (!id) { build(null, [], { owners: [] }, null); return; }
    var calls = [FleetApi.call('getCar', { id: id })];
    if (FleetAuth.isAdmin()) calls.push(FleetApi.call('listUsers')); // admins can pick any user as an owner/custodian
    Promise.all(calls).then(function (res) {
      var users = res[1] ? res[1].data.users.filter(function (u) { return u.status === 'Approved'; }) : null;
      build(res[0].data.car, res[0].data.fluids, res[0].data.people || { owners: [] }, users);
    }).catch(function (e) {
      if (e.code === 'not_found') notFound(root);
      else if (e.code !== 'unauthorized') root.replaceChildren(el('section', { class: 'card' }, [UI.notice('error', UI.errorText(e))]));
    });

    function build(car, fluids, people, users) {
      var f = {};
      var msg = el('div');
      function text(name, value, attrs) {
        f[name] = el('input', Object.assign({ type: 'text', name: name, value: value === null || value === undefined ? '' : String(value), autocomplete: 'off' }, attrs || {}));
        return f[name];
      }
      function select(name, options, value) {
        f[name] = el('select', { name: name }, options.map(function (o) {
          return el('option', { value: o[0], text: o[1], selected: o[0] === value });
        }));
        return f[name];
      }

      var v = car || { country: 'UK', currency: 'GBP', distanceUnit: 'mi', status: 'Active' };

      // Optional purchase price with its own currency, which can differ from the car's running-cost currency.
      function acquisitionCostField() {
        var cost = text('acquisitionCost', v.acquisitionCost === null || v.acquisitionCost === undefined ? '' : v.acquisitionCost, { inputmode: 'decimal', id: 'f-cost' });
        var cur = select('acquisitionCurrency', CURRENCY_OPTIONS, v.acquisitionCurrency || v.currency);
        cur.setAttribute('aria-label', 'Currency of the acquisition cost');
        // Starts from the country's usual currency, and follows it until you pick one here yourself.
        var touched = !!(car && car.acquisitionCost !== null && car.acquisitionCost !== undefined);
        cur.addEventListener('change', function () { touched = true; });
        f.country.addEventListener('change', function () { if (!touched) cur.value = f.country.value === 'UG' ? 'UGX' : 'GBP'; });
        return el('div', { class: 'field' }, [
          el('label', { for: 'f-cost', text: 'Acquisition cost' }),
          el('div', { class: 'odo-row' }, [cost, cur]),
          el('div', { class: 'hint', text: 'Optional. What you paid for the car, in any of these currencies.' }),
        ]);
      }

      // Odometer reading with its unit chosen right beside it.
      function odometerField() {
        var odo = text('odometer', v.odometer === null || v.odometer === undefined ? '' : v.odometer, { inputmode: 'numeric', id: 'f-odometer' });
        var unit = select('distanceUnit', [['mi', 'Miles'], ['km', 'Kilometres']], v.distanceUnit);
        unit.setAttribute('aria-label', 'Distance unit');
        return el('div', { class: 'field' }, [
          el('label', { for: 'f-odometer', text: 'Current odometer' }),
          el('div', { class: 'odo-row' }, [odo, unit]),
          el('div', { class: 'hint', text: 'Whole number. Changing the unit does not convert the number.' }),
        ]);
      }

      var detailFields = [
        UI.field('Registration number *', text('registration', v.registration, { maxlength: '20', autocapitalize: 'characters', required: true })),
        UI.field('Make *', text('make', v.make, { maxlength: '40', placeholder: 'e.g. Toyota', required: true })),
        UI.field('Model *', text('model', v.model, { maxlength: '40', placeholder: 'e.g. Land Cruiser', required: true })),
        UI.field('Year *', text('year', v.year, { inputmode: 'numeric', maxlength: '4', placeholder: 'e.g. 2015', required: true })),
        UI.field('Colour', text('colour', v.colour, { maxlength: '30' })),
        UI.field('Nickname', text('nickname', v.nickname, { maxlength: '40' }), 'Optional, e.g. "The work truck".'),
        UI.field('VIN / chassis number', text('vin', v.vin, { maxlength: '30', autocapitalize: 'characters' }), 'The 17-character VIN, or the chassis number for Japanese imports.'),
        UI.field('Country', select('country', [['UK', 'United Kingdom'], ['UG', 'Uganda']], v.country)),
        UI.field('Status', select('status', [['Active', 'Active'], ['Off-road', 'Off-road'], ['Sold', 'Sold'], ['Scrapped', 'Scrapped']], v.status)),
        odometerField(),
        UI.field('Acquisition date', text('acquisitionDate', v.acquisitionDate, { maxlength: '24', placeholder: 'e.g. 2021, Mar 2021 or 12/03/2021' }), 'Optional. A full date, or just the month and year, or just the year.'),
        acquisitionCostField(),
        UI.field('Parts catalogue link', text('partsouqUrl', v.partsouqUrl, { inputmode: 'url', placeholder: 'https://…' }), 'Optional. Any secure (https) link, e.g. partsouq.com'),
      ];
      var notes = el('textarea', { name: 'notes', rows: '4', maxlength: '2000' });
      notes.value = v.notes || '';
      f.notes = notes;
      detailFields.push(UI.field('Notes', notes));

      // Owner/custodian: people who use this app are ticked; anyone else is written in.
      var ownerFields = [
        UI.field('Other owner/custodian', text('ownerOther', v.ownerOther, { maxlength: '80' }), 'Optional. If the owner/custodian is not a user of this app, e.g. a company or a relative.'),
      ];
      var ownersEd = car ? ownersEditor(people, users) : null;
      var iOwn = null; // a new car: say straight away if it is yours (ticked when you come from "Add a new car")
      if (car) {
        ownerFields.push(el('div', { class: 'field' }, [el('div', { class: 'field-label', text: 'Owners/Custodians using this app' }), ownersEd.node]));
      } else {
        iOwn = el('input', { type: 'checkbox' });
        iOwn.checked = ctx.query.mine === '1';
        ownerFields.push(el('label', { class: 'check' }, [iOwn, el('span', { text: 'I own or look after this car' })]));
      }

      var fluidsEd = fluidsEditor(fluids);

      // New cars can take a photo straight away; existing cars manage it on the car page.
      var chosenPhoto = null;
      var photoFields = [];
      if (!car) {
        var photoName = el('div', { class: 'muted small-text', role: 'status' });
        var clearPhoto = el('button', { type: 'button', class: 'linklike', text: 'Remove photo', hidden: true });
        var formPicker = Photos.picker(function (file) {
          chosenPhoto = file;
          photoName.textContent = 'Photo ready: ' + file.name;
          clearPhoto.hidden = false;
        });
        clearPhoto.addEventListener('click', function () {
          chosenPhoto = null;
          photoName.textContent = '';
          clearPhoto.hidden = true;
        });
        photoFields.push(el('div', { class: 'field' }, [
          el('div', { class: 'field-label', text: 'Photo' }),
          el('div', { class: 'btn-row' }, [formPicker.take, formPicker.choose]),
          photoName, clearPhoto,
          el('div', { class: 'hint', text: 'Optional. Take a photo now or choose one from your gallery. You can also add it later.' }),
        ]));
      }

      if (!car) {
        f.country.addEventListener('change', function () {
          f.distanceUnit.value = f.country.value === 'UG' ? 'km' : 'mi';
        });
      }

      function section(title, children) {
        return el('div', { class: 'form-section' }, [el('h2', { text: title })].concat(children));
      }
      var btn = el('button', { type: 'submit', class: 'btn block big save-gap', text: car ? 'Save changes' : 'Add car' });
      var form = el('form', { novalidate: true }, [
        section('Details', detailFields),
        section('Owner/Custodian', ownerFields),
        section('Fluids and specs', [fluidsEd.node]),
      ].concat(photoFields.length ? [section('Photo', photoFields)] : []).concat([btn]));

      function collect() {
        return {
          registration: f.registration.value, make: f.make.value, model: f.model.value, year: f.year.value, colour: f.colour.value,
          nickname: f.nickname.value, vin: f.vin.value, country: f.country.value,
          distanceUnit: f.distanceUnit.value, status: f.status.value, odometer: f.odometer.value,
          acquisitionCost: f.acquisitionCost.value, acquisitionCurrency: f.acquisitionCurrency.value, acquisitionDate: f.acquisitionDate.value,
          partsouqUrl: f.partsouqUrl.value, notes: f.notes.value,
          ownerOther: f.ownerOther.value,
        };
      }

      // What has been saved so far. If a later step fails, a retry only repeats the steps that did not finish.
      var state = { carId: car ? car.id : '', version: car ? car.version : 0, snapshot: car ? JSON.stringify(collect()) : '', markedMine: false, photoDone: false };
      function carDirty() { return !state.carId || JSON.stringify(collect()) !== state.snapshot; }

      function saveCarStep(extra) {
        if (!carDirty()) return Promise.resolve('skipped');
        var payload = Object.assign({ fields: collect() }, state.carId ? { id: state.carId, version: state.version } : {}, extra || {});
        return FleetApi.call('saveCar', payload).then(function (r) {
          var d = r.data;
          if (!d.saved) {
            var lines = d.warnings.map(function (w) { return (w.type === 'vin' ? 'Same VIN as ' : 'Same registration as ') + w.label; }).join('\n');
            if (window.confirm('Possible duplicate:\n' + lines + '\n\nSave anyway?')) return saveCarStep(Object.assign({}, extra, { force: true }));
            return 'cancelled';
          }
          state.carId = d.car.id;
          state.version = d.car.version;
          state.snapshot = JSON.stringify(collect());
          carsCache = null;
          return 'saved';
        }).catch(function (e) {
          if (e.code === 'odometer_lower' && !e.asked && FleetAuth.isAdmin()) {
            e.asked = true;
            if (window.confirm('That odometer reading is lower than the current one. Correct it anyway?')) {
              return saveCarStep(Object.assign({}, extra, { forceOdometer: true }));
            }
          }
          throw e;
        });
      }

      function run() {
        var done = [];
        var step = 'the car details';
        return saveCarStep({}).then(function (res) {
          if (res === 'cancelled') return 'stop';
          if (res === 'saved') done.push('car details');
          if (!fluidsEd.dirty()) return null;
          step = 'the fluids and specs';
          return FleetApi.call('saveFluids', { carId: state.carId, fluids: fluidsEd.payload() }).then(function (r) {
            fluidsEd.markSaved(r.data.fluids);
            done.push('fluids and specs');
          });
        }).then(function (stop) {
          if (stop === 'stop') return 'stop';
          step = 'the owner/custodian';
          if (car) {
            if (!ownersEd.dirty()) return null;
            return ownersEd.save(state.carId).then(function () { done.push('owner/custodian'); });
          }
          if (iOwn.checked && !state.markedMine) {
            return FleetApi.call('setMyCarRole', { carId: state.carId, owner: true }).then(function () { state.markedMine = true; });
          }
          return null;
        }).then(function (stop) {
          if (stop === 'stop') return 'stop';
          if (car || !chosenPhoto || state.photoDone) return null;
          step = 'the photo';
          // The car is already saved, so a failed photo is reported on the next screen instead of blocking.
          return Photos.upload(state.carId, chosenPhoto).then(function () { state.photoDone = true; }, function (e) {
            FleetApp.setFlash('error', 'The car was saved, but its photo could not be added: ' + UI.errorText(e) + ' You can add it from this page.');
          });
        }).then(function (stop) {
          if (stop === 'stop') return;
          carsCache = null;
          FleetApp.go('/car/' + state.carId);
        }).catch(function (e) {
          e.savedParts = done;
          e.failedStep = step;
          throw e;
        });
      }

      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        msg.replaceChildren();
        UI.busy(btn, 'Saving…', run()).catch(function (e) {
          var text = (e.savedParts && e.savedParts.length ? 'Saved: ' + e.savedParts.join(', ') + '. ' : '') +
            'Could not save ' + (e.failedStep || 'the changes') + ': ' + UI.errorText(e);
          msg.replaceChildren(UI.notice('error', text));
          window.scrollTo(0, 0);
        });
      });

      root.replaceChildren(el('section', { class: 'card' }, [
        backLink(car ? '#/car/' + car.id : '#/', car ? car.registration : 'Fleet'),
        el('h1', { text: car ? 'Edit car' : 'Add a car' }),
        msg, form,
      ]));
    }
  };

  // ---------- printable label ----------
  Views.carLabel = function (ctx, root) {
    var id = ctx.params.id;
    root.replaceChildren(el('section', { class: 'card' }, [loading()]));
    FleetApi.call('getCar', { id: id }).then(function (r) {
      var car = r.data.car;
      var printBtn = el('button', { type: 'button', class: 'btn', text: 'Print label', onclick: function () { window.print(); } });
      root.replaceChildren(
        el('section', { class: 'card no-print' }, [
          backLink('#/car/' + car.id, car.registration),
          el('h1', { text: 'QR label' }),
          el('p', { class: 'muted', text: 'Print this and stick it on the car. Scanning it opens the car in Fleet Manager (sign-in required).' }),
          printBtn,
        ]),
        el('div', { class: 'label-wrap' }, [
          el('div', { class: 'label' }, [
            el('img', { src: qrDataUrl(carUrl(car.id)), alt: 'QR code for ' + car.registration }),
            el('div', { class: 'label-reg', text: car.registration }),
            el('div', { class: 'label-car', text: carTitle(car) }),
            el('div', { class: 'label-foot', text: 'Fleet Manager' }),
          ]),
        ])
      );
    }).catch(function (e) {
      if (e.code === 'not_found') notFound(root);
      else if (e.code !== 'unauthorized') root.replaceChildren(el('section', { class: 'card' }, [UI.notice('error', UI.errorText(e))]));
    });
  };
})();
