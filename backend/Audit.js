/**
 * Audit trail. Every meaningful event is a row in the Audit tab. A time-based
 * trigger (flushTextLog) copies new rows into a monthly, append-only text file
 * in Drive (Logs/events-YYYY-MM.txt) as an independent safety net.
 * Never put secrets (tokens, codes) in `summary`, `before` or `after`.
 */
function audit_(actor, action, recordType, recordId, summary, before, after) {
  try {
    Db.insert('Audit', {
      timestamp: nowIso_(),
      user_id: actor && actor.id ? actor.id : '',
      user_email: actor && actor.email ? actor.email : '',
      action: action,
      record_type: recordType,
      record_id: recordId || '',
      summary: cleanStr_(summary, 500),
      before: before ? JSON.stringify(before) : '',
      after: after ? JSON.stringify(after) : '',
    });
  } catch (e) {
    console.error('audit failed: ' + (e && e.message));
  }
}

/** Trigger target: append Audit rows not yet written to the monthly text log. */
function flushTextLog() {
  Db.resetRequest();
  const props = props_();
  const done = Number(props.getProperty('LOG_FLUSHED_ROW') || 1);
  const rows = Db.all('Audit').filter(function (r) { return r._row > done; });
  if (!rows.length) return;

  const byMonth = {};
  rows.forEach(function (r) {
    const month = (r.timestamp || '').slice(0, 7) || 'unknown';
    const line = [r.timestamp, r.user_email || '-', r.action, r.record_type + ':' + (r.record_id || '-'), r.summary]
      .join(' | ').replace(/[\r\n]+/g, ' ') + '\n';
    byMonth[month] = (byMonth[month] || '') + line;
  });

  const folder = DriveApp.getFolderById(props.getProperty('LOGS_FOLDER_ID'));
  Object.keys(byMonth).forEach(function (month) {
    const key = 'LOGFILE_' + month;
    let file = null;
    const id = props.getProperty(key);
    if (id) {
      try { file = DriveApp.getFileById(id); } catch (e) { file = null; }
    }
    if (!file) {
      file = folder.createFile('events-' + month + '.txt', '');
      props.setProperty(key, file.getId());
    }
    file.setContent(file.getBlob().getDataAsString() + byMonth[month]);
  });
  props.setProperty('LOG_FLUSHED_ROW', String(rows[rows.length - 1]._row));
}
