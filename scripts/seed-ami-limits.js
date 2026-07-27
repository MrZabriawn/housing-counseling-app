// scripts/seed-ami-limits.js
// Seeds 2026 HUD AMI income limits into Firestore (settings/amiLimits).
// Merges with existing data so any already-entered county (e.g. Allegheny) is preserved.
// Usage: node scripts/seed-ami-limits.js
//        node scripts/seed-ami-limits.js --dry-run

const path         = require('path');
const admin        = require('firebase-admin');

const saPath = process.env.SERVICE_ACCOUNT
  ? path.resolve(process.env.SERVICE_ACCOUNT)
  : path.resolve(__dirname, 'housing-counseling-firebase-adminsdk-fbsvc-7c2887a805.json');

admin.initializeApp({ credential: admin.credential.cert(require(saPath)) });
const db = admin.firestore();

// 2026 HUD AMI Income Limits — array index 0 = 1-person household, index 7 = 8-person
// Source: HUD published limits (Beaver, Mercer, Lawrence counties PA)
const LIMITS_2026 = {
  Beaver: {
    '30':  [23200,  26500,  29800,  33100,  38650,  44360,  50040,  55720],
    '50':  [37600,  44200,  49700,  55200,  59650,  64050,  68450,  72900],
    '60':  [45050,  51500,  57950,  64400,  69550,  74700,  79850,  85000],
    '80':  [61850,  70650,  79500,  88300,  95400, 102450, 109500, 116600],
    '100': [75100,  85850,  96550, 107300, 115900, 124450, 133050, 141650],
    '120': [90150, 103000, 115900, 128750, 139050, 149350, 159650, 169950],
  },
  Mercer: {
    '30':  [18250,  21640,  27320,  33100,  38680,  44360,  50040,  55720],
    '50':  [30450,  34800,  39150,  43450,  46950,  50450,  53900,  57400],
    '60':  [38050,  46500,  51950,  59200,  63550,  69200,  75550,  80800],
    '80':  [48650,  55600,  62550,  69500,  75190,  80650,  86200,  91750],
    '100': [58500,  65200,  72100,  79100,  85500,  90200,  96800, 101500],
    '120': [70100,  75500,  82900,  90200,  96500, 101200, 107200, 110500],
  },
  Lawrence: {
    // Lawrence and Mercer share the same 2026 HUD limits (same MSA grouping)
    '30':  [18250,  21640,  27320,  33100,  38680,  44360,  50040,  55720],
    '50':  [30450,  34800,  39150,  43450,  46950,  50450,  53900,  57400],
    '60':  [38050,  46500,  51950,  59200,  63550,  69200,  75550,  80800],
    '80':  [48650,  55600,  62550,  69500,  75190,  80650,  86200,  91750],
    '100': [58500,  65200,  72100,  79100,  85500,  90200,  96800, 101500],
    '120': [70100,  75500,  82900,  90200,  96500, 101200, 107200, 110500],
  },
};

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  // Preserve any existing county data (e.g. Allegheny entered via Settings UI)
  const existingSnap = await db.collection('settings').doc('amiLimits').get();
  const existing     = existingSnap.exists ? (existingSnap.data().counties || {}) : {};

  const merged = { ...existing, ...LIMITS_2026 };

  console.log('Counties to seed:', Object.keys(LIMITS_2026).join(', '));
  if (existing.Allegheny) console.log('Allegheny already present — preserved as-is.');
  if (dryRun) {
    console.log('[DRY RUN — no writes]');
    console.log(JSON.stringify({ counties: merged }, null, 2));
    process.exit(0);
  }

  await db.collection('settings').doc('amiLimits').set({ counties: merged });
  console.log('Done. settings/amiLimits updated with Beaver, Mercer, Lawrence 2026 limits.');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
