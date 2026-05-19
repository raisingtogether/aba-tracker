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

    } else if (data.action === 'approveBehaviorMastery') {
      var abmResult = approveBehaviorMastery(data.clientSheetId, data.clientId, data.behaviorKey, data.approverEmail, data.approverRole);
      result = abmResult;

    } else if (data.action === 'dismissBehaviorMastery') {
      var dbmResult = dismissBehaviorMastery(data.clientSheetId, data.clientId, data.behaviorKey, data.approverEmail, data.approverRole);
      result = dbmResult;

    } else if (data.action === 'diagnoseTrialDataHeaders') {
      var diagReport = diagnoseTrialDataHeaders();
      result = { success: true, report: diagReport };

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

  // Verify 6-digit PIN (64-char hex = already hashed; shorter = plaintext legacy)
  var storedPin = String(therapist.pin || '');
  var pinMatch = storedPin.length === 64
    ? (hashPin(String(email), String(pin)) === storedPin)
    : (storedPin === String(pin));
  if (!pinMatch) {
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


// ── PIN HASHING ───────────────────────────────────────────────────────

/**
 * SHA-256 hash of "email:pin". Returns 64-char lowercase hex.
 * Used for storing PINs securely in the Therapists sheet.
 */
function hashPin(email, pin) {
  var input = String(email).toLowerCase().trim() + ':' + String(pin);
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, input);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = (bytes[i] + 256) & 0xFF;
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
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
      var dateCol = -1, therapistCol = -1, durationCol = -1, dateISOCol = -1;
      for (var hi = 0; hi < headers.length; hi++) {
        var h = String(headers[hi]).trim().toLowerCase();
        if (h === 'date')           dateCol      = hi;
        if (h === 'dateiso')        dateISOCol   = hi;
        if (h === 'therapist')      therapistCol = hi;
        if (h === 'duration (min)') durationCol  = hi;
      }
      if (dateCol < 0 || therapistCol < 0 || durationCol < 0) continue;

      for (var ri = 1; ri < rows.length; ri++) {
        var row = rows[ri];
        var rowTherapist = String(row[therapistCol] || '').trim();
        if (rowTherapist !== therapistName) continue;
        var rowDateStr = '';
        if (dateISOCol >= 0) rowDateStr = toDateISO(row[dateISOCol]);
        if (!rowDateStr && dateCol >= 0) rowDateStr = toDateISO(row[dateCol]);
        if (!rowDateStr) continue;
        var rowDate = new Date(rowDateStr);
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
      var dateCol = -1, therapistCol = -1, durationCol = -1, billingCol = -1, dateISOCol = -1;
      for (var hi = 0; hi < headers.length; hi++) {
        var h = String(headers[hi]).trim().toLowerCase();
        if (h === 'date')           dateCol      = hi;
        if (h === 'dateiso')        dateISOCol   = hi;
        if (h === 'therapist')      therapistCol = hi;
        if (h === 'duration (min)') durationCol  = hi;
        if (h === 'billing code')   billingCol   = hi;
      }
      if (dateCol < 0 || therapistCol < 0 || durationCol < 0) continue;

      for (var ri = 1; ri < rows.length; ri++) {
        var row = rows[ri];
        var rowDateStr = '';
        if (dateISOCol >= 0) rowDateStr = toDateISO(row[dateISOCol]);
        if (!rowDateStr && dateCol >= 0) rowDateStr = toDateISO(row[dateCol]);
        if (!rowDateStr) continue;
        var rowDate = new Date(rowDateStr);
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
  var lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch(e) {
    throw new Error('Concurrent save in progress. Please retry.');
  }
  try {
    var ss = SpreadsheetApp.openById(ADMIN_SHEET_ID);

    if (cfg.therapists !== undefined) {
      // Hash any new/changed plaintext PINs before writing to the sheet
      var ts = cfg.therapists;
      for (var ti = 0; ti < ts.length; ti++) {
        var pin = String(ts[ti].pin || '');
        if (pin && pin.length !== 64) {
          ts[ti].pin = hashPin(String(ts[ti].email || ''), pin);
        }
      }
      objectsToSheet(ss, 'Therapists',
        ['id', 'name', 'initials', 'color', 'profile', 'email', 'pin',
         'totpSecret', 'clientIds', 'weeklyHourLimit', 'payRate', 'status', 'role'],
        ts);
    }

    if (cfg.clients !== undefined)
      objectsToSheet(ss, 'Clients',
        ['id', 'name', 'initials', 'sheetId', 'status'],
        cfg.clients);

    if (cfg.behaviors !== undefined)
      objectsToSheet(ss, 'Behaviors',
        ['key', 'label', 'icon', 'color', 'clientIds', 'status'],
        cfg.behaviors);

    if (cfg.goals !== undefined) {
      // Server-side duplicate goal code check
      var seenCodes = {};
      for (var gi = 0; gi < cfg.goals.length; gi++) {
        var gc = String(cfg.goals[gi].code || '').toUpperCase().trim();
        if (!gc) continue;
        if (seenCodes[gc]) throw new Error('Duplicate goal code: ' + cfg.goals[gi].code);
        seenCodes[gc] = true;
      }
      objectsToSheet(ss, 'Goals',
        ['clientId', 'clientIds', 'code', 'description', 'numTrials', 'status'],
        cfg.goals);
    }

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
  } finally {
    lock.releaseLock();
  }
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

  // Step 1: Insert new behavior cols BEFORE Tantrum Frequency (preferred stop).
  // Falls back to first analytics col if no Tantrum col exists yet.
  // This keeps behaviors in the right section regardless of client column layout.
  _ensureColumnsBefore(sheet, labels, analyticsSet, ['Tantrum Frequency', 'Tantrum Total (Min)']);
  // Step 2: Insert Tantrum cols BEFORE analytics (if missing).
  _ensureColumnsBefore(sheet, ['Tantrum Frequency', 'Tantrum Total (Min)'], analyticsSet, []);
  // Step 3: Append any missing analytics cols at the far right.
  ensureSheetColumns(sheet, analyticsHeaders);
  // Flush all pending structural operations (insertColumnsBefore, setValues on headers)
  // before re-reading the header row. Without this GAS may serve a cached pre-insert view.
  SpreadsheetApp.flush();

  // Read ACTUAL header row — source of truth for column positions after all inserts.
  var lastCol = sheet.getLastColumn();
  var actualHeaders = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var colMap = {};
  for (var hi = 0; hi < actualHeaders.length; hi++) {
    var h = String(actualHeaders[hi]).trim();
    if (h && colMap[h] === undefined) { colMap[h] = hi; }
  }

  // ── Diagnostics (visible in Apps Script execution log) ──────────────
  Logger.log('[writeBehaviorData] sid=' + (d.submissionId || 'none') +
    ' client=' + (d.clientName || '?') + ' date=' + (d.dateISO || d.date || '?'));
  Logger.log('[writeBehaviorData] lastCol=' + lastCol +
    ' headers=' + JSON.stringify(actualHeaders));
  Logger.log('[writeBehaviorData] colMap: submissionId=' + colMap['submissionId'] +
    ' clientName=' + colMap['clientName'] + ' clientId=' + colMap['clientId'] +
    ' therapistEmail=' + colMap['therapistEmail']);
  // Warn if any blank header exists (blank column in sheet — may cause misalignment confusion)
  for (var whi = 0; whi < actualHeaders.length; whi++) {
    if (String(actualHeaders[whi]).trim() === '') {
      Logger.log('[writeBehaviorData] WARNING: blank header at col index ' + whi +
        ' (sheet col ' + (whi + 1) + ') — this column is skipped in colMap');
    }
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

  // Log the exact analytics slice being written so we can verify positions
  Logger.log('[writeBehaviorData] row[clientName@' + colMap['clientName'] + ']=' +
    row[colMap['clientName']] + ' row[clientId@' + colMap['clientId'] + ']=' +
    row[colMap['clientId']] + ' row[therapistEmail@' + colMap['therapistEmail'] + ']=' +
    row[colMap['therapistEmail']]);

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
/**
 * Ensure columns in newCols exist in the sheet.
 * Missing columns are inserted immediately BEFORE the first preferred stop column
 * (preferredStops array, checked in order). If no preferred stop is found, falls
 * back to the first column in stopColsMap. If neither exists, appends at the end.
 * Existing columns are never moved or removed.
 *
 * @param {Sheet}    sheet          - target sheet
 * @param {string[]} newCols        - column names to ensure exist
 * @param {Object}   stopColsMap    - plain-object set of fallback stop column names
 * @param {string[]} preferredStops - ordered list of preferred stop column names (optional)
 */
function _ensureColumnsBefore(sheet, newCols, stopColsMap, preferredStops) {
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

  // Find 1-based insertion point: preferred stops take priority over stopColsMap
  var insertBefore = 0;
  if (preferredStops && preferredStops.length) {
    for (var m = 0; m < existing.length; m++) {
      var eh = String(existing[m]).trim();
      for (var p = 0; p < preferredStops.length; p++) {
        if (eh === preferredStops[p]) { insertBefore = m + 1; break; }
      }
      if (insertBefore > 0) { break; }
    }
  }
  if (!insertBefore) {
    for (var m2 = 0; m2 < existing.length; m2++) {
      if (stopColsMap[String(existing[m2]).trim()]) {
        insertBefore = m2 + 1;
        break;
      }
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
      obj[headers[ci]] = (row[ci] !== null && row[ci] !== undefined) ? row[ci] : '';
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
 * Goal mastery: 80%+ for 5 consecutive sessions → status 'confirmed'.
 * Behavior mastery: <=1 occurrence for 10 consecutive sessions →
 *   'recommended' (2+ distinct settings observed) or
 *   'pendingGeneralization' (only 1 setting observed).
 * Returns: { goals: { code: bool }, behaviors: { key: statusString }, newMasteries: [...] }
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
  // Derive behavior column range from header names rather than hardcoding startCol=3
  var META_COLS = {
    'date': true, 'therapist': true, 'setting': true,
    'submissionid': true, 'clientname': true, 'clientid': true,
    'therapistemail': true, 'sessiontype': true, 'billingcode': true,
    'isdraft': true, 'payloadhash': true, 'submittedat': true, 'dateiso': true,
    'tantrum frequency': true, 'tantrum total (min)': true
  };
  var startCol = -1, endCol = -1, settingCol = -1;
  for (var hi = 0; hi < headers.length; hi++) {
    var hn  = String(headers[hi]).trim();
    var hnl = hn.toLowerCase();
    if (hnl === 'setting') { settingCol = hi; }
    if (hnl === 'tantrum frequency') { endCol = hi; break; }
    if (startCol < 0 && hn && !META_COLS[hnl]) startCol = hi;
  }
  if (startCol < 0) startCol = 3; // absolute fallback
  if (endCol < 0)   endCol   = headers.length;

  // Need at least 10 consecutive data rows for mastery check
  var dataRows = rows.slice(1); // skip header
  if (dataRows.length < 10) return;
  var last10 = dataRows.slice(-10);

  var today = new Date().toISOString().substring(0, 10);

  // Pre-load Mastery Log data once before iterating behaviors.
  // Avoids N separate sheet reads (one per mastered behavior) inside the loop.
  var masteryLogData = null;
  var masteryLogSheet = ss.getSheetByName('Mastery Log');
  if (masteryLogSheet) {
    try {
      var mlData = masteryLogSheet.getDataRange().getValues();
      if (mlData && mlData.length >= 2) { masteryLogData = mlData; }
    } catch(e) {}
  }

  for (var ci = startCol; ci < endCol; ci++) {
    var label = String(headers[ci] || '').trim();
    if (!label) continue;
    var key = (labelToKey && labelToKey[label]) ? labelToKey[label] : label.toLowerCase().replace(/[^a-z0-9]/g, '');
    var allMastered = true;
    var scores = [];
    var settingsMap = {};
    for (var ri = 0; ri < last10.length; ri++) {
      var count = parseFloat(last10[ri][ci]) || 0;
      scores.push(count);
      if (count > 1) { allMastered = false; }
      if (settingCol >= 0) {
        var settingVal = String(last10[ri][settingCol] || '').trim();
        if (settingVal) { settingsMap[settingVal] = true; }
      }
    }

    if (!allMastered) {
      result.behaviors[key] = 'none';
      continue;
    }

    var settingsList = Object.keys(settingsMap);
    var settingsCount = settingsList.length;
    var masteryStatus = (settingsCount >= 2) ? 'recommended' : 'pendingGeneralization';

    result.behaviors[key] = masteryStatus;

    // Pass pre-loaded data to avoid re-reading the Mastery Log sheet per behavior
    var existingStatus = getMasteryLogStatus(ss, 'behavior', key, masteryLogData);
    // Only write if no existing active entry (allow re-entry after 'dismissed')
    if (existingStatus === null || existingStatus === '') {
      var scoresStr = scores.join(', ');
      var settingsStr = settingsList.join(', ');
      writeMasteryLog(ss, 'behavior', key, label, today, scoresStr, therapistName, therapistEmail, clientName, clientId, masteryStatus, settingsStr);
      // Invalidate cache after write so subsequent behaviors in this loop see updated data
      masteryLogData = null;
      result.newMasteries.push({ type: 'behavior', code: key, description: label, masteryDate: today, lastScores: scoresStr, status: masteryStatus, settingsObserved: settingsStr });
    } else if (existingStatus === 'dismissed') {
      // Regression recovered — write a fresh entry
      var scoresStr2 = scores.join(', ');
      var settingsStr2 = settingsList.join(', ');
      writeMasteryLog(ss, 'behavior', key, label, today, scoresStr2, therapistName, therapistEmail, clientName, clientId, masteryStatus, settingsStr2);
      // Invalidate cache after write
      masteryLogData = null;
      result.newMasteries.push({ type: 'behavior', code: key, description: label, masteryDate: today, lastScores: scoresStr2, status: masteryStatus, settingsObserved: settingsStr2 });
    }
    // If existingStatus is 'recommended', 'pendingGeneralization', or 'confirmed' — skip
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

/**
 * Returns the status of the most recent mastery log entry for type+code,
 * or null if no entry exists.
 * Status values: 'recommended', 'pendingGeneralization', 'confirmed', 'dismissed'
 * Backfills empty status fields using type-appropriate default on read.
 *
 * @param {Spreadsheet} ss
 * @param {string}      type  - 'behavior' or 'goal'
 * @param {string}      code  - behavior key or goal code
 * @param {Array}       [preloadedData] - optional pre-loaded sheet.getDataRange().getValues();
 *                              if provided, skips the sheet read (performance optimization).
 *                              When provided, live backfill writes are skipped (caller must
 *                              handle backfill separately if needed).
 */
function getMasteryLogStatus(ss, type, code, preloadedData) {
  var sheet, data;
  if (preloadedData) {
    data = preloadedData;
    sheet = null; // no live backfill when using cached data
  } else {
    sheet = ss.getSheetByName('Mastery Log');
    if (!sheet) return null;
    data = sheet.getDataRange().getValues();
  }
  if (!data || data.length < 2) return null;
  var headers = data[0];
  var colMap = {};
  for (var hi = 0; hi < headers.length; hi++) {
    colMap[String(headers[hi]).trim()] = hi;
  }
  if (colMap['type'] === undefined || colMap['code'] === undefined) return null;

  // Find most recent matching row (last occurrence wins)
  var lastMatchRow = -1;
  for (var ri = 1; ri < data.length; ri++) {
    var row = data[ri];
    if (String(row[colMap['type']]).trim() === type &&
        String(row[colMap['code']]).trim() === code) {
      lastMatchRow = ri;
    }
  }
  if (lastMatchRow < 0) return null;

  var statusColIdx = colMap['status'];
  if (statusColIdx === undefined) {
    // Status column doesn't exist yet (old schema). An entry DOES exist (lastMatchRow >= 0).
    // Return 'recommended' so checkBehaviorMastery does NOT write a duplicate.
    // The column will be created (with backfill) the next time writeMasteryLog runs.
    return 'recommended';
  }

  var existingStatus = String(data[lastMatchRow][statusColIdx] || '').trim();
  // Backfill: old entries with empty status — use type-appropriate default
  if (!existingStatus) {
    existingStatus = (type === 'goal') ? 'confirmed' : 'recommended';
    if (sheet) {
      // Only write backfill when using live sheet data (not preloaded cache)
      try {
        sheet.getRange(lastMatchRow + 1, statusColIdx + 1).setValue(existingStatus);
      } catch(e) {}
    }
  }
  return existingStatus;
}

// Legacy alias for goal mastery (unchanged logic)
function isMasteryLogged(ss, type, code) {
  return getMasteryLogStatus(ss, type, code) !== null;
}

function writeMasteryLog(ss, type, code, description, masteryDate, lastScores, therapistName, therapistEmail, clientName, clientId, status, settingsObserved) {
  var masteryHeaders = [
    'type', 'code', 'description', 'masteryDate', 'lastScores',
    'therapistName', 'therapistEmail', 'clientName', 'clientId', 'dateISO',
    'status', 'approvedBy', 'approvalDate', 'settingsObserved'
  ];
  var sheet = getOrCreateSheet(ss, 'Mastery Log', masteryHeaders);

  // Check whether the status column exists BEFORE ensureSheetColumns (for backfill detection)
  var priorLastCol = sheet.getLastColumn();
  var statusExistedBefore = false;
  if (priorLastCol > 0) {
    var priorHeaders = sheet.getRange(1, 1, 1, priorLastCol).getValues()[0];
    for (var pi = 0; pi < priorHeaders.length; pi++) {
      if (String(priorHeaders[pi]).trim() === 'status') { statusExistedBefore = true; break; }
    }
  }

  // Ensure all 14 columns exist (adds status, approvedBy, approvalDate, settingsObserved if missing)
  ensureSheetColumns(sheet, masteryHeaders);

  // Build colMap from actual header row after potential column additions
  var hdrs = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var colMap = {};
  for (var hi = 0; hi < hdrs.length; hi++) {
    colMap[String(hdrs[hi]).trim()] = hi;
  }

  // FIX 3: Backfill status for all existing rows when the status column was just created.
  // Runs once — only when statusExistedBefore is false but the column now exists.
  if (!statusExistedBefore && colMap['status'] !== undefined) {
    var allData = sheet.getDataRange().getValues();
    var statusColIdx = colMap['status'];
    var typeColIdx   = colMap['type'];
    for (var bri = 1; bri < allData.length; bri++) {
      var bCellStatus = String(allData[bri][statusColIdx] || '').trim();
      if (!bCellStatus) {
        var bRowType = typeColIdx !== undefined ? String(allData[bri][typeColIdx] || '').trim() : '';
        var bDefault = (bRowType === 'goal') ? 'confirmed' : 'recommended';
        sheet.getRange(bri + 1, statusColIdx + 1).setValue(bDefault);
      }
    }
  }

  var vals = {
    'type': type, 'code': code, 'description': description || '',
    'masteryDate': masteryDate, 'lastScores': lastScores || '',
    'therapistName': therapistName || '', 'therapistEmail': therapistEmail || '',
    'clientName': clientName || '', 'clientId': clientId || '', 'dateISO': masteryDate,
    'status': status || 'recommended', 'approvedBy': '', 'approvalDate': '',
    'settingsObserved': settingsObserved || ''
  };
  var row = [];
  for (var ci = 0; ci < hdrs.length; ci++) {
    var key = String(hdrs[ci]).trim();
    row.push(key && vals[key] !== undefined ? vals[key] : '');
  }
  sheet.appendRow(row);
}


// ── MASTERY REPORT ─────────────────────────────────────────────────────

/**
 * Aggregate mastery log entries across all client sheets for a given month/year.
 * clients: [{ id, name, sheetId }]
 * Returns array of entries.
 */
function getMasteryReport(year, month, clients) {
  if (!clients || !clients.length) return [];
  // latestByKey: dedupKey → entry — keeps one entry per client+type+code
  var latestByKey = {};
  var monthStr = String(month).length < 2 ? ('0' + month) : String(month);
  var prefix   = year + '-' + monthStr;

  for (var ci = 0; ci < clients.length; ci++) {
    var client = clients[ci];
    if (!client || !client.sheetId) continue;
    try {
      var ss    = SpreadsheetApp.openById(client.sheetId);
      if (!ss) continue;
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

      // PASS 1: full scan of ALL rows (no date filter) — group by type+code to find duplicates
      // This catches duplicates spread across different months.
      var allByKey = {}; // normalized key → array of { rowIndex, row }
      for (var ri = 1; ri < data.length; ri++) {
        var row = data[ri];
        var rType = String(row[colMap['type']] || '').trim();
        var rCode = String(row[colMap['code']] || '').trim();
        if (!rType || !rCode) continue;
        var rKey = rType + '|' + rCode.toLowerCase();
        if (!allByKey[rKey]) allByKey[rKey] = [];
        allByKey[rKey].push({ rowIndex: ri, row: row });
      }

      // Collect duplicate sheet rows to delete (keep LAST per key — most recent)
      var dupeSheetRows = [];
      var allKeys = Object.keys(allByKey);
      for (var ak = 0; ak < allKeys.length; ak++) {
        var grp = allByKey[allKeys[ak]];
        for (var gj = 0; gj < grp.length - 1; gj++) { // all but the last
          dupeSheetRows.push(grp[gj].rowIndex + 1); // convert to 1-based
        }
      }

      // Delete duplicate rows bottom-to-top so indices stay valid
      if (dupeSheetRows.length > 0) {
        dupeSheetRows.sort(function(a, b) { return b - a; });
        for (var di2 = 0; di2 < dupeSheetRows.length; di2++) {
          sheet.deleteRow(dupeSheetRows[di2]);
        }
      }

      // PASS 2: from the surviving rows (last per key), apply date filter for display
      for (var ak2 = 0; ak2 < allKeys.length; ak2++) {
        var grp2 = allByKey[allKeys[ak2]];
        var survivor = grp2[grp2.length - 1]; // last = most recent
        var row2 = survivor.row;
        var entryType = String(row2[colMap['type']] || '').trim();
        var entryCode = String(row2[colMap['code']] || '').trim();

        // Apply date filter
        var dateISO = toDateISO(colMap['dateISO'] !== undefined ? row2[colMap['dateISO']] : '');
        if (!dateISO && colMap['masteryDate'] !== undefined) {
          dateISO = toDateISO(row2[colMap['masteryDate']]);
        }
        if (!dateISO || dateISO.indexOf(prefix) !== 0) continue;
        var masteryDateVal = colMap['masteryDate'] !== undefined ? toDateISO(row2[colMap['masteryDate']]) : dateISO;

        var entryStatus = colMap['status'] !== undefined ? String(row2[colMap['status']] || '').trim() : '';
        if (!entryStatus) {
          entryStatus = (entryType === 'goal') ? 'confirmed' : 'recommended';
        }

        var entry = {
          clientId:        client.id || '',
          clientName:      client.name || '',
          sheetId:         client.sheetId || '',
          type:            entryType,
          code:            entryCode,
          description:     String(row2[colMap['description']]        || '').trim(),
          masteryDate:     masteryDateVal,
          lastScores:      String(row2[colMap['lastScores']]         || '').trim(),
          therapistName:   String(row2[colMap['therapistName']]      || '').trim(),
          therapistEmail:  String(row2[colMap['therapistEmail']]     || '').trim(),
          status:          entryStatus,
          settingsObserved:colMap['settingsObserved'] !== undefined ? String(row2[colMap['settingsObserved']] || '').trim() : '',
          approvedBy:      colMap['approvedBy']       !== undefined ? String(row2[colMap['approvedBy']]       || '').trim() : '',
          approvalDate:    colMap['approvalDate']     !== undefined ? String(row2[colMap['approvalDate']]     || '').trim() : ''
        };

        var dedupKey = (client.id || '') + '|' + entryType + '|' + entryCode.toLowerCase();
        latestByKey[dedupKey] = entry;
      }

    } catch(e) {
      // Skip inaccessible client sheets
    }
  }

  // Build output array from the latest entry per key
  var entries = [];
  var keys = Object.keys(latestByKey);
  for (var ki = 0; ki < keys.length; ki++) {
    var e = latestByKey[keys[ki]];
    if (e && typeof e === 'object') { entries.push(e); }
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

      // Identify which rows (1-based sheet row) are duplicates — keep the LAST (most recent) occurrence
      var lastSeenRow = {}; // key → 1-based sheet row of most recent occurrence
      var rowsToDelete = []; // 1-based sheet row indices of older duplicates
      for (var ri = 1; ri < data.length; ri++) {
        var row  = data[ri];
        // Normalize to lowercase to catch case variants (e.g. 'Elopement' vs 'elopement')
        var key  = String(row[typeCol] || '').trim().toLowerCase() + '|' + String(row[codeCol] || '').trim().toLowerCase();
        if (!key || key === '|') continue; // skip blank rows
        if (lastSeenRow[key]) {
          rowsToDelete.push(lastSeenRow[key]); // previous occurrence is the duplicate
        }
        lastSeenRow[key] = ri + 1; // update to current row (1-based)
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

// ── BEHAVIOR MASTERY APPROVAL / DISMISSAL ───────────────────────────────

/**
 * BCBA/Admin approves a behavior mastery recommendation.
 * Sets status = 'confirmed', approvedBy, approvalDate on the most recent
 * matching mastery log row.
 */
function approveBehaviorMastery(clientSheetId, clientId, behaviorKey, approverEmail, approverRole) {
  if (!approverRole || (approverRole !== 'Admin' && approverRole !== 'BCBA')) {
    return { success: false, error: 'Unauthorized: BCBA or Admin role required' };
  }
  var trimmedSheetId = clientSheetId ? String(clientSheetId).trim() : '';
  if (!trimmedSheetId || trimmedSheetId.length < 10) return { success: false, error: 'Missing or invalid clientSheetId' };
  try {
    var ss    = SpreadsheetApp.openById(trimmedSheetId);
    var sheet = ss.getSheetByName('Mastery Log');
    if (!sheet) return { success: false, error: 'Mastery Log sheet not found' };
    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return { success: false, error: 'No mastery entries found' };

    var headers = data[0];
    var colMap = {};
    for (var hi = 0; hi < headers.length; hi++) {
      colMap[String(headers[hi]).trim()] = hi;
    }
    if (colMap['type'] === undefined || colMap['code'] === undefined) {
      return { success: false, error: 'Mastery Log missing required columns' };
    }

    // Find last matching row (most recent)
    var lastMatchRow = -1;
    for (var ri = 1; ri < data.length; ri++) {
      var row = data[ri];
      if (String(row[colMap['type']]).trim() === 'behavior' &&
          String(row[colMap['code']]).trim() === behaviorKey) {
        lastMatchRow = ri;
      }
    }
    if (lastMatchRow < 0) return { success: false, error: 'No mastery entry found for this behavior' };

    var today = new Date().toISOString().substring(0, 10);
    var sheetRow = lastMatchRow + 1; // 1-based

    // Ensure new columns exist
    var newCols = ['status', 'approvedBy', 'approvalDate', 'settingsObserved'];
    ensureSheetColumns(sheet, newCols);
    // Re-read headers after potential column add
    var updatedHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var updatedColMap = {};
    for (var ui = 0; ui < updatedHeaders.length; ui++) {
      updatedColMap[String(updatedHeaders[ui]).trim()] = ui;
    }

    if (updatedColMap['status'] !== undefined) {
      sheet.getRange(sheetRow, updatedColMap['status'] + 1).setValue('confirmed');
    }
    if (updatedColMap['approvedBy'] !== undefined) {
      sheet.getRange(sheetRow, updatedColMap['approvedBy'] + 1).setValue(approverEmail || '');
    }
    if (updatedColMap['approvalDate'] !== undefined) {
      sheet.getRange(sheetRow, updatedColMap['approvalDate'] + 1).setValue(today);
    }
    return { success: true, status: 'confirmed', approvedBy: approverEmail, approvalDate: today };
  } catch(e) {
    return { success: false, error: String(e) };
  }
}

/**
 * BCBA/Admin dismisses a behavior mastery recommendation.
 * Sets status = 'dismissed' on the most recent matching mastery log row.
 */
function dismissBehaviorMastery(clientSheetId, clientId, behaviorKey, approverEmail, approverRole) {
  if (!approverRole || (approverRole !== 'Admin' && approverRole !== 'BCBA')) {
    return { success: false, error: 'Unauthorized: BCBA or Admin role required' };
  }
  var trimmedSheetId2 = clientSheetId ? String(clientSheetId).trim() : '';
  if (!trimmedSheetId2 || trimmedSheetId2.length < 10) return { success: false, error: 'Missing or invalid clientSheetId' };
  try {
    var ss    = SpreadsheetApp.openById(trimmedSheetId2);
    var sheet = ss.getSheetByName('Mastery Log');
    if (!sheet) return { success: false, error: 'Mastery Log sheet not found' };
    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return { success: false, error: 'No mastery entries found' };

    var headers = data[0];
    var colMap = {};
    for (var hi = 0; hi < headers.length; hi++) {
      colMap[String(headers[hi]).trim()] = hi;
    }
    if (colMap['type'] === undefined || colMap['code'] === undefined) {
      return { success: false, error: 'Mastery Log missing required columns' };
    }

    var lastMatchRow = -1;
    for (var ri = 1; ri < data.length; ri++) {
      var row = data[ri];
      if (String(row[colMap['type']]).trim() === 'behavior' &&
          String(row[colMap['code']]).trim() === behaviorKey) {
        lastMatchRow = ri;
      }
    }
    if (lastMatchRow < 0) return { success: false, error: 'No mastery entry found for this behavior' };

    var sheetRow = lastMatchRow + 1;

    var newCols2 = ['status', 'approvedBy', 'approvalDate', 'settingsObserved'];
    ensureSheetColumns(sheet, newCols2);
    var updatedHeaders2 = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var updatedColMap2 = {};
    for (var ui2 = 0; ui2 < updatedHeaders2.length; ui2++) {
      updatedColMap2[String(updatedHeaders2[ui2]).trim()] = ui2;
    }

    if (updatedColMap2['status'] !== undefined) {
      sheet.getRange(sheetRow, updatedColMap2['status'] + 1).setValue('dismissed');
    }
    return { success: true, status: 'dismissed' };
  } catch(e) {
    return { success: false, error: String(e) };
  }
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
      var lastCol = tab.getLastColumn();
      var lastRow = tab.getLastRow();
      if (lastRow < 2 || lastCol < 1) continue;

      // Read header row first; only read full data when goal column exists
      var headers  = tab.getRange(1, 1, 1, lastCol).getValues()[0];
      var goalCols = [];
      for (var hi = 0; hi < headers.length; hi++) {
        var h = String(headers[hi] || '').trim().toLowerCase();
        // Match exact code or "code %" / "code_..." suffixes
        if (h === code || h.indexOf(code + ' ') === 0 || h.indexOf(code + '_') === 0) {
          goalCols.push(hi);
        }
      }
      if (goalCols.length === 0) continue;

      // Goal column found — read data rows and count non-empty values
      var dataRows = tab.getRange(2, 1, lastRow - 1, lastCol).getValues();
      var clientCount = 0;
      for (var ri = 0; ri < dataRows.length; ri++) {
        var row = dataRows[ri];
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


// ── TRIAL DATA DIAGNOSTIC ──────────────────────────────────────────────

/**
 * Diagnostic: inspect the Trial Data header row for all active clients.
 * Run from the GAS editor with no arguments — outputs full report via Logger.log.
 * Also callable via doPost action='diagnoseTrialDataHeaders'.
 *
 * For each client reports:
 *   - Sheet dimensions
 *   - Every column: index, header value, whether any data row has a value
 *   - Column counts (total / with header / without header / data-but-no-header / truly empty)
 *   - Where analytics columns begin
 *   - Where goal columns begin (first non-meta, non-Trial, non-% column)
 *   - Each goal group found: code, trial col count, has % col
 *   - First 3 data rows (goal columns only, to keep output manageable)
 */
function diagnoseTrialDataHeaders() {
  var DIAG_META = {
    'Date': true, 'Therapist': true, 'Setting': true, 'Location': true, 'Notes': true,
    'submissionId': true, 'clientName': true, 'clientId': true, 'therapistEmail': true,
    'sessionType': true, 'billingCode': true, 'isDraft': true, 'payloadHash': true,
    'submittedAt': true, 'dateISO': true, 'Percent Correct': true,
    'End Time Adjustment Reason': true, 'Adjusted End Time': true, 'goalName': true
  };
  var DIAG_ANALYTICS = {
    'submissionId': true, 'clientName': true, 'clientId': true, 'therapistEmail': true,
    'sessionType': true, 'billingCode': true, 'isDraft': true, 'payloadHash': true,
    'submittedAt': true, 'dateISO': true, 'Percent Correct': true
  };

  var lines = [];

  function emit(s) { lines.push(s || ''); }
  function flush() {
    // Logger.log caps at ~8 KB per call — chunk the output
    var chunk = '';
    for (var i = 0; i < lines.length; i++) {
      chunk += lines[i] + '\n';
      if (chunk.length > 7500) { Logger.log(chunk); chunk = ''; }
    }
    if (chunk) Logger.log(chunk);
  }

  emit('=== TRIAL DATA HEADERS DIAGNOSTIC ' + new Date().toISOString() + ' ===');

  var adminSS = SpreadsheetApp.openById(ADMIN_SHEET_ID);
  var clients  = sheetToObjects(adminSS, 'Clients');

  var activeClients = [];
  for (var ci = 0; ci < clients.length; ci++) {
    var c = clients[ci];
    if ((c.status || 'active') !== 'inactive' && c.sheetId) activeClients.push(c);
  }
  emit('Active clients to scan: ' + activeClients.length);

  for (var ai = 0; ai < activeClients.length; ai++) {
    var client = activeClients[ai];
    emit('');
    emit('────────────────────────────────────────────');
    emit('CLIENT: ' + client.name + '  (id=' + client.id + ')');
    emit('────────────────────────────────────────────');

    try {
      var ss    = SpreadsheetApp.openById(client.sheetId);
      var sheet = ss.getSheetByName('Trial Data');
      if (!sheet) { emit('  !! No Trial Data tab'); continue; }

      var lastCol = sheet.getLastColumn();
      var lastRow = sheet.getLastRow();
      emit('  Dimensions: ' + lastRow + ' rows x ' + lastCol + ' cols');

      if (lastRow < 1 || lastCol < 1) { emit('  !! Sheet is empty'); continue; }

      // Read full sheet (cap at 200 rows for data presence check)
      var readRows = Math.min(lastRow, 201);
      var allData  = sheet.getRange(1, 1, readRows, lastCol).getValues();
      var headerRow = allData[0];
      var dataRows  = allData.slice(1);

      // Per-column: header value + whether any data row has a value
      var colHasData = [];
      for (var col = 0; col < lastCol; col++) {
        var found = false;
        for (var dr = 0; dr < dataRows.length; dr++) {
          var v = col < dataRows[dr].length ? dataRows[dr][col] : '';
          if (v !== '' && v !== null && v !== undefined) { found = true; break; }
        }
        colHasData.push(found);
      }

      // Column counts
      var totalCols = lastCol;
      var withHdr = 0, withoutHdr = 0, dataNoHdr = 0, emptyCol = 0;
      for (var col2 = 0; col2 < lastCol; col2++) {
        var h = String(headerRow[col2] || '').trim();
        if (h) { withHdr++; }
        else {
          withoutHdr++;
          if (colHasData[col2]) { dataNoHdr++; } else { emptyCol++; }
        }
      }
      emit('  Cols total=' + totalCols + '  withHeader=' + withHdr +
           '  noHeader=' + withoutHdr + '  (dataButNoHdr=' + dataNoHdr +
           '  trulyEmpty=' + emptyCol + ')');

      // Full column listing
      emit('  COLUMN LISTING:');
      for (var col3 = 0; col3 < lastCol; col3++) {
        var hv  = String(headerRow[col3] || '').trim();
        var lbl = hv ? '"' + hv + '"' : 'EMPTY';
        var dflag = colHasData[col3] ? 'data' : '----';
        var meta  = DIAG_META[hv] ? ' [META]' : (hv && !DIAG_META[hv] && !/^Trial \d+$/i.test(hv) && hv !== '%' ? ' [?GOAL?]' : '');
        emit('    col' + (col3 + 1) + ': ' + lbl + ' | ' + dflag + meta);
      }

      // Analytics start
      var analyticsStart = -1;
      var analyticsHdr   = '';
      for (var col4 = 0; col4 < lastCol; col4++) {
        var h4 = String(headerRow[col4] || '').trim();
        if (DIAG_ANALYTICS[h4]) { analyticsStart = col4; analyticsHdr = h4; break; }
      }
      emit('  Analytics start: col' + (analyticsStart + 1) +
           ' (' + (analyticsStart >= 0 ? '"' + analyticsHdr + '"' : 'NOT FOUND') + ')');

      // Goal columns start
      var goalStart = -1;
      for (var col5 = 0; col5 < lastCol; col5++) {
        var h5 = String(headerRow[col5] || '').trim();
        if (!h5) continue;
        if (DIAG_META[h5]) continue;
        if (/^Trial \d+$/i.test(h5) || h5 === '%') continue;
        goalStart = col5;
        break;
      }
      emit('  Goal cols start: col' + (goalStart + 1) +
           ' (' + (goalStart >= 0 ? '"' + String(headerRow[goalStart]).trim() + '"' : 'NOT FOUND') + ')');

      // Parse goal groups
      var goalGroups = [];
      var gi2 = (goalStart >= 0) ? goalStart : 0;
      while (gi2 < lastCol) {
        var gh = String(headerRow[gi2] || '').trim();
        if (!gh) { gi2++; continue; }                          // empty header — skip
        if (DIAG_META[gh]) { gi2++; continue; }               // metadata — skip
        if (/^Trial \d+$/i.test(gh) || gh === '%') { gi2++; continue; } // orphan
        if (DIAG_ANALYTICS[gh]) break;                         // entered analytics

        // This header is a goal code
        var gcCode    = gh;
        var gcTrials  = [];
        var gcPctCol  = -1;
        var gj        = gi2 + 1;
        while (gj < lastCol) {
          var ghj = String(headerRow[gj] || '').trim();
          if (!ghj || DIAG_ANALYTICS[ghj]) break;
          if (/^Trial \d+$/i.test(ghj)) { gcTrials.push(gj); gj++; }
          else if (ghj === '%')          { gcPctCol = gj; gj++; break; }
          else                           { break; }
        }
        goalGroups.push({ code: gcCode, startCol: gi2, trialCount: gcTrials.length, hasPct: gcPctCol >= 0 });
        gi2 = gj;
      }

      emit('  Goal groups found: ' + goalGroups.length);
      for (var gg = 0; gg < goalGroups.length; gg++) {
        var g = goalGroups[gg];
        emit('    [col' + (g.startCol + 1) + '] "' + g.code + '" — ' +
             g.trialCount + ' trial col(s), pct=' + (g.hasPct ? 'YES' : 'NO'));
      }

      // First 3 data rows — goal columns + key meta only
      var rowLimit = Math.min(3, dataRows.length);
      if (rowLimit > 0 && goalGroups.length > 0) {
        emit('  FIRST ' + rowLimit + ' DATA ROWS (goal cols only):');
        // Build compact column set: Date + Therapist + each goal group start col
        var previewCols = [];
        for (var col6 = 0; col6 < lastCol; col6++) {
          var ph = String(headerRow[col6] || '').trim();
          if (ph === 'Date' || ph === 'Therapist') previewCols.push(col6);
        }
        for (var gg2 = 0; gg2 < goalGroups.length; gg2++) {
          var g2 = goalGroups[gg2];
          previewCols.push(g2.startCol); // goal code col
          if (g2.hasPct) previewCols.push(g2.startCol + g2.trialCount + 1); // pct col
        }
        for (var dr2 = 0; dr2 < rowLimit; dr2++) {
          var parts = [];
          for (var pi = 0; pi < previewCols.length; pi++) {
            var pc   = previewCols[pi];
            var ph2  = String(headerRow[pc] || '').trim() || ('col' + (pc + 1));
            var pval = pc < dataRows[dr2].length ? dataRows[dr2][pc] : '';
            if (pval instanceof Date) pval = pval.toISOString().substring(0, 10);
            parts.push(ph2 + '=' + String(pval !== null && pval !== undefined ? pval : ''));
          }
          emit('    Row' + (dr2 + 1) + ': ' + parts.join(' | '));
        }
      }

    } catch (e) {
      emit('  !! ERROR: ' + e.message);
    }
  }

  emit('');
  emit('=== END DIAGNOSTIC ===');

  flush();
  return lines.join('\n');
}

