/**
 * Raising Together ABA Tracker — Google Apps Script Backend v3
 * HIPAA-compliance layer: audit log, TOTP verification, weekly hours,
 * consumed hours, biweekly payroll, authorizations, admin tier mgmt.
 *
 * CRITICAL: ES5 only. No ??, no ?., no template literals, no arrow
 * functions, no spread, no let/const, no Array.from.
 */

var ADMIN_SHEET_ID = '1VPBADMXvhOww_52O1n2CieTsQB6XCotLt6XdAQsq0ik';
var AUDIT_SHEET_ID = '1tf98iS18vV08mQtPV9Vq6hQVkEp6Qg-ebUwHkeRlwaQ';

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

    } else if (data.action === 'verifyLogin') {
      var loginResult = verifyLogin(data.email, data.pin, data.totp);
      result = { success: true, valid: loginResult.valid, therapist: loginResult.therapist, reason: loginResult.reason };

    } else if (data.action === 'logAudit') {
      writeAuditLog(data.timestamp, data.userId, data.auditAction, data.clientName, data.details);
      result = { success: true };

    } else if (data.action === 'getWeeklyHours') {
      var hours = getWeeklyHours(data.therapistName, data.weekStart, data.clients);
      result = { success: true, hours: hours };

    } else if (data.action === 'getConsumedHours') {
      var consumed = getConsumedHours(data.billingCode, data.sheetId, data.startDate, data.endDate);
      result = { success: true, consumed: consumed };

    } else if (data.action === 'getBiweeklyHours') {
      var payroll = getBiweeklyHours(data.periodStart, data.periodEnd, data.clients);
      result = { success: true, payroll: payroll };

    } else if (data.action === 'getMasteryStatus') {
      var masteryResult = getMasteryStatus(
        data.clientSheetId, data.clientId, data.clientName,
        data.therapistName, data.therapistEmail, data.behaviorLabelToKey
      );
      result = { success: true, mastery: masteryResult };

    } else if (data.action === 'getMasteryReport') {
      var reportEntries = getMasteryReport(data.year, data.month, data.clients);
      result = { success: true, entries: reportEntries, clientCount: (data.clients || []).length };

    } else if (data.action === 'getBillingReport') {
      var billingRows = getBillingReport(data.clientId, data.weekStart, data.clients);
      result = { success: true, rows: billingRows };

    } else if (data.action === 'checkGoalUsage') {
      var usageResult = checkGoalUsage(data.goalCode, data.clients);
      result = { success: true, used: usageResult.used, sessionCount: usageResult.sessionCount, clients: usageResult.clients };

    } else if (data.action === 'cleanDuplicateMasteries') {
      var cleanResult = cleanDuplicateMasteries(data.clients);
      result = { success: true, removed: cleanResult.removed, details: cleanResult.details };

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
    .createTextOutput(JSON.stringify({ status: 'RT ABA Tracker v3 - online' }))
    .setMimeType(ContentService.MimeType.JSON);
}


// ── AUTH: TIER 2 LOGIN VERIFICATION ───────────────────────────────────

/**
 * Verify RBT login: email + 6-digit PIN + TOTP code.
 * Looks up therapist by email in the Therapists sheet.
 */
function verifyLogin(email, pin, totp) {
  if (!email || !pin) {
    return { valid: false, reason: 'Missing credentials' };
  }

  var ss = SpreadsheetApp.openById(ADMIN_SHEET_ID);
  var therapists = sheetToObjects(ss, 'Therapists');
  var therapist = null;

  for (var i = 0; i < therapists.length; i++) {
    var t = therapists[i];
    if (String(t.email || '').toLowerCase().trim() === String(email).toLowerCase().trim()) {
      therapist = t;
      break;
    }
  }

  if (!therapist) {
    return { valid: false, reason: 'Account not found' };
  }

  if ((therapist.status || 'active') === 'inactive') {
    return { valid: false, reason: 'Account is inactive' };
  }

  // Verify 6-digit PIN
  if (String(therapist.pin || '') !== String(pin)) {
    return { valid: false, reason: 'Incorrect PIN' };
  }

  // Verify TOTP if secret is configured
  var secret = String(therapist.totpSecret || '').trim();
  if (secret) {
    if (!totp) return { valid: false, reason: 'Authenticator code required' };
    if (!verifyTOTP(secret, String(totp).trim())) {
      return { valid: false, reason: 'Invalid authenticator code' };
    }
  }

  // PIN login is for Collector role only
  var role = String(therapist.role || 'collector').toLowerCase();
  if (role !== 'collector') {
    return { valid: false, reason: 'Use Google Sign-In for your account type' };
  }

  return {
    valid: true,
    therapist: {
      id:               therapist.id,
      name:             therapist.name,
      initials:         therapist.initials,
      color:            therapist.color,
      profile:          therapist.profile,
      email:            therapist.email,
      clientIds:        therapist.clientIds || '',
      weeklyHourLimit:  therapist.weeklyHourLimit || '30',
      payRate:          therapist.payRate || '',
      role:             role
    }
  };
}


// ── TOTP VERIFICATION ─────────────────────────────────────────────────

function verifyTOTP(secret, token) {
  var key = base32Decode(secret);
  var counter = Math.floor(Date.now() / 1000 / 30);
  for (var offset = -1; offset <= 1; offset++) {
    if (generateTOTP(key, counter + offset) === token) return true;
  }
  return false;
}

function generateTOTP(key, counter) {
  var msg = counterToBytes(counter);
  var hash = Utilities.computeHmacSignature(
    Utilities.MacAlgorithm.HMAC_SHA_1, msg, key
  );
  var offset = hash[19] & 0xf;
  var code = ((hash[offset] & 0x7f) << 24) |
             ((hash[offset + 1] & 0xff) << 16) |
             ((hash[offset + 2] & 0xff) << 8) |
              (hash[offset + 3] & 0xff);
  code = code % 1000000;
  var str = String(code);
  while (str.length < 6) str = '0' + str;
  return str;
}

function counterToBytes(counter) {
  var bytes = [0, 0, 0, 0, 0, 0, 0, 0];
  for (var i = 7; i >= 0; i--) {
    bytes[i] = counter & 0xff;
    counter = Math.floor(counter / 256);
  }
  return bytes;
}

function base32Decode(encoded) {
  var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  var bits = 0;
  var value = 0;
  var output = [];
  var str = encoded.replace(/=+$/, '').toUpperCase();
  for (var i = 0; i < str.length; i++) {
    var idx = alphabet.indexOf(str[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((value >>> bits) & 0xff);
    }
  }
  return output;
}


// ── AUDIT LOG ─────────────────────────────────────────────────────────

function writeAuditLog(timestamp, userId, action, clientName, details) {
  if (!AUDIT_SHEET_ID) return;
  try {
    var ss = SpreadsheetApp.openById(AUDIT_SHEET_ID);
    var sheet = getOrCreateSheet(ss, 'Audit Log', [
      'Timestamp', 'User', 'Action', 'Client', 'Details'
    ]);
    sheet.appendRow([
      timestamp  || new Date().toISOString(),
      userId     || '',
      action     || '',
      clientName || '',
      details    || ''
    ]);
  } catch (e) {
    // Don't let audit failures break other operations
  }
}


// ── WEEKLY HOURS ──────────────────────────────────────────────────────

/**
 * Sum hours worked by therapistName across all client sheets
 * within [weekStart, weekStart+7d).
 * clients: array of { name, sheetId }
 */
function getWeeklyHours(therapistName, weekStart, clients) {
  if (!clients || !clients.length) return 0;

  var weekStartDate = new Date(weekStart);
  var weekEndDate   = new Date(weekStartDate.getTime());
  weekEndDate.setDate(weekEndDate.getDate() + 7);

  var totalMin = 0;

  for (var ci = 0; ci < clients.length; ci++) {
    var client = clients[ci];
    if (!client.sheetId) continue;
    try {
      var ss    = SpreadsheetApp.openById(client.sheetId);
      var sheet = ss.getSheetByName('Time In Time Out');
      if (!sheet) continue;
      var rows = sheet.getDataRange().getValues();
      if (rows.length < 2) continue;

      var headers = rows[0];
      var dateCol = -1, therapistCol = -1, durationCol = -1;
      for (var hi = 0; hi < headers.length; hi++) {
        var h = String(headers[hi]).trim().toLowerCase();
        if (h === 'date')           dateCol      = hi;
        if (h === 'therapist')      therapistCol = hi;
        if (h === 'duration (min)') durationCol  = hi;
      }
      if (dateCol < 0 || therapistCol < 0 || durationCol < 0) continue;

      for (var ri = 1; ri < rows.length; ri++) {
        var row = rows[ri];
        var rowTherapist = String(row[therapistCol] || '').trim();
        if (rowTherapist !== therapistName) continue;
        var rowDate = new Date(row[dateCol]);
        if (rowDate >= weekStartDate && rowDate < weekEndDate) {
          totalMin += parseFloat(row[durationCol]) || 0;
        }
      }
    } catch (e) {
      // skip inaccessible client sheet
    }
  }

  return totalMin / 60;
}


// ── CONSUMED HOURS PER BILLING CODE ───────────────────────────────────

/**
 * Sum minutes billed under billingCode in the given client sheet.
 * Returns hours (float).
 */
function getConsumedHours(billingCode, sheetId, startDate, endDate) {
  if (!sheetId || !billingCode) return 0;
  try {
    var ss    = SpreadsheetApp.openById(sheetId);
    var sheet = ss.getSheetByName('Time In Time Out');
    if (!sheet) return 0;
    var rows = sheet.getDataRange().getValues();
    if (rows.length < 2) return 0;

    var headers = rows[0];
    var billingCol = -1, durationCol = -1, dateCol = -1, dateISOCol = -1;
    for (var hi = 0; hi < headers.length; hi++) {
      var h = String(headers[hi]).trim().toLowerCase();
      if (h === 'billing code')   billingCol  = hi;
      if (h === 'duration (min)') durationCol = hi;
      if (h === 'date')           dateCol     = hi;
      if (h === 'dateiso')        dateISOCol  = hi;
    }
    if (billingCol < 0 || durationCol < 0) return 0;

    // Parse optional date range
    var rangeStart = startDate ? new Date(startDate) : null;
    var rangeEnd   = endDate   ? new Date(endDate)   : null;
    if (rangeEnd) rangeEnd.setDate(rangeEnd.getDate() + 1); // make end inclusive

    var totalMin = 0;
    for (var ri = 1; ri < rows.length; ri++) {
      var row     = rows[ri];
      var rowCode = String(row[billingCol] || '').trim();
      if (rowCode !== billingCode) continue;

      // Date range filter (only applied if startDate or endDate provided)
      if (rangeStart || rangeEnd) {
        var rowDateStr = '';
        if (dateISOCol >= 0) {
          rowDateStr = toDateISO(row[dateISOCol]);
        }
        if (!rowDateStr && dateCol >= 0) {
          rowDateStr = toDateISO(row[dateCol]);
        }
        if (rowDateStr) {
          var rowDate = new Date(rowDateStr);
          if (rangeStart && rowDate < rangeStart) continue;
          if (rangeEnd   && rowDate >= rangeEnd)  continue;
        }
      }

      totalMin += parseFloat(row[durationCol]) || 0;
    }
    return totalMin / 60;
  } catch (e) {
    return 0;
  }
}


// ── BIWEEKLY PAYROLL ──────────────────────────────────────────────────

/**
 * Aggregate hours per therapist per client in [periodStart, periodEnd] inclusive.
 * Returns { therapistName: { total: h, clients: { clientName: h } } }
 */
function getBiweeklyHours(periodStart, periodEnd, clients) {
  if (!clients || !clients.length) return {};

  var startDate = new Date(periodStart);
  var endDate   = new Date(periodEnd);
  endDate.setDate(endDate.getDate() + 1); // make end inclusive

  var result = {};

  for (var ci = 0; ci < clients.length; ci++) {
    var client = clients[ci];
    if (!client.sheetId) continue;
    try {
      var ss    = SpreadsheetApp.openById(client.sheetId);
      var sheet = ss.getSheetByName('Time In Time Out');
      if (!sheet) continue;
      var rows = sheet.getDataRange().getValues();
      if (rows.length < 2) continue;

      var headers = rows[0];
      var dateCol = -1, therapistCol = -1, durationCol = -1, billingCol = -1;
      for (var hi = 0; hi < headers.length; hi++) {
        var h = String(headers[hi]).trim().toLowerCase();
        if (h === 'date')           dateCol      = hi;
        if (h === 'therapist')      therapistCol = hi;
        if (h === 'duration (min)') durationCol  = hi;
        if (h === 'billing code')   billingCol   = hi;
      }
      if (dateCol < 0 || therapistCol < 0 || durationCol < 0) continue;

      for (var ri = 1; ri < rows.length; ri++) {
        var row     = rows[ri];
        var rowDate = new Date(row[dateCol]);
        if (rowDate < startDate || rowDate >= endDate) continue;
        var tName = String(row[therapistCol] || '').trim();
        if (!tName) continue;
        var mins = parseFloat(row[durationCol]) || 0;
        var bCode = billingCol >= 0 ? String(row[billingCol] || '').trim() : '';
        if (!result[tName]) result[tName] = { total: 0, clients: {}, billingCodes: {} };
        result[tName].total += mins / 60;
        if (!result[tName].clients[client.name]) result[tName].clients[client.name] = 0;
        result[tName].clients[client.name] += mins / 60;
        if (bCode) {
          if (!result[tName].billingCodes[bCode]) result[tName].billingCodes[bCode] = 0;
          result[tName].billingCodes[bCode] += mins / 60;
        }
      }
    } catch (e) {
      // skip
    }
  }
  return result;
}


// ── CONFIG: READ ──────────────────────────────────────────────────────

function getConfig() {
  var ss = SpreadsheetApp.openById(ADMIN_SHEET_ID);
  return {
    therapists:     sheetToObjects(ss, 'Therapists'),
    clients:        sheetToObjects(ss, 'Clients'),
    behaviors:      sheetToObjects(ss, 'Behaviors'),
    goals:          sheetToObjects(ss, 'Goals'),
    billing:        sheetToObjects(ss, 'Billing'),
    authorizations: sheetToObjects(ss, 'Authorizations'),
    admins:         sheetToObjects(ss, 'Admins')
  };
}


// ── CONFIG: WRITE ─────────────────────────────────────────────────────

function saveConfig(cfg) {
  var ss = SpreadsheetApp.openById(ADMIN_SHEET_ID);

  if (cfg.therapists !== undefined)
    objectsToSheet(ss, 'Therapists',
      ['id', 'name', 'initials', 'color', 'profile', 'email', 'pin',
       'totpSecret', 'clientIds', 'weeklyHourLimit', 'payRate', 'status', 'role'],
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
      ['clientId', 'clientIds', 'code', 'description', 'numTrials', 'status'],
      cfg.goals);

  if (cfg.billing !== undefined)
    objectsToSheet(ss, 'Billing',
      ['profile', 'sessionType', 'code'],
      cfg.billing);

  if (cfg.authorizations !== undefined)
    objectsToSheet(ss, 'Authorizations',
      ['clientId', 'payerType', 'insuranceCompany', 'authorizationNumber',
       'billingCode', 'authorizedHours', 'startDate', 'endDate',
       'coInsurance', 'stepUpProgram', 'status', 'unitRate', 'hourlyRate'],
      cfg.authorizations);

  if (cfg.admins !== undefined)
    objectsToSheet(ss, 'Admins',
      ['email', 'name', 'status'],
      cfg.admins);
}


// ── SESSION: PROCESS ──────────────────────────────────────────────────

function processSession(d) {
  var ss = SpreadsheetApp.openById(d.sheetId);
  writeBehaviorData(ss, d);
  writeSessionLog(ss, d);
  writeTrialData(ss, d);
  writeABCData(ss, d);
  // Also write audit entry if audit sheet configured
  writeAuditLog(
    new Date().toISOString(),
    d.therapist || '',
    'session_submit',
    d.clientName || '',
    'Session ' + (d.submissionId || '') + ' duration=' + (d.durationMin || 0) + 'min'
  );
}

/**
 * Behavior Data tab.
 * Base columns: Date | Therapist | Setting | <behavior labels> |
 *               Tantrum Frequency | Tantrum Total (Min)
 * Analytics columns (appended, backward-compatible):
 *   submissionId | clientName | clientId | therapistEmail |
 *   sessionType | billingCode | isDraft | payloadHash | submittedAt | dateISO
 */
function writeBehaviorData(ss, d) {
  var keys   = d.behaviorKeys   || ['aggression','whining','ingestingInedibles','elopement','taskRefusal','outOfArea','sib'];
  var labels = d.behaviorLabels || ['Aggression','Whining','Ingesting Inedibles','Elopement','Task Refusal','Out of Area','SIB'];
  var bd     = d.behaviorData || {};

  var analyticsHeaders = [
    'submissionId', 'clientName', 'clientId', 'therapistEmail',
    'sessionType', 'billingCode', 'isDraft', 'payloadHash', 'submittedAt', 'dateISO'
  ];
  var allHeaders = ['Date', 'Therapist', 'Setting']
    .concat(labels, ['Tantrum Frequency', 'Tantrum Total (Min)'])
    .concat(analyticsHeaders);

  var sheet = getOrCreateSheet(ss, 'Behavior Data', allHeaders);
  ensureSheetColumns(sheet, allHeaders);

  var row = [d.date, d.therapist, d.location];
  for (var i = 0; i < keys.length; i++) {
    row.push(typeof bd[keys[i]] === 'number' ? bd[keys[i]] : (bd[keys[i]] || 0));
  }
  row.push(bd.tantrumFrequency || 0);
  row.push(bd.tantrumTotalMin  || 0);
  // Analytics columns
  row.push(d.submissionId   || '');
  row.push(d.clientName     || '');
  row.push(d.clientId       || '');
  row.push(d.therapistEmail || d.submittedBy || '');
  row.push(d.sessionType    || '');
  row.push(d.billingCode    || '');
  row.push(d.isDraft ? true : false);
  row.push(d.payloadHash    || '');
  row.push(d.submittedAt    || new Date().toISOString());
  row.push(d.dateISO        || '');

  sheet.appendRow(row);
}

/**
 * Time In Time Out tab.
 * Base columns (unchanged): Date | Billing Code | Type of Session | Time In |
 *   Time Out | Duration (min) | Location | Therapist | App Start Time |
 *   Actual Start Time | Late Start Reason | Submission ID | Notes
 * Analytics columns (appended, backward-compatible):
 *   clientName | clientId | therapistEmail | isDraft | payloadHash |
 *   submittedAt | dateISO
 */
function writeSessionLog(ss, d) {
  var baseHeaders = [
    'Date', 'Billing Code', 'Type of Session', 'Time In', 'Time Out',
    'Duration (min)', 'Location', 'Therapist',
    'App Start Time', 'Actual Start Time', 'Late Start Reason',
    'Submission ID', 'Notes'
  ];
  var analyticsHeaders = [
    'clientName', 'clientId', 'therapistEmail',
    'isDraft', 'payloadHash', 'submittedAt', 'dateISO'
  ];
  // New end-time adjustment columns — appended at END only
  var adjustHeaders = ['Adjusted End Time', 'End Time Adjustment Reason'];
  // Manual entry tracking columns — appended at END
  var manualHeaders = ['manualEntry', 'enteredBy'];
  var allHeaders = baseHeaders.concat(analyticsHeaders, adjustHeaders, manualHeaders);

  var sheet = getOrCreateSheet(ss, 'Time In Time Out', allHeaders);
  ensureSheetColumns(sheet, allHeaders);

  sheet.appendRow([
    // Base columns (unchanged)
    d.date,
    d.billingCode         || '',
    d.sessionType         || '',
    d.timeIn              || '',
    d.timeOut             || '',
    d.durationMin         || 0,
    d.location            || '',
    d.therapist           || '',
    d.appStartTime        || '',
    d.actualStartTime     || '',
    d.lateStartReason     || '',
    d.submissionId        || '',
    d.notes               || '',
    // Analytics columns
    d.clientName          || '',
    d.clientId            || '',
    d.therapistEmail      || d.submittedBy || '',
    d.isDraft ? true : false,
    d.payloadHash         || '',
    d.submittedAt         || new Date().toISOString(),
    d.dateISO             || '',
    // End-time adjustment columns (new — at end)
    d.adjustedEndTime           || '',
    d.endTimeAdjustmentReason   || '',
    // Manual entry tracking (new — at end)
    d.manualEntry ? true : false,
    d.enteredBy                 || ''
  ]);
}

/**
 * Trial Data tab — dynamic columns based on active goals.
 * Base columns: Date | Setting | Therapist
 * Per-goal columns: [Goal Code | Trial 1 … Trial N | %]  (% kept as string for compat)
 * Analytics columns (appended, backward-compatible):
 *   submissionId | clientName | clientId | therapistEmail | sessionType |
 *   billingCode | isDraft | payloadHash | submittedAt | dateISO | Percent Correct
 * "Percent Correct" is a JSON string mapping goal codes to numeric percentages,
 * e.g. {"G1":80,"G2":100} — use JSON_EXTRACT in BigQuery for clean numerics.
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

  var analyticsHeaders = [
    'submissionId', 'clientName', 'clientId', 'therapistEmail',
    'sessionType', 'billingCode', 'isDraft', 'payloadHash',
    'submittedAt', 'dateISO', 'Percent Correct'
  ];
  var allHeaders = baseHeaders.concat(goalHeaders, analyticsHeaders);

  var sheet = getOrCreateSheet(ss, 'Trial Data', allHeaders);
  ensureSheetColumns(sheet, analyticsHeaders);

  // Build numeric percentages map for the Percent Correct column
  var pctMap = {};
  for (var gi3 = 0; gi3 < d.trialData.length; gi3++) {
    var gp = d.trialData[gi3];
    if (gp.percentage !== null && gp.percentage !== undefined) {
      pctMap[gp.goalCode] = gp.percentage;
    }
  }
  var percentCorrectJSON = JSON.stringify(pctMap);

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
  // Analytics columns
  row.push(d.submissionId   || '');
  row.push(d.clientName     || '');
  row.push(d.clientId       || '');
  row.push(d.therapistEmail || d.submittedBy || '');
  row.push(d.sessionType    || '');
  row.push(d.billingCode    || '');
  row.push(d.isDraft ? true : false);
  row.push(d.payloadHash    || '');
  row.push(d.submittedAt    || new Date().toISOString());
  row.push(d.dateISO        || '');
  row.push(percentCorrectJSON);

  sheet.appendRow(row);
}

/**
 * ABC Data tab.
 * Base columns (unchanged): Date | Initials | Setting | Antecedent |
 *   Behavior | Consequence | Hypothesized Function
 * Analytics columns (appended, backward-compatible):
 *   Time | submissionId | clientName | clientId | therapistName |
 *   therapistEmail | sessionType | billingCode | isDraft | payloadHash |
 *   submittedAt | dateISO
 */
function writeABCData(ss, d) {
  if (!d.abcData || !d.abcData.length) return;

  var baseHeaders = [
    'Date', 'Initials', 'Setting', 'Antecedent',
    'Behavior', 'Consequence', 'Hypothesized Function'
  ];
  var analyticsHeaders = [
    'Time', 'submissionId', 'clientName', 'clientId',
    'therapistName', 'therapistEmail', 'sessionType', 'billingCode',
    'isDraft', 'payloadHash', 'submittedAt', 'dateISO'
  ];
  var allHeaders = baseHeaders.concat(analyticsHeaders);

  var sheet = getOrCreateSheet(ss, 'ABC Data', allHeaders);
  ensureSheetColumns(sheet, allHeaders);

  for (var i = 0; i < d.abcData.length; i++) {
    var inc = d.abcData[i];
    sheet.appendRow([
      // Base columns (unchanged)
      d.date,
      d.therapistInitials      || '',
      inc.setting              || '',
      inc.antecedent           || '',
      inc.behavior             || '',
      inc.consequence          || '',
      inc.hypothesizedFunction || '',
      // Analytics columns
      inc.time                 || '',
      d.submissionId           || '',
      d.clientName             || '',
      d.clientId               || '',
      d.therapist              || '',
      d.therapistEmail         || d.submittedBy || '',
      d.sessionType            || '',
      d.billingCode            || '',
      d.isDraft ? true : false,
      d.payloadHash            || '',
      d.submittedAt            || new Date().toISOString(),
      d.dateISO                || ''
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

/**
 * Add any headers from the provided list that are not already in row 1.
 * New headers are appended at the right — existing columns are never moved.
 * Safe to call on every write; no-ops when all headers are already present.
 */
function ensureSheetColumns(sheet, headers) {
  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) {
    // Completely empty sheet — write all headers from scratch
    var r = sheet.getRange(1, 1, 1, headers.length);
    r.setValues([headers]);
    r.setFontWeight('bold');
    r.setBackground('#00A7C7');
    r.setFontColor('#FFFFFF');
    sheet.setFrozenRows(1);
    return;
  }
  var existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var existingMap = {};
  for (var i = 0; i < existing.length; i++) {
    existingMap[String(existing[i]).trim()] = true;
  }
  var toAdd = [];
  for (var j = 0; j < headers.length; j++) {
    if (!existingMap[String(headers[j]).trim()]) {
      toAdd.push(headers[j]);
    }
  }
  if (!toAdd.length) return;
  var startCol = lastCol + 1;
  var r2 = sheet.getRange(1, startCol, 1, toAdd.length);
  r2.setValues([toAdd]);
  r2.setFontWeight('bold');
  r2.setBackground('#00A7C7');
  r2.setFontColor('#FFFFFF');
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

  if (objects && objects.length > 0) {
    var rows = [];
    for (var oi = 0; oi < objects.length; oi++) {
      var row = [];
      for (var hi = 0; hi < headers.length; hi++) {
        var val = objects[oi][headers[hi]];
        row.push((val !== undefined && val !== null) ? val : '');
      }
      rows.push(row);
    }
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
}


// ── MASTERY STATUS ─────────────────────────────────────────────────────

/**
 * Check goal and behavior mastery for a client.
 * Goal mastery: 80%+ for 5 consecutive sessions.
 * Behavior mastery: <=1 occurrence for 8 consecutive sessions.
 * Returns: { goals: { code: bool }, behaviors: { key: bool }, newMasteries: [...] }
 */
function getMasteryStatus(clientSheetId, clientId, clientName, therapistName, therapistEmail, behaviorLabelToKey) {
  var result = { goals: {}, behaviors: {}, newMasteries: [] };
  if (!clientSheetId) return result;

  try {
    var ss = SpreadsheetApp.openById(clientSheetId);
    checkGoalMastery(ss, clientId, clientName, therapistName, therapistEmail, result);
    checkBehaviorMastery(ss, clientId, clientName, therapistName, therapistEmail, result, behaviorLabelToKey || {});
  } catch (e) {
    // Return empty on error — do not disrupt session
  }
  return result;
}

function checkGoalMastery(ss, clientId, clientName, therapistName, therapistEmail, result) {
  var sheet = ss.getSheetByName('Trial Data');
  if (!sheet) return;
  var rows = sheet.getDataRange().getValues();
  if (rows.length < 2) return;

  var headers = rows[0];
  // Find "Percent Correct" column (JSON map of goal->numeric pct)
  var pctJsonCol = -1;
  for (var hi = 0; hi < headers.length; hi++) {
    if (String(headers[hi]).trim() === 'Percent Correct') { pctJsonCol = hi; break; }
  }
  if (pctJsonCol < 0) return;

  // Collect data rows (skip header)
  var dataRows = [];
  for (var ri = 1; ri < rows.length; ri++) {
    var pctJson = String(rows[ri][pctJsonCol] || '').trim();
    if (pctJson) dataRows.push(pctJson);
  }

  // Need at least 5 rows to check mastery
  if (dataRows.length < 5) return;

  // Get the 5 most recent rows
  var last5 = dataRows.slice(-5);

  // Collect all goal codes seen across these 5 sessions
  var goalMap = {};
  for (var di = 0; di < last5.length; di++) {
    try {
      var pctObj = JSON.parse(last5[di]);
      var codes = Object.keys(pctObj);
      for (var ki = 0; ki < codes.length; ki++) {
        var code = codes[ki];
        if (!goalMap[code]) goalMap[code] = [];
        goalMap[code].push(parseFloat(pctObj[code]));
      }
    } catch(e) {}
  }

  var today = new Date().toISOString().substring(0, 10);
  var codes = Object.keys(goalMap);
  for (var gi = 0; gi < codes.length; gi++) {
    var code = codes[gi];
    var scores = goalMap[code];
    if (scores.length < 5) { result.goals[code] = false; continue; }
    // Check if all 5 are >= 80
    var allMastered = true;
    for (var si = 0; si < scores.length; si++) {
      if (isNaN(scores[si]) || scores[si] < 80) { allMastered = false; break; }
    }
    result.goals[code] = allMastered;
    if (allMastered) {
      // Check if this mastery is already recorded in Mastery Log
      if (!isMasteryLogged(ss, 'goal', code)) {
        var scoresStr = scores.join(', ') + '%';
        writeMasteryLog(ss, 'goal', code, '', today, scoresStr, therapistName, therapistEmail, clientName, clientId);
        result.newMasteries.push({ type: 'goal', code: code, description: '', masteryDate: today, lastScores: scoresStr });
      }
    }
  }
}

function checkBehaviorMastery(ss, clientId, clientName, therapistName, therapistEmail, result, labelToKey) {
  var sheet = ss.getSheetByName('Behavior Data');
  if (!sheet) return;
  var rows = sheet.getDataRange().getValues();
  if (rows.length < 2) return;

  var headers = rows[0];
  // Find columns: Date=0, Therapist=1, Setting=2, then behaviors until Tantrum Frequency
  var startCol = 3; // behavior columns start after Date, Therapist, Setting
  var endCol   = -1;
  for (var hi = 0; hi < headers.length; hi++) {
    if (String(headers[hi]).trim() === 'Tantrum Frequency') { endCol = hi; break; }
  }
  if (endCol < 0) endCol = headers.length; // fallback: use all remaining cols

  // Collect last 8 data rows
  var dataRows = rows.slice(1); // skip header
  if (dataRows.length < 8) return;
  var last8 = dataRows.slice(-8);

  var today = new Date().toISOString().substring(0, 10);

  for (var ci = startCol; ci < endCol; ci++) {
    var label = String(headers[ci] || '').trim();
    if (!label) continue;
    // Use the label→key map if provided; otherwise fall back to stripped lowercase
    var key = (labelToKey && labelToKey[label]) ? labelToKey[label] : label.toLowerCase().replace(/[^a-z0-9]/g, '');
    var allMastered = true;
    var scores = [];
    for (var ri = 0; ri < last8.length; ri++) {
      var count = parseFloat(last8[ri][ci]) || 0;
      scores.push(count);
      if (count > 1) { allMastered = false; }
    }
    result.behaviors[key] = allMastered;
    if (allMastered) {
      if (!isMasteryLogged(ss, 'behavior', key)) {
        var scoresStr = scores.join(', ');
        writeMasteryLog(ss, 'behavior', key, label, today, scoresStr, therapistName, therapistEmail, clientName, clientId);
        result.newMasteries.push({ type: 'behavior', code: key, description: label, masteryDate: today, lastScores: scoresStr });
      }
    }
  }
}

/**
 * Normalize a cell value to a YYYY-MM-DD string.
 * Google Sheets sometimes auto-converts ISO date strings to Date objects
 * when stored via appendRow; this undoes that conversion safely.
 */
function toDateISO(val) {
  if (!val && val !== 0) return '';
  if (val instanceof Date) {
    return Utilities.formatDate(val, 'UTC', 'yyyy-MM-dd');
  }
  return String(val).trim();
}

// Checks if a mastery entry already exists for this type+code in this client's sheet.
// Intentionally does NOT filter by date — once mastered, never log again.
function isMasteryLogged(ss, type, code) {
  var sheet = ss.getSheetByName('Mastery Log');
  if (!sheet) return false;
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return false;
  var headers = data[0];
  var typeCol = -1, codeCol = -1;
  for (var hi = 0; hi < headers.length; hi++) {
    var h = String(headers[hi]).trim();
    if (h === 'type') typeCol = hi;
    if (h === 'code') codeCol = hi;
  }
  if (typeCol < 0 || codeCol < 0) return false;
  for (var ri = 1; ri < data.length; ri++) {
    var row = data[ri];
    if (String(row[typeCol]).trim() === type &&
        String(row[codeCol]).trim() === code) {
      return true;
    }
  }
  return false;
}

function writeMasteryLog(ss, type, code, description, masteryDate, lastScores, therapistName, therapistEmail, clientName, clientId) {
  var masteryHeaders = [
    'type', 'code', 'description', 'masteryDate', 'lastScores',
    'therapistName', 'therapistEmail', 'clientName', 'clientId', 'dateISO'
  ];
  var sheet = getOrCreateSheet(ss, 'Mastery Log', masteryHeaders);
  ensureSheetColumns(sheet, masteryHeaders);
  sheet.appendRow([
    type, code, description || '', masteryDate, lastScores || '',
    therapistName || '', therapistEmail || '', clientName || '', clientId || '', masteryDate
  ]);
}


// ── MASTERY REPORT ─────────────────────────────────────────────────────

/**
 * Aggregate mastery log entries across all client sheets for a given month/year.
 * clients: [{ id, name, sheetId }]
 * Returns array of entries.
 */
function getMasteryReport(year, month, clients) {
  if (!clients || !clients.length) return [];
  var entries = [];
  var seen    = {};  // dedup key: clientId|type|code
  var monthStr = String(month).length < 2 ? ('0' + month) : String(month);
  var prefix   = year + '-' + monthStr;

  for (var ci = 0; ci < clients.length; ci++) {
    var client = clients[ci];
    if (!client.sheetId) continue;
    try {
      var ss    = SpreadsheetApp.openById(client.sheetId);
      var sheet = ss.getSheetByName('Mastery Log');
      if (!sheet) continue;
      var data  = sheet.getDataRange().getValues();
      if (data.length < 2) continue;
      var headers = data[0];

      // Build column map
      var colMap = {};
      for (var hi = 0; hi < headers.length; hi++) {
        colMap[String(headers[hi]).trim()] = hi;
      }

      for (var ri = 1; ri < data.length; ri++) {
        var row = data[ri];
        var entryType = String(row[colMap['type']] || '').trim();
        var entryCode = String(row[colMap['code']] || '').trim();

        // Deduplicate: skip if we already have an entry for this client+type+code
        var dedupKey = (client.id || '') + '|' + entryType + '|' + entryCode;
        if (seen[dedupKey]) continue;

        // Normalize dateISO — Google Sheets may store ISO strings as Date objects
        var dateISO = toDateISO(colMap['dateISO'] !== undefined ? row[colMap['dateISO']] : '');
        // Fall back to masteryDate column if dateISO is missing
        if (!dateISO && colMap['masteryDate'] !== undefined) {
          dateISO = toDateISO(row[colMap['masteryDate']]);
        }
        if (!dateISO || dateISO.indexOf(prefix) !== 0) continue;
        var masteryDateVal = colMap['masteryDate'] !== undefined ? toDateISO(row[colMap['masteryDate']]) : dateISO;

        seen[dedupKey] = true;
        entries.push({
          clientId:      client.id || '',
          clientName:    client.name || '',
          type:          entryType,
          code:          entryCode,
          description:   String(row[colMap['description']]   || '').trim(),
          masteryDate:   masteryDateVal,
          lastScores:    String(row[colMap['lastScores']]    || '').trim(),
          therapistName: String(row[colMap['therapistName']] || '').trim(),
          therapistEmail:String(row[colMap['therapistEmail']]|| '').trim()
        });
      }
    } catch(e) {
      // Skip inaccessible client sheets
    }
  }
  return entries;
}


// ── MASTERY DUPLICATE CLEANUP ───────────────────────────────────────────

/**
 * One-time cleanup: remove duplicate Mastery Log entries across all client sheets.
 * For each client, groups rows by (type + code). Keeps the FIRST occurrence
 * (lowest row index = earliest logged). Deletes all later duplicates.
 * clients: [{ id, name, sheetId }]
 * Returns { removed: <total count>, details: [{ clientName, removed }] }
 */
function cleanDuplicateMasteries(clients) {
  var totalRemoved = 0;
  var details = [];
  if (!clients || !clients.length) return { removed: 0, details: [] };

  for (var ci = 0; ci < clients.length; ci++) {
    var client = clients[ci];
    if (!client.sheetId) continue;
    try {
      var ss    = SpreadsheetApp.openById(client.sheetId);
      var sheet = ss.getSheetByName('Mastery Log');
      if (!sheet) continue;
      var data = sheet.getDataRange().getValues();
      if (data.length < 2) continue;

      var headers = data[0];
      var typeCol = -1, codeCol = -1;
      for (var hi = 0; hi < headers.length; hi++) {
        var h = String(headers[hi]).trim();
        if (h === 'type') typeCol = hi;
        if (h === 'code') codeCol = hi;
      }
      if (typeCol < 0 || codeCol < 0) continue;

      // Identify which rows (1-based sheet row) are duplicates
      var seen = {};
      var rowsToDelete = []; // 1-based sheet row indices, collected in order
      for (var ri = 1; ri < data.length; ri++) {
        var row  = data[ri];
        var key  = String(row[typeCol] || '').trim() + '|' + String(row[codeCol] || '').trim();
        if (!key || key === '|') continue; // skip blank rows
        if (seen[key]) {
          rowsToDelete.push(ri + 1); // +1 because sheet rows are 1-based
        } else {
          seen[key] = true;
        }
      }

      // Delete from bottom to top so row indices stay valid
      for (var di = rowsToDelete.length - 1; di >= 0; di--) {
        sheet.deleteRow(rowsToDelete[di]);
      }

      var removed = rowsToDelete.length;
      totalRemoved += removed;
      if (removed > 0) {
        details.push({ clientName: client.name || client.id, removed: removed });
      }
    } catch(e) {
      // Skip inaccessible sheets; don't abort the whole cleanup
    }
  }
  return { removed: totalRemoved, details: details };
}


// ── WEEKLY BILLING REPORT ───────────────────────────────────────────────

/**
 * Aggregate session rows from Time In Time Out for a Mon-Sun week,
 * matched against insurance authorization rates from the admin sheet.
 * clientId: specific client id, or 'all'
 * weekStart: ISO date string (Monday)
 * clients: [{ id, name, sheetId }]
 * Returns array of row objects for the frontend billing report.
 */
function getBillingReport(clientId, weekStart, clients) {
  if (!clients || !clients.length) return [];

  var startDate = new Date(weekStart);
  startDate.setUTCHours(0, 0, 0, 0);
  var endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + 7);

  // Read authorizations once from admin sheet
  var adminSS = SpreadsheetApp.openById(ADMIN_SHEET_ID);
  var auths = sheetToObjects(adminSS, 'Authorizations');

  var rows = [];

  for (var ci = 0; ci < clients.length; ci++) {
    var client = clients[ci];
    if (clientId !== 'all' && client.id !== clientId) continue;
    if (!client.sheetId) continue;

    try {
      var ss    = SpreadsheetApp.openById(client.sheetId);
      var sheet = ss.getSheetByName('Time In Time Out');
      if (!sheet) continue;
      var data = sheet.getDataRange().getValues();
      if (data.length < 2) continue;

      var hdrs = data[0];
      var colMap = {};
      for (var hi = 0; hi < hdrs.length; hi++) {
        colMap[String(hdrs[hi]).trim()] = hi;
      }

      var dateIdx     = colMap['Date']            !== undefined ? colMap['Date']            : -1;
      var therapistIdx = colMap['Therapist']      !== undefined ? colMap['Therapist']       : -1;
      var billingIdx  = colMap['Billing Code']    !== undefined ? colMap['Billing Code']    : -1;
      var sessTypeIdx = colMap['Type of Session'] !== undefined ? colMap['Type of Session'] : -1;
      var durationIdx = colMap['Duration (min)']  !== undefined ? colMap['Duration (min)']  : -1;
      var dateISOIdx  = colMap['dateISO']          !== undefined ? colMap['dateISO']          : -1;

      if (dateIdx < 0 || durationIdx < 0) continue;

      for (var ri = 1; ri < data.length; ri++) {
        var row     = data[ri];
        var rowDate = new Date(row[dateIdx]);
        if (rowDate < startDate || rowDate >= endDate) continue;

        var bCode    = billingIdx  >= 0 ? String(row[billingIdx]   || '').trim() : '';
        var duration = parseFloat(row[durationIdx]) || 0;
        var therapist = therapistIdx >= 0 ? String(row[therapistIdx] || '').trim() : '';
        var sessType  = sessTypeIdx  >= 0 ? String(row[sessTypeIdx]  || '').trim() : '';

        var dateISO = dateISOIdx >= 0 ? toDateISO(row[dateISOIdx]) : '';
        if (!dateISO) {
          dateISO = Utilities.formatDate(rowDate, 'UTC', 'yyyy-MM-dd');
        }

        // Match authorization for this client + billing code
        var matchAuth = null;
        for (var ai = 0; ai < auths.length; ai++) {
          var a = auths[ai];
          if (a.clientId === client.id &&
              String(a.billingCode || '').trim() === bCode &&
              (a.status || 'active') !== 'inactive') {
            matchAuth = a;
            break;
          }
        }

        var unitRate   = matchAuth ? (parseFloat(matchAuth.unitRate)   || 0) : 0;
        var hourlyRate = matchAuth ? (parseFloat(matchAuth.hourlyRate)  || 0) : 0;
        var insCompany = matchAuth ? (matchAuth.insuranceCompany        || '') : '';

        var hours    = Math.round(duration / 60 * 100) / 100;
        var billable = hourlyRate > 0 ? Math.round(hours * hourlyRate * 100) / 100 : 0;

        rows.push({
          date:             dateISO,
          clientName:       client.name,
          clientId:         client.id,
          therapist:        therapist,
          billingCode:      bCode,
          sessionType:      sessType,
          durationMin:      duration,
          hours:            hours,
          insuranceCompany: insCompany,
          unitRate:         unitRate,
          hourlyRate:       hourlyRate,
          billable:         billable
        });
      }
    } catch(e) {
      // Skip inaccessible sheets
    }
  }

  // Sort by date ascending
  rows.sort(function(a, b) {
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  });

  return rows;
}

// ── CHECK GOAL USAGE ──────────────────────────────────────────────────

/**
 * Checks whether a goal code has any recorded trial data across all client sheets.
 * Returns { used, sessionCount, clients }
 */
function checkGoalUsage(goalCode, clients) {
  var code = String(goalCode || '').trim().toLowerCase();
  var totalCount = 0;
  var foundClients = [];

  for (var ci = 0; ci < clients.length; ci++) {
    var client = clients[ci];
    if (!client.sheetId) continue;
    try {
      var ss  = SpreadsheetApp.openById(client.sheetId);
      var tab = ss.getSheetByName('Trial Data');
      if (!tab) continue;
      var vals = tab.getDataRange().getValues();
      if (vals.length < 2) continue;

      // Find columns whose header matches the goal code
      var headers  = vals[0];
      var goalCols = [];
      for (var hi = 0; hi < headers.length; hi++) {
        var h = String(headers[hi] || '').trim().toLowerCase();
        // Match exact code or "code %" / "code_..." suffixes
        if (h === code || h.indexOf(code + ' ') === 0 || h.indexOf(code + '_') === 0) {
          goalCols.push(hi);
        }
      }
      if (goalCols.length === 0) continue;

      // Count data rows that have any non-empty value in a matched column
      var clientCount = 0;
      for (var ri = 1; ri < vals.length; ri++) {
        var row = vals[ri];
        for (var gi = 0; gi < goalCols.length; gi++) {
          var val = row[goalCols[gi]];
          if (val !== '' && val !== null && val !== undefined) {
            clientCount++;
            break;
          }
        }
      }

      if (clientCount > 0) {
        totalCount += clientCount;
        foundClients.push(client.name);
      }
    } catch(e) {
      // Skip inaccessible sheets
    }
  }

  return {
    used:         totalCount > 0,
    sessionCount: totalCount,
    clients:      foundClients
  };
}
