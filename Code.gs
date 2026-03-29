/**
 * Raising Together ABA Tracker — Google Apps Script Backend v2
 * Config-driven session tracking for ABA therapy.
 *
 * SETUP
 * ─────
 * 1. Create a Google Sheet called "RT Admin" (leave it blank — the app
 *    will create tabs automatically when you first save from the Admin panel).
 * 2. Copy its Sheet ID (the long string in the URL) into ADMIN_SHEET_ID below.
 * 3. Deploy -> New Deployment -> Web App
 *      Execute as : Me
 *      Who has access : Anyone
 * 4. Copy the Web App URL into index.html -> GAS_URL constant.
 *
 * ACTIONS (all via POST with Content-Type: text/plain)
 * ----------------------------------------------------
 *  { action: 'getConfig' }                       -> returns full config JSON
 *  { action: 'saveConfig', config: { ... } }     -> rewrites RT Admin tabs
 *  { action: 'saveSession', sheetId, ... }        -> appends session data
 *  (no action field)                              -> legacy saveSession
 */

var ADMIN_SHEET_ID = '1VPBADMXvhOww_52O1n2CieTsQB6XCotLt6XdAQsq0ik';

// ── ROUTER ────────────────────────────────────────────────────────────

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var result;

    if (data.action === 'getConfig') {
      result = { success: true, config: getConfig() };
    } else if (data.action === 'saveConfig') {
      saveConfig(data.config);
      result = { success: true };
    } else {
      processSession(data);
      result = { success: true };
    }

    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet() {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'RT ABA Tracker v2 - online' }))
    .setMimeType(ContentService.MimeType.JSON);
}


// ── CONFIG: READ ──────────────────────────────────────────────────────

function getConfig() {
  var ss = SpreadsheetApp.openById(ADMIN_SHEET_ID);
  return {
    therapists: sheetToObjects(ss, 'Therapists'),
    clients:    sheetToObjects(ss, 'Clients'),
    behaviors:  sheetToObjects(ss, 'Behaviors'),
    goals:      sheetToObjects(ss, 'Goals'),
    billing:    sheetToObjects(ss, 'Billing')
  };
}


// ── CONFIG: WRITE ─────────────────────────────────────────────────────

function saveConfig(cfg) {
  var ss = SpreadsheetApp.openById(ADMIN_SHEET_ID);

  if (cfg.therapists !== undefined)
    objectsToSheet(ss, 'Therapists',
      ['id', 'name', 'initials', 'color', 'profile', 'status'],
      cfg.therapists);

  if (cfg.clients !== undefined)
    objectsToSheet(ss, 'Clients',
      ['id', 'name', 'initials', 'sheetId', 'status'],
      cfg.clients);

  if (cfg.behaviors !== undefined)
    objectsToSheet(ss, 'Behaviors',
      ['key', 'label', 'icon', 'color', 'clientIds', 'status'],
      cfg.behaviors);

  if (cfg.goals !== undefined)
    objectsToSheet(ss, 'Goals',
      ['clientId', 'code', 'description', 'numTrials', 'status'],
      cfg.goals);

  if (cfg.billing !== undefined)
    objectsToSheet(ss, 'Billing',
      ['profile', 'sessionType', 'code'],
      cfg.billing);
}


// ── SESSION: PROCESS ──────────────────────────────────────────────────

function processSession(d) {
  var ss = SpreadsheetApp.openById(d.sheetId);
  writeBehaviorData(ss, d);
  writeSessionLog(ss, d);
  writeTrialData(ss, d);
  writeABCData(ss, d);
}

/**
 * Behavior Data tab.
 * Columns: Date | Therapist | Setting | <behavior labels> |
 *          Tantrum Frequency | Tantrum Total (Min)
 */
function writeBehaviorData(ss, d) {
  var keys   = d.behaviorKeys   || ['aggression','whining','ingestingInedibles','elopement','taskRefusal','outOfArea','sib'];
  var labels = d.behaviorLabels || ['Aggression','Whining','Ingesting Inedibles','Elopement','Task Refusal','Out of Area','SIB'];
  var bd     = d.behaviorData || {};

  var headers = ['Date', 'Therapist', 'Setting'].concat(labels, ['Tantrum Frequency', 'Tantrum Total (Min)']);
  var sheet   = getOrCreateSheet(ss, 'Behavior Data', headers);

  var row = [d.date, d.therapist, d.location];
  for (var i = 0; i < keys.length; i++) {
    row.push(bd[keys[i]] || 0);
  }
  row.push(bd.tantrumFrequency || 0);
  row.push(bd.tantrumTotalMin  || 0);

  sheet.appendRow(row);
}

/**
 * Time In Time Out tab.
 * Columns: Date | Billing Code | Type of Session | Time In | Time Out |
 *          Duration (min) | Location | Therapist |
 *          App Start Time | Actual Start Time | Late Start Reason | Notes
 */
function writeSessionLog(ss, d) {
  var sheet = getOrCreateSheet(ss, 'Time In Time Out', [
    'Date', 'Billing Code', 'Type of Session', 'Time In', 'Time Out',
    'Duration (min)', 'Location', 'Therapist',
    'App Start Time', 'Actual Start Time', 'Late Start Reason', 'Notes'
  ]);

  sheet.appendRow([
    d.date,
    d.billingCode || '',
    d.sessionType || '',
    d.timeIn      || '',
    d.timeOut     || '',
    d.durationMin || 0,
    d.location    || '',
    d.therapist   || '',
    d.appStartTime    || '',
    d.actualStartTime || '',
    d.lateStartReason || '',
    d.notes           || ''
  ]);
}

/**
 * Trial Data tab — dynamic columns based on active goals.
 * Base columns: Date | Setting | Therapist
 * Then per goal: [Goal Code | Trial 1 ... Trial N | %]
 */
function writeTrialData(ss, d) {
  if (!d.trialData || !d.trialData.length) return;

  var baseHeaders = ['Date', 'Setting', 'Therapist'];
  var goalHeaders = [];

  for (var gi = 0; gi < d.trialData.length; gi++) {
    var g = d.trialData[gi];
    var n = (g.trials && g.trials.length) ? g.trials.length : 5;
    goalHeaders.push(g.goalCode);
    for (var ti = 0; ti < n; ti++) {
      goalHeaders.push('Trial ' + (ti + 1));
    }
    goalHeaders.push('%');
  }

  var sheet = getOrCreateSheet(ss, 'Trial Data', baseHeaders.concat(goalHeaders));

  var row = [d.date, d.location, d.therapist];
  for (var gi2 = 0; gi2 < d.trialData.length; gi2++) {
    var g2     = d.trialData[gi2];
    var trials = g2.trials || [];
    var pct    = (g2.percentage !== null && g2.percentage !== undefined) ? g2.percentage + '%' : '';
    row.push(g2.goalCode);
    for (var ti2 = 0; ti2 < trials.length; ti2++) {
      row.push(trials[ti2]);
    }
    row.push(pct);
  }
  sheet.appendRow(row);
}

/**
 * ABC Data tab.
 * Columns: Date | Initials | Setting | Antecedent | Behavior |
 *          Consequence | Hypothesized Function
 * One row per ABC incident.
 */
function writeABCData(ss, d) {
  if (!d.abcData || !d.abcData.length) return;

  var sheet = getOrCreateSheet(ss, 'ABC Data', [
    'Date', 'Initials', 'Setting', 'Antecedent',
    'Behavior', 'Consequence', 'Hypothesized Function'
  ]);

  for (var i = 0; i < d.abcData.length; i++) {
    var inc = d.abcData[i];
    sheet.appendRow([
      d.date,
      d.therapistInitials    || '',
      inc.setting            || '',
      inc.antecedent         || '',
      inc.behavior           || '',
      inc.consequence        || '',
      inc.hypothesizedFunction || ''
    ]);
  }
}


// ── SHEET UTILITIES ───────────────────────────────────────────────────

/** Get sheet by name, creating it with styled headers if missing. */
function getOrCreateSheet(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    var r = sheet.getRange(1, 1, 1, headers.length);
    r.setValues([headers]);
    r.setFontWeight('bold');
    r.setBackground('#00A7C7');
    r.setFontColor('#FFFFFF');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** Read a sheet tab into an array of plain objects (row 1 = keys). */
function sheetToObjects(ss, tabName) {
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  var headers = [];
  for (var hi = 0; hi < data[0].length; hi++) {
    headers.push(String(data[0][hi]).trim());
  }

  var result = [];
  for (var ri = 1; ri < data.length; ri++) {
    var row = data[ri];
    if (row[0] === '' || row[0] === null || row[0] === undefined) continue;
    var obj = {};
    for (var ci = 0; ci < headers.length; ci++) {
      obj[headers[ci]] = (row[ci] !== null && row[ci] !== undefined) ? String(row[ci]) : '';
    }
    result.push(obj);
  }
  return result;
}

/**
 * Rewrite an entire sheet tab from an array of objects.
 * Clears existing content and rewrites from row 1.
 */
function objectsToSheet(ss, tabName, headers, objects) {
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) {
    sheet = ss.insertSheet(tabName);
  } else {
    sheet.clearContents();
  }

  var r = sheet.getRange(1, 1, 1, headers.length);
  r.setValues([headers]);
  r.setFontWeight('bold');
  r.setBackground('#00A7C7');
  r.setFontColor('#FFFFFF');
  sheet.setFrozenRows(1);

  if (objects.length > 0) {
    var rows = [];
    for (var oi = 0; oi < objects.length; oi++) {
      var row = [];
      for (var hi = 0; hi < headers.length; hi++) {
        var val = objects[oi][headers[hi]];
        row.push(val !== undefined ? val : '');
      }
      rows.push(row);
    }
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
}
