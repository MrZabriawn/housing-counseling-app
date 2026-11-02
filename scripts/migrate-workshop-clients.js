'use strict';
/**
 * migrate-workshop-clients.js
 *
 * Phase 1 (--dry-run, default): scan only, print what would happen.
 * Phase 2 (--execute):
 *   a) Create one legacy `workshops` doc per unique session date cluster.
 *   b) Soft-delete duplicate sessions on each workshop-only client.
 *   c) Soft-delete the 131 workshop-only client records.
 *
 * The one real client (has non-workshop counseling sessions) is skipped.
 *
 * Safe to re-run: workshop docs are keyed by date string and only created
 * if one doesn't exist for that date; client records already deleted are skipped.
 */
const path  = require('path');
const admin = require('firebase-admin');
const saPath = path.join(__dirname, 'housing-counseling-firebase-adminsdk-fbsvc-7c2887a805.json');
admin.initializeApp({ credential: admin.credential.cert(require(saPath)) });
const db = admin.firestore();

const DRY_RUN = !process.argv.includes('--execute');
const WORKSHOP_TYPES  = new Set(['Workshop', 'WORKSHOP', 'Group Education']);
const COUNSELING_TYPES = new Set(['OUTSTANDING', 'PRE', 'POST', 'COURT', 'Case Management']);

function toDateStr(ts) {
  if (!ts) return null;
  const d = ts.toDate ? ts.toDate() : (ts instanceof Date ? ts : new Date(ts));
  return d.toISOString().split('T')[0];
}
function fmtDate(str) {
  if (!str) return 'unknown';
  const [y, m, d] = str.split('-');
  return new Date(parseInt(y), parseInt(m)-1, parseInt(d))
    .toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
}

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN (no writes) ===' : '=== EXECUTE MODE ===');

  // 1. Load all WORKSHOP-type clients
  const clientSnap = await db.collection('clients').get();
  const workshopClients = clientSnap.docs.filter(d =>
    WORKSHOP_TYPES.has(d.data().counselingType) && !d.data().deleted
  );
  console.log(`\nWORKSHOP-type clients (not yet deleted): ${workshopClients.length}`);

  // 2. Load sessions for each; classify
  const toDelete   = []; // { clientId, clientName, sessions[], dupeIds[] }
  const toKeep     = []; // has real counseling sessions

  for (const cd of workshopClients) {
    const c = cd.data();
    const sessSnap = await db.collection('clients').doc(cd.id).collection('sessions').get();
    const sessions = sessSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const active   = sessions.filter(s => !s.deleted);

    const hasCounseling = active.some(s => COUNSELING_TYPES.has(s.counselingType));
    if (hasCounseling) { toKeep.push({ id: cd.id, name: c.clientName }); continue; }

    // Find duplicates (same date + type + rx key)
    const seen = new Map();
    const dupeIds = [];
    for (const s of active) {
      const key = `${toDateStr(s.date)}|${s.counselingType}|${s.rxNumber || ''}`;
      if (seen.has(key)) dupeIds.push(s.id);
      else seen.set(key, s.id);
    }

    toDelete.push({ clientId: cd.id, clientName: c.clientName, sessions: active, dupeIds });
  }

  console.log(`  → workshop-only (will soft-delete): ${toDelete.length}`);
  console.log(`  → has counseling (keep):            ${toKeep.length}`);
  toKeep.forEach(r => console.log(`    KEEP: ${r.name} (${r.id})`));

  // 3. Cluster workshop dates across all to-delete clients
  const dateMap = new Map(); // dateStr → { clients[], counselors: Set }
  for (const r of toDelete) {
    for (const s of r.sessions) {
      const dateStr = toDateStr(s.date);
      if (!dateStr) continue;
      if (!dateMap.has(dateStr)) dateMap.set(dateStr, { clients: [], counselors: new Set() });
      const entry = dateMap.get(dateStr);
      if (!entry.clients.includes(r.clientName)) entry.clients.push(r.clientName);
      if (s.counselor) entry.counselors.add(s.counselor);
    }
  }

  const sortedDates = [...dateMap.keys()].sort();
  console.log(`\nUnique workshop dates found: ${sortedDates.length}`);
  sortedDates.forEach(d => {
    const e = dateMap.get(d);
    console.log(`  ${fmtDate(d)}  (${e.clients.length} attendees, counselors: ${[...e.counselors].join(', ') || 'none'})`);
  });

  const totalDupes = toDelete.reduce((n, r) => n + r.dupeIds.length, 0);
  console.log(`\nDuplicate sessions to remove: ${totalDupes}`);
  console.log(`Client records to soft-delete: ${toDelete.length}`);

  if (DRY_RUN) {
    console.log('\nDry run complete. Run with --execute to apply.');
    process.exit(0);
  }

  // ── EXECUTE ──────────────────────────────────────────────────────────────────

  const now = admin.firestore.FieldValue.serverTimestamp();

  // 4. Create legacy workshop docs (one per date, idempotent)
  console.log('\nCreating legacy workshop docs…');
  const workshopIdByDate = new Map();
  for (const dateStr of sortedDates) {
    const e = dateMap.get(dateStr);
    // Check if a legacy workshop for this date already exists
    const existing = await db.collection('workshops')
      .where('legacyDate', '==', dateStr).limit(1).get();
    if (!existing.empty) {
      workshopIdByDate.set(dateStr, existing.docs[0].id);
      console.log(`  [skip] ${fmtDate(dateStr)} — already exists (${existing.docs[0].id})`);
      continue;
    }

    const wsRef = await db.collection('workshops').add({
      title:       `Legacy Workshop — ${fmtDate(dateStr)}`,
      subtitle:    'Retroactive record from sign-in sheet',
      legacyDate:  dateStr,
      date:        new Date(dateStr + 'T12:00:00'),
      active:      false,
      legacy:      true,
      counselors:  [...e.counselors],
      locations:   [{ id: 'main', label: 'Main Location', cap: 999, seatCount: e.clients.length }],
      createdAt:   now,
      createdBy:   'workshop-migration',
    });
    workshopIdByDate.set(dateStr, wsRef.id);
    console.log(`  [created] ${fmtDate(dateStr)} → ${wsRef.id}  (${e.clients.length} attendees)`);
  }

  // 5. Soft-delete duplicate sessions
  console.log('\nSoft-deleting duplicate sessions…');
  let dupesDeleted = 0;
  for (const r of toDelete) {
    for (const dupeId of r.dupeIds) {
      await db.collection('clients').doc(r.clientId)
        .collection('sessions').doc(dupeId).update({
          deleted:   true,
          deletedAt: now,
          deletedBy: 'workshop-migration-dedup',
        });
      dupesDeleted++;
    }
  }
  console.log(`  ${dupesDeleted} duplicate sessions removed`);

  // 6. Soft-delete workshop-only client records
  console.log('\nSoft-deleting workshop-only client records…');
  let clientsDeleted = 0;
  for (const r of toDelete) {
    await db.collection('clients').doc(r.clientId).update({
      deleted:     true,
      deletedAt:   now,
      deletedBy:   'workshop-migration',
      deletedNote: 'Workshop-only attendee; not an intake client. See legacy workshops for record.',
    });
    clientsDeleted++;
  }
  console.log(`  ${clientsDeleted} client records soft-deleted`);

  console.log('\n✓ Migration complete.');
  console.log(`  Legacy workshops created: ${workshopIdByDate.size}`);
  console.log(`  Duplicate sessions removed: ${dupesDeleted}`);
  console.log(`  Workshop-only clients archived: ${clientsDeleted}`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
