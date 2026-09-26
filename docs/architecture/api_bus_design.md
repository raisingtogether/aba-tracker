# RT ABA Tracker — Integration Bus & API Design

**Goal:** an integration layer that (1) feeds the **LHBM** (training + inference) and
(2) supports **wearables/JUAN**, without over-building before those consumers exist.

> Companion files: `events.schema.json` (the canonical event contract) and
> `../../analyst/semantic/schema.json` (the warehouse data dictionary).

---

## 1. Two buses, not one

"API bus" conflates two needs with different latency and shape. Build them separately.

| | Batch data pipeline (→ LHBM **training**) | Real-time event bus (→ wearables + LHBM **inference**) |
|---|---|---|
| Consumers | m-series training, analytics, federation (l6) | JUAN (l7/l8), VANT (l9), live inference (m16/m17) |
| Latency | hourly / on-demand | seconds (event → inference → haptic/audio) |
| Direction | one-way (source → warehouse → model) | bidirectional (device → model → device push) |
| Transport | Sheets → BigQuery → local export | REST + Pub/Sub broker + push |
| Status | skeleton exists (BQ sync done; export planned) | does not exist yet |

---

## 2. Current state (grounded in the codebase)

**Assets already in place — real bus prerequisites:**
- **`submissionId`** idempotency key (hardened) — required for at-least-once delivery.
- **Offline submit queue** (f49) — a client-side **outbox pattern**; the device-SDK model.
- **EventBus** (f17) — in-browser pub/sub; a *vocabulary*, now formalized in `events.schema.json`.
- **BigQuery** (11 normalized tables) — the analytical sink.
- **Semantic layer** (`schema.json` + BQ column descriptions) — the data contract.
- **GAS `doPost`** — de-facto JSON-RPC API (~20 actions over HTTPS).

**Gaps blocking LHBM + wearables:**
1. No device identity / auth tokens (GAS trusts client-supplied email).
2. GAS can't do real-time (6-min cap, daily quotas, no persistent connections/streaming).
3. No canonical event schema outside the browser → **fixed by `events.schema.json`**.
4. No broker for fan-out (one event → BQ + LHBM + dashboard).
5. No inference endpoint contract (m16 undefined).
6. Training export not built (m3/m4/d8 planned).

---

## 3. Target architecture

```
        ┌──────── canonical EVENT SCHEMA (events.schema.json) ────────┐
producers                                                              consumers
PWA (outbox) ─┐                                                    ┌─► BigQuery (warehouse → training source)
video device ─┼─► Ingestion API ─► [Broker: Pub/Sub] ─────────────┼─► LHBM inference (m16) ─► push ─► wearable
wearable SDK ─┘   (REST; GAS now,     (Phase C only)               ├─► VANT dashboard (l9)
                   Cloud Run later)                                └─► webhooks (f26 registry)
                        ▲ auth: device tokens (f26a)
```

**Keystone = the event schema.** The app, video device, wearable SDK, BigQuery, and the
LHBM all agree on it. Build it first; everything plugs in. ~80% already existed in the
EventBus vocabulary + `schema.json`.

**Training vs inference paths:**
- **Training** consumes the *warehouse tables* (batch), not raw events — de-identified per
  `schema.json` exclusions, `is_draft=FALSE`. Path: Sheets → BQ (hourly) → m3 export →
  m4 de-id → m6/m7 pairs → m10–m13 local training on Mac Mini.
- **Inference** consumes *live events* (Phase C): `inference.requested` → LHBM (m16) →
  `inference.produced` → wearable push / smart notes (m17) / alerts (m18).

---

## 4. Phased plan (mapped to roadmap IDs)

### Phase A — Contract + batch pipeline (now; unblocks LHBM training)
- ✅ **Canonical event schema** (`events.schema.json`) — done with this doc.
- **m3** BQ→local export · **m4** HIPAA Safe-Harbor de-id · **m5** validation · **d8** pipeline.
- No new infra (GAS + BQ suffice). Outcome: m6–m13 can start.

### Phase B — REST API + device identity  → **f26a** (P0)
- Authenticated endpoints, **device tokens**, **webhook registry**, versioned routes (`/v1`).
- Unblocks **three** things at once: video-device pairing (Phase 2 `v2`), wearables, external
  integrations/federation (l6).
- **Decision:** likely move hot endpoints off GAS onto **Cloud Run/Functions** here (GAS keeps
  Sheets ops). Ties to **d6** (BigQuery as source of truth at 10+ clients).

### Phase C — Real-time bus + inference  → **f26b** (P1) + m16
- Add **Google Pub/Sub** for fan-out; stand up the **LHBM inference API** (m16) with the
  `inference.requested`/`inference.produced` contract.
- Wearable SDK becomes producer (`behavior.recorded`) + consumer (push, f27 / JUAN l7).

---

## 5. f26a — REST API + device auth (concrete first build)

**Auth model (device tokens):**
1. An authenticated admin/therapist registers a device → backend issues a long-lived
   **device token** (opaque, revocable, scoped to therapist + allowed clients).
2. Device sends `Authorization: Bearer <token>` on every call; backend validates + maps to
   identity (replaces today's trust-the-email model).
3. Tokens stored hashed; revocation list checked per request. Audit every issue/revoke.

**Endpoints (v1; JSON; idempotent by `submissionId`/`eventId`):**
| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/v1/events` | Ingest one or a batch of canonical events (the write path for all producers). |
| POST | `/v1/sessions` | Submit a completed session (wraps today's `saveSession`). |
| GET | `/v1/sessions?clientId&from&to` | Read sessions (read-only, scoped by token). |
| GET | `/v1/clients` / `/v1/goals` / `/v1/behaviors` | Reference data (from config). |
| POST | `/v1/devices` / DELETE `/v1/devices/{id}` | Register / revoke a device token. |
| POST | `/v1/webhooks` | Register a webhook (url + event types) for fan-out. |
| GET | `/v1/health` | Liveness + version. |

**Cross-cutting:** `/v1` version prefix; at-least-once + dedup; rate limits; CORS for real
REST clients (GAS is limited here → another reason for Cloud Run at this phase); OpenAPI spec
published; **BAA required** before any PHI flows to a new consumer.

**Migration note:** keep the existing GAS `doPost` actions working (the PWA depends on them);
add `/v1` alongside. Retire GAS actions only after clients move.

---

## 6. Key decisions to make (owner: you)

1. **When to move off GAS** — trigger is real-time/streaming or 10+ clients (d6). Until then GAS is fine.
2. **Broker choice** — Google Pub/Sub (same cloud as BQ, BAA-eligible) is the default.
3. **Wearable data residency** — sensor streams are new PHI; needs BAA + likely on-device/edge
   pre-processing (mirrors Phase 3 `s4`: extract features, discard raw).
4. **Federation contract** (l6) — the event schema here becomes the multi-practice standard;
   version it deliberately.

---

## 7. Immediate next steps
1. Start **Phase A**: build m3/m4 export on top of the semantic layer + de-identified views.
2. Add **f30 (prompt hierarchy)** — it enriches `trial.scored` with `promptLevel`, the
   highest-value LHBM signal; capture it *before* accumulating more training data.
3. Draft the **f26a OpenAPI spec** when Phase B starts.
