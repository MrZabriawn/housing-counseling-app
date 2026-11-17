'use strict';
const admin = require('firebase-admin');
const path  = require('path');

const keyFile = process.argv[2];
if (!keyFile) { console.error('Usage: node clear-stale-qrew-jobs.js <service-account.json>'); process.exit(1); }

admin.initializeApp({ credential: admin.credential.cert(require(path.resolve(keyFile))) });
const db = admin.firestore();

// LDD008 and CET009 have qrewJobId values pointing at deleted Qrew jobs.
// Clear those fields so the UI shows them as unlinked rather than broken.
// Firestore doc IDs for Mark Abels (Qrew LDD008) and Mark Arner (Qrew CET009)
const STALE_IDS = ['gnq4PFqyeHsjH2baYl78', 'oRxwRaYQPLFTSGZh0FrS'];

async function main() {
  for (const docId of STALE_IDS) {
    const ref = db.collection('higWaitlist').doc(docId);
    const snap = await ref.get();
    if (!snap.exists) {
      console.log(`${docId}: not found — skipping`);
      continue;
    }
    const data = snap.data();
    if (!data.qrewJobId && !data.qrewJobCode) {
      console.log(`${docId}: no qrewJobId/qrewJobCode present — nothing to do`);
      continue;
    }
    console.log(`${docId}: clearing qrewJobId=${data.qrewJobId}  qrewJobCode=${data.qrewJobCode}`);
    await ref.update({
      qrewJobId:   admin.firestore.FieldValue.delete(),
      qrewJobCode: admin.firestore.FieldValue.delete(),
    });
    console.log(`${docId}: cleared`);
  }
  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
