// Car documents: the card on the car page (logbook, insurance, import papers...).
// Kept against the car as a whole, as opposed to the photos and invoices attached to one entry.
(function () {
  'use strict';

  var el = UI.el;
  var Views = (window.Views = window.Views || {});
  var fmt = Views.fmt;
  var TYPES = ['Logbook', 'Insurance', 'MOT / inspection', 'Import papers', 'Receipt / invoice', 'Other'];

  function kb(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

  // `preloaded` (the car page's documents) saves a request; after a change the card fetches its own list.
  function card(car, preloaded) {
    var list = el('div', { class: 'stack' }, [fmt.loading()]);
    var msg = el('div');

    var typeSel = el('select', { name: 'docType' }, TYPES.map(function (t) { return el('option', { value: t, text: t }); }));
    var noteIn = el('input', { type: 'text', name: 'docNote', maxlength: '200', autocomplete: 'off', placeholder: 'Optional note, e.g. valid to March 2027' });
    var buttons = [];

    function upload(file) {
      msg.replaceChildren();
      var type = typeSel.value, note = noteIn.value;
      var work = Photos.prepareAttachment(file).then(function (a) {
        return FleetApi.call('uploadCarDocument', { carId: car.id, type: type, note: note, mime: a.mime, data: a.data, filename: a.filename }, { timeoutMs: 240000 });
      }).then(function () {
        noteIn.value = '';
        msg.replaceChildren(UI.notice('ok', 'Document added.'));
        return load();
      }).catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
      msg.replaceChildren(UI.notice('ok', 'Adding the document…'));
      return work;
    }
    buttons.push(Photos.fileButton('Take photo', 'image/*', true, upload));
    buttons.push(Photos.fileButton('Choose photo', 'image/*', false, upload));
    buttons.push(Photos.fileButton('Add PDF', 'application/pdf', false, upload));

    function row(d) {
      var isPdf = d.mime === 'application/pdf';
      var holder = el('div');
      var view = el('button', { type: 'button', class: 'btn small secondary', text: isPdf ? 'Open' : 'View' });
      view.addEventListener('click', function () {
        UI.busy(view, 'Loading…', FleetApi.call('getCarDocument', { id: d.id }).then(function (r) { return r.data; })).then(function (att) {
          var url = Photos.toBlobUrl(att);
          if (isPdf) {
            var link = el('a', { href: url, download: att.filename });
            document.body.append(link); link.click(); link.remove();
          } else {
            holder.replaceChildren(el('img', { class: 'attach-img', src: url, alt: att.filename }));
          }
        }).catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
      });
      var actions = [view];
      if (FleetAuth.isAdmin()) {
        var rm = el('button', { type: 'button', class: 'btn small danger', text: 'Remove' });
        rm.addEventListener('click', function () {
          UI.confirm('Remove ' + d.filename + '?', { okLabel: 'Remove', danger: true }).then(function (yes) {
            if (!yes) return;
            UI.busy(rm, 'Removing…', FleetApi.call('deleteCarDocument', { id: d.id })).then(load)
              .catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
          });
        });
        actions.push(rm);
      }
      return el('div', { class: 'attach-row doc-row' }, [
        el('div', { class: 'attach-name' }, [
          el('div', { class: 'doc-type', text: (isPdf ? '📄 ' : '📷 ') + d.type }),
          el('div', { class: 'muted small-text', text: d.filename + ' · ' + kb(d.size) + (d.createdAt ? ' · added ' + fmt.date(d.createdAt) : '') }),
          d.note ? el('div', { class: 'muted small-text', text: d.note }) : null,
        ]),
        el('div', { class: 'btn-row' }, actions), holder,
      ]);
    }

    function draw(docs) {
      list.replaceChildren.apply(list, docs.length ? docs.map(row)
        : [el('p', { class: 'muted', text: 'No documents yet. Add the logbook, insurance, import papers or anything else worth keeping with this car.' })]);
    }
    function load() {
      return FleetApi.call('listCarDocuments', { carId: car.id }).then(function (r) { draw(r.data.documents); })
        .catch(function (e) { list.replaceChildren(UI.notice('error', UI.errorText(e))); });
    }

    if (preloaded) draw(preloaded); else load();

    return el('section', { class: 'card' }, [
      el('h2', { text: 'Documents' }),
      list,
      msg,
      el('div', { class: 'stack' }, [
        UI.field('Add a document: what kind is it?', typeSel),
        UI.field('Note', noteIn),
        el('div', { class: 'btn-row' }, buttons),
        el('div', { class: 'hint', text: 'Photos are shrunk automatically; PDFs can be up to 5 MB. Only signed-in people can see these, never guests.' }),
      ]),
    ]);
  }

  window.DocumentsUI = { card: card };
})();
