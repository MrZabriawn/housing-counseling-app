'use strict';
const admin = require('firebase-admin');
const path  = require('path');

const keyFile = process.argv[2];
if (!keyFile) { console.error('Usage: node inspect-award-types.js <service-account.json>'); process.exit(1); }

admin.initializeApp({ credential: admin.credential.cert(require(path.resolve(keyFile))) });
const db = admin.firestore();

async function main() {
  const now   = new Date();
  const start = new Date(now);
  start.setMonth(start.getMonth() - 12);

  const { Timestamp } = admin.firestore;
  const snap = await db.collection('clients')
    .where('closureDate', '>=', Timestamp.fromDate(start))
    .where('closureDate', '<=', Timestamp.fromDate(now))
    .get();

  const other = [], none = [];
  for (const doc of snap.docs) {
    const c = doc.data();
    if (c.deleted || c.status !== 'closed') continue;
    const val = Number(c.closureOutcomeValue) || 0;
    if (!val) continue;
    const type = c.closureAwardType || '';
    if (!type) none.push({ val, outcome: c.closureOutcome || '(none)' });
    else if (type === 'Other') other.push({ val, outcome: c.closureOutcome || '(none)' });
  }

  console.log('\n=== closureAwardType: (none) ===');
  none.sort((a,b) => b.val - a.val).forEach(r =>
    console.log(`  $${r.val.toLocaleString('en-US', {minimumFractionDigits:2})}  |  ${r.outcome}`)
  );
  console.log(`  TOTAL: $${none.reduce((s,r)=>s+r.val,0).toLocaleString('en-US', {minimumFractionDigits:2})} across ${none.length} cases`);

  console.log('\n=== closureAwardType: Other ===');
  other.sort((a,b) => b.val - a.val).forEach(r =>
    console.log(`  $${r.val.toLocaleString('en-US', {minimumFractionDigits:2})}  |  ${r.outcome}`)
  );
  console.log(`  TOTAL: $${other.reduce((s,r)=>s+r.val,0).toLocaleString('en-US', {minimumFractionDigits:2})} across ${other.length} cases`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => process.exit(0));
