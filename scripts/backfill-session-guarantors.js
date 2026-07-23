'use strict';
/**
 * backfill-session-guarantors.js
 *
 * For each client, reads their rxNumbers subcollection to build a
 * rxNumber → guarantor map, then finds sessions that have an rxNumber
 * but no rxGuarantor and patches them.
 *
 * Usage:
 *   node scripts/backfill-session-guarantors.js
 *   node scripts/backfill-session-guarantors.js --dry-run
 */

const path  = require('path');
const admin = require('firebase-admin');

const DRY_RUN = process.argv.includes('--dry-run');
const saPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  || path.join(__dirname, 'serviceAccount.json');

admin.initializeApp({
  credential: admin.credential.cert(require(path.resolve(saPath))),
});
const db = admin.firestore();

async function main() {
  console.log(DRY_RUN ? '--- DRY RUN ---' : '--- LIVE RUN ---');

  const clientSnap = await db.collection('clients').get();
  console.log(`Found ${clientSnap.size} clients`);

  let totalPatched = 0;
  let totalSkipped = 0;
  let totalNoMatch = 0;

  for (const clientDoc of clientSnap.docs) {
    const clientId = clientDoc.id;

    // Build rxNumber → guarantor map from this client's rxNumbers subcollection
    const rxSnap = await db.collection('clients').doc(clientId).collection('rxNumbers').get();
    if (rxSnap.empty) continue;

    const rxMap = {};
    rxSnap.docs.forEach(d => {
      const r = d.data();
      if (r.rxNumber && r.guarantor) {
        rxMap[r.rxNumber.trim()] = r.guarantor;
      }
    });
    if (!Object.keys(rxMap).length) continue;

    // Load sessions for this client
    const sessSnap = await db.collection('clients').doc(clientId).collection('sessions').get();
    if (sessSnap.empty) continue;

    const batch = db.batch();
    let batchCount = 0;

    for (const sessDoc of sessSnap.docs) {
      const s = sessDoc.data();
      const rxNum = (s.rxNumber || '').trim();

      // Skip if already has a guarantor or no rx number
      if (!rxNum || s.rxGuarantor) {
        totalSkipped++;
        continue;
      }

      const guarantor = rxMap[rxNum];
      if (!guarantor) {
        totalNoMatch++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`  [DRY] ${clientId}/${sessDoc.id}  rx=${rxNum}  → guarantor=${guarantor}`);
      } else {
        batch.update(sessDoc.ref, { rxGuarantor: guarantor });
      }
      batchCount++;
      totalPatched++;
    }

    if (!DRY_RUN && batchCount > 0) {
      await batch.commit();
      console.log(`  ${clientId}: patched ${batchCount} session(s)`);
    }
  }

  console.log('\n── Summary ──────────────────────────────');
  console.log(`  Patched : ${totalPatched}`);
  console.log(`  Skipped (already set or no rx): ${totalSkipped}`);
  console.log(`  No match in rxNumbers: ${totalNoMatch}`);
  if (DRY_RUN) console.log('\nRe-run without --dry-run to apply changes.');
}

main().catch(err => { console.error(err); process.exit(1); });
