'use strict';

const path  = require('path');
const admin = require('firebase-admin');

const SERVICE_ACCOUNT_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS
  || path.join(__dirname, 'serviceAccount.json');

let serviceAccount;
try {
  serviceAccount = require(SERVICE_ACCOUNT_PATH);
} catch {
  console.error('ERROR: Could not load serviceAccount.json from scripts/');
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// caseNo → correct date (stored as noon local to avoid any timezone shift)
const FIXES = [
  { caseNo: '4214408', date: '2026-04-02', name: 'SHARON BIBLE' },
  { caseNo: '4214191', date: '2026-04-02', name: 'ALEXANDRA GIELAS' },
  { caseNo: '4213717', date: '2026-04-02', name: 'Cassandra L Anderson' },
  { caseNo: '4212702', date: '2026-04-01', name: 'Kelly\'lee Decaria' },
  { caseNo: '4211725', date: '2026-03-31', name: 'LARRY RAY PHILLIPS' },
  { caseNo: '4208245', date: '2026-03-27', name: 'MEGAN LEFEBVRE' },
  { caseNo: '4202964', date: '2026-03-23', name: 'RACHEL WAGSTER' },
  { caseNo: '4200949', date: '2026-03-19', name: 'WILLIAN G JONES' },
  { caseNo: '4197216', date: '2026-03-16', name: 'Deborah A Sterrett' },
  { caseNo: '4192804', date: '2026-03-11', name: 'SHAWNAE SALLIE' },
  { caseNo: '4189128', date: '2026-03-06', name: 'MARK ABELS' },
  { caseNo: '4188605', date: '2026-03-05', name: 'Robert Johnston' },
  { caseNo: '4188281', date: '2026-03-05', name: 'IAN SPIGLER' },
  { caseNo: '4187391', date: '2026-03-04', name: 'Kathleen J Shelhammer' },
  { caseNo: '4187407', date: '2026-03-04', name: 'Joseph Muto' },
  { caseNo: '4180894', date: '2026-02-25', name: 'KATHERINE RUTLEDGE' },
  { caseNo: '4174250', date: '2026-02-17', name: 'Ramona Dawson-Bell' },
  { caseNo: '4173462', date: '2026-02-16', name: 'Craig Harris' },
  { caseNo: '4173329', date: '2026-02-16', name: 'Sean Pacheco' },
  { caseNo: '4171468', date: '2026-02-12', name: 'JOSEPH DOUGHTY' },
  { caseNo: '4169395', date: '2026-02-10', name: 'Stacey L Wiles' },
];

async function run() {
  console.log(`\nFixing dates for ${FIXES.length} records…\n`);

  // Build a lookup map: caseNo → fix
  const fixMap = {};
  for (const fix of FIXES) fixMap[fix.caseNo] = fix;

  // Full collection scan — avoids index/quota issues with where queries
  const snap = await db.collection('counselingLog').get();

  const now = admin.firestore.Timestamp.now();
  const batch = db.batch();
  let fixed = 0;
  const foundCaseNos = new Set();

  for (const docSnap of snap.docs) {
    const caseNo = docSnap.data().caseNo;
    const fix = fixMap[caseNo];
    if (!fix) continue;
    foundCaseNos.add(caseNo);

    const correctDate = admin.firestore.Timestamp.fromDate(
      new Date(fix.date + 'T12:00:00')  // noon local — no timezone slippage
    );
    batch.update(docSnap.ref, { counselingDate: correctDate, updatedAt: now });
    console.log(`  QUEUED  caseNo=${caseNo}  ${fix.name}  → ${fix.date}`);
    fixed++;
  }

  // Report anything not found
  for (const fix of FIXES) {
    if (!foundCaseNos.has(fix.caseNo)) {
      console.log(`  NOT FOUND  caseNo=${fix.caseNo}  (${fix.name})`);
    }
  }

  if (fixed > 0) {
    await batch.commit();
    console.log(`\nCommitted. Fixed: ${fixed}  Not found: ${FIXES.length - fixed}\n`);
  } else {
    console.log('\nNothing to commit.\n');
  }
  process.exit(0);
}

run().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
