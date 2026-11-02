'use strict';
const path  = require('path');
const admin = require('firebase-admin');
const saPath = path.join(__dirname, 'housing-counseling-firebase-adminsdk-fbsvc-7c2887a805.json');
admin.initializeApp({ credential: admin.credential.cert(require(saPath)) });
const db = admin.firestore();

const rxToFind = ['1901935', '1901498'];

async function main() {
  const snap = await db.collectionGroup('sessions').get();
  const hits = snap.docs.filter(d => rxToFind.includes(String(d.data().rxNumber || '').trim()));
  console.log(`Sessions carrying Rx ${rxToFind.join(' or ')}:`);
  for (const d of hits) {
    const data = d.data();
    const clientId = d.ref.parent.parent.id;
    const clientDoc = await db.collection('clients').doc(clientId).get();
    const clientName = clientDoc.exists ? clientDoc.data().clientName : '(not found)';
    const date = data.date?.toDate?.() ? data.date.toDate().toLocaleDateString() : data.date;
    console.log(`  client: ${clientName} (${clientId})  rx: ${data.rxNumber}  date: ${date}  type: ${data.counselingType}  source: ${data.source || 'manual'}`);
  }

  const rxSnap = await db.collectionGroup('rxNumbers').get();
  const rxHits = rxSnap.docs.filter(d => rxToFind.includes(String(d.data().rxNumber || '').trim()));
  console.log(`\nrxNumbers subcollection entries:`);
  if (!rxHits.length) { console.log('  (none — not registered to any client)'); }
  for (const d of rxHits) {
    const clientId = d.ref.parent.parent.id;
    const clientDoc = await db.collection('clients').doc(clientId).get();
    const clientName = clientDoc.exists ? clientDoc.data().clientName : '(not found)';
    console.log(`  client: ${clientName} (${clientId})  rx: ${d.data().rxNumber}  guarantor: ${d.data().guarantor}`);
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
