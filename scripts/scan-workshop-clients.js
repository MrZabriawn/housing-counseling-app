'use strict';
/**
 * scan-workshop-clients.js  (READ-ONLY)
 * Finds clients whose counselingType is WORKSHOP/Workshop/Group Education
 * and classifies their session history.
 *
 * Buckets:
 *   WORKSHOP_ONLY       — all sessions are workshop/group-ed type (or no sessions)
 *   HAS_COUNSELING      — has at least one non-workshop session (real intake client)
 *
 * Also reports duplicate sessions within any client.
 */
const path  = require('path');
const admin = require('firebase-admin');
const saPath = path.join(__dirname, 'housing-counseling-firebase-adminsdk-fbsvc-7c2887a805.json');
admin.initializeApp({ credential: admin.credential.cert(require(saPath)) });
const db = admin.firestore();

const WORKSHOP_TYPES = new Set(['Workshop', 'WORKSHOP', 'Group Education']);
const COUNSELING_TYPES = new Set(['OUTSTANDING', 'PRE', 'POST', 'COURT', 'Case Management']);

async function main() {
  // Load all clients flagged as WORKSHOP counselingType
  const clientSnap = await db.collection('clients').get();
  const workshopClients = clientSnap.docs.filter(d => {
    const ct = d.data().counselingType || '';
    return WORKSHOP_TYPES.has(ct);
  });
  console.log(`Total clients: ${clientSnap.size}`);
  console.log(`Clients with WORKSHOP counselingType: ${workshopClients.length}\n`);

  const workshopOnly   = [];
  const hasCounseling  = [];
  const withDuplicates = [];

  for (const cd of workshopClients) {
    const c = cd.data();
    const sessSnap = await db.collection('clients').doc(cd.id).collection('sessions').get();
    const sessions = sessSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const active   = sessions.filter(s => !s.deleted);

    const counselingSessions = active.filter(s => COUNSELING_TYPES.has(s.counselingType));
    const workshopSessions   = active.filter(s => WORKSHOP_TYPES.has(s.counselingType));

    // Detect duplicates: same date + same counselingType
    const seen = new Map();
    const dupes = [];
    for (const s of active) {
      const dateStr = s.date?.toDate ? s.date.toDate().toISOString().split('T')[0]
        : (s.date instanceof Date ? s.date.toISOString().split('T')[0] : String(s.date));
      const key = `${dateStr}|${s.counselingType}|${s.rxNumber || ''}`;
      if (seen.has(key)) dupes.push({ keep: seen.get(key), remove: s.id, key });
      else seen.set(key, s.id);
    }

    const row = {
      id:            cd.id,
      name:          c.clientName,
      counselor:     c.counselor,
      status:        c.status,
      totalSessions: active.length,
      workshopSess:  workshopSessions.length,
      counselingSess: counselingSessions.length,
      dupes,
    };

    if (counselingSessions.length > 0) hasCounseling.push(row);
    else workshopOnly.push(row);

    if (dupes.length > 0) withDuplicates.push(row);
  }

  const bar = '═'.repeat(70);
  console.log(bar);
  console.log(`WORKSHOP_ONLY (no real counseling sessions): ${workshopOnly.length}`);
  workshopOnly.forEach(r => {
    const d = r.dupes.length ? `  ⚠ ${r.dupes.length} dupe pair(s)` : '';
    console.log(`  ${r.name.padEnd(30)} sess=${r.totalSessions} ws=${r.workshopSess}${d}`);
  });

  console.log(`\n${bar}`);
  console.log(`HAS_COUNSELING (real intake, also has workshop sessions): ${hasCounseling.length}`);
  hasCounseling.forEach(r => {
    console.log(`  ${r.name.padEnd(30)} counseling=${r.counselingSess} workshop=${r.workshopSess}`);
  });

  console.log(`\n${bar}`);
  console.log(`CLIENTS WITH DUPLICATE SESSIONS: ${withDuplicates.length}`);
  withDuplicates.forEach(r => {
    console.log(`\n  ${r.name} (${r.id})`);
    r.dupes.forEach(d => console.log(`    dupe: key="${d.key}"  keep=${d.keep}  remove=${d.remove}`));
  });

  console.log(`\n${bar}`);
  console.log('SUMMARY');
  console.log(`  Workshop-only clients (candidates for removal/migration): ${workshopOnly.length}`);
  console.log(`  Real intake clients with workshop sessions (keep as-is):  ${hasCounseling.length}`);
  console.log(`  Clients with duplicate sessions:                          ${withDuplicates.length}`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
