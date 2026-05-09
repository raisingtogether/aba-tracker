/**
 * rt_feature_tracker.jsx
 * Raising Together ABA Tracker — Feature & Roadmap Tracker
 * Open in any React sandbox (Vite, CodeSandbox, etc.) to render.
 */

const PHASES = [
  {
    id: 'p0',
    name: 'Phase 1 — Core ABA Tracker',
    color: '#00A7C7',
    timeline: 'Complete',
    features: [
      { id: 'c1',  name: 'Two-tier auth (Google OAuth + PIN/TOTP)', status: 'done', priority: 'P0', category: 'Auth', description: 'Tier 1: Google Sign-In for admin/BCBA. Tier 2: email + 6-digit PIN + optional TOTP (Google Authenticator) for RBTs.' },
      { id: 'c2',  name: 'Session data collection (behaviors, trials, ABC)', status: 'done', priority: 'P0', category: 'Core', description: 'Live session with behavior tally, trial-by-trial goal tracking, and ABC incident logging. Writes to per-client Google Sheets.' },
      { id: 'c3',  name: 'Admin panel (therapists, clients, goals, behaviors)', status: 'done', priority: 'P0', category: 'Admin', description: 'Full CRUD for all config entities. Role-based access: Tier 1 only for admin, payroll, audit log.' },
      { id: 'c4',  name: 'HIPAA audit log', status: 'done', priority: 'P0', category: 'Compliance', description: 'Every significant action writes to separate RT Audit Log Google Sheet. Export CSV from admin panel.' },
      { id: 'c5',  name: 'Session timer + elapsed time display', status: 'done', priority: 'P1', category: 'UX', description: 'Visible elapsed time in turquesa during session. Timer restarts correctly after modal cancel.' },
      { id: 'c6',  name: 'Session notes guided template', status: 'done', priority: 'P1', category: 'Core', description: '8-section guided notes template with 150-word minimum enforcement.' },
      { id: 'c7',  name: 'End session time adjustment modal', status: 'done', priority: 'P1', category: 'Core', description: 'Post-submit end time adjustment with validation.' },
      { id: 'c8',  name: 'Auto-logout (60 min inactivity)', status: 'done', priority: 'P0', category: 'Security', description: '27-min warning, 30-min logout. Background reauth after 5 min away from app.' },
      { id: 'c9',  name: 'PWA / offline support', status: 'done', priority: 'P1', category: 'UX', description: 'Service worker, manifest.json, Add to Home Screen. Offline login for PIN-only accounts.' },
      { id: 'c10', name: 'Biweekly payroll report', status: 'done', priority: 'P1', category: 'Admin', description: 'Hours × rate per therapist per client. CSV export. Admin-only.' },
      { id: 'c11', name: 'Authorization tracking with multi-code cards', status: 'done', priority: 'P1', category: 'Billing', description: 'Per-code hour pools (97153, 97155, etc.). Progress bars. Expiry alerts at 45 days.' },
      { id: 'c12', name: 'Weekly billing report', status: 'done', priority: 'P1', category: 'Billing', description: 'Per-client weekly billing summary. CSV export.' },
      { id: 'c13', name: 'Goal + behavior mastery detection', status: 'done', priority: 'P1', category: 'Clinical', description: 'Goal: 80%+ for 5 consecutive sessions (gold star). Behavior: ≤1 for 8 consecutive sessions (green checkmark).' },
      { id: 'c14', name: 'Monthly mastery report', status: 'done', priority: 'P1', category: 'Clinical', description: 'Aggregate mastery log across all clients for a given month. CSV export.' },
      { id: 'c15', name: 'Admin manual session entry', status: 'done', priority: 'P1', category: 'Admin', description: 'Backdated session entry (today/yesterday). Identical pipeline to live sessions.' },
      { id: 'c16', name: 'RBT weekly hour limit', status: 'done', priority: 'P1', category: 'Compliance', description: 'Configurable per therapist. Warning at ≤2h remaining. Block when limit reached.' },
    ]
  },

  {
    id: 'paudit',
    name: 'Quality Audit & Security Hardening',
    color: '#E53935',
    timeline: 'Complete',
    features: [
      { id: 'q1', name: 'Full code audit (30 issues)', status: 'done', priority: 'P0', category: 'Quality', description: 'Comprehensive audit of index.html and Code.gs. 30 issues found across JS errors, GAS errors, data integrity, security, UX, performance.' },
      { id: 'q2', name: 'XSS protection (escHtml on all innerHTML)', status: 'done', priority: 'P0', category: 'Security', description: 'escHtml() helper using div.textContent applied to renderAdminList, renderMasteryReportResults, client buttons, behavior pills.' },
      { id: 'q3', name: 'TOTP QR generated client-side (no external API)', status: 'done', priority: 'P0', category: 'Security', description: 'Inline _QR module (250 lines, GF(256)/Reed-Solomon, SVG output). Eliminated api.qrserver.com leak of TOTP secrets.' },
      { id: 'q4', name: 'PIN hashing (SHA-256)', status: 'done', priority: 'P0', category: 'Security', description: 'hashPin(email,pin) in GAS via Utilities.computeDigest. Backward-compat migration on first login. simpleHash for admin PIN in localStorage.' },
      { id: 'q5', name: 'Offline login blocks TOTP users', status: 'done', priority: 'P0', category: 'Security', description: 'Network required for 2FA verification. Offline fallback only allowed for PIN-only accounts.' },
      { id: 'q6', name: 'saveConfig LockService (concurrent write protection)', status: 'done', priority: 'P0', category: 'Data', description: 'LockService.getScriptLock() with 10s timeout. Throws on failure so caller gets error response.' },
      { id: 'q7', name: 'Double-submission guard', status: 'done', priority: 'P0', category: 'Data', description: '_submitting flag in doSubmitSession prevents duplicate session records.' },
      { id: 'q8', name: 'BigQuerySync.gs audit (15 issues)', status: 'done', priority: 'P0', category: 'Data', description: 'All HIGH/MEDIUM/LOW issues fixed: behavior_key join, blank headers, is_draft null, mastery date format, empty vs null, alerting, timeout.' },
    ]
  },

  {
    id: 'pdata',
    name: 'Data Architecture Evolution',
    color: '#00897B',
    timeline: 'Ongoing',
    features: [
      { id: 'd1', name: 'Data reconciliation query (BigQuery health check)', status: 'done', priority: 'P0', category: 'Data', description: 'SQL query that checks all 11 BigQuery tables for null fields, duplicates, orphans, type issues. Run periodically in BigQuery console.' },
      { id: 'd2', name: 'Historical data cleanup (cleanHistoricalData)', status: 'in-progress', priority: 'P0', category: 'Data', description: 'One-time migration: fill missing dateISO, submissionId, clientName, clientId, therapistEmail. Remove duplicates. Match submissionIds across tabs by session key.' },
      { id: 'd3', name: 'BigQuerySync.gs audit fixes (15 issues)', status: 'done', priority: 'P0', category: 'Data', description: 'Fixed: behavior_key mismatch, blank headers, is_draft null handling, mastery_date format, empty string vs null, session_type fallback, email alerting, timeout optimization, dynamic goal column detection.' },
      { id: 'd4', name: 'Assessment tables in BigQuery', status: 'planned', priority: 'P1', category: 'Data', description: 'New tables: assessments, behavioral_plans, plan_goals. Schema designed for ABLLS-R, VB-MAPP, and extensible assessment framework.' },
      { id: 'd5', name: 'Video annotation tables in BigQuery', status: 'planned', priority: 'P1', category: 'Data', description: 'New tables: video_sessions, video_annotations, skeleton_frames. Schema supports VANT training pipeline.' },
      { id: 'd6', name: 'Migrate source of truth from Sheets to BigQuery', status: 'planned', priority: 'P2', category: 'Infrastructure', description: 'When reaching 10+ clients: app writes directly to BigQuery via Apps Script. Sheets become read-only mirrors. Eliminates column alignment issues permanently.' },
      { id: 'd7', name: 'Schema versioning system', status: 'planned', priority: 'P2', category: 'Infrastructure', description: 'Track schema versions per client sheet and BigQuery table. Enable safe migrations when adding new modules.' },
      { id: 'd8', name: 'LHBM training data pipeline from BigQuery', status: 'planned', priority: 'P1', category: 'ML', description: 'Export scripts: BigQuery → de-identified local files on Mac Mini → training pairs. Connects data architecture to Phase 1.5 LHBM training.' },
    ]
  },

  {
    id: 'p15',
    name: 'Phase 1.5 — LHBM First Signal',
    color: '#7B1FA2',
    timeline: 'Next',
    features: [
      { id: 'l1', name: 'ABA session data export for training', status: 'planned', priority: 'P0', category: 'ML', description: 'Export de-identified session data from BigQuery as training pairs (context → intervention). Privacy-preserving transforms.' },
      { id: 'l2', name: 'Fine-tune base LLM on ABA data (Mac Mini M4)', status: 'planned', priority: 'P0', category: 'ML', description: 'Local fine-tuning on Mac Mini M4. Target: LHBM First Signal — model that can suggest interventions from session context.' },
      { id: 'l3', name: 'LHBM prediction API in Apps Script', status: 'planned', priority: 'P1', category: 'ML', description: 'GAS endpoint that sends session context to local LHBM API and returns intervention suggestions to the app.' },
      { id: 'l4', name: 'Suggestion display in session UI', status: 'planned', priority: 'P1', category: 'UX', description: 'Show LHBM intervention suggestions during session. Therapist accepts/rejects. Feedback loops back to training data.' },
    ]
  },

  {
    id: 'p2',
    name: 'Phase 2 — Video Annotation & Recording',
    color: '#F57C00',
    timeline: 'Future',
    features: [
      { id: 'v1', name: 'In-session video recording (PWA camera API)', status: 'planned', priority: 'P0', category: 'Video', description: 'Record session video from mobile device. Store encrypted in Google Drive or GCS. Link to session submission_id.' },
      { id: 'v2', name: 'Manual video annotation UI', status: 'planned', priority: 'P0', category: 'Video', description: 'Frame-by-frame annotation: behavior label, prompt level, result. Output: video_annotations BigQuery table.' },
      { id: 'v3', name: 'Video annotation export for VANT training', status: 'planned', priority: 'P1', category: 'ML', description: 'Export annotated video clips as training pairs for VANT foundation model.' },
    ]
  },

  {
    id: 'p3',
    name: 'Phase 3 — Skeleton Extraction & VANT Foundation',
    color: '#1565C0',
    timeline: 'Future',
    features: [
      { id: 's1', name: 'Pose estimation pipeline (MediaPipe / OpenPose)', status: 'planned', priority: 'P0', category: 'CV', description: 'Extract skeleton keypoints from video frames. Store in skeleton_frames BigQuery table. Run on Mac Mini M4.' },
      { id: 's2', name: 'VANT foundation model training', status: 'planned', priority: 'P0', category: 'ML', description: 'Video + Annotation + Notes + Tabular data. Multimodal foundation model trained on ABA therapy data.' },
      { id: 's3', name: 'Behavior classification from skeleton', status: 'planned', priority: 'P1', category: 'ML', description: 'Classify target behaviors from skeleton sequences. Initial target: tantrum frequency validation.' },
    ]
  },

  {
    id: 'p4',
    name: 'Phase 4 — Multimodal LHBM & Products',
    color: '#4E342E',
    timeline: 'Future',
    features: [
      { id: 'm1', name: 'Multimodal LHBM (text + video + skeleton)', status: 'planned', priority: 'P0', category: 'ML', description: 'Combine LHBM (Phase 1.5) with VANT (Phase 3) into unified multimodal model.' },
      { id: 'm2', name: 'Real-time intervention suggestions from video', status: 'planned', priority: 'P1', category: 'UX', description: 'Live video feed → skeleton extraction → VANT → intervention suggestion in under 2 seconds.' },
      { id: 'm3', name: 'Federated learning across practices', status: 'planned', priority: 'P2', category: 'ML', description: 'Other ABA practices sync to shared Master LHBM via differential privacy. No raw PHI shared.' },
      { id: 'm4', name: 'LHBM-as-a-service API', status: 'planned', priority: 'P2', category: 'Product', description: 'API product for other ABA software vendors. Model inference + fine-tuning pipeline as a service.' },
    ]
  },
];

// ── STATUS / PRIORITY CONFIG ──────────────────────────────────────────

const STATUS_CONFIG = {
  done:        { label: 'Done',        bg: '#E8F5E9', color: '#2E7D32', border: '#A5D6A7' },
  'in-progress': { label: 'In Progress', bg: '#FFF8E1', color: '#F57F17', border: '#FFE082' },
  planned:     { label: 'Planned',     bg: '#F3F4F6', color: '#6B7280', border: '#D1D5DB' },
};

const PRIORITY_CONFIG = {
  P0: { bg: '#FEE2E2', color: '#991B1B' },
  P1: { bg: '#FEF3C7', color: '#92400E' },
  P2: { bg: '#EDE9FE', color: '#5B21B6' },
};

// ── COMPONENT ─────────────────────────────────────────────────────────

function FeatureBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.planned;
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 12,
      background: cfg.bg, color: cfg.color,
      border: '1px solid ' + cfg.border,
      whiteSpace: 'nowrap',
    }}>
      {cfg.label}
    </span>
  );
}

function PriorityBadge({ priority }) {
  const cfg = PRIORITY_CONFIG[priority] || PRIORITY_CONFIG.P2;
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 8,
      background: cfg.bg, color: cfg.color, whiteSpace: 'nowrap',
    }}>
      {priority}
    </span>
  );
}

function FeatureRow({ feature }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10,
      padding: '10px 14px', borderBottom: '1px solid #F3F4F6',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 3 }}>
          <span style={{ fontWeight: 600, fontSize: 13, color: '#111827' }}>{feature.name}</span>
          <FeatureBadge status={feature.status} />
          <PriorityBadge priority={feature.priority} />
          <span style={{ fontSize: 10, color: '#9CA3AF', background: '#F9FAFB',
            border: '1px solid #E5E7EB', borderRadius: 6, padding: '1px 6px' }}>
            {feature.category}
          </span>
        </div>
        <div style={{ fontSize: 12, color: '#6B7280', lineHeight: 1.5 }}>{feature.description}</div>
      </div>
    </div>
  );
}

function PhaseCard({ phase }) {
  const done       = phase.features.filter(f => f.status === 'done').length;
  const inProgress = phase.features.filter(f => f.status === 'in-progress').length;
  const total      = phase.features.length;
  const pct        = Math.round((done / total) * 100);

  return (
    <div style={{
      background: '#fff', borderRadius: 12, marginBottom: 24,
      boxShadow: '0 1px 3px rgba(0,0,0,0.08)', overflow: 'hidden',
      border: '1px solid #E5E7EB',
    }}>
      {/* Header */}
      <div style={{ background: phase.color, padding: '14px 18px', display: 'flex',
        alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div style={{ color: '#fff', fontWeight: 700, fontSize: 16 }}>{phase.name}</div>
          <div style={{ color: 'rgba(255,255,255,0.8)', fontSize: 12, marginTop: 2 }}>
            {phase.timeline} &nbsp;·&nbsp; {done}/{total} done
            {inProgress > 0 ? ' · ' + inProgress + ' in progress' : ''}
          </div>
        </div>
        {/* Progress bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 120, height: 6, background: 'rgba(255,255,255,0.3)', borderRadius: 3 }}>
            <div style={{ width: pct + '%', height: '100%', background: '#fff', borderRadius: 3,
              transition: 'width 0.3s' }} />
          </div>
          <span style={{ color: '#fff', fontSize: 12, fontWeight: 600, minWidth: 32 }}>{pct}%</span>
        </div>
      </div>

      {/* Feature list */}
      {phase.features.map(function(f) {
        return <FeatureRow key={f.id} feature={f} />;
      })}
    </div>
  );
}

function SummaryBar() {
  var allFeatures = [];
  for (var i = 0; i < PHASES.length; i++) {
    for (var j = 0; j < PHASES[i].features.length; j++) {
      allFeatures.push(PHASES[i].features[j]);
    }
  }
  var done       = allFeatures.filter(function(f) { return f.status === 'done'; }).length;
  var inProgress = allFeatures.filter(function(f) { return f.status === 'in-progress'; }).length;
  var planned    = allFeatures.filter(function(f) { return f.status === 'planned'; }).length;
  var total      = allFeatures.length;

  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 28 }}>
      {[
        { label: 'Total', value: total,      bg: '#F9FAFB', color: '#374151', border: '#E5E7EB' },
        { label: 'Done',  value: done,        bg: '#E8F5E9', color: '#2E7D32', border: '#A5D6A7' },
        { label: 'In Progress', value: inProgress, bg: '#FFF8E1', color: '#F57F17', border: '#FFE082' },
        { label: 'Planned',  value: planned,  bg: '#F3F4F6', color: '#6B7280', border: '#D1D5DB' },
      ].map(function(s) {
        return (
          <div key={s.label} style={{ background: s.bg, border: '1px solid ' + s.border,
            borderRadius: 10, padding: '10px 18px', textAlign: 'center', minWidth: 80 }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 11, color: s.color, opacity: 0.85 }}>{s.label}</div>
          </div>
        );
      })}
    </div>
  );
}

export default function FeatureTracker() {
  return (
    <div style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      maxWidth: 860, margin: '0 auto', padding: '32px 16px', background: '#F9FAFB',
      minHeight: '100vh' }}>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: '#111827', margin: 0 }}>
          Raising Together ABA Tracker
        </h1>
        <p style={{ color: '#6B7280', fontSize: 14, marginTop: 6 }}>
          Feature Roadmap &amp; Progress Tracker
        </p>
      </div>

      <SummaryBar />

      {PHASES.map(function(phase) {
        return <PhaseCard key={phase.id} phase={phase} />;
      })}
    </div>
  );
}
