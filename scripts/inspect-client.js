'use strict';
/**
 * inspect-client.js  (READ-ONLY)
 * Usage: node scripts/inspect-client.js "Kendra Coleman"
 */
const path  = require('path');
const admin = require('firebase-admin');

const name  = process.argv[2] || '';
if (!name) { console.error('Usage: node scripts/inspect-client.js "First Last"'); process.exit(1); }

const saPath = path.join(__dirname, 'housing-counseling-firebase-adminsdk-fbsvc-7c2887a805.json');
admin.initializeApp({ credential: admin.credential.cert(require(saPath)) });
const db = admin.firestore();

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

async function main() {
  const snap = await db.collection('clients').get();
  const matches = snap.docs.filter(d => norm(d.data().clientName) === norm(name));

  if (!matches.length) {
    // fuzzy: contains each token
    const tokens = norm(name).split(' ');
    const fuzzy = snap.docs.filter(d => {
      const n = norm(d.data().clientName);
      return tokens.every(t => n.includes(t));
    });
    if (!fuzzy.length) { console.log(`No client found matching "${name}"`); process.exit(0); }
    console.log(`Exact match not found. Fuzzy matches:\n`);
    fuzzy.forEach(d => console.log(`  ${d.id}  ${d.data().clientName}`));
    // proceed with fuzzy matches
    matches.push(...fuzzy);
  }

  for (const clientDoc of matches) {
    const c = clientDoc.data();
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`CLIENT: ${c.clientName}  (id: ${clientDoc.id})`);
    console.log(`  status: ${c.status}  counselor: ${c.counselor}  counselingType: ${c.counselingType}`);
    console.log(`  reCode: ${c.reCode}  amiLabel: ${c.amiLabel}  amiPercent: ${c.amiPercent}`);
    console.log(`  createdAt: ${c.createdAt?.toDate?.()}`);

    // Sessions
    const sessSnap = await db.collection('clients').doc(clientDoc.id).collection('sessions').orderBy('date').get();
    console.log(`\n  SESSIONS (${sessSnap.size}):`);
    if (!sessSnap.size) {
      console.log('    (none)');
    } else {
      sessSnap.docs.forEach((s, i) => {
        const d = s.data();
        const date = d.date?.toDate?.() ? d.date.toDate().toLocaleDateString('en-US') : d.date;
        console.log(`  [${i+1}] ${date}  type=${d.counselingType}  hudType=${d.hudType}  hours=${d.hours}`);
        console.log(`       rx="${d.rxNumber || ''}"  counselor=${d.counselor || ''}  source=${d.source || 'manual'}`);
        if (d.workshopName) console.log(`       workshopName=${d.workshopName}  workshopId=${d.workshopId}`);
        if (d.notes) console.log(`       notes=${d.notes}`);
      });
    }

    // rxNumbers subcollection
    const rxSnap = await db.collection('clients').doc(clientDoc.id).collection('rxNumbers').get();
    console.log(`\n  RX NUMBERS subcollection (${rxSnap.size}):`);
    if (!rxSnap.size) {
      console.log('    (none)');
    } else {
      rxSnap.docs.forEach(r => {
        const d = r.data();
        console.log(`    ${r.id}  rxNumber="${d.rxNumber}"  guarantor=${d.guarantor}  active=${d.active}`);
      });
    }
  }
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
