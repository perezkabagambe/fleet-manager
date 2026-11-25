// The list of issues linked to an entry: three rows tall (it scrolls for more). Read-only on an entry's page; with Unlink, an
// "add" picker and, for maintenance, a "Resolved by this" tick for each in the forms and on the review screen.
(function () {
  'use strict';

  var el = UI.el;

  function label(i) { return (i.ref ? i.ref + ' · ' : '') + i.title; }
  function statusChip(status) { return status ? el('span', { class: 'linked-status' + (status === 'Resolved' ? ' done' : ''), text: status }) : null; }

  /** Read-only: [{ id, ref, title, status, resolves }], each opening its issue. */
  function view(carId, items) {
    return el('div', { class: 'linked-list' }, items.map(function (i) {
      return el('a', { class: 'linked-row', href: '#/car/' + carId + '/entry/' + i.id }, [
        el('span', { class: 'linked-main' }, [
          el('span', { class: 'linked-title', text: label(i) }),
          el('span', { class: 'linked-sub' }, [statusChip(i.status), i.resolves ? el('span', { class: 'linked-note', text: 'Resolved by this' }) : null]),
        ]),
        el('span', { class: 'linked-chev', 'aria-hidden': 'true', text: '›' }),
      ]);
    }));
  }

  /**
   * An editable list. o: { choices: [{ id, ref, title, status }] (what can be linked), selected: [{ id, resolves }],
   * resolvable (show "Resolved by this"), onChange(value) }. Returns { node, value() -> [{ issueId, resolves }], ids() }.
   */
  function editor(o) {
    var choices = o.choices.slice();
    var byId = {};
    choices.forEach(function (c) { byId[c.id] = c; });
    var chosen = (o.selected || []).filter(function (s) { return byId[s.id]; }).map(function (s) { return { id: s.id, resolves: !!s.resolves }; });
    var heading = el('div', { class: 'field-label' });
    var listBox = el('div', { class: 'linked-list' + (o.resolvable ? ' tall' : '') });
    var addBox = el('div', { class: 'linked-add' });
    var node = el('div', { class: 'field linked-field' }, [heading, listBox, addBox]);

    function value() { return chosen.map(function (c) { return { issueId: c.id, resolves: !!(o.resolvable && c.resolves) }; }); }
    function changed() { draw(); if (o.onChange) o.onChange(value()); }
    function draw() {
      heading.textContent = 'Linked issues' + (chosen.length ? ' (' + chosen.length + ')' : '');
      listBox.hidden = !chosen.length;
      listBox.replaceChildren.apply(listBox, chosen.map(function (c) {
        var i = byId[c.id];
        var remove = el('button', { type: 'button', class: 'linklike linked-unlink', 'aria-label': 'Unlink ' + label(i), text: 'Unlink' });
        remove.addEventListener('click', function () { chosen = chosen.filter(function (x) { return x !== c; }); changed(); });
        var sub = [statusChip(i.status)];
        if (o.resolvable) {
          var tick = el('input', { type: 'checkbox' });
          tick.checked = c.resolves;
          tick.addEventListener('change', function () { c.resolves = tick.checked; if (o.onChange) o.onChange(value()); });
          sub.push(el('label', { class: 'linked-resolve' }, [tick, el('span', { text: 'Resolved by this' })]));
        }
        return el('div', { class: 'linked-row' }, [el('span', { class: 'linked-main' }, [el('span', { class: 'linked-title', text: label(i) }), el('span', { class: 'linked-sub' }, sub)]), remove]);
      }));
      var rest = choices.filter(function (i) { return !chosen.some(function (c) { return c.id === i.id; }); });
      if (!rest.length) {
        addBox.replaceChildren(chosen.length ? el('span', {}) : el('p', { class: 'muted small-text', text: 'This car has no other issues to link.' }));
        return;
      }
      var picker = UI.searchSelect(rest.map(function (i) { return { value: i.id, label: label(i) + (i.status ? ' (' + i.status + ')' : '') }; }), { placeholder: 'Link an issue…', ariaLabel: 'Link an issue', searchPlaceholder: 'Search issues…', emptyText: 'No other issue' });
      picker.addEventListener('change', function (ev) {
        ev.stopPropagation();
        if (!picker.value) return;
        // a maintenance entry usually fixes what it is linked to, so an open issue starts ticked
        chosen = chosen.concat([{ id: picker.value, resolves: !!o.resolvable && byId[picker.value].status !== 'Resolved' }]);
        changed();
      });
      addBox.replaceChildren(picker);
    }
    draw();
    return { node: node, value: value, ids: function () { return chosen.map(function (c) { return c.id; }); } };
  }

  /** An amount that is shared with other issues is shown in brackets. */
  function shared(text, isShared) { return isShared && text ? '(' + text + ')' : text; }

  window.LinkedIssues = { view: view, editor: editor, shared: shared };
})();
