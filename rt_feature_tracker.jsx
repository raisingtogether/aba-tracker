import { useState } from "react";

const PHASES = [
  {
    id: "phase1",
    name: "Phase 1 — ABA Tracker Hardening",
    subtitle: "Reliability, APIs, and operational readiness",
    timeline: "Now → June 2026",
    color: "#00A7C7",
    features: [
      // Completed
      { id: "f1",  name: "Firebase Hosting + HIPAA", status: "done", priority: "P0", category: "Infrastructure" },
      { id: "f2",  name: "Google Workspace migration (all RBTs)", status: "done", priority: "P0", category: "Infrastructure" },
      { id: "f3",  name: "BigQuery sync (11 tables, hourly)", status: "done", priority: "P0", category: "Data" },
      { id: "f4",  name: "Looker Studio reports (8 queries)", status: "done", priority: "P1", category: "Data" },
      { id: "f5",  name: "Session timer visible", status: "done", priority: "P1", category: "UX" },
      { id: "f6",  name: "Session notes guided template", status: "done", priority: "P1", category: "UX" },
      { id: "f7",  name: "End session time adjustment", status: "done", priority: "P1", category: "UX" },
      { id: "f8",  name: "Logout button", status: "done", priority: "P2", category: "UX" },
      { id: "f9",  name: "Goal mastery detection (80% × 5)", status: "done", priority: "P1", category: "Clinical" },
      { id: "f10", name: "Behavior mastery system — BCBA review workflow (≤1 × 10, 3 states)", status: "done", priority: "P1", category: "Clinical", description: "Rewritten May 2026: 10 consecutive sessions (was 8). recommended (2+ settings) vs pendingGeneralization (1 setting) vs confirmed. BCBA Approve/Dismiss from mastery report. Recovery after dismiss. Dedup keeps most-recent entry." },
      { id: "f11", name: "Monthly mastery report (admin, CSV, Approve/Dismiss)", status: "done", priority: "P1", category: "Clinical" },
      { id: "f12", name: "Authorization multi-code cards", status: "done", priority: "P1", category: "Billing" },
      { id: "f13", name: "Weekly billing report", status: "done", priority: "P1", category: "Billing" },
      { id: "f14", name: "Admin manual session entry", status: "done", priority: "P2", category: "Admin" },
      { id: "f15", name: "Goal duplicate validation + delete", status: "done", priority: "P2", category: "Admin" },
      { id: "f16", name: "Client filter in Goals admin", status: "done", priority: "P2", category: "Admin" },
      { id: "f17", name: "EventBus (7 events)", status: "done", priority: "P1", category: "Infrastructure" },
      { id: "f18", name: "PWA standalone Sign-In fix", status: "done", priority: "P1", category: "UX" },
      { id: "f19", name: "Auto-logout extended to 60 min", status: "done", priority: "P2", category: "UX" },
      { id: "f20", name: "Mastery duplicate cleanup", status: "done", priority: "P2", category: "Data" },
      { id: "f21", name: "Beforeunload warning", status: "done", priority: "P2", category: "UX" },
      { id: "f22", name: "Re-auth fix for Workspace users", status: "done", priority: "P0", category: "UX" },
      { id: "f23", name: "Payroll CSV export fix", status: "done", priority: "P1", category: "Billing" },
      { id: "f24", name: "Duration uses adjusted times", status: "done", priority: "P1", category: "Billing" },
      { id: "f43", name: "Trial Data column placement fix + LockService", status: "done", priority: "P0", category: "Data", description: "writeTrialData rewrote: new _ensureTrialGoalColumns inserts goal groups (GoalCode + Trial 1..N + %) immediately BEFORE the analytics block (submissionId column) via insertColumnsBefore, never appending after. LockService.getScriptLock(30s) wraps the full column-check + insert + write sequence to prevent concurrent session submits from creating duplicate columns. Percent Correct JSON now stores whole-number percentages (multiplies 0-1 decimals by 100). Safety: colMap undefined → Audit Log error + skip, never writes to index 0. Column count warning at 500+." },
      { id: "f44", name: "Trial Summary tab — live writes per session submit", status: "done", priority: "P1", category: "Data", description: "New _appendTrialSummaryRows: after every session submit, appends one normalized row per goal to the Trial Summary tab (Source='Live'). Creates the tab with the 13-column header if absent; extends pre-Source 12-column schema via ensureSheetColumns. Date formatted MM/DD/YYYY. Always appends — never clears. Errors caught and logged to Audit Log, never block session submission." },
      { id: "f45", name: "recoverTrialData: JSON recovery pass + Live row preservation", status: "done", priority: "P1", category: "Data", description: "Pass 3 added to recoverTrialData: parses 'Percent Correct' JSON column to recover goals missing from sheet columns (e.g. Mand1, SS, SE1 etc that were in unnamed overflow columns). Deduplicates against sheet-recovered records using O(1) sid|GOALCODE lookup. dryRun logs 3 sample records and one dedup example per client. Source column added to Trial Summary (Sheet / JSON / Live). recoverTrialData now harvests existing Live rows before clearing, appends them back at the end — live session data survives historical re-recovery." },
      { id: "f46", name: "Fix saveConfig duplicate goal code check (F15 bug)", status: "pending", priority: "P0", category: "Admin", description: "BLOCKING: Every goal save fails with 'Save failed: Duplicate goal code: F15'. Root cause: duplicate check uses code as sole key — two goals with same code for different clients (or one active + one inactive) both trip the error. Fix: scope check to clientId+code pair, or exclude inactive goals. Diagnostic Logger.log added and deployed (commit f6a9241) to count F15 entries; removed after diagnosis. Fix not yet implemented." },
      // Pending
      { id: "f25", name: "Offline mode (Service Worker + IndexedDB)", status: "pending", priority: "P0", category: "Infrastructure", description: "Session data works without WiFi. Sync on reconnect. Biggest gap vs competitors." },
      { id: "f26", name: "REST API Layer in Code.gs", status: "pending", priority: "P0", category: "Infrastructure", description: "Authenticated endpoints: GET /sessions, GET /behaviors, GET /trials, POST /session, webhook registry. Session tokens for device auth." },
      { id: "f27", name: "Push notifications", status: "pending", priority: "P1", category: "UX", description: "Auth expiry alerts, RBT hour limit warnings, mastery achievements." },
      { id: "f28", name: "Digital signatures", status: "done", priority: "P1", category: "Clinical", description: "Parent/guardian signs on the End screen before submit (signature pad + signer name, or 'unavailable' + reason). Stored in Time In Time Out tab. v4." },
      { id: "f29", name: "Caregiver/parent dashboard", status: "pending", priority: "P1", category: "Clinical", description: "Read-only view for parents to see child's progress. Link shared by Tatiana." },
      { id: "f30", name: "Prompt hierarchy tracking per trial", status: "pending", priority: "P2", category: "Clinical", description: "Record prompt level: independent, verbal, gestural, model, partial physical, full physical. Critical training data for LHBM." },
      { id: "f31", name: "Multi-language (EN/ES)", status: "pending", priority: "P2", category: "UX", description: "South Florida requires bilingual support." },
      { id: "f32", name: "User documentation manual", status: "pending", priority: "P2", category: "Admin", description: "Interactive guide with screenshots. Needs screenshots from Tatiana." },
      { id: "f33", name: "Looker Studio fix (missing clients)", status: "pending", priority: "P1", category: "Data", description: "Some clients not appearing. Likely is_draft boolean vs string issue." },
      // Assessments & Behavioral Plans
      { id: "f34", name: "Assessment module — ABLLS-R", status: "pending", priority: "P0", category: "Clinical", description: "Digitize ABLLS-R assessment within the app. Supports partial completion (save draft, resume later). Visual scoring grid matching the paper ABLLS-R format. Historical assessments viewable for progress comparison." },
      { id: "f35", name: "Assessment module — VB-MAPP", status: "pending", priority: "P1", category: "Clinical", description: "Same structure as ABLLS-R but for VB-MAPP milestones, barriers, and transition assessments. Scoring per domain (Mand, Tact, Listener, VP/MTS, etc). Visual milestone chart." },
      { id: "f36", name: "Assessment module — extensible framework", status: "pending", priority: "P2", category: "Clinical", description: "Generic assessment engine that Tatiana can configure for any standardized assessment (PEAK, Vineland, AFLS, ESSENTIALS). Define domains, items, scoring criteria in admin panel." },
      { id: "f37", name: "Assessment data → BigQuery sync", status: "pending", priority: "P1", category: "Data", description: "New BigQuery table 'assessments': client_id, assessment_type, date, domain, subdomain, item_code, score, scorer_name, notes. Feeds LHBM training data." },
      { id: "f38", name: "Behavioral Plan generator", status: "pending", priority: "P0", category: "Clinical", description: "New module: Tatiana creates a Behavioral Intervention Plan (BIP) per client. Generates professional PDF for insurance and parents." },
      { id: "f39", name: "Assessment → Goals auto-suggestion", status: "pending", priority: "P1", category: "Clinical", description: "Based on assessment results (ABLLS-R/VB-MAPP scores), auto-suggest goals to add to the client's program. Tatiana reviews, edits, and approves." },
      { id: "f40", name: "Behavioral Plan → Goal assignment flow", status: "pending", priority: "P1", category: "Clinical", description: "Goals defined in the Behavioral Plan automatically populate the Tracker's goal list for that client. Two-way sync between plan and tracker." },
      { id: "f41", name: "Behavioral Plan sharing (parent + insurance)", status: "pending", priority: "P1", category: "Clinical", description: "Export Behavioral Plan as branded PDF with RT logo. Share link with parents (read-only, authenticated). Version history." },
      { id: "f42", name: "Re-assessment scheduling and comparison", status: "pending", priority: "P2", category: "Clinical", description: "Remind Tatiana when re-assessments are due (typically every 6 months). Side-by-side comparison of current vs previous assessment scores." },
    ],
  },
  {
    id: "paudit",
    name: "Quality Audit & Security Hardening",
    subtitle: "Comprehensive code audit, XSS protection, PIN hashing, concurrent write safety",
    timeline: "Complete",
    color: "#E53935",
    features: [
      { id: "q1", name: "Full code audit (30 issues)", status: "done", priority: "P0", category: "Quality", description: "Comprehensive audit of index.html and Code.gs. 30 issues found across JS errors, GAS errors, data integrity, security, UX, performance. All fixed." },
      { id: "q2", name: "XSS protection (escHtml on all innerHTML)", status: "done", priority: "P0", category: "Security", description: "escHtml() helper using div.textContent applied to renderAdminList, renderMasteryReportResults, client buttons, behavior pills." },
      { id: "q3", name: "TOTP QR generated client-side (no external API)", status: "done", priority: "P0", category: "Security", description: "Inline _QR module (250 lines, GF(256)/Reed-Solomon, SVG output). Eliminated api.qrserver.com leak of TOTP secrets." },
      { id: "q4", name: "PIN hashing (SHA-256)", status: "done", priority: "P0", category: "Security", description: "hashPin(email,pin) in GAS via Utilities.computeDigest. Backward-compat migration on first login. simpleHash for admin PIN in localStorage." },
      { id: "q5", name: "Offline login blocks TOTP users", status: "done", priority: "P0", category: "Security", description: "Network required for 2FA verification. Offline fallback only allowed for PIN-only accounts." },
      { id: "q6", name: "saveConfig LockService (concurrent write protection)", status: "done", priority: "P0", category: "Data", description: "LockService.getScriptLock() with 10s timeout. Throws on failure so caller gets error response." },
      { id: "q7", name: "Double-submission guard", status: "done", priority: "P0", category: "Data", description: "_submitting flag in doSubmitSession prevents duplicate session records." },
      { id: "q8", name: "BigQuerySync.gs audit (15 issues)", status: "done", priority: "P0", category: "Data", description: "All HIGH/MEDIUM/LOW issues fixed: behavior_key join, blank headers, is_draft null, mastery date format, empty vs null, alerting, timeout." },
      { id: "q9", name: "Data structural repairs — Camila + Dylan sheets", status: "done", priority: "P0", category: "Data", description: "Camila Behavior Data: empty column removed, Type A/B/C row shifts corrected. Camila TITO: 2 empty columns removed, Type B/C data realigned. Dylan TITO: 1 empty column removed, Type A/B data realigned." },
      { id: "q10", name: "Submission ID unification (117 IDs, all 5 clients)", status: "done", priority: "P0", category: "Data", description: "TITO used as source of truth. 117 submissionIds reconciled across Behavior Data, Trial Data, ABC Data tabs for all 5 clients." },
      { id: "q11", name: "Historical cleanup: 417 fields filled, 3 duplicates removed", status: "done", priority: "P0", category: "Data", description: "isDraft backfill (70 fields set to false), missing analytics fields filled, duplicate sessions removed." },
      { id: "q12", name: "Migration code removed from production (2,714 lines)", status: "done", priority: "P1", category: "Quality", description: "All one-time repair, migration, and diagnostic functions deleted from Code.gs. Production codebase reduced from ~4,400 to ~1,800 lines." },
      { id: "q13", name: "ABC behaviors filtered by client assignment", status: "done", priority: "P1", category: "UX", description: "renderABCList uses S.client.behaviors instead of CFG.ABC_BEHAVIORS. meRenderABC (manual entry) also uses client-filtered behaviors." },
      { id: "q14", name: "Trial screen goal names (not just codes)", status: "done", priority: "P1", category: "UX", description: "buildTrials was using g.description (undefined). applyConfig maps g.description → g.name. Fixed to use g.name." },
      { id: "q15", name: "Hypothesized Function multi-select", status: "done", priority: "P1", category: "Clinical", description: "Replaced single-select (inc.fn) with multi-select array (inc.fns[]). Both session and manual-entry flows updated. Stored as comma-separated string." },
      { id: "q16", name: "Mastery approve/dismiss security hardening", status: "done", priority: "P0", category: "Security", description: "Early return guard for non-BCBA/non-admin. approverRole ternary now sends actual role string (not hardcoded 'BCBA'). Server role check enforced. onclick uses esc() not escAttr() for JS string embedding." },
      { id: "q17", name: "Mastery log schema: 4 new fields", status: "done", priority: "P1", category: "Data", description: "Added status, approvedBy, approvalDate, settingsObserved to Mastery Log. writeMasteryLog, getMasteryReport, getMasteryLogStatus, BigQuerySync all updated. Type-aware backfill: goals get 'confirmed', behaviors get 'recommended'." },
      { id: "q18", name: "Mastery duplicate prevention (status column guard)", status: "done", priority: "P0", category: "Clinical", description: "getMasteryLogStatus returned '' when status column missing but entry existed → writeMasteryLog called every session. Fixed: return 'recommended' when entry exists but no status column. Plus one-time backfill in writeMasteryLog when status column is first created." },
      { id: "q19", name: "Mastery Report crash fix (null clientName)", status: "done", priority: "P0", category: "Quality", description: "getMasteryReport stored entries directly in latestByKey but build loop still used latestByKey[key].entry (stale .entry dereference). Every pushed entry was undefined → crash in renderMasteryReportResults. Fixed build loop + defensive null guards in frontend." },
      { id: "q20", name: "Mastery Approve/Dismiss sheetId fix", status: "done", priority: "P0", category: "Clinical", description: "Frontend CFG.CLIENTS lookup to find sheetId could fail on id mismatch. Fixed by including sheetId in each getMasteryReport entry object (server-side) and using ent.sheetId directly in frontend. Whitespace trim + length<10 guard on server." },
      { id: "q21", name: "Mastery Report cross-month dedup", status: "done", priority: "P1", category: "Data", description: "getMasteryReport inline dedup was date-filtered — couldn't see duplicates across months. Replaced with two-pass: PASS 1 scans all rows (no date filter) and physically deletes older duplicates from sheet. PASS 2 applies date filter for display. Handles case-variant codes via toLowerCase()." },
    ],
  },
  {
    id: "pdata",
    name: "Data Architecture Evolution",
    subtitle: "BigQuery health checks, historical cleanup, schema versioning, LHBM pipeline",
    timeline: "Ongoing",
    color: "#00897B",
    features: [
      { id: "d1", name: "Data reconciliation query (BigQuery health check)", status: "done", priority: "P0", category: "Data", description: "SQL query that checks all 11 BigQuery tables for null fields, duplicates, orphans, type issues. Run periodically in BigQuery console." },
      { id: "d2", name: "Historical data cleanup (cleanHistoricalData)", status: "done", priority: "P0", category: "Data", description: "Completed May 2026. 417 fields filled (dateISO, submissionId, clientName, clientId, therapistEmail, isDraft). 3 duplicate sessions removed. 117 submissionIds reconciled. All migration code removed from production after completion." },
      { id: "d3", name: "BigQuerySync.gs audit fixes (15 issues)", status: "done", priority: "P0", category: "Data", description: "Fixed: behavior_key mismatch, blank headers, is_draft null handling, mastery_date format, empty string vs null, session_type fallback, email alerting, timeout optimization, dynamic goal column detection." },
      { id: "d9", name: "bqReadTrialRows null goal_code fix (7,308 rows)", status: "done", priority: "P0", category: "Data", description: "BigQuerySync bqReadTrialRows was emitting rows with null goal_code for 7,308 records. Fixes: skip empty/blank headers before goal group detection, expand TRIAL_META_COLS to cover all analytics column names (submissionId through Percent Correct), require at least one Trial column OR a % column for a valid goal group — bare goal-code-only headers no longer emit a row. Fixes corrupt Trial Data records in BigQuery trial_records table." },
      { id: "d4", name: "Assessment tables in BigQuery", status: "planned", priority: "P1", category: "Data", description: "New tables: assessments, behavioral_plans, plan_goals. Schema designed for ABLLS-R, VB-MAPP, and extensible assessment framework." },
      { id: "d5", name: "Video annotation tables in BigQuery", status: "planned", priority: "P1", category: "Data", description: "New tables: video_sessions, video_annotations, skeleton_frames. Schema supports VANT training pipeline." },
      { id: "d6", name: "Migrate source of truth from Sheets to BigQuery", status: "planned", priority: "P2", category: "Infrastructure", description: "When reaching 10+ clients: app writes directly to BigQuery via Apps Script. Sheets become read-only mirrors. Eliminates column alignment issues permanently." },
      { id: "d7", name: "Schema versioning system", status: "planned", priority: "P2", category: "Infrastructure", description: "Track schema versions per client sheet and BigQuery table. Enable safe migrations when adding new modules." },
      { id: "d8", name: "LHBM training data pipeline from BigQuery", status: "planned", priority: "P1", category: "ML", description: "Export scripts: BigQuery → de-identified local files on Mac Mini → training pairs. Connects data architecture to Phase 1.5 LHBM training." },
    ],
  },
  {
    id: "phase1b",
    name: "Phase 1.5 — LHBM First Signal (Structured Data)",
    subtitle: "Fine-tune Personal + Master LLMs from ABA Tracker data — HIPAA compliant, fully local",
    timeline: "June → September 2026",
    color: "#7B1FA2",
    features: [
      // Step 1: Environment setup
      { id: "m1",  name: "Mac Mini M4 ML environment setup", status: "pending", priority: "P0", category: "Infrastructure", description: "Install Python 3.11, PyTorch with MPS (Apple Silicon GPU), Hugging Face Transformers, PEFT (QLoRA), bitsandbytes. Verify 8B model fits in 16GB unified memory with 4-bit quantization." },
      { id: "m2",  name: "Download base model (Llama 3.1 8B or Qwen 3 8B)", status: "planned", priority: "P0", category: "ML", description: "Download Apache 2.0 licensed model to Mac Mini local storage. No cloud dependency. Verify inference works locally with a test prompt before any fine-tuning." },
      // Step 2: Data export and de-identification
      { id: "m3",  name: "BigQuery → local training data export script", status: "planned", priority: "P0", category: "Data", description: "Python script that queries BigQuery (sessions, behavior_records, trial_records, abc_incidents, mastery_log) and exports to local JSON files on Mac Mini. Runs on demand or scheduled." },
      { id: "m4",  name: "HIPAA de-identification pipeline (Safe Harbor)", status: "planned", priority: "P0", category: "Data", description: "Python script that strips all 18 HIPAA identifiers from exported data: client names → Client_A/B/C, therapist names → Therapist_1/2/3, dates → relative day offsets (Day 1, Day 45), locations → generic (Setting_Home), session notes → NER-based name/address scrubbing." },
      { id: "m5",  name: "De-identification validation checklist", status: "planned", priority: "P0", category: "Data", description: "Manual review process: Tatiana reviews sample of de-identified data to confirm no PHI leakage. Checklist covers all 18 Safe Harbor identifiers. Document the review for HIPAA compliance records." },
      // Step 3: Training data generation
      { id: "m6",  name: "Training pair schema design", status: "planned", priority: "P0", category: "ML", description: "Define the prompt-completion format for behavioral prediction training. Input: client behavioral profile (last N sessions of behavior frequencies, goal scores, ABC patterns, session context). Output: behavioral prediction + clinical reasoning + intervention recommendation." },
      { id: "m7",  name: "Synthetic training data generation (de-identified)", status: "planned", priority: "P0", category: "ML", description: "Send DE-IDENTIFIED data to Claude/GPT-4 API to generate clinical reasoning completions. Tatiana validates outputs as BCBA (target: 100+ validated pairs per client). PHI never touches external API — only de-identified Client_A/B data." },
      { id: "m8",  name: "Tatiana BCBA validation of training pairs", status: "planned", priority: "P0", category: "Clinical", description: "Tatiana reviews each synthetic completion for clinical accuracy. Marks: correct, partially correct (edits), incorrect (rejects). Target: 83%+ acceptance rate (matches published research on synthetic ABA data validity)." },
      { id: "m9",  name: "ABA literature corpus preparation", status: "planned", priority: "P1", category: "Data", description: "Collect publicly available ABA textbooks, JABA articles, BACB task list, PEAK curriculum descriptions, RFT foundational texts. Convert to training-ready text format." },
      // Step 4: Model training (local, HIPAA compliant)
      { id: "m10", name: "Stage 1: Domain pre-training on ABA literature", status: "planned", priority: "P0", category: "ML", description: "Fine-tune base model on ABA literature corpus using QLoRA on Mac Mini. Purpose: teach the model ABA terminology, behavioral principles, reinforcement concepts, RFT basics. No PHI involved." },
      { id: "m11", name: "Stage 2: Master LHBM training (all clients, de-identified)", status: "planned", priority: "P0", category: "ML", description: "Fine-tune the domain-adapted model on de-identified training pairs from ALL clients combined. The Master learns general ABA patterns: typical extinction bursts, mastery timelines by goal type, session frequency effects, antecedent-behavior correlations." },
      { id: "m12", name: "Stage 3: Personal LHBM — Client A", status: "planned", priority: "P0", category: "ML", description: "Starting from the Master model, further fine-tune on Client A's de-identified data only. The Personal model learns this specific child's patterns: their unique behavior triggers, which goals progress faster, reinforcement preferences, time-of-day effects." },
      { id: "m13", name: "Stage 3: Personal LHBM — Client B", status: "planned", priority: "P0", category: "ML", description: "Same process for second client. Separate LoRA adapter weights on top of the Master model. Comparison between Client A and Client B personal models validates that personalization captures individual differences." },
      // Step 5: Evaluation and re-identification
      { id: "m14", name: "Evaluation framework: behavioral prediction accuracy", status: "planned", priority: "P0", category: "ML", description: "Hold out last 20% of sessions per client as test set. Metrics: behavior frequency prediction accuracy, goal mastery timing prediction (±2 sessions), intervention recommendation relevance (Tatiana rates 1-5), ABC function hypothesis accuracy." },
      { id: "m15", name: "Re-identification mapping (local only)", status: "planned", priority: "P1", category: "Data", description: "After training and evaluation, the de-identification mapping table (Client_A → real name) is used ONLY on the local Mac Mini to present results with real client names to Tatiana. The model weights themselves contain no PHI." },
      // Step 6: Integration
      { id: "m16", name: "Inference API on Mac Mini (local Flask/FastAPI)", status: "planned", priority: "P1", category: "Infrastructure", description: "Local REST API on Mac Mini that accepts a client behavioral profile and returns predictions. No cloud, no external access. HIPAA compliant by design." },
      { id: "m17", name: "Smart session notes (first LHBM feature)", status: "planned", priority: "P1", category: "Product", description: "After a session is submitted, the model generates a draft clinical summary: predicted trends, suggested focus areas for next session, flags for Tatiana's review. Displayed in admin panel. Tatiana edits/approves." },
      { id: "m18", name: "Pattern detection alerts", status: "planned", priority: "P2", category: "Product", description: "The Master/Personal model runs nightly analysis on recent sessions. Alerts Tatiana to: unexpected behavior spikes, goals that stalled, potential mastery approaching, reinforcement schedule that may need adjustment." },
      { id: "m19", name: "Training data versioning and lineage", status: "planned", priority: "P2", category: "Data", description: "Track which data was used to train each model version. Git-like versioning for training datasets and model checkpoints. Essential for reproducibility and patent evidence." },
      { id: "m20", name: "Assessment data as LHBM training signal", status: "planned", priority: "P1", category: "ML", description: "Include ABLLS-R/VB-MAPP assessment scores in the training data schema. Training pairs: given assessment profile + N sessions of data → predict which goals will master first, which behaviors will be hardest to reduce." },
      { id: "m21", name: "LHBM-assisted Behavioral Plan draft", status: "planned", priority: "P2", category: "Product", description: "After the Personal LHBM is trained, it generates a draft Behavioral Plan based on the client's assessment results + session history. Tatiana reviews, edits, and approves." },
    ],
  },
  {
    id: "phase2",
    name: "Phase 2 — Video Annotation & Recording",
    subtitle: "Session recording, annotation, and VANT training data",
    timeline: "July → December 2026",
    color: "#FF9701",
    features: [
      { id: "v1", name: "RT Recording Device app (dedicated iPhone SE)", status: "planned", priority: "P0", category: "Video", description: "Custom iOS app on RT-owned devices. QR code pairs to active Tracker session. Records encrypted with session key. MDM locked — no other functionality." },
      { id: "v2", name: "Session token + QR pairing protocol", status: "planned", priority: "P0", category: "Infrastructure", description: "Tracker generates encrypted session token + QR. Recording device scans, validates against API, starts recording. Auto-stops when Tracker session ends." },
      { id: "v3", name: "Encrypted video storage (Google Cloud Storage)", status: "planned", priority: "P0", category: "Infrastructure", description: "Videos upload encrypted to GCS with BAA. Decryption requires session key + reviewer auth. Auto-delete after configurable retention period (default 90 days)." },
      { id: "v4", name: "Video Annotation App (PWA)", status: "planned", priority: "P0", category: "Video", description: "Second PWA. Reviewer authenticates via Tracker API. Loads encrypted video for a specific session. Timeline-based annotation: mark timestamp + type (goal/behavior/ABC) + code + prompt level + result." },
      { id: "v5", name: "Annotation data → Tracker API sync", status: "planned", priority: "P1", category: "Data", description: "Annotations sent to Tracker as enriched session data. Creates second data layer for the same session. Stored in BigQuery as video_annotations table." },
      { id: "v6", name: "Parent consent workflow for recording", status: "planned", priority: "P0", category: "Clinical", description: "Digital consent form in Tracker. Parent signs before any recording. Stored in client record. Revocable." },
      { id: "v7", name: "Inter-rater reliability scoring", status: "planned", priority: "P2", category: "Clinical", description: "Compare original RBT session data with reviewer annotations. Calculate agreement %. Identifies areas where data collection training is needed." },
    ],
  },
  {
    id: "phase3",
    name: "Phase 3 — Skeleton Extraction & VANT Foundation",
    subtitle: "Privacy-preserving video processing and behavior detection",
    timeline: "January → June 2027",
    color: "#F1196E",
    features: [
      { id: "s1", name: "YOLO11 Pose skeleton extraction pipeline", status: "planned", priority: "P0", category: "ML", description: "Process annotated videos: extract skeleton keypoints frame-by-frame. Run on Mac Mini M4 or cloud GPU. Output: skeleton sequences + behavioral labels from annotations." },
      { id: "s2", name: "Skeleton + annotation training dataset", status: "planned", priority: "P0", category: "Data", description: "Paired dataset: skeleton sequences aligned with human-annotated behavioral labels. Stored in BigQuery as skeleton_frames table. Target: 100+ annotated sessions." },
      { id: "s3", name: "Video encoder fine-tuning (VideoMAE-v2)", status: "planned", priority: "P0", category: "ML", description: "Fine-tune VideoMAE-v2 on skeleton sequences to classify: stereotypical motor movements, aggression, SIB, engagement, goal responses (prompted vs independent). Target: 85%+ recall." },
      { id: "s4", name: "Real-time skeleton extraction on device", status: "planned", priority: "P1", category: "ML", description: "Skeleton extraction runs on the recording device itself (or Mac Mini as edge device for clinic settings). Raw video discarded after extraction. Only skeletons transmitted." },
      { id: "s5", name: "VANT v1 — automated behavior detection", status: "planned", priority: "P1", category: "ML", description: "Cloud-based classifier receives skeleton streams. Detects behaviors in real-time. Corroborates against RBT manual data entry. Flags discrepancies." },
      { id: "s6", name: "Elopement detection (scene-level anomaly)", status: "planned", priority: "P2", category: "ML", description: "Detect person disappearance from therapy zone. Cannot use person-level action recognition. Requires scene-level anomaly detection approach." },
    ],
  },
  {
    id: "phase4",
    name: "Phase 4 — Multimodal LHBM & Products",
    subtitle: "Add video + audio signals to Personal/Master models. JUAN, VANT v2, federated learning.",
    timeline: "July 2027 → 2028",
    color: "#5D4337",
    features: [
      { id: "l1",  name: "Add second signal: video annotations to training data", status: "planned", priority: "P0", category: "ML", description: "Enrich training pairs with timestamped behavioral annotations from Phase 2. Same session now has structured ABA data + human video review. Model learns temporal correlations: what sequence of skeleton poses precedes aggression, how engagement looks before mastery trials." },
      { id: "l2",  name: "Add third signal: skeleton sequences to training data", status: "planned", priority: "P0", category: "ML", description: "Integrate skeleton keypoint sequences from Phase 3 as a third modality. Training data now has: structured ABA data + video annotations + skeleton sequences, all temporally aligned per session." },
      { id: "l3",  name: "Cross-modal attention fusion layer", status: "planned", priority: "P0", category: "ML", description: "Align skeleton encoder (VideoMAE-v2) + structured data encoder into shared embedding space. Q-Former architecture. The Master and Personal models from Phase 1.5 become the LLM backbone — now receiving fused multimodal embeddings instead of text-only input." },
      { id: "l4",  name: "RFT-informed Relational Reasoning Module", status: "planned", priority: "P0", category: "ML", description: "Graph neural network operating parallel to LLM core. Models mutual entailment, combinatorial entailment, transformation of stimulus functions. Nodes = stimuli/behaviors/reinforcers. The core IP differentiator from the patent." },
      { id: "l5",  name: "Retrain Personal + Master with multimodal data", status: "planned", priority: "P0", category: "ML", description: "Fine-tune the Phase 1.5 models with the multimodal training pipeline. Personal models now predict behavior from text + video + skeleton signals. Evaluate: does multimodal beat text-only?" },
      { id: "l6",  name: "Federated learning fabric (multi-practice)", status: "planned", priority: "P1", category: "ML", description: "Enable other ABA practices using RT ABA Tracker to contribute de-identified gradients to the Master LHBM. Differential privacy noise injection. RT data schema as the federation standard." },
      { id: "l7",  name: "JUAN v1 — Audio-first caregiver companion", status: "planned", priority: "P1", category: "Product", description: "Apple Watch + AirPods. Haptic alerts + audio prompts. Context-aware suggestions based on Personal LHBM inference. Offline-capable with compressed Personal model on device." },
      { id: "l8",  name: "JUAN v2 — Visual prompting (smart glasses)", status: "planned", priority: "P2", category: "Product", description: "Meta Ray-Ban Display integration. Visual schedules, social story cards, real-time behavior graphs on HUD. Requires JUAN v1 proven first." },
      { id: "l9",  name: "VANT v2 — Session intelligence dashboard", status: "planned", priority: "P1", category: "Product", description: "Real-time dashboard for Tatiana during sessions. Shows: automated behavior counts vs RBT manual counts (discrepancy flags), goal mastery progress, intervention fidelity score, session engagement timeline." },
      { id: "l10", name: "Non-provisional patent filing", status: "planned", priority: "P0", category: "Legal", description: "Deadline: April 5, 2027. Convert provisional #64/030,031 to full patent. Include Phase 1.5 results (Personal/Master architecture) and multimodal pipeline as evidence of reduction to practice. Requires patent attorney (~$8K-15K)." },
      { id: "l11", name: "Trademarks: LHBM, JUAN, VANT", status: "planned", priority: "P1", category: "Legal", description: "File trademark applications for all three names before public launch." },
      { id: "l12", name: "Corporate separation: RT Inc + RT Technologies", status: "planned", priority: "P1", category: "Legal", description: "When funding arrives: Raising Together Inc (501c3, mission/practice) + Raising Together Technologies (C-Corp Delaware, IP/patent/equity). LHBM patent transfers to the C-Corp." },
      { id: "l13", name: "Dynamic Behavioral Plan enrichment", status: "planned", priority: "P1", category: "Product", description: "The multimodal LHBM continuously enriches the Behavioral Plan. As new session data, video annotations, and assessment results arrive, the model suggests plan modifications. Tatiana approves changes — creates a living document that evolves with the child." },
      { id: "l14", name: "Automated re-assessment recommendations", status: "planned", priority: "P2", category: "Product", description: "LHBM analyzes session trends and predicts when a re-assessment will show significant progress. Instead of fixed 6-month schedules, suggests optimal re-assessment timing per client." },
      { id: "l15", name: "Insurance authorization intelligence", status: "planned", priority: "P2", category: "Product", description: "LHBM generates data-driven justifications for insurance authorization renewals. Auto-compiles: assessment progress, goal mastery rates, behavior reduction trends, session attendance. Outputs a pre-filled authorization request document." },
    ],
  },
];

const HIPAA = [
  { id: "h1", name: "Tatiana signs 8 HIPAA documents", status: "pending", category: "Admin" },
  { id: "h2", name: "Upload documents to Google Drive", status: "pending", category: "Admin" },
  { id: "h3", name: "HIPAA training (30 min) with RBTs", status: "pending", category: "Training" },
  { id: "h4", name: "Training acknowledgment signatures", status: "pending", category: "Training" },
  { id: "h5", name: "NPP distributed to 5 families", status: "pending", category: "Parents" },
  { id: "h6", name: "Parent acknowledgment signatures", status: "pending", category: "Parents" },
  { id: "h7", name: "Device security check (3 iPhones)", status: "pending", category: "Devices" },
  { id: "h8", name: "WhatsApp HIPAA notices in groups", status: "pending", category: "Comms" },
];

const GROWTH = [
  { id: "g1", name: "Publish 'The Supremacy of Behavior'", status: "ready", category: "Content", description: "Draft complete. Edit in Google Docs, publish on LinkedIn + blog." },
  { id: "g2", name: "Autism Tech Accelerator 2026", status: "pending", category: "Funding", description: "10-week virtual, no equity. Closes May 22, 2026." },
  { id: "g3", name: "NEXT for AUTISM grants", status: "pending", category: "Funding", description: "Up to $10K for first-time grantees." },
  { id: "g4", name: "Contact UM-NSU CARD (Michael Alessandri)", status: "pending", category: "Research", description: "Clinical validation partner. 18,000+ families served." },
  { id: "g5", name: "Gusto + QuickBooks setup", status: "pending", category: "Operations", description: "Payroll automation. $108/mo vs $602/mo with accountant." },
  { id: "g6", name: "Mac Mini M4 setup (agents, n8n)", status: "in-progress", category: "Infrastructure", description: "Arrived April 23. Configure for development and agents." },
  { id: "g7", name: "Claude nonprofit account migration", status: "pending", category: "Infrastructure", description: "CLAUDE.md in repo + Project in claude.ai." },
  { id: "g8", name: "rodrigocuello.com launch", status: "in-progress", category: "Content", description: "Designer working on it. 6 categories: AI, Neurodiversity, Art, Faith, Philosophy, Leadership." },
];

const statusColors = {
  done:         { bg: "#E8F5E9", text: "#2E7D32", label: "Done" },
  "in-progress":{ bg: "#E3F2FD", text: "#1565C0", label: "In Progress" },
  pending:      { bg: "#FFF3E0", text: "#E65100", label: "Pending" },
  ready:        { bg: "#F3E5F5", text: "#7B1FA2", label: "Ready" },
  planned:      { bg: "#F5F5F5", text: "#616161", label: "Planned" },
};

const categoryColors = {
  Infrastructure: "#607D8B",
  Data:           "#00897B",
  UX:             "#00A7C7",
  Clinical:       "#F1196E",
  Billing:        "#FF9701",
  Admin:          "#5D4337",
  Video:          "#E65100",
  ML:             "#7B1FA2",
  Product:        "#1565C0",
  Legal:          "#37474F",
  Security:       "#B71C1C",
  Quality:        "#4E342E",
  CV:             "#1B5E20",
  Content:        "#00A7C7",
  Funding:        "#2E7D32",
  Research:       "#F1196E",
  Operations:     "#FF9701",
  Training:       "#E65100",
  Parents:        "#F1196E",
  Devices:        "#607D8B",
  Comms:          "#00897B",
};

function Badge({ status }) {
  const s = statusColors[status];
  return (
    <span style={{ background: s.bg, color: s.text, padding: "2px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: 500, whiteSpace: "nowrap" }}>
      {s.label}
    </span>
  );
}

function CatBadge({ category }) {
  const c = categoryColors[category] || "#999";
  return (
    <span style={{ background: c + "18", color: c, padding: "2px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: 500, whiteSpace: "nowrap" }}>
      {category}
    </span>
  );
}

function ProgressBar({ features, color }) {
  const done = features.filter((f) => f.status === "done").length;
  const total = features.length;
  const pct = Math.round((done / total) * 100);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "4px" }}>
      <div style={{ flex: 1, height: "6px", background: "#E0E0E0", borderRadius: "3px", overflow: "hidden" }}>
        <div style={{ width: pct + "%", height: "100%", background: color, borderRadius: "3px", transition: "width 0.3s" }} />
      </div>
      <span style={{ fontSize: "12px", color: "#666", whiteSpace: "nowrap" }}>{done}/{total} ({pct}%)</span>
    </div>
  );
}

export default function Tracker() {
  const [expandedPhase, setExpandedPhase] = useState("phase1");
  const [showSection, setShowSection] = useState("roadmap");
  const [statusFilter, setStatusFilter] = useState("all");
  const [expandedFeature, setExpandedFeature] = useState(null);

  const totalDone = PHASES.reduce((sum, p) => sum + p.features.filter((f) => f.status === "done").length, 0);
  const totalInProgress = PHASES.reduce((sum, p) => sum + p.features.filter((f) => f.status === "in-progress").length, 0);
  const totalFeatures = PHASES.reduce((sum, p) => sum + p.features.length, 0);
  const hipaaComplete = HIPAA.filter((h) => h.status === "done").length;

  return (
    <div style={{ fontFamily: "'Inter', system-ui, sans-serif", maxWidth: "720px", margin: "0 auto", padding: "16px" }}>
      <div style={{ textAlign: "center", marginBottom: "24px" }}>
        <h1 style={{ fontSize: "22px", fontWeight: 700, color: "#1a1a1a", margin: "0 0 4px" }}>Raising Together</h1>
        <p style={{ fontSize: "13px", color: "#00A7C7", fontWeight: 500, margin: 0 }}>Product & Feature Tracker</p>
      </div>

      <div style={{ display: "flex", gap: "6px", marginBottom: "16px", flexWrap: "wrap" }}>
        {["roadmap", "hipaa", "growth"].map((s) => (
          <button key={s} onClick={() => setShowSection(s)}
            style={{ padding: "6px 14px", borderRadius: "6px", border: showSection === s ? "2px solid #00A7C7" : "1px solid #ddd", background: showSection === s ? "#E0F4F8" : "#fff", color: showSection === s ? "#00A7C7" : "#666", fontSize: "13px", fontWeight: 500, cursor: "pointer" }}>
            {s === "roadmap" ? "Product Roadmap" : s === "hipaa" ? "HIPAA Ops" : "Growth & Ops"}
          </button>
        ))}
      </div>

      {showSection === "roadmap" && (
        <>
          <div style={{ display: "flex", gap: "8px", padding: "12px", background: "#F8F9FA", borderRadius: "8px", marginBottom: "16px", justifyContent: "space-around" }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "20px", fontWeight: 700, color: "#00A7C7" }}>{totalDone}</div>
              <div style={{ fontSize: "11px", color: "#888" }}>Completed</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "20px", fontWeight: 700, color: "#1565C0" }}>{totalInProgress}</div>
              <div style={{ fontSize: "11px", color: "#888" }}>In Progress</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "20px", fontWeight: 700, color: "#FF9701" }}>{totalFeatures - totalDone - totalInProgress}</div>
              <div style={{ fontSize: "11px", color: "#888" }}>Remaining</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "20px", fontWeight: 700, color: "#1a1a1a" }}>{PHASES.length}</div>
              <div style={{ fontSize: "11px", color: "#888" }}>Phases</div>
            </div>
          </div>

          <div style={{ display: "flex", gap: "4px", marginBottom: "12px", flexWrap: "wrap" }}>
            {["all", "pending", "in-progress", "planned", "done"].map((s) => (
              <button key={s} onClick={() => setStatusFilter(s)}
                style={{ padding: "3px 10px", borderRadius: "4px", border: statusFilter === s ? "1px solid #00A7C7" : "1px solid #eee", background: statusFilter === s ? "#E0F4F8" : "#fff", fontSize: "11px", cursor: "pointer", color: statusFilter === s ? "#00A7C7" : "#888" }}>
                {s === "all" ? "All" : statusColors[s].label}
              </button>
            ))}
          </div>

          {PHASES.map((phase) => {
            const filtered = statusFilter === "all" ? phase.features : phase.features.filter((f) => f.status === statusFilter);
            const isExpanded = expandedPhase === phase.id;
            return (
              <div key={phase.id} style={{ marginBottom: "12px", border: "1px solid #eee", borderRadius: "8px", overflow: "hidden" }}>
                <div onClick={() => setExpandedPhase(isExpanded ? null : phase.id)}
                  style={{ padding: "12px 14px", cursor: "pointer", borderLeft: `4px solid ${phase.color}`, background: isExpanded ? "#FAFAFA" : "#fff" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ fontSize: "14px", fontWeight: 600, color: "#1a1a1a" }}>{phase.name}</div>
                      <div style={{ fontSize: "11px", color: "#888", marginTop: "2px" }}>{phase.subtitle}</div>
                    </div>
                    <span style={{ fontSize: "11px", color: phase.color, fontWeight: 500, whiteSpace: "nowrap" }}>{phase.timeline}</span>
                  </div>
                  <ProgressBar features={phase.features} color={phase.color} />
                </div>
                {isExpanded && (
                  <div style={{ padding: "0 14px 12px" }}>
                    {filtered.length === 0 && <p style={{ fontSize: "12px", color: "#999", padding: "8px 0" }}>No features match this filter</p>}
                    {filtered.map((f) => (
                      <div key={f.id} onClick={() => setExpandedFeature(expandedFeature === f.id ? null : f.id)}
                        style={{ padding: "8px 0", borderBottom: "1px solid #f0f0f0", cursor: f.description ? "pointer" : "default" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                          <span style={{ fontSize: "13px", color: f.status === "done" ? "#999" : "#333", textDecoration: f.status === "done" ? "line-through" : "none", flex: 1 }}>{f.name}</span>
                          <CatBadge category={f.category} />
                          <Badge status={f.status} />
                        </div>
                        {expandedFeature === f.id && f.description && (
                          <p style={{ fontSize: "12px", color: "#666", margin: "6px 0 0", lineHeight: 1.5, paddingLeft: "4px", borderLeft: "2px solid #E0E0E0" }}>{f.description}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}

      {showSection === "hipaa" && (
        <div>
          <div style={{ padding: "12px", background: "#FFF3E0", borderRadius: "8px", marginBottom: "12px" }}>
            <div style={{ fontSize: "14px", fontWeight: 600, color: "#E65100" }}>HIPAA Operational — {hipaaComplete}/{HIPAA.length} complete</div>
            <div style={{ fontSize: "12px", color: "#888", marginTop: "4px" }}>Technical safeguards ✅ complete. Administrative docs ✅ generated. These are the remaining operational items.</div>
          </div>
          {HIPAA.map((h) => (
            <div key={h.id} style={{ padding: "10px 0", borderBottom: "1px solid #f0f0f0", display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "13px", color: "#333", flex: 1 }}>{h.name}</span>
              <CatBadge category={h.category} />
              <Badge status={h.status} />
            </div>
          ))}
        </div>
      )}

      {showSection === "growth" && (
        <div>
          <div style={{ padding: "12px", background: "#E8F5E9", borderRadius: "8px", marginBottom: "12px" }}>
            <div style={{ fontSize: "14px", fontWeight: 600, color: "#2E7D32" }}>Growth, Operations & External</div>
            <div style={{ fontSize: "12px", color: "#888", marginTop: "4px" }}>Funding applications, content strategy, operational setup, and account migration.</div>
          </div>
          {GROWTH.map((g) => (
            <div key={g.id} onClick={() => setExpandedFeature(expandedFeature === g.id ? null : g.id)}
              style={{ padding: "10px 0", borderBottom: "1px solid #f0f0f0", cursor: g.description ? "pointer" : "default" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <span style={{ fontSize: "13px", color: "#333", flex: 1 }}>{g.name}</span>
                <CatBadge category={g.category} />
                <Badge status={g.status} />
              </div>
              {expandedFeature === g.id && g.description && (
                <p style={{ fontSize: "12px", color: "#666", margin: "6px 0 0", lineHeight: 1.5, paddingLeft: "4px", borderLeft: "2px solid #E0E0E0" }}>{g.description}</p>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: "20px", padding: "12px", background: "#F8F9FA", borderRadius: "8px", fontSize: "11px", color: "#999", textAlign: "center" }}>
        Raising Together Inc. • Product Tracker • Patent #64/030,031 • raisingtogetherautism.org
      </div>
    </div>
  );
}
