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

    } else if (data.action === 'migrateHistoricalData') {
      var migResult = migrateHistoricalData(data.dryRun !== false);
      result = { success: true, dryRun: migResult.dryRun, summary: migResult.summary,
        checked: migResult.checked, fixed: migResult.fixed };

    } else if (data.action === 'fixShiftedAnalytics') {
      var fsaResult = fixShiftedAnalytics(data.dryRun !== false);
      result = { success: true, dryRun: fsaResult.dryRun, summary: fsaResult.summary,
        fixed: fsaResult.fixed };

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
  var rawKeys   = d.behaviorKeys   || [];
  var rawLabels = d.behaviorLabels || [];
  var bd        = d.behaviorData   || {};
  var clientId  = d.clientId       || '';

  // If the payload already contains behavior keys the frontend filtered by client
  // assignment, use them directly — no need to re-read the admin sheet on every
  // session submit.  Only fall back to the admin sheet when keys are absent
  // (legacy or manual-entry payloads without a behaviorKeys field).
  var keys, labels;
  if (rawKeys.length > 0) {
    keys   = rawKeys;
    labels = rawLabels;
  } else {
    // Fallback: read admin Behaviors tab and filter by clientId
    var adminSS   = SpreadsheetApp.openById(ADMIN_SHEET_ID);
    var allBehavs = sheetToObjects(adminSS, 'Behaviors');
    var assignedKeys = {};
    for (var ai = 0; ai < allBehavs.length; ai++) {
      var bv   = allBehavs[ai];
      var bKey = String(bv.key || '').trim();
      var cids = String(bv.clientIds || '').trim();
      if (!bKey) continue;
      if (!cids) {
        assignedKeys[bKey] = true;
      } else {
        var cidArr = cids.split(',');
        for (var ci = 0; ci < cidArr.length; ci++) {
          if (cidArr[ci].trim() === clientId) { assignedKeys[bKey] = true; break; }
        }
      }
    }
    keys   = [];
    labels = [];
    for (var fi = 0; fi < rawKeys.length; fi++) {
      if (assignedKeys[rawKeys[fi]]) {
        keys.push(rawKeys[fi]);
        labels.push(rawLabels[fi]);
      }
    }
  }

  var analyticsHeaders = [
    'submissionId', 'clientName', 'clientId', 'therapistEmail',
    'sessionType', 'billingCode', 'isDraft', 'payloadHash', 'submittedAt', 'dateISO'
  ];
  var analyticsSet = {};
  for (var asi = 0; asi < analyticsHeaders.length; asi++) {
    analyticsSet[analyticsHeaders[asi]] = true;
  }

  var allHeaders = ['Date', 'Therapist', 'Setting']
    .concat(labels, ['Tantrum Frequency', 'Tantrum Total (Min)'])
    .concat(analyticsHeaders);

  var sheet = getOrCreateSheet(ss, 'Behavior Data', allHeaders);

  // For existing sheets: insert new behavior/tantrum cols BEFORE the first
  // analytics column (so they stay in the logical data section, not after analytics).
  // Then append any missing analytics cols at the far right.
  var nonAnalyticsCols = labels.concat(['Tantrum Frequency', 'Tantrum Total (Min)']);
  _ensureColumnsBefore(sheet, nonAnalyticsCols, analyticsSet);
  ensureSheetColumns(sheet, analyticsHeaders);

  // Read ACTUAL header row — source of truth for column positions after all inserts.
  var lastCol = sheet.getLastColumn();
  var actualHeaders = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var colMap = {};
  for (var hi = 0; hi < actualHeaders.length; hi++) {
    var h = String(actualHeaders[hi]).trim();
    if (h && colMap[h] === undefined) { colMap[h] = hi; }
  }

  // Build row sized to actual header count, default '' per cell
  var row = [];
  for (var ri = 0; ri < lastCol; ri++) { row.push(''); }

  if (colMap['Date']      !== undefined) { row[colMap['Date']]      = d.date; }
  if (colMap['Therapist'] !== undefined) { row[colMap['Therapist']] = d.therapist; }
  if (colMap['Setting']   !== undefined) { row[colMap['Setting']]   = d.location; }

  for (var bi = 0; bi < keys.length; bi++) {
    var lbl = labels[bi];
    if (colMap[lbl] !== undefined) {
      row[colMap[lbl]] = typeof bd[keys[bi]] === 'number' ? bd[keys[bi]] : (bd[keys[bi]] || 0);
    }
  }
  if (colMap['Tantrum Frequency']   !== undefined) { row[colMap['Tantrum Frequency']]   = bd.tantrumFrequency || 0; }
  if (colMap['Tantrum Total (Min)'] !== undefined) { row[colMap['Tantrum Total (Min)']] = bd.tantrumTotalMin  || 0; }

  if (colMap['submissionId']   !== undefined) { row[colMap['submissionId']]   = d.submissionId   || ''; }
  if (colMap['clientName']     !== undefined) { row[colMap['clientName']]     = resolveClientName(d); }
  if (colMap['clientId']       !== undefined) { row[colMap['clientId']]       = d.clientId       || ''; }
  if (colMap['therapistEmail'] !== undefined) { row[colMap['therapistEmail']] = d.therapistEmail || d.submittedBy || ''; }
  if (colMap['sessionType']    !== undefined) { row[colMap['sessionType']]    = d.sessionType    || ''; }
  if (colMap['billingCode']    !== undefined) { row[colMap['billingCode']]    = d.billingCode    || ''; }
  if (colMap['isDraft']        !== undefined) { row[colMap['isDraft']]        = d.isDraft ? true : false; }
  if (colMap['payloadHash']    !== undefined) { row[colMap['payloadHash']]    = d.payloadHash    || ''; }
  if (colMap['submittedAt']    !== undefined) { row[colMap['submittedAt']]    = d.submittedAt    || new Date().toISOString(); }
  if (colMap['dateISO']        !== undefined) { row[colMap['dateISO']]        = d.dateISO        || ''; }

  validateRowAlignment('Behavior Data', actualHeaders, row);
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
  var adjustHeaders = ['Adjusted End Time', 'End Time Adjustment Reason'];
  var manualHeaders = ['manualEntry', 'enteredBy'];
  var allHeaders = baseHeaders.concat(analyticsHeaders, adjustHeaders, manualHeaders);

  var sheet = getOrCreateSheet(ss, 'Time In Time Out', allHeaders);
  ensureSheetColumns(sheet, allHeaders);

  // Read ACTUAL header row — source of truth for column positions
  var lastCol = sheet.getLastColumn();
  var actualHeaders = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var colMap = {};
  for (var hi = 0; hi < actualHeaders.length; hi++) {
    var h = String(actualHeaders[hi]).trim();
    if (h && colMap[h] === undefined) colMap[h] = hi;
  }

  var row = [];
  for (var ri = 0; ri < lastCol; ri++) row.push('');

  if (colMap['Date']               !== undefined) row[colMap['Date']]               = d.date;
  if (colMap['Billing Code']       !== undefined) row[colMap['Billing Code']]       = d.billingCode    || '';
  if (colMap['Type of Session']    !== undefined) row[colMap['Type of Session']]    = d.sessionType    || '';
  if (colMap['Time In']            !== undefined) row[colMap['Time In']]            = d.timeIn         || '';
  if (colMap['Time Out']           !== undefined) row[colMap['Time Out']]           = d.timeOut        || '';
  if (colMap['Duration (min)']     !== undefined) row[colMap['Duration (min)']]     = d.durationMin    || 0;
  if (colMap['Location']           !== undefined) row[colMap['Location']]           = d.location       || '';
  if (colMap['Therapist']          !== undefined) row[colMap['Therapist']]          = d.therapist      || '';
  if (colMap['App Start Time']     !== undefined) row[colMap['App Start Time']]     = d.appStartTime   || '';
  if (colMap['Actual Start Time']  !== undefined) row[colMap['Actual Start Time']]  = d.actualStartTime || '';
  if (colMap['Late Start Reason']  !== undefined) row[colMap['Late Start Reason']]  = d.lateStartReason || '';
  if (colMap['Submission ID']      !== undefined) row[colMap['Submission ID']]      = d.submissionId   || '';
  if (colMap['Notes']              !== undefined) row[colMap['Notes']]              = d.notes          || '';
  if (colMap['clientName']         !== undefined) row[colMap["clientName"]]         = resolveClientName(d);
  if (colMap['clientId']           !== undefined) row[colMap['clientId']]           = d.clientId       || '';
  if (colMap['therapistEmail']     !== undefined) row[colMap['therapistEmail']]     = d.therapistEmail || d.submittedBy || '';
  if (colMap['isDraft']            !== undefined) row[colMap['isDraft']]            = d.isDraft ? true : false;
  if (colMap['payloadHash']        !== undefined) row[colMap['payloadHash']]        = d.payloadHash    || '';
  if (colMap['submittedAt']        !== undefined) row[colMap['submittedAt']]        = d.submittedAt    || new Date().toISOString();
  if (colMap['dateISO']            !== undefined) row[colMap['dateISO']]            = d.dateISO        || '';
  if (colMap['Adjusted End Time']        !== undefined) row[colMap['Adjusted End Time']]        = d.adjustedEndTime          || '';
  if (colMap['End Time Adjustment Reason'] !== undefined) row[colMap['End Time Adjustment Reason']] = d.endTimeAdjustmentReason || '';
  if (colMap['manualEntry']        !== undefined) row[colMap['manualEntry']]        = d.manualEntry ? true : false;
  if (colMap['enteredBy']          !== undefined) row[colMap['enteredBy']]          = d.enteredBy      || '';

  validateRowAlignment('Time In Time Out', actualHeaders, row);
  sheet.appendRow(row);
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
  ensureSheetColumns(sheet, allHeaders); // was analyticsHeaders — fixed to ensure goal columns too

  // Build numeric percentages map for the Percent Correct column
  var pctMap = {};
  for (var gi3 = 0; gi3 < d.trialData.length; gi3++) {
    var gp = d.trialData[gi3];
    if (gp.percentage !== null && gp.percentage !== undefined) {
      pctMap[gp.goalCode] = gp.percentage;
    }
  }
  var percentCorrectJSON = JSON.stringify(pctMap);

  // Read ACTUAL header row — source of truth for column positions.
  // New goal or analytics columns may have been appended in different order
  // than allHeaders if goals changed between sessions.
  var lastCol = sheet.getLastColumn();
  var actualHeaders = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

  // Build a map of unique headers (first occurrence wins).
  // Trial N and % repeat per goal — we address those relative to each goal code column.
  var colMap = {};
  for (var hi2 = 0; hi2 < actualHeaders.length; hi2++) {
    var h2 = String(actualHeaders[hi2]).trim();
    if (h2 && colMap[h2] === undefined) { colMap[h2] = hi2; }
  }

  // Build row sized to actual header count
  var row = [];
  for (var ri2 = 0; ri2 < lastCol; ri2++) { row.push(''); }

  if (colMap['Date']      !== undefined) { row[colMap['Date']]      = d.date; }
  if (colMap['Setting']   !== undefined) { row[colMap['Setting']]   = d.location; }
  if (colMap['Therapist'] !== undefined) { row[colMap['Therapist']] = d.therapist; }

  // For each goal: find its goal-code column by scanning for an exact match,
  // then write trial values and % in the immediately following columns.
  for (var gi2 = 0; gi2 < d.trialData.length; gi2++) {
    var g2 = d.trialData[gi2];
    var goalCol = -1;
    for (var hj = 0; hj < actualHeaders.length; hj++) {
      if (String(actualHeaders[hj]).trim() === String(g2.goalCode).trim()) { goalCol = hj; break; }
    }
    if (goalCol < 0) { continue; } // goal column not present in sheet — skip safely
    row[goalCol] = g2.goalCode;
    var trials = g2.trials || [];
    for (var ti2 = 0; ti2 < trials.length; ti2++) {
      if (goalCol + 1 + ti2 < row.length) { row[goalCol + 1 + ti2] = trials[ti2]; }
    }
    var pct    = (g2.percentage !== null && g2.percentage !== undefined) ? g2.percentage + '%' : '';
    var pctPos = goalCol + 1 + trials.length;
    if (pctPos < row.length) { row[pctPos] = pct; }
  }

  // Analytics columns
  if (colMap['submissionId']    !== undefined) { row[colMap['submissionId']]    = d.submissionId   || ''; }
  if (colMap['clientName']      !== undefined) { row[colMap["clientName"]]      = resolveClientName(d); }
  if (colMap['clientId']        !== undefined) { row[colMap['clientId']]        = d.clientId       || ''; }
  if (colMap['therapistEmail']  !== undefined) { row[colMap['therapistEmail']]  = d.therapistEmail || d.submittedBy || ''; }
  if (colMap['sessionType']     !== undefined) { row[colMap['sessionType']]     = d.sessionType    || ''; }
  if (colMap['billingCode']     !== undefined) { row[colMap['billingCode']]     = d.billingCode    || ''; }
  if (colMap['isDraft']         !== undefined) { row[colMap['isDraft']]         = d.isDraft ? true : false; }
  if (colMap['payloadHash']     !== undefined) { row[colMap['payloadHash']]     = d.payloadHash    || ''; }
  if (colMap['submittedAt']     !== undefined) { row[colMap['submittedAt']]     = d.submittedAt    || new Date().toISOString(); }
  if (colMap['dateISO']         !== undefined) { row[colMap['dateISO']]         = d.dateISO        || ''; }
  if (colMap['Percent Correct'] !== undefined) { row[colMap['Percent Correct']] = percentCorrectJSON; }

  validateRowAlignment('Trial Data', actualHeaders, row);
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

  // Read ACTUAL header row — source of truth for column positions
  var lastCol = sheet.getLastColumn();
  var actualHeaders = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var colMap = {};
  for (var hi = 0; hi < actualHeaders.length; hi++) {
    var h = String(actualHeaders[hi]).trim();
    if (h && colMap[h] === undefined) colMap[h] = hi;
  }

  for (var i = 0; i < d.abcData.length; i++) {
    var inc = d.abcData[i];
    var row = [];
    for (var ri = 0; ri < lastCol; ri++) row.push('');

    if (colMap['Date']                   !== undefined) row[colMap['Date']]                   = d.date;
    if (colMap['Initials']               !== undefined) row[colMap['Initials']]               = d.therapistInitials      || '';
    if (colMap['Setting']                !== undefined) row[colMap['Setting']]                = inc.setting              || '';
    if (colMap['Antecedent']             !== undefined) row[colMap['Antecedent']]             = inc.antecedent           || '';
    if (colMap['Behavior']               !== undefined) row[colMap['Behavior']]               = inc.behavior             || '';
    if (colMap['Consequence']            !== undefined) row[colMap['Consequence']]            = inc.consequence          || '';
    if (colMap['Hypothesized Function']  !== undefined) row[colMap['Hypothesized Function']]  = inc.hypothesizedFunction || '';
    if (colMap['Time']                   !== undefined) row[colMap['Time']]                   = inc.time                 || '';
    if (colMap['submissionId']           !== undefined) row[colMap['submissionId']]           = d.submissionId           || '';
    if (colMap['clientName']             !== undefined) row[colMap["clientName"]]             = resolveClientName(d);
    if (colMap['clientId']              !== undefined) row[colMap['clientId']]               = d.clientId               || '';
    if (colMap['therapistName']          !== undefined) row[colMap['therapistName']]          = d.therapist              || '';
    if (colMap['therapistEmail']         !== undefined) row[colMap['therapistEmail']]         = d.therapistEmail || d.submittedBy || '';
    if (colMap['sessionType']            !== undefined) row[colMap['sessionType']]            = d.sessionType            || '';
    if (colMap['billingCode']            !== undefined) row[colMap['billingCode']]            = d.billingCode            || '';
    if (colMap['isDraft']                !== undefined) row[colMap['isDraft']]                = d.isDraft ? true : false;
    if (colMap['payloadHash']            !== undefined) row[colMap['payloadHash']]            = d.payloadHash            || '';
    if (colMap['submittedAt']            !== undefined) row[colMap['submittedAt']]            = d.submittedAt            || new Date().toISOString();
    if (colMap['dateISO']                !== undefined) row[colMap['dateISO']]                = d.dateISO                || '';

    validateRowAlignment('ABC Data', actualHeaders, row);
    sheet.appendRow(row);
  }
}


// ── CLIENT NAME RESOLUTION ────────────────────────────────────────────

/**
 * Returns the clientName from the payload. If it is absent or blank
 * (which would silently shift all subsequent analytics columns left),
 * logs a warning and falls back to looking up the name from the RT Admin
 * Clients sheet by clientId. This prevents the "clientName gap" bug.
 */
function resolveClientName(d) {
  var name = String(d.clientName || '').trim();
  if (name) return name;

  // clientName missing — log warning and attempt admin-sheet lookup
  var warn = 'resolveClientName: clientName missing for clientId=' + (d.clientId || 'unknown') +
    ' submissionId=' + (d.submissionId || '?');
  Logger.log('WARNING: ' + warn);
  writeAuditLog(new Date().toISOString(), 'system', 'alignment_warning', d.clientName || '', warn);

  if (!d.clientId) return '';
  try {
    var adminSS = SpreadsheetApp.openById(ADMIN_SHEET_ID);
    var clients  = sheetToObjects(adminSS, 'Clients');
    for (var ci = 0; ci < clients.length; ci++) {
      if (String(clients[ci].id || '').trim() === String(d.clientId).trim()) {
        return String(clients[ci].name || '').trim();
      }
    }
  } catch (e) {
    Logger.log('resolveClientName lookup failed: ' + e.message);
  }
  return '';
}


// ── ROW ALIGNMENT VALIDATION ──────────────────────────────────────────

/**
 * Permanent safety net — called before every sheet.appendRow().
 * Checks that:
 *   1. row.length === headers.length (no truncation or overflow)
 *   2. Every known analytics column carries the expected value type
 *      (submissionId must look like a UUID or be empty; never a plain number)
 *   3. No UUID-format value lands outside the submissionId column
 *
 * Writes a warning to the Audit Log on any violation — does NOT throw,
 * so a validation failure never blocks a session submission.
 * Returns true if aligned, false if a problem was detected.
 */
function validateRowAlignment(tabName, headers, row) {
  try {
    var ok = true;
    var warnings = [];

    // Build colMap for this validation pass
    var colMap = {};
    for (var hi = 0; hi < headers.length; hi++) {
      var h = String(headers[hi]).trim();
      if (h && colMap[h] === undefined) colMap[h] = hi;
    }

    // Check 1: row length matches header length
    if (row.length !== headers.length) {
      warnings.push('row length ' + row.length + ' != header length ' + headers.length);
      ok = false;
    }

    // Check 2: submissionId column must hold a UUID or be empty — not a plain number
    var sidCol = colMap['submissionId'];
    if (sidCol !== undefined && sidCol < row.length) {
      var sidVal = String(row[sidCol] || '').trim();
      if (sidVal !== '' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sidVal)) {
        warnings.push('submissionId col has non-UUID value: ' + sidVal.substring(0, 30));
        ok = false;
      }
    }

    // Check 3: no UUID-format value in a column other than submissionId
    for (var ri = 0; ri < row.length; ri++) {
      if (ri === sidCol) continue;
      var cellVal = String(row[ri] || '').trim();
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cellVal)) {
        var hdr = ri < headers.length ? String(headers[ri]) : 'col' + ri;
        warnings.push('UUID found in wrong column "' + hdr + '" (col ' + ri + ')');
        ok = false;
      }
    }

    if (!ok) {
      var msg = '[validateRowAlignment] ' + tabName + ': ' + warnings.join('; ');
      Logger.log('WARNING: ' + msg);
      writeAuditLog(new Date().toISOString(), 'system', 'alignment_warning', '', msg);
    }
    return ok;
  } catch (e) {
    // Validation errors must never disrupt session submission
    Logger.log('[validateRowAlignment] error: ' + e.message);
    return true;
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

/**
 * Ensure columns in newCols exist in the sheet.
 * Missing columns are inserted immediately BEFORE the first column whose
 * header appears in stopColsMap (plain object used as a set).
 * If no stop column is found in the sheet, missing cols are appended at the end.
 * Existing columns are never moved or removed.
 * Used by writeBehaviorData to keep behavior cols before analytics cols.
 */
function _ensureColumnsBefore(sheet, newCols, stopColsMap) {
  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) return; // empty sheet handled by getOrCreateSheet
  var existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var existingMap = {};
  for (var i = 0; i < existing.length; i++) {
    existingMap[String(existing[i]).trim()] = true;
  }
  var missing = [];
  for (var j = 0; j < newCols.length; j++) {
    if (!existingMap[String(newCols[j]).trim()]) {
      missing.push(newCols[j]);
    }
  }
  if (!missing.length) return;
  // Find 1-based column index of the first stop column
  var insertBefore = 0;
  for (var m = 0; m < existing.length; m++) {
    if (stopColsMap[String(existing[m]).trim()]) {
      insertBefore = m + 1;
      break;
    }
  }
  var startCol;
  if (insertBefore > 0) {
    sheet.insertColumnsBefore(insertBefore, missing.length);
    startCol = insertBefore;
  } else {
    startCol = lastCol + 1; // no stop col found — append at end
  }
  var r = sheet.getRange(1, startCol, 1, missing.length);
  r.setValues([missing]);
  r.setFontWeight('bold');
  r.setBackground('#00A7C7');
  r.setFontColor('#FFFFFF');
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


// ── HISTORICAL DATA MIGRATION ───────────────────────────────────────────

/**
 * migrateHistoricalData(dryRun)
 *
 * One-time fix for column misalignment in all client data sheets.
 * Misalignment occurred when new behaviors/goals were added after analytics
 * columns already existed: ensureSheetColumns appended new columns at the far
 * right, but the row-build code used a fixed allHeaders order (data before
 * analytics), causing values to land in wrong column positions.
 *
 * dryRun=true (default): log what would change, write nothing.
 * dryRun=false: create backups, apply corrections, log to Audit Log.
 *
 * Run from Apps Script editor:
 *   migrateHistoricalData(true);   // dry run
 *   migrateHistoricalData(false);  // live
 */
function migrateHistoricalData(dryRun) {
  var isDryRun = (dryRun !== false); // default true — safe by default
  var ts = new Date().toISOString();
  var logLines = [];
  var totalChecked = 0;
  var totalFixed   = 0;

  function log(msg) {
    Logger.log(msg);
    logLines.push(msg);
  }

  log('=== migrateHistoricalData ' + (isDryRun ? '[DRY RUN]' : '[LIVE]') +
      ' started ' + ts + ' ===');

  var adminSS = SpreadsheetApp.openById(ADMIN_SHEET_ID);
  var clients  = sheetToObjects(adminSS, 'Clients');
  log('Clients found: ' + clients.length);

  var tabNames = ['Behavior Data', 'Trial Data', 'ABC Data', 'Time In Time Out'];

  for (var ci = 0; ci < clients.length; ci++) {
    var client = clients[ci];
    if (!client.sheetId || String(client.status || 'active') === 'inactive') {
      log('SKIP ' + (client.name || client.id) + ': no sheetId or inactive');
      continue;
    }
    log('--- ' + client.name + ' ---');
    var ss;
    try {
      ss = SpreadsheetApp.openById(client.sheetId);
    } catch (e) {
      log('  ERROR opening sheet: ' + e.message);
      continue;
    }
    for (var ti = 0; ti < tabNames.length; ti++) {
      var r = _mig_processTab(ss, client.name, tabNames[ti], isDryRun, log);
      totalChecked += r.checked;
      totalFixed   += r.fixed;
    }
  }

  var summary = (isDryRun ? '[DRY RUN] ' : '') +
    'checked=' + totalChecked + ' fixed=' + totalFixed;
  log('=== DONE: ' + summary + ' ===');

  if (!isDryRun) {
    writeAuditLog(ts, 'system', 'data_migration', '', summary);
  }
  return { dryRun: isDryRun, summary: summary, checked: totalChecked, fixed: totalFixed };
}


function _mig_processTab(ss, clientName, tabName, isDryRun, log) {
  var result = { checked: 0, fixed: 0 };
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) { log('  ' + tabName + ': not found'); return result; }

  var allData = sheet.getDataRange().getValues();
  if (allData.length < 2) { log('  ' + tabName + ': no data rows'); return result; }

  var headers = allData[0];
  var colMap  = _mig_buildColMap(headers);

  var corrections = []; // [{ sheetRow, oldRow, newRow }]

  for (var ri = 1; ri < allData.length; ri++) {
    var rowData = allData[ri];
    // Skip blank rows
    var blank = true;
    for (var bi = 0; bi < rowData.length; bi++) {
      if (rowData[bi] !== '' && rowData[bi] !== null && rowData[bi] !== undefined) {
        blank = false; break;
      }
    }
    if (blank) continue;
    result.checked++;

    var fixedRow = null;

    if (tabName === 'Behavior Data') {
      fixedRow = _mig_fixBehaviorRow(headers, colMap, rowData);
    } else if (tabName === 'Trial Data') {
      fixedRow = _mig_fixTrialRow(headers, colMap, rowData);
    }

    if (!fixedRow) {
      // No alignment fix needed; try data quality fixes only
      var copy    = rowData.slice(0);
      var changed = _mig_fixDataQuality(colMap, copy);
      if (changed) fixedRow = copy;
    } else {
      // Alignment fix applied; also run data quality fixes
      _mig_fixDataQuality(colMap, fixedRow);
    }

    if (fixedRow) {
      var sheetRow = ri + 1; // +1 because allData[0]=header=row1, allData[1]=row2
      corrections.push({ sheetRow: sheetRow, oldRow: rowData, newRow: fixedRow });
      result.fixed++;
      log('  ' + tabName + ' row ' + sheetRow + ': ' +
          _mig_diffSummary(headers, rowData, fixedRow));
    }
  }

  if (!corrections.length) {
    log('  ' + tabName + ': all ' + result.checked + ' rows OK');
    return result;
  }

  log('  ' + tabName + ': ' + corrections.length + '/' + result.checked + ' rows need fixing');

  if (isDryRun) {
    log('  ' + tabName + ': [DRY RUN] — no changes written');
    return result;
  }

  // Create backup before first write
  _mig_backupTab(ss, tabName, log);

  var numCols = headers.length;
  for (var ki = 0; ki < corrections.length; ki++) {
    var corr     = corrections[ki];
    var writeRow = corr.newRow.slice(0, numCols);
    while (writeRow.length < numCols) writeRow.push('');
    sheet.getRange(corr.sheetRow, 1, 1, numCols).setValues([writeRow]);
  }
  log('  ' + tabName + ': wrote ' + corrections.length + ' corrections');
  return result;
}


function _mig_backupTab(ss, tabName, log) {
  try {
    var sheet = ss.getSheetByName(tabName);
    if (!sheet) return;
    var backupName = tabName + ' BACKUP';
    if (ss.getSheetByName(backupName)) {
      log('  Backup already exists: ' + backupName + ' (kept existing)');
      return;
    }
    var backup = sheet.copyTo(ss);
    backup.setName(backupName);
    log('  Created backup: ' + backupName);
  } catch (e) {
    log('  WARNING: backup failed for ' + tabName + ': ' + e.message);
  }
}


function _mig_buildColMap(headers) {
  var m = {};
  for (var i = 0; i < headers.length; i++) {
    var h = String(headers[i]).trim();
    if (h && m[h] === undefined) m[h] = i;
  }
  return m;
}


function _mig_isUUID(val) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    .test(String(val || '').trim());
}


function _mig_findUUID(rowData) {
  for (var i = 0; i < rowData.length; i++) {
    if (_mig_isUUID(rowData[i])) return i;
  }
  return -1;
}


/**
 * Fix Behavior Data row alignment.
 *
 * Sheet header structure (immutable existing cols):
 *   [base(3)] [originalBehaviors(S-5)] [TantrumFreq(S-2)] [TantrumTotal(S-1)]
 *   [analytics(S..S+9)] [newBehaviors appended after analytics]
 *
 * Misaligned row was written as allHeaders order:
 *   [base] [allBehaviors(inc new)] [tantrum] [analytics]
 *   ↑ new behaviors appear BEFORE tantrum, pushing tantrum+analytics right by shift positions
 *
 * S = colMap['submissionId'], P = position UUID was found in row data.
 * shift = P - S = number of new behavior columns.
 */
function _mig_fixBehaviorRow(headers, colMap, rowData) {
  var S = colMap['submissionId'];
  if (S === undefined) return null;
  var P = _mig_findUUID(rowData);
  if (P < 0 || P === S || P < S) return null;

  var shift         = P - S;
  var analyticsCount = 10; // submissionId..dateISO

  // Tantrum must be at S-2, S-1 (invariant of the schema)
  if (colMap['Tantrum Frequency'] !== S - 2 ||
      colMap['Tantrum Total (Min)'] !== S - 1) return null;

  var totalCols = headers.length;
  var newRow = [];
  for (var i = 0; i < totalCols; i++) newRow.push('');

  // Original behavior data (base + original behaviors): row[0..S-3] → same positions
  for (var oi = 0; oi <= S - 3; oi++) {
    if (oi < rowData.length) newRow[oi] = rowData[oi];
  }

  // Tantrum: was at row[P-2], row[P-1] → goes to col S-2, S-1
  if (P - 2 < rowData.length) newRow[S - 2] = rowData[P - 2];
  if (P - 1 < rowData.length) newRow[S - 1] = rowData[P - 1];

  // Analytics block: row[P..P+9] → cols S..S+9
  for (var ai = 0; ai < analyticsCount; ai++) {
    if (P + ai < rowData.length && S + ai < totalCols) {
      newRow[S + ai] = rowData[P + ai];
    }
  }

  // New behavior values: row[S-2..P-3] (count=shift) → cols S+analyticsCount..S+analyticsCount+shift-1
  for (var ni = 0; ni < shift; ni++) {
    var srcIdx = (S - 2) + ni;
    var dstIdx = S + analyticsCount + ni;
    if (srcIdx < rowData.length && dstIdx < totalCols) {
      newRow[dstIdx] = rowData[srcIdx];
    }
  }

  return newRow;
}


/**
 * Fix Trial Data row alignment.
 *
 * Sheet header structure:
 *   [base(3)] [originalGoals] [analytics(S..S+10)] [newGoals appended after analytics]
 *
 * Misaligned row was written in allHeaders order:
 *   [base] [allGoals(inc new)] [analytics]
 *   ↑ new goal columns appear BEFORE analytics, pushing analytics right by shift positions
 */
function _mig_fixTrialRow(headers, colMap, rowData) {
  var S = colMap['submissionId'];
  if (S === undefined) return null;
  var P = _mig_findUUID(rowData);
  if (P < 0 || P === S || P < S) return null;

  var shift         = P - S;
  var analyticsCount = 11; // submissionId..Percent Correct

  var totalCols = headers.length;
  var newRow = [];
  for (var i = 0; i < totalCols; i++) newRow.push('');

  // Original goal data: row[0..S-1] → same sheet positions (correct)
  for (var oi = 0; oi < S; oi++) {
    if (oi < rowData.length) newRow[oi] = rowData[oi];
  }

  // Analytics block: row[P..P+10] → cols S..S+10
  for (var ai = 0; ai < analyticsCount; ai++) {
    if (P + ai < rowData.length && S + ai < totalCols) {
      newRow[S + ai] = rowData[P + ai];
    }
  }

  // New goal data: row[S..P-1] (count=shift) → cols S+analyticsCount..S+analyticsCount+shift-1
  for (var ni = 0; ni < shift; ni++) {
    var srcIdx = S + ni;
    var dstIdx = S + analyticsCount + ni;
    if (srcIdx < rowData.length && dstIdx < totalCols) {
      newRow[dstIdx] = rowData[srcIdx];
    }
  }

  // Carry any remaining orphaned values beyond analytics (extra appended data)
  for (var ex = P + analyticsCount; ex < rowData.length; ex++) {
    var exDst = S + analyticsCount + shift + (ex - (P + analyticsCount));
    if (exDst < totalCols) newRow[exDst] = rowData[ex];
  }

  return newRow;
}


/**
 * In-place data quality fixes. Returns true if any change was made.
 * - isDraft: "FALSE"/"TRUE" string → boolean
 * - dateISO: empty → derive from Date column value
 */
function _mig_fixDataQuality(colMap, row) {
  var changed = false;

  var isDraftCol = colMap['isDraft'];
  if (isDraftCol !== undefined && isDraftCol < row.length) {
    var dv = row[isDraftCol];
    if (dv === 'FALSE' || dv === 'false') { row[isDraftCol] = false; changed = true; }
    else if (dv === 'TRUE' || dv === 'true') { row[isDraftCol] = true; changed = true; }
  }

  var dateISOCol = colMap['dateISO'];
  if (dateISOCol !== undefined && dateISOCol < row.length) {
    var diso = String(row[dateISOCol] || '').trim();
    if (!diso || diso === '0') {
      var dateCol = (colMap['Date'] !== undefined) ? colMap['Date'] : colMap['date'];
      if (dateCol !== undefined && dateCol < row.length && row[dateCol]) {
        var derived = toDateISO(row[dateCol]);
        if (derived) { row[dateISOCol] = derived; changed = true; }
      }
    }
  }

  return changed;
}


function _mig_diffSummary(headers, oldRow, newRow) {
  var diffs = [];
  var len = Math.max(oldRow.length, newRow.length);
  for (var i = 0; i < len; i++) {
    var ov = (i < oldRow.length) ? oldRow[i] : '';
    var nv = (i < newRow.length) ? newRow[i] : '';
    if (String(ov) !== String(nv)) {
      var hdr = (i < headers.length) ? String(headers[i]) : 'col' + i;
      diffs.push(hdr + ':[' + String(ov).substring(0, 20) + ']→[' + String(nv).substring(0, 20) + ']');
    }
  }
  return diffs.length + ' changes: ' + diffs.slice(0, 4).join('; ') + (diffs.length > 4 ? '…' : '');
}


// ── SHIFTED ANALYTICS REPAIR ────────────────────────────────────────────

/**
 * fixShiftedAnalytics(dryRun)
 *
 * Repairs rows where the clientName analytics column contains a clientId
 * value (e.g. "C1") instead of a full client name. This happens when old
 * session-write code omitted the clientName push, causing all subsequent
 * analytics values to be one position to the left relative to the headers.
 *
 * Detection: value at the 'clientName' column matches a known clientId
 *            from the RT Admin Clients sheet.
 * Fix: right-shift the existing analytics values by 1 (starting from
 *      clientName position) to fill their correct columns, then insert
 *      the real client name at the clientName column.
 *
 * dryRun=true (default): log what would change, no writes.
 * dryRun=false: backup each tab, apply corrections, write to Audit Log.
 *
 *   fixShiftedAnalytics(true);   // dry run
 *   fixShiftedAnalytics(false);  // live
 */
function fixShiftedAnalytics(dryRun) {
  var isDryRun = (dryRun !== false);
  var ts = new Date().toISOString();
  var logLines = [];
  var totalFixed = 0;

  function log(msg) { Logger.log(msg); logLines.push(msg); }

  log('=== fixShiftedAnalytics ' + (isDryRun ? '[DRY RUN]' : '[LIVE]') +
      ' started ' + ts + ' ===');

  // Load client list — used both for iterating sheets and for the ID→name lookup
  var adminSS = SpreadsheetApp.openById(ADMIN_SHEET_ID);
  var clientRows = sheetToObjects(adminSS, 'Clients');

  // Build clientId → clientName map (only active clients)
  var clientIdToName = {};
  for (var ci = 0; ci < clientRows.length; ci++) {
    var c = clientRows[ci];
    if (c.id && c.name) clientIdToName[String(c.id).trim()] = String(c.name).trim();
  }
  log('Client map: ' + JSON.stringify(clientIdToName));

  // Per-tab: which headers follow clientName in the correct schema.
  // Used to compute the right-shift boundary.
  var tabConfigs = [
    {
      name: 'Behavior Data',
      afterClientName: ['clientId','therapistEmail','sessionType','billingCode',
                        'isDraft','payloadHash','submittedAt','dateISO']
    },
    {
      name: 'Trial Data',
      afterClientName: ['clientId','therapistEmail','sessionType','billingCode',
                        'isDraft','payloadHash','submittedAt','dateISO','Percent Correct']
    },
    {
      name: 'ABC Data',
      afterClientName: ['clientId','therapistName','therapistEmail','sessionType','billingCode',
                        'isDraft','payloadHash','submittedAt','dateISO']
    },
    {
      name: 'Time In Time Out',
      afterClientName: ['clientId','therapistEmail','isDraft','payloadHash','submittedAt','dateISO']
    }
  ];

  for (var ki = 0; ki < clientRows.length; ki++) {
    var client = clientRows[ki];
    if (!client.sheetId || String(client.status || 'active') === 'inactive') {
      log('SKIP ' + (client.name || client.id) + ': no sheetId or inactive');
      continue;
    }
    log('--- ' + client.name + ' ---');
    var ss;
    try {
      ss = SpreadsheetApp.openById(client.sheetId);
    } catch (e) {
      log('  ERROR opening sheet: ' + e.message);
      continue;
    }
    for (var ti = 0; ti < tabConfigs.length; ti++) {
      var r = _fsa_processTab(ss, client.name, tabConfigs[ti], clientIdToName, isDryRun, log);
      totalFixed += r.fixed;
    }
  }

  var summary = (isDryRun ? '[DRY RUN] ' : '') + 'fixed=' + totalFixed;
  log('=== DONE: ' + summary + ' ===');

  if (!isDryRun) {
    writeAuditLog(ts, 'system', 'fix_shifted_analytics', '', summary);
  }
  return { dryRun: isDryRun, summary: summary, fixed: totalFixed };
}


function _fsa_processTab(ss, clientName, tabConf, clientIdToName, isDryRun, log) {
  var result = { fixed: 0 };
  var tabName = tabConf.name;
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) return result;

  var allData = sheet.getDataRange().getValues();
  if (allData.length < 2) return result;

  var headers = allData[0];
  var colMap  = _mig_buildColMap(headers); // reuse migration helper

  var cnCol = colMap['clientName'];
  if (cnCol === undefined) {
    log('  ' + tabName + ': no clientName column — skipping');
    return result;
  }

  // shiftEnd: the last column in the analytics block that needs to move right.
  // In the MISALIGNED row the analytics values occupy cnCol..(cnCol + afterCount - 1)
  // because clientName was never written — everything after it is 1 step left.
  // After the fix they should occupy cnCol..(cnCol + afterCount) (one wider).
  var afterCount = tabConf.afterClientName.length;
  var shiftEnd   = cnCol + afterCount; // inclusive — this is where the last value lands

  var corrections = [];

  for (var ri = 1; ri < allData.length; ri++) {
    var row = allData[ri];

    // Skip blank rows
    if (!row[0]) continue;

    var cnVal = String(row[cnCol] || '').trim();
    if (!cnVal) continue; // empty clientName — not detectable as shifted

    // If the value in the clientName column is a known clientId, the row is shifted
    if (!clientIdToName[cnVal]) continue;

    var realName = clientIdToName[cnVal];

    // Build corrected row
    var newRow = row.slice(0);

    // Right-shift values from cnCol..shiftEnd-1 → cnCol+1..shiftEnd
    // Iterate from right to left to avoid overwriting source values
    for (var ai = shiftEnd; ai > cnCol; ai--) {
      newRow[ai] = (ai - 1 < row.length) ? row[ai - 1] : '';
    }

    // Insert the real client name at cnCol
    newRow[cnCol] = realName;

    corrections.push({ sheetRow: ri + 1, oldRow: row, newRow: newRow });
    result.fixed++;
    log('  ' + tabName + ' row ' + (ri + 1) + ': clientId=' + cnVal +
        ' → inserted clientName="' + realName + '"');
  }

  if (!corrections.length) {
    log('  ' + tabName + ': no shifted rows');
    return result;
  }

  log('  ' + tabName + ': ' + corrections.length + ' rows to fix');

  if (isDryRun) {
    log('  ' + tabName + ': [DRY RUN] — no changes written');
    return result;
  }

  // Backup before first write
  _mig_backupTab(ss, tabName, log);

  var numCols = headers.length;
  for (var ki2 = 0; ki2 < corrections.length; ki2++) {
    var corr     = corrections[ki2];
    var writeRow = corr.newRow.slice(0, numCols);
    while (writeRow.length < numCols) writeRow.push('');
    sheet.getRange(corr.sheetRow, 1, 1, numCols).setValues([writeRow]);
  }
  log('  ' + tabName + ': wrote ' + corrections.length + ' corrections');
  return result;
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
