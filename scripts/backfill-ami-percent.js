// scripts/backfill-ami-percent.js
// Recalculates amiPercent for all clients that have:
//   - county matching a county in settings/amiLimits
//   - adultsInHousehold + childrenInHousehold > 0
//   - gross monthly income > 0 (from employmentHistory + otherIncome)
//
// Only updates clients whose calculated AMI differs from what's stored.
// Usage:
//   node scripts/backfill-ami-percent.js --dry-run
//   node scripts/backfill-ami-percent.js

const path  = require('path');
const admin = require('firebase-admin');

const saPath = process.env.SERVICE_ACCOUNT
  ? path.resolve(process.env.SERVICE_ACCOUNT)
  : path.resolve(__dirname, 'housing-counseling-firebase-adminsdk-fbsvc-7c2887a805.json');

admin.initializeApp({ credential: admin.credential.cert(require(saPath)) });
const db = admin.firestore();

function calcAmi(client, amiLimits) {
  const rawCounty  = (client.county || '').replace(/\s*county\s*$/i, '').trim();
  const countyKey  = Object.keys(amiLimits).find(k => k.toLowerCase() === rawCounty.toLowerCase());
  const countyData = countyKey ? amiLimits[countyKey] : null;
  const county     = countyKey || rawCounty;
  if (!rawCounty || !countyData) return { pct: null, reason: rawCounty ? `no limits for "${rawCounty}"` : 'county not set' };

  const adults   = parseInt(client.adultsInHousehold)   || 0;
  const children = parseInt(client.childrenInHousehold) || 0;
  if (adults + children === 0) return { pct: null, reason: 'household size is 0' };

  const hhSize = Math.max(1, Math.min(8, adults + children));
  const base   = countyData['100']?.[hhSize - 1] || 0;
  if (!base) return { pct: null, reason: '100% limit not in chart for this household size' };

  const empGross   = (client.employmentHistory || []).reduce((s, e) => s + (parseFloat(e.grossMonthly) || 0), 0);
  const otherGross = (client.otherIncome       || []).reduce((s, i) => s + (parseFloat(i.monthlyAmount) || 0), 0);
  const gross      = empGross + otherGross;
  if (gross <= 0) return { pct: null, reason: 'no income on file' };

  return { pct: Math.round((gross * 12 / base) * 100), county, hhSize, gross };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(dryRun ? '[DRY RUN — no writes]\n' : '[LIVE RUN]\n');

  // Load AMI limits
  const limitsSnap = await db.collection('settings').doc('amiLimits').get();
  if (!limitsSnap.exists) { console.error('settings/amiLimits not found — run seed-ami-limits.js first'); process.exit(1); }
  const amiLimits = limitsSnap.data().counties || {};
  console.log('Loaded AMI limits for:', Object.keys(amiLimits).join(', '));

  // Load all clients, skip soft-deleted ones in JS
  const snap = await db.collection('clients').get();
  const clients = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(c => !c.deleted);
  console.log(`Loaded ${clients.length} clients\n`);

  let updated = 0, skipped = 0, unchanged = 0;
  const BATCH_SIZE = 400;
  let batch = db.batch();
  let batchCount = 0;

  for (const client of clients) {
    const { pct, reason, county, hhSize, gross } = calcAmi(client, amiLimits);

    if (pct === null) {
      console.log(`  SKIP  ${client.clientName || client.id} — ${reason}`);
      skipped++;
      continue;
    }

    const existing = client.amiPercent;
    if (existing === pct) {
      unchanged++;
      continue;
    }

    console.log(`  UPDATE ${client.clientName || client.id} — ${existing ?? '(none)'} → ${pct}%  (${county} Co, ${hhSize}-person, $${Math.round(gross * 12).toLocaleString()}/yr)`);

    if (!dryRun) {
      batch.update(db.collection('clients').doc(client.id), {
        amiPercent: pct,
        updatedAt:  admin.firestore.FieldValue.serverTimestamp(),
      });
      batchCount++;
      updated++;

      if (batchCount >= BATCH_SIZE) {
        await batch.commit();
        batch = db.batch();
        batchCount = 0;
      }
    } else {
      updated++;
    }
  }

  if (!dryRun && batchCount > 0) await batch.commit();

  console.log(`\n— Done —`);
  console.log(`  Updated:   ${updated}`);
  console.log(`  Unchanged: ${unchanged}`);
  console.log(`  Skipped:   ${skipped} (missing county, household size, or income)`);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
