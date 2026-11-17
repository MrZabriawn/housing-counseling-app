'use strict';
const admin = require('firebase-admin');
const path  = require('path');

const keyFile = process.argv[2];
if (!keyFile) { console.error('Usage: node scan-qrew-jobs.js <service-account.json>'); process.exit(1); }

admin.initializeApp({ credential: admin.credential.cert(require(path.resolve(keyFile))) });
const db = admin.firestore();

async function main() {
  const snap = await db.collection('higWaitlist').get();
  console.log(`Total higWaitlist docs: ${snap.size}\n`);
  for (const doc of snap.docs) {
    const d = doc.data();
    if (d.qrewJobId || d.qrewJobCode) {
      console.log(`docId=${doc.id}  name=${d.clientName || d.name || '?'}  qrewJobId=${d.qrewJobId || ''}  qrewJobCode=${d.qrewJobCode || ''}`);
    }
  }
  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
