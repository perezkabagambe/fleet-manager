// AI tips on issues: the AI's own advice, shown in its own box, apart from what a report or a person wrote. A tip can be
// removed but never reworded. On the review screen of a report the tips are saved with their issues unless removed. On a
// saved issue (its page and its edit form) anyone can ask for one: it is not kept until they keep it, or save the issue.
(function () {
  'use strict';

  var el = UI.el;
  var CAUTION = 'AI can be wrong. Check it before acting on it.';
  var SENDS = 'Sends the issue\'s title and notes, and the car\'s make, model, year and engine, to Google\'s AI.';
  var ASK_TIMEOUT_MS = 90000;

  // tips asked for and not yet kept or discarded, by issue: { tip, proof, kept (chosen in the edit form) }
  var waiting = {};

  function title(source) { return source === 'asked' ? 'AI tip' : 'AI tip, not from the report'; }

  function link(text, onClick) {
    var b = el('button', { type: 'button', class: 'linklike ai-tip-action', text: text });
    b.addEventListener('click', function () { onClick(b); });
    return b;
  }

  function row(heading, text, foot, action) {
    return el('div', { class: 'ai-tip-row' }, [
      el('strong', { text: heading }), el('p', { text: text }),
      foot || action ? el('div', { class: 'ai-tip-foot' }, [el('span', { class: 'muted', text: foot || '' }), action || null]) : null,
    ]);
  }

  function box(rows) { return el('div', { class: 'ai-tip' }, rows.concat([el('p', { class: 'muted ai-tip-caution', text: CAUTION })])); }

  /** On the review screen: `issue` is the draft's ({ tips, removedTips }). Every tip left here is saved with the issue. */
  function review(issue, redraw) {
    var out = [];
    if (issue.tips.length) {
      out.push(box(issue.tips.map(function (text, n) {
        return row(title('report'), text, 'Saved with the issue', link('Remove tip', function () {
          issue.removedTips.push(issue.tips.splice(n, 1)[0]);
          redraw();
        }));
      })));
    }
    if (issue.removedTips.length) {
      out.push(el('p', { class: 'muted small-text ai-tip-removed' }, [
        el('span', { text: issue.removedTips.length > 1 ? issue.removedTips.length + ' AI tips removed.' : 'AI tip removed.' }),
        link('Undo', function () { issue.tips.push(issue.removedTips.pop()); redraw(); }),
      ]));
    }
    return out.length ? el('div', {}, out) : null;
  }

  /** The "Get an AI tip" button. `values()` gives the title and notes to send. */
  function asker(entry, values, redraw) {
    var message = el('div', {});
    var button = el('button', { type: 'button', class: 'btn block secondary', text: 'Get an AI tip' });
    button.addEventListener('click', function () {
      var wait = UI.waiting('Asking AI for a tip…');
      message.replaceChildren(wait);
      button.disabled = true;
      var send = Object.assign({ id: entry.id }, values ? values() : {});
      FleetApi.call('aiIssueTip', send, { timeoutMs: ASK_TIMEOUT_MS }).then(function (r) {
        button.disabled = false;
        if (!r.data.tip) { message.replaceChildren(UI.notice('info', 'AI had nothing useful to add to this one.')); return; }
        waiting[entry.id] = { tip: r.data.tip, proof: r.data.proof, kept: false };
        redraw();
      }).catch(function (e) {
        button.disabled = false;
        message.replaceChildren(UI.notice('error', e && e.code === 'ai_bad_answer' ? 'The AI did not give an answer that could be used. Please try again.' : UI.errorText(e)));
      });
    });
    return el('div', { class: 'ai-tip-ask' }, [button, el('p', { class: 'muted small-text center', text: SENDS }), message]);
  }

  /** A tip that has come back and is not yet kept: Discard or Keep. `keep(button)` does the keeping. */
  function offer(entry, note, keep, redraw) {
    var discard = el('button', { type: 'button', class: 'btn secondary', text: 'Discard' });
    var keepButton = el('button', { type: 'button', class: 'btn', text: 'Keep' });
    discard.addEventListener('click', function () { delete waiting[entry.id]; redraw(); });
    keepButton.addEventListener('click', function () { keep(keepButton); });
    return box([row('AI tip: not saved yet', waiting[entry.id].tip), el('p', { class: 'muted small-text', text: note }), el('div', { class: 'ai-tip-choice' }, [discard, keepButton])]);
  }

  /** Keep the tip that is waiting for this issue, if there is one. Resolves with the saved entry (or null). */
  function keepWaiting(entry) {
    var held = waiting[entry.id];
    if (!held) return Promise.resolve(null);
    return FleetApi.call('keepIssueTip', { id: entry.id, tip: held.tip, proof: held.proof }).then(function (r) {
      delete waiting[entry.id];
      entry.aiTips = r.data.entry.aiTips;
      entry.version = r.data.entry.version;
      Views.invalidateCars();
      return r.data.entry;
    });
  }

  /**
   * The tips of a saved issue, for its page. `dayText(iso)` words a date. Returns { node, keepWaiting() }: saving the issue
   * from its page (changing its status) keeps a tip that is still waiting.
   */
  function onPage(entry, dayText) {
    var node = el('section', { class: 'ai-tips-section' });
    var message = el('div', {});
    function fail(e) { message.replaceChildren(UI.notice('error', UI.errorText(e))); }

    function draw() {
      var out = [];
      var tips = entry.aiTips || [];
      if (tips.length) {
        out.push(box(tips.map(function (t) {
          var from = t.date ? (t.source === 'asked' ? 'Asked for on ' : 'Report of ') + dayText(t.date) : '';
          return row(title(t.source), t.text, from, link('Remove tip', function (b) {
            UI.confirm('Remove this AI tip?\nIt can\'t be brought back.', { okLabel: 'Remove tip' }).then(function (yes) {
              if (!yes) return;
              message.replaceChildren();
              UI.busy(b, 'Removing…', FleetApi.call('removeIssueTip', { id: entry.id, tipId: t.id })).then(function (r) {
                entry.aiTips = r.data.entry.aiTips;
                entry.version = r.data.entry.version;
                Views.invalidateCars();
                draw();
              }).catch(fail);
            });
          }));
        })));
      }
      if (waiting[entry.id]) {
        out.push(offer(entry, 'If you don\'t choose, it\'s kept when you next save this issue.', function (b) {
          message.replaceChildren();
          UI.busy(b, 'Saving…', keepWaiting(entry)).then(draw).catch(fail);
        }, draw));
      } else if (!tips.length) {
        out.push(asker(entry, null, draw));
      }
      node.replaceChildren.apply(node, out.concat([message]));
    }

    draw();
    return { node: node, keepWaiting: function () { return keepWaiting(entry).then(function (saved) { if (saved) draw(); }).catch(fail); } };
  }

  /**
   * In the edit form of an issue that has no tip yet. `values()` gives what is in the form. Returns { node (null when the
   * issue already has a tip: those are looked after on its page), value() for saveEntry, saved() once the issue is saved }.
   */
  function inForm(entry, values) {
    var node = (entry.aiTips || []).length && !waiting[entry.id] ? null : el('div', { class: 'ai-tips-section' });

    function draw() {
      if (!node) return;
      var held = waiting[entry.id];
      if (!held) node.replaceChildren(asker(entry, values, draw));
      else if (!held.kept) node.replaceChildren(offer(entry, 'If you don\'t choose, it\'s saved with your changes.', function () { held.kept = true; draw(); }, draw));
      else node.replaceChildren(box([row(title('asked'), held.tip, 'Saved when you save your changes', link('Remove tip', function () { delete waiting[entry.id]; draw(); }))]));
    }

    draw();
    return {
      node: node,
      value: function () { var held = waiting[entry.id]; return held ? { tip: held.tip, proof: held.proof } : null; },
      saved: function () { delete waiting[entry.id]; },
    };
  }

  window.AiTips = { review: review, onPage: onPage, inForm: inForm };
})();
