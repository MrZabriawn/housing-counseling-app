'use strict';
const admin = require('firebase-admin');
const path  = require('path');

const keyFile = process.argv[2];
if (!keyFile) { console.error('Usage: node fix-award-types.js <service-account.json>'); process.exit(1); }

admin.initializeApp({ credential: admin.credential.cert(require(path.resolve(keyFile))) });
const db = admin.firestore();

// Keywords that indicate Direct Assistance (grants, CCA, PAHAF, closing cost funds)
const DIRECT = [/\bCCA\b/i, /\bPAHAF\b/i, /closing cost/i, /forgivable/i, /grant/i];
// Keywords that indicate Loan Modification (reinstatements, deed-in-lieu, etc.)
const LOAN_MOD = [/reinstated/i, /reinstatement/i, /deed.in.lieu/i, /hemap/i, /chapter 13/i, /bankruptcy/i];

function classify(outcome) {
  const text = outcome || '';
  if (LOAN_MOD.some(re => re.test(text))) return 'Loan Modification';
  if (DIRECT.some(re => re.test(text)))   return 'Direct Assistance';
  return null; // can't determine
}

async function main() {
  const snap = await db.collection('clients')
    .where('status', '==', 'closed')
    .get();

  const updates = [];

  for (const doc of snap.docs) {
    const c = doc.data();
    if (c.deleted) continue;
    const val  = Number(c.closureOutcomeValue) || 0;
    const type = c.closureAwardType || '';
    if (!val) continue;
    if (type !== 'Other' && type !== '') continue; // only fix miscategorized records

    const newType = classify(c.closureOutcome);
    if (!newType) continue; // leave ambiguous records alone

    updates.push({
      id:      doc.id,
      from:    type || '(none)',
      to:      newType,
      outcome: c.closureOutcome || '(none)',
      val,
    });
  }

  if (!updates.length) {
    console.log('Nothing to update.');
    return;
  }

  console.log(`\nReclassifying ${updates.length} records:\n`);
  for (const u of updates) {
    console.log(`  [${u.from} → ${u.to}]  $${u.val.toLocaleString()}  |  ${u.outcome}`);
  }

  // Apply in batches of 500
  let count = 0;
  for (let i = 0; i < updates.length; i += 500) {
    const batch = db.batch();
    for (const u of updates.slice(i, i + 500)) {
      batch.update(db.collection('clients').doc(u.id), {
        closureAwardType: u.to,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
    count += updates.slice(i, i + 500).length;
  }

  console.log(`\nDone. Updated ${count} records.`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => process.exit(0));
