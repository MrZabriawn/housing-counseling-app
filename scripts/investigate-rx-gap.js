'use strict';
/**
 * investigate-rx-gap.js  (READ-ONLY — no writes)
 *
 * ~52% of export Rx numbers have no session carrying that Rx. Before deciding
 * what to do, this explains WHY, by matching each export case to a CLIENT (by
 * Homeowner name) rather than by Rx, and inspecting that client's sessions.
 *
 * Every export Rx falls into one bucket:
 *   RX_ON_SESSION        Rx already on ≥1 session                (already linked)
 *   CLIENT_HAS_BLANK_SESS client exists, has session(s) with NO rxNumber
 *                          → attachable: we could fill the Rx in-place
 *   CLIENT_ALL_SESS_RXED  client exists, has sessions but every one already
 *                          has some Rx → this case has no home session
 *   CLIENT_NO_SESSIONS    client exists but has zero sessions
 *   CLIENT_NOT_FOUND      no client matches the Homeowner name at all
 *
 * Name matching: exact normalized "first last" first, then a token-set match
 * (order-independent) as a looser second pass; anything else is NOT_FOUND.
 *
 * Usage:
 *   node scripts/investigate-rx-gap.js
 *   node scripts/investigate-rx-gap.js --json   (writes rx-gap-investigation.json)
 */

const fs    = require('fs');
const path  = require('path');
const admin = require('firebase-admin');
const OR    = require('./lib/old-reports');

const WRITE_JSON = process.argv.includes('--json');
const saPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, 'serviceAccount.json');
admin.initializeApp({ credential: admin.credential.cert(require(path.resolve(saPath))) });
const db = admin.firestore();

const normName  = s => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const tokenKey  = s => normName(s).split(' ').filter(Boolean).sort().join(' ');
const norm      = v => String(v == null ? '' : v).trim();

async function main() {
  // 1) Export cases (deduped by Rx)
  const rxMap = OR.dedupeByRx(OR.loadAll());  // Map<rx,{row,files}>
  console.log(`Export: ${rxMap.size} unique Rx cases`);

  // 2) Clients → name indexes + per-client id
  console.log('Reading clients…');
  const clientSnap = await db.collection('clients').get();
  const byNorm = new Map(), byToken = new Map();
  const clientName = new Map();
  clientSnap.forEach(d => {
    const nm = norm(d.data().clientName);
    clientName.set(d.id, nm);
    const n = normName(nm), t = tokenKey(nm);
    if (n) { (byNorm.get(n)  || byNorm.set(n, []).get(n)).push(d.id); }
    if (t) { (byToken.get(t) || byToken.set(t, []).get(t)).push(d.id); }
  });
  console.log(`  ${clientSnap.size} clients indexed`);

  // 3) Sessions → per-client stats (total, blank-rx, rx set) and global rx set
  console.log('Reading sessions…');
  const sessSnap = await db.collectionGroup('sessions').get();
  const perClient = new Map();  // clientId → {total, blank, rxSet}
  const rxOnSession = new Set();
  sessSnap.forEach(doc => {
    const cid = doc.ref.parent.parent ? doc.ref.parent.parent.id : '?';
    const rx  = norm(doc.data().rxNumber);
    if (!perClient.has(cid)) perClient.set(cid, { total: 0, blank: 0, rxSet: new Set() });
    const e = perClient.get(cid);
    e.total++;
    if (rx) { e.rxSet.add(rx); rxOnSession.add(rx); } else e.blank++;
  });
  console.log(`  ${sessSnap.size} sessions; ${rxOnSession.size} distinct Rx already on sessions`);

  // helper: find client ids for a homeowner name
  function findClients(name) {
    const n = normName(name), t = tokenKey(name);
    if (byNorm.has(n))  return { ids: byNorm.get(n),  how: 'exact' };
    if (byToken.has(t)) return { ids: byToken.get(t), how: 'token' };
    return { ids: [], how: null };
  }

  // 4) Classify
  const buckets = { RX_ON_SESSION: [], CLIENT_HAS_BLANK_SESS: [], CLIENT_ALL_SESS_RXED: [], CLIENT_NO_SESSIONS: [], CLIENT_NOT_FOUND: [] };
  for (const [rx, { row }] of rxMap) {
    const s = OR.toSessionPatch(row);
    const rec = { rx, name: s.clientName, counselor: s.counselor, guarantor: s.guarantor, type: s.counselingType, opened: s.caseOpenDate };

    if (rxOnSession.has(rx)) { buckets.RX_ON_SESSION.push(rec); continue; }

    const { ids, how } = findClients(s.clientName);
    rec.match = how;
    if (!ids.length) { buckets.CLIENT_NOT_FOUND.push(rec); continue; }
    rec.clientIds = ids;

    // aggregate session stats across matched clients
    let total = 0, blank = 0;
    for (const id of ids) { const e = perClient.get(id); if (e) { total += e.total; blank += e.blank; } }
    rec.clientSessions = total; rec.clientBlankSessions = blank;
    if (total === 0) buckets.CLIENT_NO_SESSIONS.push(rec);
    else if (blank > 0) buckets.CLIENT_HAS_BLANK_SESS.push(rec);
    else buckets.CLIENT_ALL_SESS_RXED.push(rec);
  }

  // 5) Report
  const bar = '═'.repeat(72), N = rxMap.size;
  const p = n => `${String(n).padStart(4)}  (${(100 * n / N).toFixed(1)}%)`;
  console.log('\n' + bar + '\nRX GAP INVESTIGATION  (' + N + ' unique export Rx)\n' + bar);
  console.log(`  RX_ON_SESSION         already linked to a session        ${p(buckets.RX_ON_SESSION.length)}`);
  console.log(`  CLIENT_HAS_BLANK_SESS client exists, has blank-Rx session ${p(buckets.CLIENT_HAS_BLANK_SESS.length)}`);
  console.log(`  CLIENT_ALL_SESS_RXED  client exists, all sessions Rx'd    ${p(buckets.CLIENT_ALL_SESS_RXED.length)}`);
  console.log(`  CLIENT_NO_SESSIONS    client exists, zero sessions        ${p(buckets.CLIENT_NO_SESSIONS.length)}`);
  console.log(`  CLIENT_NOT_FOUND      no client by that name              ${p(buckets.CLIENT_NOT_FOUND.length)}`);

  const clientsExist = buckets.CLIENT_HAS_BLANK_SESS.length + buckets.CLIENT_ALL_SESS_RXED.length + buckets.CLIENT_NO_SESSIONS.length;
  console.log(`\n  → Of the ${N - buckets.RX_ON_SESSION.length} Rx not yet on a session:`);
  console.log(`      client DOES exist : ${clientsExist}`);
  console.log(`      client NOT found  : ${buckets.CLIENT_NOT_FOUND.length}`);

  const sample = (label, arr) => {
    if (!arr.length) return;
    console.log(`\n  ── ${label} (${arr.length}) — first 12 ──`);
    arr.slice(0, 12).forEach(r => console.log(`     ${r.rx}  ${(r.name||'').padEnd(22)} ${(r.guarantor||'').padEnd(10)} ${r.type||''}  opened ${r.opened}${r.match?'  ['+r.match+']':''}${r.clientSessions!=null?'  sess='+r.clientSessions+'/blank='+r.clientBlankSessions:''}`));
    if (arr.length > 12) console.log(`     …and ${arr.length - 12} more`);
  };
  sample('CLIENT_HAS_BLANK_SESS — attach Rx into an existing blank session', buckets.CLIENT_HAS_BLANK_SESS);
  sample('CLIENT_ALL_SESS_RXED — case has no home session (all sessions already Rx\'d)', buckets.CLIENT_ALL_SESS_RXED);
  sample('CLIENT_NO_SESSIONS — client record but no sessions', buckets.CLIENT_NO_SESSIONS);
  sample('CLIENT_NOT_FOUND — no client by name', buckets.CLIENT_NOT_FOUND);

  if (WRITE_JSON) {
    const out = path.join(__dirname, 'rx-gap-investigation.json');
    fs.writeFileSync(out, JSON.stringify({
      totals: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
      uniqueRx: N, clientsExist, notFound: buckets.CLIENT_NOT_FOUND.length,
      buckets,
    }, null, 2));
    console.log(`\nWrote ${out}`);
  }
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
