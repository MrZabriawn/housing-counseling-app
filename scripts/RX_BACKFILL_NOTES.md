# Rx / Guarantor Backfill — Working Notes

_Last updated: 2026-07-30 (Z. Smith)_

Backfilling historical **Rx numbers + guarantors** from PHFA "RX CASES" exports into
the app, now that we have the session-centric setup. These notes let me resume on
another machine.

## Source data
`scripts/OldReports/` (3 workbooks, Jan 2025 – May 2026):
- `DRB RX CASES ...xlsx` — sheet `CasesOpenedbyCounselor`, 697 rows, 30 cols (superset-ish export)
- `RX CASES AL ...xlsx` — sheet `CasesOpenedbyPHFA`, 175 rows, 25 cols
- `RX CASES ZS ...xlsx` — sheet `CasesOpenedbyPHFA`, 29 rows, 25 cols
- 901 rows total → **705 unique Rx** after cross-file de-dup (dupes are self-consistent: 0 guarantor / 0 agent conflicts).

## Decisions locked in
- **Case ID IS the Rx number.** (`Internal Reference#` is empty everywhere.)
- **guarantor ← Funding Source** (all 8 values map cleanly; see `scripts/lib/old-reports.js`):
  - Anti-Predatory Lending Initiative → `Anti-Pred`
  - Mediation And Diversion Counseling Initiative → `M&D`
  - NOFA 2024-1 COMP / NOFA 2025-1 COMP → `NOFA` (and `nofaInitiative` = `2024-1` / `2025-1`)
  - CHCI Supplement / CHCI Funding 2016 / Comprehensive Housing Counseling Initiative → `CHCI`
  - HEMAP → `HEMAP`
- **counselingType ← Case type** (not needed for the catalog write, but defined):
  Default And Delinquency, HEMAP → `OUTSTANDING`; Pre-Purchase → `PRE`;
  Post-Purchase, Credit And Debt → `POST`.
- **zipCode: NOT sourced** (address column ~2% populated).
- **outcome/ami/reCode/hispanic/femaleHeaded/hours/rate/dollars/notes: absent — never touched.**
- **Backfill target = client Rx catalog** (`clients/{id}/rxNumbers`). **Do NOT create clients or sessions; do NOT edit sessions.**
- **active flag by case status**: closed PHFA cases (Case Close/Closed) → `active:false`, else `active:true`.

## What was DONE (already applied to Firestore prod `housing-counseling`)
Ran `node scripts/backfill-rx-catalog.js --active=status --apply` on **2026-07-30**:
- **Wrote 450 `rxNumber` docs across 214 existing clients** (372 active / 78 inactive).
- Skipped 178 already-cataloged, 77 no-client, 0 ambiguous, 0 unmapped.
- Client resolution: 298 by exact name, 152 by authoritative session link (rx already on a session).
- Doc shape: `{ rxNumber, guarantor, nofaInitiative, active, createdAt, importSource:'OldReports-PHFA', caseOpenDate }`.
- **Idempotent** — re-running the dry run now shows 0 to add, 628 already cataloged.

Coverage of the 705 export cases: **450 newly cataloged + 178 already there + 77 no-client-in-system**.

## Rollback
Delete `rxNumbers` docs where `importSource == 'OldReports-PHFA'` (450 docs). Easy to script.

## Scripts (all read-only except the backfill)
- `scripts/lib/old-reports.js` — single source of truth (loaders, dedupe, guarantor/counselingType/NOFA maps).
- `scripts/analyze-old-reports.js` — schema/consistency report (`--json`).
- `scripts/verify-rx-exist.js` — Rx existence check vs sessions (`--json`).
- `scripts/investigate-rx-gap.js` — why ~52% had no session; client-match breakdown (`--json`).
- `scripts/backfill-rx-catalog.js` — the catalog write. **Dry-run by default**; `--apply` to write; `--active=status|all|none`; `--json`.
- Generated reports (gitignored-optional): `*-analysis.json`, `rx-existence-report.json`, `rx-gap-investigation.json`, `rx-catalog-plan.json`.

Needs `scripts/serviceAccount.json` (gitignored) for the Firestore-touching scripts.

## OPEN / TODO (not done yet)
1. **77 truly-absent cases** — clients not in the system by name. Only cases the catalog couldn't cover. Options: dump to CSV for manual review, or attempt fuzzy name matching.
2. **119 blank-Rx sessions** — sessions whose client exists and has an rxNumber-less session. Parked. Plan: attach Rx onto a blank session by matching session `date` ≈ case open date. Ambiguous when a client has multiple blank sessions.
3. **counselingType backfill** — mapping is defined but was NOT written anywhere yet (catalog-only pass). Decide if/where it should land.
4. Decide whether to **commit these scripts** (currently in working tree).

## Rx gap breakdown (for reference — from investigate-rx-gap.js)
Of 705 unique export Rx:
- 321 (45.5%) already on a session
- 119 (16.9%) client exists + has a blank-Rx session (attachable, parked)
- 188 (26.7%) client exists but all sessions already Rx'd (no home session)
- 0 client with zero sessions
- 77 (10.9%) no client by name
