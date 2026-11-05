'use strict';
const admin = require('firebase-admin');
const path  = require('path');

const keyFile = process.argv[2];
if (!keyFile) { console.error('Usage: node fix-ami-labels.js <service-account.json>'); process.exit(1); }

admin.initializeApp({ credential: admin.credential.cert(require(path.resolve(keyFile))) });
const db = admin.firestore();

const VALID = new Set(['Extremely Low Income', 'Very Low Income', 'Low Income', 'Non Low-Moderate']);

const LEGACY_MAP = {
  '0-30%':                'Extremely Low Income',
  '<30%':                 'Extremely Low Income',
  'extremely low':        'Extremely Low Income',
  'extremely low income': 'Extremely Low Income',
  '30-49%':               'Very Low Income',
  '30-50%':               'Very Low Income',
  '31-50%':               'Very Low Income',
  'very low':             'Very Low Income',
  'very low income':      'Very Low Income',
  'low':                  'Very Low Income',
  '50-79%':               'Low Income',
  '51-80%':               'Low Income',
  '50-80%':               'Low Income',
  'low income':           'Low Income',
  'moderate':             'Low Income',
  'low-moderate':         'Low Income',
  '80-100%':              'Non Low-Moderate',
  '100+%':                'Non Low-Moderate',
  '>80%':                 'Non Low-Moderate',
  'above 80%':            'Non Low-Moderate',
  'non low-moderate':     'Non Low-Moderate',
  'non low moderate':     'Non Low-Moderate',
  'non-moderate':         'Non Low-Moderate',
  'non moderate':         'Non Low-Moderate',
  'above moderate':       'Non Low-Moderate',
};

function normalize(label, pct) {
  if (label && VALID.has(label)) return null; // already correct
  if (label) {
    const mapped = LEGACY_MAP[label.toLowerCase().trim()];
    if (mapped) return mapped;
  }
  // Fall back to computing from numeric percent
  if (pct != null && pct !== '') {
    const n = Number(pct);
    if (!isNaN(n) && n > 0) {
      if (n <= 30) return 'Extremely Low Income';
      if (n <= 50) return 'Very Low Income';
      if (n <= 80) return 'Low Income';
      return 'Non Low-Moderate';
    }
  }
  return null; // can't fix
}

async function main() {
  const snap = await db.collection('clients').get();
  const updates = [];

  for (const doc of snap.docs) {
    const c = doc.data();
    if (c.deleted) continue;
    const newLabel = normalize(c.amiLabel, c.amiPercent);
    if (!newLabel) continue;
    updates.push({ id: doc.id, from: c.amiLabel || '(none)', to: newLabel });
  }

  if (!updates.length) { console.log('Nothing to update.'); return; }

  // Show summary by old → new
  const summary = {};
  for (const u of updates) {
    const k = `${u.from} → ${u.to}`;
    summary[k] = (summary[k] || 0) + 1;
  }
  console.log(`\nReclassifying ${updates.length} amiLabel values:\n`);
  Object.entries(summary).sort((a,b) => b[1]-a[1]).forEach(([k,n]) => console.log(`  ${n}x  ${k}`));

  for (let i = 0; i < updates.length; i += 500) {
    const batch = db.batch();
    for (const u of updates.slice(i, i + 500)) {
      batch.update(db.collection('clients').doc(u.id), {
        amiLabel:  u.to,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
  }
  console.log(`\nDone. Updated ${updates.length} records.`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => process.exit(0));
