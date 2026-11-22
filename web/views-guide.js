// The user guide (Me → User guide) and the links in it. Every link goes to the demo car (a made-up, fully filled-in vehicle) so a reader
// can try each action straight away on something that is not their own data.
(function () {
  'use strict';

  var el = UI.el;
  var Views = (window.Views = window.Views || {});

  // ---------- where a demo link goes ----------
  // path: the page to open; open: car-page sections to have open; scroll: what to scroll to there
  var LOG = 'Maintenance & Issues Log';
  var TARGETS = {
    car: { path: '' },
    log: { path: '', open: [LOG], scroll: LOG },
    fluids: { path: '', open: ['Fluids | Bulbs | Parts'], scroll: 'Fluids | Bulbs | Parts' },
    docs: { path: '', open: ['Documents'], scroll: 'Documents' },
    guest: { path: '', open: ['Guest access'], scroll: 'Guest access' },
    qr: { path: '', open: ['QR label'], scroll: 'QR label' },
    export: { path: '', scroll: 'Export all vehicle data' },
    editspecs: { path: '/fluids' },
    edit: { path: '/edit' },
    label: { path: '/label' },
    add: { path: '/add' },
    addissue: { path: '/add/issue' },
    addmaint: { path: '/add/maintenance' },
    addpurchase: { path: '/add/purchase' },
  };

  /** After the car page has drawn, bring a section (or the export button) into view. */
  function scrollToSection(text) {
    var tries = 0;
    (function look() {
      var target = null;
      [].slice.call(document.querySelectorAll('summary h2, button, .btn')).forEach(function (n) { if (!target && n.textContent.trim() === text) target = n; });
      if (target) { var top = target.getBoundingClientRect().top + window.scrollY - 90; window.scrollTo({ top: Math.max(0, top), behavior: 'auto' }); return; }
      if (tries++ < 24) setTimeout(look, 250);
    })();
  }

  function go(id, where) {
    var t = TARGETS[where] || TARGETS.car;
    if (t.open && Views.openCarSections) Views.openCarSections(id, t.open.reduce(function (o, k) { o[k] = true; return o; }, {}));
    FleetApp.go('/car/' + id + t.path);
    if (t.scroll) setTimeout(function () { scrollToSection(t.scroll); }, 400);
  }

  /** #/demo/<where>: find the demo car and go there. */
  Views.demoLink = function (ctx, root) {
    var where = ctx.params.where || 'car';
    var msg = el('div');
    root.replaceChildren(el('section', { class: 'card' }, [el('h1', { text: 'Demo car' }), UI.waiting('Opening the demo car…'), msg]));
    FleetApi.call('getDemoCar').then(function (r) {
      if (r.data.id) { go(r.data.id, where); return; }
      var kids = [el('h1', { text: 'Demo car' }), el('p', { class: 'section-note', text: 'The demo car used by the user guide has not been set up yet.' })];
      if (FleetAuth.isAdmin()) {
        var make = el('button', { type: 'button', class: 'btn', text: 'Create the demo car' });
        make.addEventListener('click', function () {
          UI.busy(make, 'Creating…', FleetApi.call('createDemoCar', {}, { timeoutMs: 170000 })).then(function (c) { go(c.data.id, where); })
            .catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
        });
        kids.push(el('p', { class: 'muted small-text', text: 'It is a made-up vehicle with example entries, fluids, reminders and a document. It can be deleted at any time.' }), make);
      } else {
        kids.push(el('p', { class: 'muted', text: 'Ask an administrator to create it.' }));
      }
      kids.push(msg);
      root.replaceChildren(el('section', { class: 'card' }, kids));
    }).catch(function (e) { if (e.code !== 'unauthorized') root.replaceChildren(el('section', { class: 'card' }, [UI.notice('error', UI.errorText(e))])); });
  };

  // ---------- the guide ----------
  function link(where, text) { return el('a', { href: '#/demo/' + where, text: text }); }
  function page(path, text) { return el('a', { href: '#' + path, text: text }); }
  function b(text) { return el('strong', { text: text }); }
  function p(kids) { return el('p', {}, kids); }
  function shot(name, alt) {
    var img = el('img', { src: 'guide/' + name + '.jpg', alt: alt, loading: 'lazy' });
    img.addEventListener('error', function () { fig.hidden = true; }); // no picture yet: the text still reads fine
    var fig = el('figure', { class: 'guide-shot' }, [img]);
    return fig;
  }
  function section(title, kids, open) {
    return el('details', { class: 'card collapsible guide-section', open: open ? true : undefined }, [el('summary', {}, [el('h2', { text: title })]), el('div', { class: 'guide-body' }, kids)]);
  }
  function adminNote(kids) {
    return FleetAuth.isAdmin() ? el('p', { class: 'guide-admin' }, [el('span', { class: 'chip', text: 'Admins only' }), document.createTextNode(' ')].concat(kids)) : null;
  }

  Views.guide = function (ctx, root) {
    FleetApp.setBanner({ title: 'User guide', back: '#/profile' });
    // an administrator is offered the demo car's set-up if it does not exist yet
    var demoSetup = el('div');
    FleetApi.call('getDemoCar').then(function (r) {
      if (r.data.id) return;
      var make = el('button', { type: 'button', class: 'btn small', text: 'Create the demo car' });
      make.addEventListener('click', function () {
        UI.busy(make, 'Creating…', FleetApi.call('createDemoCar', {}, { timeoutMs: 170000 })).then(function () {
          demoSetup.replaceChildren(UI.notice('ok', 'The demo car is ready. The links in this guide now work.'));
        }).catch(function (e) { demoSetup.replaceChildren(UI.notice('error', UI.errorText(e))); });
      });
      demoSetup.replaceChildren(el('p', { class: 'section-note' }, [document.createTextNode(FleetAuth.isAdmin() ? 'The demo car this guide links to has not been created yet. It is a made-up vehicle that an administrator can delete at any time.' : 'The demo car this guide links to has not been created yet. Ask an administrator to create it.')]), FleetAuth.isAdmin() ? make : null);
    }).catch(function () { /* the guide reads fine without it */ });
    root.replaceChildren(el('section', { class: 'card' }, [
      el('h1', { text: 'User guide' }),
      demoSetup,
      el('p', { class: 'section-note' }, [
        document.createTextNode('The links below open a demo car (DEMO 001), a made-up vehicle with everything filled in, so you can try each step without touching your own cars.'),
      ]),
    ]), 
    section('1. What Fleet Manager does', [
      p([document.createTextNode('Keep every vehicle\'s details, issues, maintenance, parts and costs in one place, on your phone or laptop. Only people an administrator has approved can sign in and see anything.')]),
      p([b('The easy way to log work is to email it.'), document.createTextNode(' Every car has two addresses: a '), b('simple'), document.createTextNode(' one, made from its registration, for your own email, and a '), b('public'), document.createTextNode(' one that works for anyone, so you can share it with a garage.')]),
      el('ol', {}, [
        el('li', {}, [document.createTextNode('Open the demo car\'s '), link('log', 'Maintenance & Issues Log'), document.createTextNode('. The purple note shows both addresses.')]),
        el('li', {}, [document.createTextNode('Email a parts receipt or garage invoice (PDF or photo) to either one. A garage can send its invoice straight to the public address.')]),
        el('li', {}, [document.createTextNode('AI reads it and puts it in the '), page('/inbox', 'AI Inbox'), document.createTextNode('. Check what it read, tap '), b('Draft an entry from this receipt'), document.createTextNode(', review, and save.')]),
      ]),
      shot('guide-email', 'The car\'s email addresses in the log note'),
      shot('guide-inbox', 'What AI read from a receipt'),
      p([document.createTextNode('No email handy? Tap '), b('Upload a receipt'), document.createTextNode(' in the same note, or share a PDF or photo to the Android app.')]),
    ], true),
    section('2. Adding a car', [
      p([document.createTextNode('Tap '), page('/car/new', 'Add a car'), document.createTextNode(' on the Fleet page, then choose:')]),
      el('ul', {}, [
        el('li', {}, [b('Upload the vehicle log book (PDF).'), document.createTextNode(' AI reads it, fills in the key and technical details, and attaches the PDF. It can take up to a minute.')]),
        el('li', {}, [b('Add it yourself.'), document.createTextNode(' Fill in the details, then tap '), b('Use AI to fill in technical details'), document.createTextNode(' (give the VIN, or the make and model).')]),
      ]),
      shot('guide-addcar', 'The two ways to add a car'),
      p([document.createTextNode('Always check what AI filled in before you save. It also suggests the right fluids and bulbs (oil approvals, coolant type, capacities). See them in '), link('fluids', 'Fluids | Bulbs | Parts'), document.createTextNode(' and '), link('editspecs', 'edit them'), document.createTextNode(' any time.')]),
      shot('guide-fluids', 'Fluids and bulbs, with the note to check them'),
    ]),
    section('3. Log entries', [
      p([document.createTextNode('Each car\'s log holds four kinds of entry:')]),
      el('ul', {}, [
        el('li', {}, [b('Issue:'), document.createTextNode(' something is wrong.')]),
        el('li', {}, [b('Maintenance:'), document.createTextNode(' work done (servicing, repairs), with parts and labour.')]),
        el('li', {}, [b('Purchase:'), document.createTextNode(' parts you have bought, which you later fit in a maintenance entry.')]),
        el('li', {}, [b('Compliance:'), document.createTextNode(' a renewal or test that must be kept up to date (MOT, insurance, road tax). It keeps a reminder for its expiry date.')]),
      ]),
      p([b('Create one'), document.createTextNode(' by hand with '), link('add', 'Add entry'), document.createTextNode(' ('), link('addissue', 'issue'), document.createTextNode(', '), link('addmaint', 'maintenance'), document.createTextNode(', '), link('addpurchase', 'purchase'), document.createTextNode(', or the compliance option on that page), or with AI by emailing or uploading a receipt (see 1).')]),
      shot('guide-addentry', 'Choosing the kind of entry'),
      p([document.createTextNode('As the log grows, tap a coloured tile at the top of the '), link('log', 'log'), document.createTextNode(' to see just one kind. Tap '), b('Select'), document.createTextNode(' to share or delete several at once.')]),
      shot('guide-filter', 'The filter tiles above the log'),
    ]),
    section('4. More features', [
      el('ul', {}, [
        el('li', {}, [b('Photos and documents.'), document.createTextNode(' Attach photos and PDFs to any entry (Photos and documents, in '), link('addmaint', 'Add maintenance'), document.createTextNode('), and keep the car\'s papers under '), link('docs', 'Documents'), document.createTextNode('.')]),
        el('li', {}, [b('QR code and guest mode.'), document.createTextNode(' Every car has a '), link('qr', 'QR label'), document.createTextNode('; '), link('label', 'print it'), document.createTextNode(' for the windscreen. Scanning it opens the car for signed-in people; anyone else can add an entry as a named guest, to that one car only. This is useful if you want your garage to log what they have done for you (as well as emailing the car\'s public address, which you can give them).')]),
        el('li', {}, [b('Export.'), document.createTextNode(' '), link('export', 'Export all vehicle data'), document.createTextNode(' saves a PDF of everything, plus every photo and file, in one zip.')]),
        el('li', {}, [b('Your data is private.'), document.createTextNode(' Everyone signs in with an emailed link, only approved users can see anything, and guests see one car only.')]),
      ]),
      shot('guide-qr', 'The QR label and guest access'),
      adminNote([document.createTextNode('Approve users, email the team, sign everyone out and switch '), link('guest', 'Guest access'), document.createTextNode(' on or off from '), page('/admin/users', 'Users'), document.createTextNode('.')]),
    ]));
  };
})();
