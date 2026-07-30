'use strict';
/**
 * verify-rx-exist.js  (READ-ONLY — no writes)
 *
 * Guard rail before any Rx/guarantor backfill: confirm every Rx number in the
 * OldReports exports ALREADY exists as a session in Firestore. The backfill
 * must only ENRICH existing sessions — it must never create new ones — so any
 * Rx here that has no matching session is a problem to resolve first.
 *
 * For each unique Rx (Case ID) it reports one of:
 *   • HAS SESSION(S)   — enrichable (count of sessions that would be patched)
 *   • RX-DOC ONLY      — exists in a clients/{id}/rxNumbers subcollection but
 *                        no session carries that Rx  → nothing to enrich
 *   • MISSING          — not found anywhere in the system
 *
 * Usage:
 *   node scripts/verify-rx-exist.js
 *   node scripts/verify-rx-exist.js --json   (writes rx-existence-report.json)
 */

const fs    = require('fs');
const path  = require('path');
const admin = require('firebase-admin');
const OR    = require('./lib/old-reports');

const WRITE_JSON = process.argv.includes('--json');
const saPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, 'serviceAccount.json');
admin.initializeApp({ credential: admin.credential.cert(require(path.resolve(saPath))) });
const db = admin.firestore();

const norm = v => String(v == null ? '' : v).trim();

async function main() {
  // 1) Unique Rx set from the exports
  const loaded  = OR.loadAll();
  const rxMap   = OR.dedupeByRx(loaded);           // Map<rx, {row, files}>
  const rxList  = [...rxMap.keys()];
  console.log(`OldReports: ${loaded.reduce((n, L) => n + L.rows.length, 0)} rows → ${rxList.length} unique Rx numbers`);

  // 2) Existing sessions: rxNumber → {sessionCount, clients:Set}
  console.log('Reading sessions (collectionGroup "sessions")…');
  const sessSnap = await db.collectionGroup('sessions').get();
  const sessByRx = new Map();
  let sessWithRx = 0;
  sessSnap.forEach(doc => {
    const rx = norm(doc.data().rxNumber);
    if (!rx) return;
    sessWithRx++;
    const clientId = doc.ref.parent.parent ? doc.ref.parent.parent.id : '?';
    if (!sessByRx.has(rx)) sessByRx.set(rx, { count: 0, clients: new Set() });
    const e = sessByRx.get(rx); e.count++; e.clients.add(clientId);
  });
  console.log(`  ${sessSnap.size} sessions total, ${sessWithRx} carry an rxNumber, ${sessByRx.size} distinct Rx values`);

  // 3) rxNumbers subcollection docs (fallback context)
  console.log('Reading rxNumbers (collectionGroup "rxNumbers")…');
  const rxDocSnap = await db.collectionGroup('rxNumbers').get();
  const rxDocSet = new Set();
  rxDocSnap.forEach(doc => { const rx = norm(doc.data().rxNumber); if (rx) rxDocSet.add(rx); });
  console.log(`  ${rxDocSnap.size} rxNumber docs, ${rxDocSet.size} distinct Rx values`);

  // 4) Classify each export Rx
  const hasSession = [], rxDocOnly = [], missing = [];
  let enrichableSessions = 0;
  for (const rx of rxList) {
    if (sessByRx.has(rx)) { hasSession.push(rx); enrichableSessions += sessByRx.get(rx).count; }
    else if (rxDocSet.has(rx)) rxDocOnly.push(rx);
    else missing.push(rx);
  }

  // 5) Report
  const bar = '═'.repeat(70);
  console.log('\n' + bar);
  console.log('RX EXISTENCE CHECK');
  console.log(bar);
  const p = (n) => `${n}  (${(100 * n / rxList.length).toFixed(1)}%)`;
  console.log(`  Unique Rx in exports        : ${rxList.length}`);
  console.log(`  ✓ HAS SESSION(S) (enrichable): ${p(hasSession.length)}  → ${enrichableSessions} sessions would be patched`);
  console.log(`  ~ RX-DOC ONLY (no session)  : ${p(rxDocOnly.length)}`);
  console.log(`  ✗ MISSING (not in system)   : ${p(missing.length)}`);

  const show = (label, arr, decorate = rx => rx) => {
    if (!arr.length) return;
    console.log(`\n  ── ${label} (${arr.length}) ──`);
    arr.slice(0, 40).forEach(rx => console.log(`     ${decorate(rx)}`));
    if (arr.length > 40) console.log(`     …and ${arr.length - 40} more (see --json for the full list)`);
  };
  show('MISSING — would require creating a NEW session (DO NOT)', missing, rx => {
    const s = OR.toSessionPatch(rxMap.get(rx).row);
    return `${rx}  ${s.clientName} | ${s.counselor} | ${s.guarantor} | opened ${s.caseOpenDate}`;
  });
  show('RX-DOC ONLY — Rx registered but no session to enrich', rxDocOnly, rx => {
    const s = OR.toSessionPatch(rxMap.get(rx).row);
    return `${rx}  ${s.clientName} | ${s.guarantor}`;
  });

  const verdict = (missing.length === 0 && rxDocOnly.length === 0)
    ? 'ALL CLEAR — every Rx maps to at least one existing session. Safe to enrich.'
    : `HOLD — ${missing.length + rxDocOnly.length} Rx have no session to attach to; resolve before backfill.`;
  console.log('\n' + bar + '\n  ' + verdict + '\n' + bar);

  if (WRITE_JSON) {
    const out = path.join(__dirname, 'rx-existence-report.json');
    const detail = rx => {
      const s = OR.toSessionPatch(rxMap.get(rx).row);
      return { rx, clientName: s.clientName, counselor: s.counselor, guarantor: s.guarantor,
               counselingType: s.counselingType, caseStatus: s.caseStatus, caseOpenDate: s.caseOpenDate,
               files: [...rxMap.get(rx).files],
               sessionCount: sessByRx.get(rx)?.count || 0,
               clients: sessByRx.has(rx) ? [...sessByRx.get(rx).clients] : [] };
    };
    fs.writeFileSync(out, JSON.stringify({
      generatedFor: 'Rx existence check (read-only)',
      totals: { uniqueRx: rxList.length, hasSession: hasSession.length,
                rxDocOnly: rxDocOnly.length, missing: missing.length, enrichableSessions },
      missing:   missing.map(detail),
      rxDocOnly: rxDocOnly.map(detail),
      hasSession: hasSession.map(detail),
    }, null, 2));
    console.log(`\nWrote ${out}`);
  }
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
