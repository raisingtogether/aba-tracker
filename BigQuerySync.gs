/**
 * BigQuerySync.gs — RT ABA Tracker
 * Syncs all Google Sheets data (client + admin) to BigQuery hourly.
 * Add as a second file in the same Apps Script project as Code.gs.
 *
 * Setup:
 *   1. Enable the BigQuery API in Apps Script: Resources > Advanced Google Services > BigQuery API ON
 *   2. Run setupHourlySync() once to install the trigger
 *   3. Run manualSync() to test immediately
 *
 * CRITICAL: ES5 only — no ??, no ?., no template literals, no arrow functions,
 * no spread, no let/const, no Array.from. var only.
 */

// ── CONFIGURATION ─────────────────────────────────────────────────────
var BQ_PROJECT     = 'rt-aba-tracker';
var BQ_DATASET     = 'aba_tracker';
var BQ_ADMIN_SHEET = '1VPBADMXvhOww_52O1n2CieTsQB6XCotLt6XdAQsq0ik';
var BQ_AUDIT_SHEET = '1tf98iS18vV08mQtPV9Vq6hQVkEp6Qg-ebUwHkeRlwaQ';
// BQ_BATCH_SIZE is unused now that we use NDJSON load jobs instead of streaming insertAll
var BQ_BATCH_SIZE  = 500;

// Analytics columns appended to Behavior Data tab
var BQ_BEHAV_ANALYTICS = [
  'submissionId', 'clientName', 'clientId', 'therapistEmail',
  'sessionType', 'billingCode', 'isDraft', 'payloadHash', 'submittedAt', 'dateISO'
];
// Analytics columns appended to Trial Data tab
var BQ_TRIAL_ANALYTICS = [
  'submissionId', 'clientName', 'clientId', 'therapistEmail',
  'sessionType', 'billingCode', 'isDraft', 'payloadHash', 'submittedAt', 'dateISO', 'Percent Correct'
];


// ── MAIN ENTRY POINT ──────────────────────────────────────────────────

/**
 * Primary sync function — called by hourly trigger.
 * Reads all client sheets + RT Admin, writes normalized rows to BigQuery.
 */
function syncAllToBigQuery() {
  var startTime = new Date();
  var errors    = [];
  var counts    = {};

  // Ensure the BQ dataset exists before doing anything else
  try {
    bqEnsureDataset();
  } catch (e) {
    bqAuditLog('bigquery_sync_error', 'Dataset setup failed: ' + e.message);
    return;
  }

  // ── READ ADMIN CONFIG ───────────────────────────────────────────────
  var adminSS;
  try {
    adminSS = SpreadsheetApp.openById(BQ_ADMIN_SHEET);
  } catch (e) {
    bqAuditLog('bigquery_sync_error', 'Cannot open admin sheet: ' + e.message);
    return;
  }

  var clients        = bqSheetToObjects(adminSS, 'Clients');
  var therapists     = bqSheetToObjects(adminSS, 'Therapists');
  var goals          = bqSheetToObjects(adminSS, 'Goals');
  var behaviors      = bqSheetToObjects(adminSS, 'Behaviors');
  var billing        = bqSheetToObjects(adminSS, 'Billing');
  var authorizations = bqSheetToObjects(adminSS, 'Authorizations');

  // Build goal code → description lookup
  var goalDescMap = {};
  for (var gi = 0; gi < goals.length; gi++) {
    var gc = String(goals[gi].code || '').trim();
    if (gc) goalDescMap[gc] = goals[gi].description || '';
  }

  // ── SYNC REFERENCE TABLES (always WRITE_TRUNCATE) ───────────────────
  var refTables = [
    { name: 'therapists',          rows: bqBuildTherapistRows(therapists)          },
    { name: 'clients',             rows: bqBuildClientRows(clients)                },
    { name: 'authorizations',      rows: bqBuildAuthorizationRows(authorizations)  },
    { name: 'goals_reference',     rows: bqBuildGoalReferenceRows(goals)           },
    { name: 'behaviors_reference', rows: bqBuildBehaviorReferenceRows(behaviors)   },
    { name: 'billing_codes',       rows: bqBuildBillingCodeRows(billing)           }
  ];
  for (var ri = 0; ri < refTables.length; ri++) {
    var rt = refTables[ri];
    try {
      bqSyncTable(rt.name, rt.rows);
      counts[rt.name] = rt.rows.length;
    } catch (e) {
      errors.push(rt.name + ': ' + e.message);
    }
  }

  // ── COLLECT DATA ROWS FROM CLIENT SHEETS ────────────────────────────
  var sessionsBuf    = [];
  var behaviorsBuf   = [];
  var trialsBuf      = [];
  var abcBuf         = [];
  var masteryBuf     = [];

  for (var ci = 0; ci < clients.length; ci++) {
    var client = clients[ci];
    if ((client.status || 'active') === 'inactive' || !client.sheetId) continue;

    var clientSS;
    try {
      clientSS = SpreadsheetApp.openById(client.sheetId);
    } catch (e) {
      errors.push('Open sheet ' + client.name + ': ' + e.message);
      continue;
    }

    var readers = [
      { buf: sessionsBuf,  fn: bqReadSessionRows,  name: 'sessions'  },
      { buf: behaviorsBuf, fn: bqReadBehaviorRows,  name: 'behaviors' },
      { buf: trialsBuf,    fn: bqReadTrialRows,     name: 'trials'    },
      { buf: abcBuf,       fn: bqReadABCRows,       name: 'abc'       },
      { buf: masteryBuf,   fn: bqReadMasteryRows,   name: 'mastery'   }
    ];

    for (var rdr = 0; rdr < readers.length; rdr++) {
      try {
        var rows = readers[rdr].fn(clientSS, client, goalDescMap);
        for (var rowi = 0; rowi < rows.length; rowi++) {
          readers[rdr].buf.push(rows[rowi]);
        }
      } catch (e) {
        errors.push(client.name + '/' + readers[rdr].name + ': ' + e.message);
      }
    }
  }

  // ── SYNC DATA TABLES ────────────────────────────────────────────────
  var dataTables = [
    { name: 'sessions',        rows: sessionsBuf  },
    { name: 'behavior_records', rows: behaviorsBuf },
    { name: 'trial_records',   rows: trialsBuf    },
    { name: 'abc_incidents',   rows: abcBuf       },
    { name: 'mastery_log',     rows: masteryBuf   }
  ];
  for (var dt = 0; dt < dataTables.length; dt++) {
    var tbl = dataTables[dt];
    try {
      bqSyncTable(tbl.name, tbl.rows);
      counts[tbl.name] = tbl.rows.length;
    } catch (e) {
      errors.push(tbl.name + ' sync: ' + e.message);
    }
  }

  // ── AUDIT LOG ENTRY ─────────────────────────────────────────────────
  var elapsed  = Math.round((new Date() - startTime) / 1000);
  var details  = 'Sync complete in ' + elapsed + 's | rows: ' + JSON.stringify(counts);
  if (errors.length) details += ' | errors: ' + errors.join('; ');
  bqAuditLog('bigquery_sync', details);
}


// ── REFERENCE TABLE BUILDERS ──────────────────────────────────────────

function bqBuildTherapistRows(therapists) {
  var rows = [];
  for (var i = 0; i < therapists.length; i++) {
    var t = therapists[i];
    rows.push({
      id:                t.id              || '',
      name:              t.name            || '',
      initials:          t.initials        || '',
      profile:           t.profile         || '',
      email:             t.email           || '',
      role:              t.role            || 'collector',
      weekly_hour_limit: bqParseFloat(t.weeklyHourLimit),
      pay_rate:          bqParseFloat(t.payRate),
      status:            t.status          || 'active',
      client_ids:        t.clientIds       || ''
    });
  }
  return rows;
}

function bqBuildClientRows(clients) {
  var rows = [];
  for (var i = 0; i < clients.length; i++) {
    var c = clients[i];
    rows.push({
      id:       c.id       || '',
      name:     c.name     || '',
      initials: c.initials || '',
      sheet_id: c.sheetId  || '',
      status:   c.status   || 'active'
    });
  }
  return rows;
}

function bqBuildAuthorizationRows(auths) {
  var rows = [];
  for (var i = 0; i < auths.length; i++) {
    var a = auths[i];
    rows.push({
      client_id:            a.clientId            || '',
      payer_type:           a.payerType           || '',
      insurance_company:    a.insuranceCompany     || '',
      authorization_number: a.authorizationNumber  || '',
      billing_code:         a.billingCode          || '',
      authorized_hours:     bqParseFloat(a.authorizedHours),
      unit_rate:            bqParseFloat(a.unitRate),
      hourly_rate:          bqParseFloat(a.hourlyRate),
      start_date:           a.startDate            || '',
      end_date:             a.endDate              || '',
      co_insurance:         a.coInsurance          || '',
      step_up_program:      a.stepUpProgram        || '',
      status:               a.status              || 'active'
    });
  }
  return rows;
}

function bqBuildGoalReferenceRows(goals) {
  var rows = [];
  for (var i = 0; i < goals.length; i++) {
    var g = goals[i];
    rows.push({
      code:        g.code        || '',
      description: g.description || '',
      client_ids:  g.clientIds   || g.clientId || '',
      num_trials:  parseInt(g.numTrials) || 5,
      status:      g.status      || 'active'
    });
  }
  return rows;
}

function bqBuildBehaviorReferenceRows(behaviors) {
  var rows = [];
  for (var i = 0; i < behaviors.length; i++) {
    var b = behaviors[i];
    rows.push({
      key:        b.key        || '',
      label:      b.label      || '',
      client_ids: b.clientIds  || '',
      status:     b.status     || 'active'
    });
  }
  return rows;
}

function bqBuildBillingCodeRows(billing) {
  var rows = [];
  for (var i = 0; i < billing.length; i++) {
    var b = billing[i];
    rows.push({
      profile:      b.profile      || '',
      session_type: b.sessionType  || '',
      code:         b.code         || ''
    });
  }
  return rows;
}


// ── CLIENT SHEET READERS ──────────────────────────────────────────────

/**
 * Read Time In Time Out tab → sessions table rows.
 * Accepts three params for consistency with the readers dispatch loop,
 * but goalDescMap is unused here.
 */
function bqReadSessionRows(clientSS, client) {
  var sheet = clientSS.getSheetByName('Time In Time Out');
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  var cm = bqBuildColMap(data[0]);
  var result = [];

  for (var ri = 1; ri < data.length; ri++) {
    var row = data[ri];
    // Skip empty rows (no date and no submission ID)
    if (!row[0] && bqStr(cm, row, 'Submission ID') === '') continue;

    result.push({
      submission_id:              bqStr(cm, row, 'Submission ID'),
      date_iso:                   bqStr(cm, row, 'dateISO'),
      date_display:               bqDateCell(cm, row, 'Date'),
      billing_code:               bqStr(cm, row, 'Billing Code'),
      session_type:               bqStr(cm, row, 'Type of Session'),
      time_in:                    bqStr(cm, row, 'Time In'),
      time_out:                   bqStr(cm, row, 'Time Out'),
      duration_min:               bqNum(cm, row, 'Duration (min)'),
      location:                   bqStr(cm, row, 'Location'),
      therapist_name:             bqStr(cm, row, 'Therapist'),
      therapist_email:            bqStr(cm, row, 'therapistEmail'),
      client_name:                bqStr(cm, row, 'clientName') || client.name,
      client_id:                  bqStr(cm, row, 'clientId')   || client.id,
      app_start_time:             bqStr(cm, row, 'App Start Time'),
      actual_start_time:          bqStr(cm, row, 'Actual Start Time'),
      late_start_reason:          bqStr(cm, row, 'Late Start Reason'),
      adjusted_end_time:          bqStr(cm, row, 'Adjusted End Time'),
      end_time_adjustment_reason: bqStr(cm, row, 'End Time Adjustment Reason'),
      notes:                      bqStr(cm, row, 'Notes'),
      is_draft:                   bqBool(cm, row, 'isDraft'),
      manual_entry:               bqBool(cm, row, 'manualEntry'),
      entered_by:                 bqStr(cm, row, 'enteredBy'),
      payload_hash:               bqStr(cm, row, 'payloadHash'),
      submitted_at:               bqStr(cm, row, 'submittedAt')
    });
  }
  return result;
}

/**
 * Read Behavior Data tab → behavior_records table rows.
 * NORMALIZES: one sheet row → one row per behavior (+ 2 tantrum rows).
 */
function bqReadBehaviorRows(clientSS, client) {
  var sheet = clientSS.getSheetByName('Behavior Data');
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  var headers = bqBuildHeaders(data[0]);
  var cm      = bqBuildColMap(data[0]);

  // Build a fast lookup for analytics columns
  var analyticsMap = {};
  for (var ai = 0; ai < BQ_BEHAV_ANALYTICS.length; ai++) {
    analyticsMap[BQ_BEHAV_ANALYTICS[ai]] = true;
  }

  // Identify behavior columns: between Setting and Tantrum Frequency
  var settingIdx  = cm['Setting']           !== undefined ? cm['Setting']           : -1;
  var tantrumIdx  = cm['Tantrum Frequency'] !== undefined ? cm['Tantrum Frequency'] : -1;

  var behaviorCols = [];
  for (var hi = 0; hi < headers.length; hi++) {
    var h = headers[hi];
    if (h === 'Date' || h === 'Therapist' || h === 'Setting') continue;
    if (h === 'Tantrum Frequency' || h === 'Tantrum Total (Min)') continue;
    if (analyticsMap[h]) continue;
    if (settingIdx >= 0 && hi <= settingIdx) continue;
    if (tantrumIdx >= 0 && hi >= tantrumIdx) continue;
    behaviorCols.push({ colIdx: hi, key: bqLabelToKey(h), label: h });
  }

  var result = [];

  for (var ri = 1; ri < data.length; ri++) {
    var row = data[ri];
    if (!row[0]) continue;

    var submissionId   = bqStr(cm, row, 'submissionId');
    var dateISO        = bqStr(cm, row, 'dateISO');
    var dateDisplay    = bqDateCell(cm, row, 'Date');
    var clientNameVal  = bqStr(cm, row, 'clientName') || client.name;
    var clientIdVal    = bqStr(cm, row, 'clientId')   || client.id;
    var therapistName  = bqStr(cm, row, 'Therapist');
    var therapistEmail = bqStr(cm, row, 'therapistEmail');
    var location       = bqStr(cm, row, 'Setting');
    var sessionType    = bqStr(cm, row, 'sessionType');
    var billingCode    = bqStr(cm, row, 'billingCode');
    var isDraft        = bqBool(cm, row, 'isDraft');
    var submittedAt    = bqStr(cm, row, 'submittedAt');

    // One row per behavior
    for (var bci = 0; bci < behaviorCols.length; bci++) {
      var bc    = behaviorCols[bci];
      var count = bc.colIdx < row.length ? (parseInt(row[bc.colIdx]) || 0) : 0;
      result.push({
        submission_id:  submissionId,
        date_iso:       dateISO,
        date_display:   dateDisplay,
        client_name:    clientNameVal,
        client_id:      clientIdVal,
        therapist_name: therapistName,
        therapist_email: therapistEmail,
        location:       location,
        session_type:   sessionType,
        billing_code:   billingCode,
        behavior_key:   bc.key,
        behavior_label: bc.label,
        count:          count,
        is_draft:       isDraft,
        submitted_at:   submittedAt
      });
    }

    // Tantrum frequency row
    var tanFreq = tantrumIdx >= 0 && tantrumIdx < row.length ? (parseInt(row[tantrumIdx]) || 0) : 0;
    result.push({
      submission_id:  submissionId, date_iso: dateISO, date_display: dateDisplay,
      client_name:    clientNameVal, client_id: clientIdVal,
      therapist_name: therapistName, therapist_email: therapistEmail,
      location:       location, session_type: sessionType, billing_code: billingCode,
      behavior_key:   'tantrumFrequency', behavior_label: 'Tantrum Frequency',
      count:          tanFreq, is_draft: isDraft, submitted_at: submittedAt
    });

    // Tantrum total minutes row
    var tanMinIdx = cm['Tantrum Total (Min)'];
    var tanMin    = (tanMinIdx !== undefined && tanMinIdx < row.length) ? (parseInt(row[tanMinIdx]) || 0) : 0;
    result.push({
      submission_id:  submissionId, date_iso: dateISO, date_display: dateDisplay,
      client_name:    clientNameVal, client_id: clientIdVal,
      therapist_name: therapistName, therapist_email: therapistEmail,
      location:       location, session_type: sessionType, billing_code: billingCode,
      behavior_key:   'tantrumTotalMin', behavior_label: 'Tantrum Total (Min)',
      count:          tanMin, is_draft: isDraft, submitted_at: submittedAt
    });
  }
  return result;
}

/**
 * Read Trial Data tab → trial_records rows.
 * NORMALIZES: one sheet row → one row per goal group found in the header.
 */
function bqReadTrialRows(clientSS, client, goalDescMap) {
  var sheet = clientSS.getSheetByName('Trial Data');
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  var headers = bqBuildHeaders(data[0]);
  var cm      = bqBuildColMap(data[0]);

  // Build analytics map for trial tab
  var trialAnalyticsMap = {};
  for (var tai = 0; tai < BQ_TRIAL_ANALYTICS.length; tai++) {
    trialAnalyticsMap[BQ_TRIAL_ANALYTICS[tai]] = true;
  }

  // Parse goal groups from header row.
  // Structure: Date | Setting | Therapist | [GoalCode, Trial 1..N, %]... | analytics...
  var goalGroups = [];
  var hi2 = 3; // skip Date, Setting, Therapist
  while (hi2 < headers.length) {
    var hdr = headers[hi2];
    if (trialAnalyticsMap[hdr]) break; // entered analytics section
    if (hdr === '%' || /^Trial \d+$/i.test(hdr)) { hi2++; continue; } // orphan column
    // This column is a goal code
    var goalCode     = hdr;
    var trialColIdxs = [];
    var pctColIdx    = -1;
    var j            = hi2 + 1;
    while (j < headers.length) {
      var h2 = headers[j];
      if (trialAnalyticsMap[h2]) break;
      if (/^Trial \d+$/i.test(h2)) {
        trialColIdxs.push(j);
        j++;
      } else if (h2 === '%') {
        pctColIdx = j;
        j++;
        break;
      } else {
        break; // next goal code starts here
      }
    }
    goalGroups.push({ code: goalCode, trialCols: trialColIdxs, pctCol: pctColIdx });
    hi2 = j;
  }

  if (!goalGroups.length) return [];

  var result = [];

  for (var ri = 1; ri < data.length; ri++) {
    var row = data[ri];
    if (!row[0]) continue;

    // Parse Percent Correct JSON column for numeric percentages
    var pctMap = {};
    var pctJSONIdx = cm['Percent Correct'];
    if (pctJSONIdx !== undefined && pctJSONIdx < row.length) {
      var pctJSONStr = String(row[pctJSONIdx] || '');
      if (pctJSONStr) {
        try { pctMap = JSON.parse(pctJSONStr); } catch (e) {}
      }
    }

    var submissionId   = bqStr(cm, row, 'submissionId');
    var dateISO        = bqStr(cm, row, 'dateISO');
    var dateDisplay    = bqDateCell(cm, row, 'Date');
    var clientNameVal  = bqStr(cm, row, 'clientName') || client.name;
    var clientIdVal    = bqStr(cm, row, 'clientId')   || client.id;
    var therapistName  = bqStr(cm, row, 'Therapist');
    var therapistEmail = bqStr(cm, row, 'therapistEmail');
    var location       = bqStr(cm, row, 'Setting');
    var sessionType    = bqStr(cm, row, 'sessionType');
    var billingCode    = bqStr(cm, row, 'billingCode');
    var isDraft        = bqBool(cm, row, 'isDraft');
    var submittedAt    = bqStr(cm, row, 'submittedAt');

    for (var gg = 0; gg < goalGroups.length; gg++) {
      var g = goalGroups[gg];
      var trialVals = [];
      for (var tv = 0; tv < g.trialCols.length; tv++) {
        var tIdx = g.trialCols[tv];
        trialVals.push(tIdx < row.length ? String(row[tIdx] !== null && row[tIdx] !== undefined ? row[tIdx] : '') : '');
      }

      var pctDisplay = (g.pctCol >= 0 && g.pctCol < row.length) ? String(row[g.pctCol] || '') : '';
      var pctNumeric = null;
      if (pctMap[g.code] !== undefined && pctMap[g.code] !== null) {
        pctNumeric = parseFloat(pctMap[g.code]);
        if (isNaN(pctNumeric)) pctNumeric = null;
      } else if (pctDisplay) {
        var parsed = parseFloat(String(pctDisplay).replace('%', ''));
        if (!isNaN(parsed)) pctNumeric = parsed;
      }

      var totalTrials   = 0;
      var correctTrials = 0;
      for (var tv2 = 0; tv2 < trialVals.length; tv2++) {
        var v = trialVals[tv2];
        if (v !== '') totalTrials++;
        if (v === 'true' || v === '1' || v === '\u2713') correctTrials++;
      }

      result.push({
        submission_id:      submissionId,
        date_iso:           dateISO,
        date_display:       dateDisplay,
        client_name:        clientNameVal,
        client_id:          clientIdVal,
        therapist_name:     therapistName,
        therapist_email:    therapistEmail,
        location:           location,
        session_type:       sessionType,
        billing_code:       billingCode,
        goal_code:          g.code,
        goal_description:   goalDescMap[g.code] || '',
        trial_1:            trialVals[0] || '',
        trial_2:            trialVals[1] || '',
        trial_3:            trialVals[2] || '',
        trial_4:            trialVals[3] || '',
        trial_5:            trialVals[4] || '',
        trial_6:            trialVals[5] || '',
        trial_7:            trialVals[6] || '',
        trial_8:            trialVals[7] || '',
        trial_9:            trialVals[8] || '',
        trial_10:           trialVals[9] || '',
        percentage_display: pctDisplay,
        percentage_numeric: pctNumeric,
        total_trials:       totalTrials,
        correct_trials:     correctTrials,
        is_draft:           isDraft,
        submitted_at:       submittedAt
      });
    }
  }
  return result;
}

/**
 * Read ABC Data tab → abc_incidents rows.
 */
function bqReadABCRows(clientSS, client) {
  var sheet = clientSS.getSheetByName('ABC Data');
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  var cm     = bqBuildColMap(data[0]);
  var result = [];

  for (var ri = 1; ri < data.length; ri++) {
    var row = data[ri];
    if (!row[0]) continue;
    result.push({
      submission_id:          bqStr(cm, row, 'submissionId'),
      date_iso:               bqStr(cm, row, 'dateISO'),
      date_display:           bqDateCell(cm, row, 'Date'),
      client_name:            bqStr(cm, row, 'clientName')     || client.name,
      client_id:              bqStr(cm, row, 'clientId')       || client.id,
      therapist_name:         bqStr(cm, row, 'therapistName'),
      therapist_email:        bqStr(cm, row, 'therapistEmail'),
      therapist_initials:     bqStr(cm, row, 'Initials'),
      setting:                bqStr(cm, row, 'Setting'),
      antecedent:             bqStr(cm, row, 'Antecedent'),
      behavior:               bqStr(cm, row, 'Behavior'),
      consequence:            bqStr(cm, row, 'Consequence'),
      hypothesized_function:  bqStr(cm, row, 'Hypothesized Function'),
      incident_time:          bqStr(cm, row, 'Time'),
      session_type:           bqStr(cm, row, 'sessionType'),
      billing_code:           bqStr(cm, row, 'billingCode'),
      is_draft:               bqBool(cm, row, 'isDraft'),
      submitted_at:           bqStr(cm, row, 'submittedAt')
    });
  }
  return result;
}

/**
 * Read Mastery Log tab → mastery_log rows.
 */
function bqReadMasteryRows(clientSS, client) {
  var sheet = clientSS.getSheetByName('Mastery Log');
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  var cm     = bqBuildColMap(data[0]);
  var result = [];

  for (var ri = 1; ri < data.length; ri++) {
    var row = data[ri];
    if (!row[0]) continue;
    result.push({
      type:            bqStr(cm, row, 'type'),
      code:            bqStr(cm, row, 'code'),
      description:     bqStr(cm, row, 'description'),
      mastery_date:    bqStr(cm, row, 'masteryDate'),
      date_iso:        bqStr(cm, row, 'dateISO') || bqStr(cm, row, 'masteryDate'),
      last_scores:     bqStr(cm, row, 'lastScores'),
      therapist_name:  bqStr(cm, row, 'therapistName'),
      therapist_email: bqStr(cm, row, 'therapistEmail'),
      client_name:     bqStr(cm, row, 'clientName') || client.name,
      client_id:       bqStr(cm, row, 'clientId')   || client.id
    });
  }
  return result;
}


// ── BIGQUERY TABLE MANAGEMENT ──────────────────────────────────────────

/**
 * Ensure the BQ dataset exists; create it if not.
 */
function bqEnsureDataset() {
  // Try to GET the dataset first. If it succeeds, the dataset already exists — done.
  // Only attempt INSERT if the GET returns a 404 (dataset genuinely not found).
  // This works even without datasets.insert permission, as long as the dataset exists.
  var exists = false;
  try {
    BigQuery.Datasets.get(BQ_PROJECT, BQ_DATASET);
    exists = true;
  } catch (getErr) {
    // Check if it's a 404 (not found). Apps Script wraps HTTP errors in the message.
    var msg = String(getErr.message || '').toLowerCase();
    if (msg.indexOf('404') >= 0 || msg.indexOf('not found') >= 0) {
      // Dataset truly does not exist — try to create it
      try {
        BigQuery.Datasets.insert(
          { datasetReference: { projectId: BQ_PROJECT, datasetId: BQ_DATASET } },
          BQ_PROJECT
        );
        Utilities.sleep(2000); // wait for creation to propagate
      } catch (insertErr) {
        throw new Error('Dataset not found and creation failed: ' + insertErr.message);
      }
    } else {
      // GET failed for a reason other than 404 (e.g. permission denied on GET itself)
      throw new Error('Could not verify dataset existence: ' + getErr.message);
    }
  }
}

/**
 * Sync rows to a BigQuery table using a NEWLINE_DELIMITED_JSON load job (WRITE_TRUNCATE).
 * JSON format avoids all CSV escaping issues with free-text fields (notes, reasons, etc.).
 * Works on the BigQuery free tier — does NOT use streaming insertAll.
 * Creates the table if it does not exist; replaces all data if it does.
 */
function bqSyncTable(tableId, rows) {
  var schema = bqCreateTableSchema(tableId);

  // Build newline-delimited JSON blob
  var ndjBlob = bqRowsToNDJSONBlob(rows);

  // Submit load job — WRITE_TRUNCATE handles both create-if-not-exists and replace
  var job = {
    configuration: {
      load: {
        destinationTable: { projectId: BQ_PROJECT, datasetId: BQ_DATASET, tableId: tableId },
        sourceFormat:     'NEWLINE_DELIMITED_JSON',
        writeDisposition: 'WRITE_TRUNCATE',
        schema:           schema,
        autodetect:       false
      }
    }
  };

  var jobResult = BigQuery.Jobs.insert(job, BQ_PROJECT, ndjBlob);
  bqWaitForJob(jobResult.jobReference.jobId);
}

/**
 * Convert an array of row objects to a newline-delimited JSON Blob.
 * Each row is JSON.stringify()'d on its own line — no CSV escaping needed,
 * so free-text fields with commas, quotes, or newlines are handled correctly.
 * Null/undefined values are omitted from each JSON object (BQ treats missing
 * fields as NULL for NULLABLE columns).
 */
function bqRowsToNDJSONBlob(rows) {
  var lines = [];
  for (var i = 0; i < rows.length; i++) {
    // Build a clean object: skip null/undefined so BQ sees them as NULL
    var obj = {};
    var row = rows[i];
    for (var key in row) {
      if (row.hasOwnProperty(key)) {
        var v = row[key];
        if (v !== null && v !== undefined) {
          obj[key] = v;
        }
      }
    }
    lines.push(JSON.stringify(obj));
  }
  return Utilities.newBlob(lines.join('\n'), 'application/octet-stream');
}

/**
 * Poll a BigQuery job until it reaches DONE state (or times out).
 * Throws if the job reports an error or does not complete within ~3 minutes.
 */
function bqWaitForJob(jobId) {
  var maxAttempts = 60; // 60 × 3 s = 3-minute ceiling
  for (var attempt = 0; attempt < maxAttempts; attempt++) {
    Utilities.sleep(3000);
    var job = BigQuery.Jobs.get(BQ_PROJECT, jobId);
    if (job.status.state === 'DONE') {
      if (job.status.errorResult) {
        throw new Error('BQ load job failed (' + jobId + '): ' + job.status.errorResult.message);
      }
      return; // success
    }
  }
  throw new Error('BQ load job timed out after ' + maxAttempts + ' polls: ' + jobId);
}


// ── SCHEMA DEFINITIONS ────────────────────────────────────────────────

function bqCreateTableSchema(tableId) {
  if (tableId === 'sessions') {
    return { fields: [
      { name: 'submission_id',              type: 'STRING',  mode: 'NULLABLE' },
      { name: 'date_iso',                   type: 'STRING',  mode: 'NULLABLE' },
      { name: 'date_display',               type: 'STRING',  mode: 'NULLABLE' },
      { name: 'billing_code',               type: 'STRING',  mode: 'NULLABLE' },
      { name: 'session_type',               type: 'STRING',  mode: 'NULLABLE' },
      { name: 'time_in',                    type: 'STRING',  mode: 'NULLABLE' },
      { name: 'time_out',                   type: 'STRING',  mode: 'NULLABLE' },
      { name: 'duration_min',               type: 'FLOAT',   mode: 'NULLABLE' },
      { name: 'location',                   type: 'STRING',  mode: 'NULLABLE' },
      { name: 'therapist_name',             type: 'STRING',  mode: 'NULLABLE' },
      { name: 'therapist_email',            type: 'STRING',  mode: 'NULLABLE' },
      { name: 'client_name',                type: 'STRING',  mode: 'NULLABLE' },
      { name: 'client_id',                  type: 'STRING',  mode: 'NULLABLE' },
      { name: 'app_start_time',             type: 'STRING',  mode: 'NULLABLE' },
      { name: 'actual_start_time',          type: 'STRING',  mode: 'NULLABLE' },
      { name: 'late_start_reason',          type: 'STRING',  mode: 'NULLABLE' },
      { name: 'adjusted_end_time',          type: 'STRING',  mode: 'NULLABLE' },
      { name: 'end_time_adjustment_reason', type: 'STRING',  mode: 'NULLABLE' },
      { name: 'notes',                      type: 'STRING',  mode: 'NULLABLE' },
      { name: 'is_draft',                   type: 'BOOLEAN', mode: 'NULLABLE' },
      { name: 'manual_entry',               type: 'BOOLEAN', mode: 'NULLABLE' },
      { name: 'entered_by',                 type: 'STRING',  mode: 'NULLABLE' },
      { name: 'payload_hash',               type: 'STRING',  mode: 'NULLABLE' },
      { name: 'submitted_at',               type: 'STRING',  mode: 'NULLABLE' }
    ]};
  }

  if (tableId === 'behavior_records') {
    return { fields: [
      { name: 'submission_id',  type: 'STRING',  mode: 'NULLABLE' },
      { name: 'date_iso',       type: 'STRING',  mode: 'NULLABLE' },
      { name: 'date_display',   type: 'STRING',  mode: 'NULLABLE' },
      { name: 'client_name',    type: 'STRING',  mode: 'NULLABLE' },
      { name: 'client_id',      type: 'STRING',  mode: 'NULLABLE' },
      { name: 'therapist_name', type: 'STRING',  mode: 'NULLABLE' },
      { name: 'therapist_email', type: 'STRING', mode: 'NULLABLE' },
      { name: 'location',       type: 'STRING',  mode: 'NULLABLE' },
      { name: 'session_type',   type: 'STRING',  mode: 'NULLABLE' },
      { name: 'billing_code',   type: 'STRING',  mode: 'NULLABLE' },
      { name: 'behavior_key',   type: 'STRING',  mode: 'NULLABLE' },
      { name: 'behavior_label', type: 'STRING',  mode: 'NULLABLE' },
      { name: 'count',          type: 'INTEGER', mode: 'NULLABLE' },
      { name: 'is_draft',       type: 'BOOLEAN', mode: 'NULLABLE' },
      { name: 'submitted_at',   type: 'STRING',  mode: 'NULLABLE' }
    ]};
  }

  if (tableId === 'trial_records') {
    return { fields: [
      { name: 'submission_id',      type: 'STRING',  mode: 'NULLABLE' },
      { name: 'date_iso',           type: 'STRING',  mode: 'NULLABLE' },
      { name: 'date_display',       type: 'STRING',  mode: 'NULLABLE' },
      { name: 'client_name',        type: 'STRING',  mode: 'NULLABLE' },
      { name: 'client_id',          type: 'STRING',  mode: 'NULLABLE' },
      { name: 'therapist_name',     type: 'STRING',  mode: 'NULLABLE' },
      { name: 'therapist_email',    type: 'STRING',  mode: 'NULLABLE' },
      { name: 'location',           type: 'STRING',  mode: 'NULLABLE' },
      { name: 'session_type',       type: 'STRING',  mode: 'NULLABLE' },
      { name: 'billing_code',       type: 'STRING',  mode: 'NULLABLE' },
      { name: 'goal_code',          type: 'STRING',  mode: 'NULLABLE' },
      { name: 'goal_description',   type: 'STRING',  mode: 'NULLABLE' },
      { name: 'trial_1',            type: 'STRING',  mode: 'NULLABLE' },
      { name: 'trial_2',            type: 'STRING',  mode: 'NULLABLE' },
      { name: 'trial_3',            type: 'STRING',  mode: 'NULLABLE' },
      { name: 'trial_4',            type: 'STRING',  mode: 'NULLABLE' },
      { name: 'trial_5',            type: 'STRING',  mode: 'NULLABLE' },
      { name: 'trial_6',            type: 'STRING',  mode: 'NULLABLE' },
      { name: 'trial_7',            type: 'STRING',  mode: 'NULLABLE' },
      { name: 'trial_8',            type: 'STRING',  mode: 'NULLABLE' },
      { name: 'trial_9',            type: 'STRING',  mode: 'NULLABLE' },
      { name: 'trial_10',           type: 'STRING',  mode: 'NULLABLE' },
      { name: 'percentage_display', type: 'STRING',  mode: 'NULLABLE' },
      { name: 'percentage_numeric', type: 'FLOAT',   mode: 'NULLABLE' },
      { name: 'total_trials',       type: 'INTEGER', mode: 'NULLABLE' },
      { name: 'correct_trials',     type: 'INTEGER', mode: 'NULLABLE' },
      { name: 'is_draft',           type: 'BOOLEAN', mode: 'NULLABLE' },
      { name: 'submitted_at',       type: 'STRING',  mode: 'NULLABLE' }
    ]};
  }

  if (tableId === 'abc_incidents') {
    return { fields: [
      { name: 'submission_id',         type: 'STRING',  mode: 'NULLABLE' },
      { name: 'date_iso',              type: 'STRING',  mode: 'NULLABLE' },
      { name: 'date_display',          type: 'STRING',  mode: 'NULLABLE' },
      { name: 'client_name',           type: 'STRING',  mode: 'NULLABLE' },
      { name: 'client_id',             type: 'STRING',  mode: 'NULLABLE' },
      { name: 'therapist_name',        type: 'STRING',  mode: 'NULLABLE' },
      { name: 'therapist_email',       type: 'STRING',  mode: 'NULLABLE' },
      { name: 'therapist_initials',    type: 'STRING',  mode: 'NULLABLE' },
      { name: 'setting',               type: 'STRING',  mode: 'NULLABLE' },
      { name: 'antecedent',            type: 'STRING',  mode: 'NULLABLE' },
      { name: 'behavior',              type: 'STRING',  mode: 'NULLABLE' },
      { name: 'consequence',           type: 'STRING',  mode: 'NULLABLE' },
      { name: 'hypothesized_function', type: 'STRING',  mode: 'NULLABLE' },
      { name: 'incident_time',         type: 'STRING',  mode: 'NULLABLE' },
      { name: 'session_type',          type: 'STRING',  mode: 'NULLABLE' },
      { name: 'billing_code',          type: 'STRING',  mode: 'NULLABLE' },
      { name: 'is_draft',              type: 'BOOLEAN', mode: 'NULLABLE' },
      { name: 'submitted_at',          type: 'STRING',  mode: 'NULLABLE' }
    ]};
  }

  if (tableId === 'mastery_log') {
    return { fields: [
      { name: 'type',            type: 'STRING', mode: 'NULLABLE' },
      { name: 'code',            type: 'STRING', mode: 'NULLABLE' },
      { name: 'description',     type: 'STRING', mode: 'NULLABLE' },
      { name: 'mastery_date',    type: 'STRING', mode: 'NULLABLE' },
      { name: 'date_iso',        type: 'STRING', mode: 'NULLABLE' },
      { name: 'last_scores',     type: 'STRING', mode: 'NULLABLE' },
      { name: 'therapist_name',  type: 'STRING', mode: 'NULLABLE' },
      { name: 'therapist_email', type: 'STRING', mode: 'NULLABLE' },
      { name: 'client_name',     type: 'STRING', mode: 'NULLABLE' },
      { name: 'client_id',       type: 'STRING', mode: 'NULLABLE' }
    ]};
  }

  if (tableId === 'therapists') {
    return { fields: [
      { name: 'id',                type: 'STRING', mode: 'NULLABLE' },
      { name: 'name',              type: 'STRING', mode: 'NULLABLE' },
      { name: 'initials',          type: 'STRING', mode: 'NULLABLE' },
      { name: 'profile',           type: 'STRING', mode: 'NULLABLE' },
      { name: 'email',             type: 'STRING', mode: 'NULLABLE' },
      { name: 'role',              type: 'STRING', mode: 'NULLABLE' },
      { name: 'weekly_hour_limit', type: 'FLOAT',  mode: 'NULLABLE' },
      { name: 'pay_rate',          type: 'FLOAT',  mode: 'NULLABLE' },
      { name: 'status',            type: 'STRING', mode: 'NULLABLE' },
      { name: 'client_ids',        type: 'STRING', mode: 'NULLABLE' }
    ]};
  }

  if (tableId === 'clients') {
    return { fields: [
      { name: 'id',       type: 'STRING', mode: 'NULLABLE' },
      { name: 'name',     type: 'STRING', mode: 'NULLABLE' },
      { name: 'initials', type: 'STRING', mode: 'NULLABLE' },
      { name: 'sheet_id', type: 'STRING', mode: 'NULLABLE' },
      { name: 'status',   type: 'STRING', mode: 'NULLABLE' }
    ]};
  }

  if (tableId === 'authorizations') {
    return { fields: [
      { name: 'client_id',            type: 'STRING', mode: 'NULLABLE' },
      { name: 'payer_type',           type: 'STRING', mode: 'NULLABLE' },
      { name: 'insurance_company',    type: 'STRING', mode: 'NULLABLE' },
      { name: 'authorization_number', type: 'STRING', mode: 'NULLABLE' },
      { name: 'billing_code',         type: 'STRING', mode: 'NULLABLE' },
      { name: 'authorized_hours',     type: 'FLOAT',  mode: 'NULLABLE' },
      { name: 'unit_rate',            type: 'FLOAT',  mode: 'NULLABLE' },
      { name: 'hourly_rate',          type: 'FLOAT',  mode: 'NULLABLE' },
      { name: 'start_date',           type: 'STRING', mode: 'NULLABLE' },
      { name: 'end_date',             type: 'STRING', mode: 'NULLABLE' },
      { name: 'co_insurance',         type: 'STRING', mode: 'NULLABLE' },
      { name: 'step_up_program',      type: 'STRING', mode: 'NULLABLE' },
      { name: 'status',               type: 'STRING', mode: 'NULLABLE' }
    ]};
  }

  if (tableId === 'goals_reference') {
    return { fields: [
      { name: 'code',        type: 'STRING',  mode: 'NULLABLE' },
      { name: 'description', type: 'STRING',  mode: 'NULLABLE' },
      { name: 'client_ids',  type: 'STRING',  mode: 'NULLABLE' },
      { name: 'num_trials',  type: 'INTEGER', mode: 'NULLABLE' },
      { name: 'status',      type: 'STRING',  mode: 'NULLABLE' }
    ]};
  }

  if (tableId === 'behaviors_reference') {
    return { fields: [
      { name: 'key',        type: 'STRING', mode: 'NULLABLE' },
      { name: 'label',      type: 'STRING', mode: 'NULLABLE' },
      { name: 'client_ids', type: 'STRING', mode: 'NULLABLE' },
      { name: 'status',     type: 'STRING', mode: 'NULLABLE' }
    ]};
  }

  if (tableId === 'billing_codes') {
    return { fields: [
      { name: 'profile',      type: 'STRING', mode: 'NULLABLE' },
      { name: 'session_type', type: 'STRING', mode: 'NULLABLE' },
      { name: 'code',         type: 'STRING', mode: 'NULLABLE' }
    ]};
  }

  // Fallback: auto-detect (empty schema — BQ will infer)
  return { fields: [] };
}


// ── LOW-LEVEL HELPERS ─────────────────────────────────────────────────

/** Read a sheet into an array of objects (header row = keys). Skips blank rows. */
function bqSheetToObjects(ss, tabName) {
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
      var v = row[ci];
      if (v instanceof Date) {
        obj[headers[ci]] = Utilities.formatDate(v, 'UTC', 'yyyy-MM-dd');
      } else {
        obj[headers[ci]] = (v !== null && v !== undefined) ? String(v) : '';
      }
    }
    result.push(obj);
  }
  return result;
}

/** Build a header string array from a raw row. */
function bqBuildHeaders(headerRow) {
  var headers = [];
  for (var i = 0; i < headerRow.length; i++) {
    headers.push(String(headerRow[i]).trim());
  }
  return headers;
}

/** Build a column-name → index map from a raw header row. */
function bqBuildColMap(headerRow) {
  var cm = {};
  for (var i = 0; i < headerRow.length; i++) {
    var key = String(headerRow[i]).trim();
    if (key) cm[key] = i;
  }
  return cm;
}

/** Read a string value from a row via column map. Handles Date objects. */
function bqStr(cm, row, colName) {
  var idx = cm[colName];
  if (idx === undefined || idx === null) return '';
  var v = (idx < row.length) ? row[idx] : null;
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    return Utilities.formatDate(v, 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");
  }
  return String(v).trim();
}

/** Read a date cell — returns YYYY-MM-DD if Date object, else string as-is. */
function bqDateCell(cm, row, colName) {
  var idx = cm[colName];
  if (idx === undefined || idx === null) return '';
  var v = (idx < row.length) ? row[idx] : null;
  if (!v && v !== 0) return '';
  if (v instanceof Date) {
    return Utilities.formatDate(v, 'UTC', 'yyyy-MM-dd');
  }
  return String(v).trim();
}

/** Read a numeric (FLOAT) value. Returns null if missing or NaN. */
function bqNum(cm, row, colName) {
  var idx = cm[colName];
  if (idx === undefined || idx === null) return null;
  var v = (idx < row.length) ? row[idx] : null;
  var n = parseFloat(v);
  return isNaN(n) ? null : n;
}

/** Read a boolean value. */
function bqBool(cm, row, colName) {
  var idx = cm[colName];
  if (idx === undefined || idx === null) return false;
  var v = (idx < row.length) ? row[idx] : null;
  if (v === true || v === 1 || String(v).toLowerCase() === 'true') return true;
  return false;
}

/** Parse a float, returning null if empty or unparseable. */
function bqParseFloat(val) {
  if (val === '' || val === null || val === undefined) return null;
  var n = parseFloat(val);
  return isNaN(n) ? null : n;
}

/**
 * Convert a behavior label to a camelCase key.
 * "Ingesting Inedibles" -> "ingestingInedibles"
 * "Out of Area"         -> "outOfArea"
 */
function bqLabelToKey(label) {
  var parts  = String(label).toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/);
  var result = parts[0] || '';
  for (var i = 1; i < parts.length; i++) {
    if (parts[i]) {
      result += parts[i].charAt(0).toUpperCase() + parts[i].slice(1);
    }
  }
  return result;
}


// ── AUDIT LOG ─────────────────────────────────────────────────────────

/** Write a sync event to the RT Audit Log sheet (fire-and-forget). */
function bqAuditLog(action, details) {
  try {
    var ss    = SpreadsheetApp.openById(BQ_AUDIT_SHEET);
    var sheet = ss.getSheetByName('Audit Log');
    if (!sheet) {
      sheet = ss.insertSheet('Audit Log');
      sheet.appendRow(['Timestamp', 'User', 'Action', 'Client', 'Details']);
    }
    sheet.appendRow([new Date().toISOString(), 'BigQuerySync', action, '', details]);
  } catch (e) {
    Logger.log('bqAuditLog error: ' + e.message);
  }
  Logger.log('[BQ SYNC] ' + action + ': ' + details);
}


// ── TRIGGER MANAGEMENT ────────────────────────────────────────────────

/**
 * Install an hourly time-based trigger for syncAllToBigQuery.
 * Run this once from the Apps Script editor to set up automation.
 * Removes any existing trigger with the same handler first.
 */
function setupHourlySync() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'syncAllToBigQuery') {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }
  ScriptApp.newTrigger('syncAllToBigQuery')
    .timeBased()
    .everyHours(1)
    .create();
  Logger.log('Hourly BigQuery sync trigger installed.');
}

/**
 * Remove the hourly trigger.
 */
function removeSync() {
  var existing = ScriptApp.getProjectTriggers();
  var removed  = 0;
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'syncAllToBigQuery') {
      ScriptApp.deleteTrigger(existing[i]);
      removed++;
    }
  }
  Logger.log('Removed ' + removed + ' BigQuery sync trigger(s).');
}

/**
 * Run a manual sync immediately (useful for testing from the editor).
 */
function manualSync() {
  Logger.log('Starting manual BigQuery sync...');
  syncAllToBigQuery();
  Logger.log('Manual sync complete.');
}
