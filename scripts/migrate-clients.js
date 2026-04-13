'use strict';
/**
 * migrate-clients.js — One-time migration from counselingLog (flat sessions)
 * into the new clients + sessions subcollection architecture.
 *
 * Groups counselingLog records by normalized client name.
 * Existing counselingLog records are NOT deleted — they stay as a backup.
 *
 * Usage: node scripts/migrate-clients.js
 */

const path  = require('path');
const admin = require('firebase-admin');

const SERVICE_ACCOUNT_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS
  || path.join(__dirname, 'serviceAccount.json');

admin.initializeApp({ credential: admin.credential.cert(require(SERVICE_ACCOUNT_PATH)) });
const db = admin.firestore();

function normalizeKey(name) {
  return (name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function toTitleCase(str) {
  return (str || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function toDate(ts) {
  if (!ts) return new Date(0);
  return ts.toDate ? ts.toDate() : new Date(ts);
}

async function run() {
  console.log('\n=== Client Migration ===\n');

  // Load all counselingLog records
  const snap = await db.collection('counselingLog').get();
  const all  = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  console.log(`Loaded ${all.length} counselingLog records.\n`);

  // Group by normalized client name
  const groups = new Map();
  for (const rec of all) {
    const key = normalizeKey(rec.clientName);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  }
  console.log(`Grouped into ${groups.size} unique clients.\n`);

  const now = admin.firestore.Timestamp.now();
  let batch     = db.batch();
  let batchOps  = 0;
  let batchNum  = 0;
  let totalClients  = 0;
  let totalSessions = 0;

  async function flush() {
    if (batchOps === 0) return;
    batchNum++;
    process.stdout.write(`  Committing batch ${batchNum} (${batchOps} ops)… `);
    await batch.commit();
    console.log('done');
    batch = db.batch();
    batchOps = 0;
  }

  for (const [, recs] of groups) {
    // Sort oldest first
    recs.sort((a, b) => toDate(a.counselingDate) - toDate(b.counselingDate));

    const first = recs[0];
    const last  = recs[recs.length - 1];

    // Most recent record with a drive folder
    const withFolder = [...recs].reverse().find(r => r.driveFolderId);

    // All unique Rx numbers (stored as caseNo before the rename)
    const rxNumbers = [...new Set(
      recs.map(r => (r.rxNumber || r.caseNo || '').trim()).filter(Boolean)
    )];

    const totalOutcomeValue = recs.reduce((s, r) => s + (Number(r.dollarsAwarded) || 0), 0);

    const clientData = {
      clientName:        toTitleCase(last.clientName || first.clientName),
      rxNumbers,
      counselingType:    last.counselingType    || first.counselingType    || '',
      counselor:         last.counselor         || first.counselor         || '',
      amiPercent:        last.amiPercent        || first.amiPercent        || '',
      reCode:            last.reCode            || first.reCode            || '',
      hispanic:          !!(last.hispanic       ?? first.hispanic),
      femaleHeaded:      !!(last.femaleHeaded   ?? first.femaleHeaded),
      zipCode:           last.zipCode           || first.zipCode           || '',
      guarantor:         last.guarantor         || first.guarantor         || '',
      areasOfInterest:   [],
      driveFolderId:     withFolder?.driveFolderId   || '',
      driveFolderName:   withFolder?.driveFolderName || '',
      driveFolderUrl:    withFolder?.driveFolderUrl  || '',
      totalDownPayment:  0,
      ccaAmountProvided: 0,
      status:            'active',
      sessionCount:      recs.length,
      totalOutcomeValue,
      firstSessionDate:  first.counselingDate || null,
      lastSessionDate:   last.counselingDate  || null,
      createdAt:         now,
      updatedAt:         now,
    };

    // Flush before adding if batch would overflow (1 client + N sessions)
    if (batchOps + 1 + recs.length > 490) await flush();

    const clientRef = db.collection('clients').doc();
    batch.set(clientRef, clientData);
    batchOps++;
    totalClients++;

    for (const rec of recs) {
      const sessionData = {
        date:            rec.counselingDate || null,
        counselor:       rec.counselor      || '',
        rxNumber:        (rec.rxNumber || rec.caseNo || '').trim(),
        hours:           Number(rec.hours)          || 0,
        ratePerHour:     Number(rec.ratePerHour)    || 0,
        dollarsAwarded:  Number(rec.dollarsAwarded) || 0,
        awardType:       rec.awardType    || '',
        dollarsFor:      rec.dollarsFor   || '',
        caseStatus:      rec.caseStatus   || '',
        outcome:         rec.outcome      || '',
        notes:           rec.notes        || '',
        sourceMonth:     rec.sourceMonth  || '',
        counselingLogId: rec.id,
        createdAt:       rec.createdAt || now,
        updatedAt:       now,
      };
      batch.set(clientRef.collection('sessions').doc(), sessionData);
      batchOps++;
      totalSessions++;
    }
  }

  await flush();

  console.log('\n=== Migration complete ===');
  console.log(`  Clients:  ${totalClients}`);
  console.log(`  Sessions: ${totalSessions}\n`);
  process.exit(0);
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
