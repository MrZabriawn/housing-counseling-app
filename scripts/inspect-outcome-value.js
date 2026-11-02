'use strict';
const admin = require('firebase-admin');
const path  = require('path');

const keyFile = process.argv[2];
if (!keyFile) { console.error('Usage: node inspect-outcome-value.js <service-account.json>'); process.exit(1); }

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

  const rows = [];
  for (const doc of snap.docs) {
    const c = doc.data();
    if (c.deleted || c.status !== 'closed') continue;
    const val = Number(c.closureOutcomeValue) || 0;
    if (val > 0) {
      rows.push({
        awardType:    c.closureAwardType || '(none)',
        outcome:      c.closureOutcome   || '(none)',
        value:        val,
        closureDate:  c.closureDate?.toDate?.().toISOString().split('T')[0] ?? '',
      });
    }
  }

  // Sort descending by value
  rows.sort((a, b) => b.value - a.value);

  // Group by awardType
  const byType = {};
  for (const r of rows) {
    if (!byType[r.awardType]) byType[r.awardType] = { count: 0, total: 0 };
    byType[r.awardType].count++;
    byType[r.awardType].total += r.value;
  }

  console.log('\n=== By Award Type ===');
  const typeEntries = Object.entries(byType).sort((a, b) => b[1].total - a[1].total);
  for (const [type, { count, total }] of typeEntries) {
    console.log(`  ${type.padEnd(30)} ${count} cases   $${total.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  }
  const grand = rows.reduce((s, r) => s + r.value, 0);
  console.log(`  ${'TOTAL'.padEnd(30)} ${rows.length} cases   $${grand.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);

  console.log('\n=== Top 20 individual records ===');
  for (const r of rows.slice(0, 20)) {
    console.log(`  ${r.closureDate}  $${String(r.value.toFixed(2)).padStart(14)}  [${r.awardType}]  ${r.outcome}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => process.exit(0));
