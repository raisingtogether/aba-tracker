# Phase 1.5 — LHBM First Signal: m1–m4 scope

**Status:** scoped Oct 2, 2026. Phase 1.5 window is Sept 2026 → Feb 2027 and
currently has **0 of 21 items done**. The patent filing (l10) is due **April 5,
2027** and wants Phase 1.5 results as evidence of reduction to practice, so
slippage here is expensive rather than merely late.

---

## Two roadmap assumptions that do not survive contact

### 1. `bitsandbytes` 4-bit QLoRA does not work on Apple Silicon

m1 currently specifies *"PyTorch with MPS, Transformers, PEFT (QLoRA),
bitsandbytes"* and *"verify 8B fits in 16GB with 4-bit quantization"*.
`bitsandbytes` is CUDA-centric; its non-CUDA backends are experimental and
Apple-Silicon 4-bit QLoRA is not a supported path. Expect to lose a day fighting
it.

**Substitute MLX** (Apple's first-party ML framework) with `mlx-lm`, which
supports 4-bit quantization and LoRA fine-tuning natively on Apple Silicon.
Fallback if MLX proves limiting: PyTorch MPS + PEFT LoRA at bf16 — works, but
needs materially more memory, which pushes toward a smaller base model.

**Verify this before writing the training code**, not after.

### 2. Llama 3.1 is not Apache 2.0

m2 says *"Llama 3.1 8B or Qwen 3 8B"* and *"Apache 2.0 licensed"*. Llama 3.1
ships under the **Llama Community License**, not Apache 2.0 — it carries use
restrictions and an acceptable-use policy. Given the patent (l10) and the planned
C-Corp holding the IP (l12), the licence of the base model is a commercial
question, not a detail.

**Qwen (Apache 2.0) is the correct choice** on licensing grounds alone.

---

## Hardware reality

| | Dev laptop | Mac Mini M4 |
|---|---|---|
| Chip / RAM | M1, **8 GB** | M4, **memory unknown — m1 must detect it** |
| Free disk | 17 GB | unknown |
| Python | 3.9.6 (too old for current PyTorch/PEFT) | unknown |
| Role | **m3 + m4** (data work, no GPU) | **m1 + m2 + training** |

The laptop cannot host an 8B model or stage one on disk. Everything involving
model weights belongs on the Mini.

---

## m1 — ML environment on the Mac Mini · P0 · ~2–3 h on the Mini

I write the script and runbook; it executes on the Mini.

- Python 3.11 (3.9 is too old), isolated venv.
- `mlx`, `mlx-lm`, `transformers`, `datasets`, `huggingface_hub`.
- `ml/check_env.py` — reports chip, unified memory, free disk, MPS availability,
  and prints a **go/no-go for 8B vs 4B** based on what it finds. This is also how
  we answer the open "16 GB or 24 GB?" question.
- Deliverables: `ml/setup_mini.sh`, `ml/check_env.py`.

## m2 — base model · P0 · ~1 h (mostly download)

Model choice is **conditional on m1's memory report**:

| Detected memory | Recommendation |
|---|---|
| 16 GB | Qwen3 8B at 4-bit via MLX — fits but tight; keep Qwen3 4B as the de-risk |
| 24 GB+ | Qwen3 8B comfortable; 8-bit becomes possible and usually trains better |

Verify local inference with a test prompt before any fine-tuning.

## m3 — BigQuery → local export · P0 · ~half a day · **buildable on the laptop**

- Reuse the existing read-only service-account pattern from `analyst/` +
  `.mcp.json`. No new access path.
- Export `sessions`, `behavior_records`, `trial_records`, `abc_incidents`,
  `mastery_log` to local JSON.
- **`trial_records` now carries `prompt_level`, `prompt_level_rank`, `is_probe`,
  `first_scored_at`, `last_scored_at`** (f30a/f30c). Include them from day one —
  prompt level is the highest-value per-trial signal and probe-vs-teaching is
  the cleanest label in the dataset.
- Deliverable: `ml/export_bigquery.py`.

## m4 — HIPAA de-identification (Safe Harbor) · P0 · ~1.5–2 days · **the long pole**

Gates every downstream item: nothing real can leave the machine until this is
right, and m7 sends de-identified data to an external API.

**Structured fields** — client names → `Client_A/B/C`, therapists →
`Therapist_1/2/3`, dates → relative day offsets (`Day 1`, `Day 45`), locations →
generic (`Setting_Home`), emails and ids dropped.

**Session notes** (confirmed in scope) — free text written by RBTs, and the most
likely place a name, address or phone number leaks.

> **Do not rely on NER alone.** We *know* the names in this system — clients,
> therapists, parents, and the siblings and pets that turn up in notes. A
> **deny-list pass built from RT Admin config** (exact + fuzzy match) catches the
> names that actually occur far more reliably than a general NER model. Run NER
> *after* it as a second net for the names we do not know.

**Reversible mapping** lives only on the local machine (m15) and is never
committed. `.gitignore` must cover the export, the de-identified corpus and the
mapping before the first run.

**Validation** — all 18 Safe Harbor identifiers as a written checklist, reviewed
on a sample by Tatiana (m5), documented for the compliance record.

- Deliverables: `ml/deidentify.py`, `ml/deid_checklist.md`, `ml/denylist.py`.

---

## Recommended sequence

1. **Now, on the laptop:** m3 → m4. No hardware dependency, and m4 is both the
   long pole and the gate on everything touching real data.
2. **In parallel, on the Mini:** m1 → m2 from the runbook, which also answers
   the memory question that decides the m2 model.
3. **Then:** m6 (training-pair schema) with real de-identified data in hand.

~3–4 days of work to reach a de-identified training corpus plus a working local
model — the point where Phase 1.5 stops being 0% done.

## Open questions

- Mac Mini unified memory and free disk (m1 answers this).
- Whether a BAA is needed for the m7 external-API step, or whether
  de-identification under Safe Harbor is sufficient on its own. Worth a written
  answer in the compliance record either way.
