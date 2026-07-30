'use strict';
/**
 * backfill-rx-catalog.js
 *
 * Populates each EXISTING client's rxNumbers subcollection (the client Rx /
 * guarantor catalog) from the PHFA OldReports exports. It NEVER creates clients
 * or sessions and never edits sessions — it only adds missing rxNumber docs to
 * clients that already exist, and is idempotent (an Rx already in a client's
 * catalog is skipped).
 *
 * Match: export Homeowner name → client.clientName (exact normalized, then
 * order-independent token match). Names that match zero or MORE THAN ONE client
 * are skipped and reported — never guessed.
 *
 * New doc shape (mirrors the app's manual "Add Rx" in public/js/client.js):
 *   { rxNumber, guarantor, nofaInitiative, active:true, createdAt,
 *     importSource:'OldReports-PHFA', caseOpenDate }
 * The two import* fields are provenance only (ignored by the UI) and make the
 * whole backfill reversible: delete rxNumbers where importSource=='OldReports-PHFA'.
 *
 * Usage:
 *   node scripts/backfill-rx-catalog.js            # DRY RUN (default) — writes nothing
 *   node scripts/backfill-rx-catalog.js --apply    # perform the writes
 *   node scripts/backfill-rx-catalog.js --json      # also write a plan/report JSON
 */

const fs    = require('fs');
const path  = require('path');
const admin = require('firebase-admin');
const OR    = require('./lib/old-reports');

const APPLY      = process.argv.includes('--apply');
const WRITE_JSON = process.argv.includes('--json');
// active policy: 'status' (closed cases → inactive), 'all', or 'none'
const ACTIVE_POLICY = (process.argv.find(a => a.startsWith('--active=')) || '--active=status').split('=')[1];
const isClosed = s => /\bclose\b|\bclosed\b/i.test(String(s || ''));
function activeFor(caseStatus) {
  if (ACTIVE_POLICY === 'all')  return true;
  if (ACTIVE_POLICY === 'none') return false;
  return !isClosed(caseStatus);   // 'status'
}
const saPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, 'serviceAccount.json');
admin.initializeApp({ credential: admin.credential.cert(require(path.resolve(saPath))) });
const db = admin.firestore();

const normName = s => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const tokenKey = s => normName(s).split(' ').filter(Boolean).sort().join(' ');
const norm     = v => String(v == null ? '' : v).trim();

async function main() {
  console.log(APPLY ? '━━━ LIVE RUN (--apply) ━━━' : '━━━ DRY RUN (default — no writes) ━━━');

  // 1) Export cases, deduped by Rx
  const rxMap = OR.dedupeByRx(OR.loadAll());   // Map<rx,{row,files}>
  console.log(`Export: ${rxMap.size} unique Rx cases`);

  // 2) Client name index (+ collision detection)
  const clientSnap = await db.collection('clients').get();
  const byNorm = new Map(), byToken = new Map();
  clientSnap.forEach(d => {
    const nm = norm(d.data().clientName); if (!nm) return;
    const n = normName(nm), t = tokenKey(nm);
    if (!byNorm.has(n))  byNorm.set(n, new Set());  byNorm.get(n).add(d.id);
    if (!byToken.has(t)) byToken.set(t, new Set()); byToken.get(t).add(d.id);
  });
  console.log(`Clients: ${clientSnap.size}`);

  // 2b) Authoritative rx → client link from existing sessions. When an export
  // Rx is already on a session we KNOW the client, even if the Homeowner name
  // doesn't string-match clientName (nicknames, maiden names, typos).
  const sessSnap = await db.collectionGroup('sessions').get();
  const sessByRx = new Map();   // rxNumber → Set<clientId>
  sessSnap.forEach(doc => {
    const rx  = norm(doc.data().rxNumber); if (!rx) return;
    const cid = doc.ref.parent.parent ? doc.ref.parent.parent.id : null; if (!cid) return;
    if (!sessByRx.has(rx)) sessByRx.set(rx, new Set());
    sessByRx.get(rx).add(cid);
  });
  console.log(`Sessions: ${sessSnap.size} (${sessByRx.size} distinct Rx on sessions)`);

  function resolve(rx, name) {
    // 1) authoritative: rx already on a session
    if (sessByRx.has(rx)) { const ids = [...sessByRx.get(rx)]; return ids.length === 1 ? { id: ids[0], how: 'session' } : { ambiguous: ids }; }
    // 2) fall back to client name (exact, then order-independent tokens)
    const n = normName(name), t = tokenKey(name);
    if (byNorm.has(n))  { const ids = [...byNorm.get(n)];  return ids.length === 1 ? { id: ids[0], how: 'exact' } : { ambiguous: ids }; }
    if (byToken.has(t)) { const ids = [...byToken.get(t)]; return ids.length === 1 ? { id: ids[0], how: 'token' } : { ambiguous: ids }; }
    return { none: true };
  }

  // 3) Existing rxNumbers per client (idempotency)
  const rxDocSnap = await db.collectionGroup('rxNumbers').get();
  const existing = new Map();   // clientId → Set<rxNumber>
  rxDocSnap.forEach(doc => {
    const cid = doc.ref.parent.parent ? doc.ref.parent.parent.id : null;
    const rx  = norm(doc.data().rxNumber);
    if (!cid || !rx) return;
    if (!existing.has(cid)) existing.set(cid, new Set());
    existing.get(cid).add(rx);
  });
  console.log(`Existing rxNumbers docs: ${rxDocSnap.size}`);

  // 4) Build the plan
  const toAdd = [];                                   // {clientId, rxNumber, guarantor, nofaInitiative, caseOpenDate}
  const skip = { alreadyInCatalog: 0, noClient: [], ambiguous: [], unmatchedGuarantor: [] };
  const perGuarantor = new Map();
  const resolvedBy = new Map();
  const clientsTouched = new Set();

  for (const [rx, { row }] of rxMap) {
    const g = OR.mapGuarantor(row['Funding Source']);
    if (!g.matched) { skip.unmatchedGuarantor.push({ rx, src: norm(row['Funding Source']) }); continue; }

    const name = norm(row['Homeowner']);
    const r = resolve(rx, name);
    if (r.none)      { skip.noClient.push({ rx, name, guarantor: g.guarantor }); continue; }
    if (r.ambiguous) { skip.ambiguous.push({ rx, name, clientIds: r.ambiguous }); continue; }

    if (existing.get(r.id)?.has(rx)) { skip.alreadyInCatalog++; continue; }

    toAdd.push({
      clientId:       r.id,
      rxNumber:       rx,
      guarantor:      g.guarantor,
      nofaInitiative: OR.nofaInitiativeOf(row['Funding Source']),
      caseOpenDate:   norm(row['Case Open Date']),
      caseStatus:     norm(row['Current Case Status']),
      active:         activeFor(row['Current Case Status']),
    });
    clientsTouched.add(r.id);
    perGuarantor.set(g.guarantor, (perGuarantor.get(g.guarantor) || 0) + 1);
    resolvedBy.set(r.how, (resolvedBy.get(r.how) || 0) + 1);
    // reserve within-run so two export rows for the same (client,rx) don't double-add
    if (!existing.has(r.id)) existing.set(r.id, new Set());
    existing.get(r.id).add(rx);
  }

  // 5) Report the plan
  const bar = '═'.repeat(72);
  const nActive = toAdd.filter(a => a.active).length;
  console.log('\n' + bar + `\nPLAN   (active policy: ${ACTIVE_POLICY})\n` + bar);
  console.log(`  TO ADD                 : ${toAdd.length} rxNumber docs across ${clientsTouched.size} clients`);
  console.log(`     active=true : ${nActive}   active=false : ${toAdd.length - nActive}`);
  console.log(`  skip — already cataloged: ${skip.alreadyInCatalog}`);
  console.log(`  skip — no client match  : ${skip.noClient.length}`);
  console.log(`  skip — ambiguous name   : ${skip.ambiguous.length}`);
  console.log(`  skip — unmapped funding : ${skip.unmatchedGuarantor.length}`);
  console.log('\n  Client resolved by: ' + [...resolvedBy.entries()].map(([k, v]) => `${k}=${v}`).join('  '));
  console.log('\n  New docs by guarantor:');
  [...perGuarantor.entries()].sort((a, b) => b[1] - a[1]).forEach(([g, n]) => console.log(`     ${String(n).padStart(4)}  ${g}`));
  if (skip.ambiguous.length) {
    console.log('\n  Ambiguous names (skipped — resolve via de-dup, then re-run):');
    skip.ambiguous.slice(0, 10).forEach(a => console.log(`     ${a.rx}  ${a.name}  → ${a.clientIds.length} clients`));
    if (skip.ambiguous.length > 10) console.log(`     …and ${skip.ambiguous.length - 10} more`);
  }

  if (WRITE_JSON) {
    const out = path.join(__dirname, 'rx-catalog-plan.json');
    fs.writeFileSync(out, JSON.stringify({ apply: APPLY, toAddCount: toAdd.length, clientsTouched: clientsTouched.size, skip, toAdd }, null, 2));
    console.log(`\nWrote ${out}`);
  }

  // 6) Apply
  if (!APPLY) {
    console.log('\nDRY RUN complete. Re-run with --apply to write these ' + toAdd.length + ' docs.');
    process.exit(0);
  }
  console.log(`\nWriting ${toAdd.length} docs…`);
  let written = 0;
  for (let i = 0; i < toAdd.length; i += 400) {
    const batch = db.batch();
    for (const a of toAdd.slice(i, i + 400)) {
      const ref = db.collection('clients').doc(a.clientId).collection('rxNumbers').doc();
      batch.set(ref, {
        rxNumber:       a.rxNumber,
        guarantor:      a.guarantor,
        nofaInitiative: a.nofaInitiative,
        active:         a.active,
        createdAt:      admin.firestore.FieldValue.serverTimestamp(),
        importSource:   'OldReports-PHFA',
        caseOpenDate:   a.caseOpenDate,
      });
    }
    await batch.commit();
    written += Math.min(400, toAdd.length - i);
    console.log(`  committed ${written}/${toAdd.length}`);
  }
  console.log('\nDONE. Wrote ' + written + ' rxNumber docs. Rollback: delete rxNumbers where importSource=="OldReports-PHFA".');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
