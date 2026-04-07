/**
 * migrate.js — One-time migration from SUPER_DUPER_MASTER_COUNSELING_LOG.xlsx to Firestore
 *
 * Usage:
 *   1. Run:  npm install
 *   2. Place your Firebase service account JSON at scripts/serviceAccount.json
 *      OR set the GOOGLE_APPLICATION_CREDENTIALS env var to its path.
 *   3. Place SUPER_DUPER_MASTER_COUNSELING_LOG.xlsx in the project root.
 *   4. Run:  npm run migrate
 *
 * Column mapping (A=0 … O=14):
 *   A  caseNo          B  counselingDate   C  counselor
 *   D  clientName      E  counselingType   F  guarantor
 *   G  zipCode         H  amiPercent       I  dollarsAwarded
 *   J  awardType       K  caseStatus       L  dollarsFor
 *   M  outcome         N  notes            O  sourceMonth
 */

'use strict';

const path  = require('path');
const admin = require('firebase-admin');
const XLSX  = require('xlsx');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const EXCEL_FILE          = path.join(__dirname, '..', 'SUPER_DUPER_MASTER_COUNSELING_LOG.xlsx');
const SHEET_NAME          = 'Master Log';
const SERVICE_ACCOUNT_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS
  || path.join(__dirname, 'serviceAccount.json');
const BATCH_SIZE          = 400; // Firestore max is 500; stay under it
// ─────────────────────────────────────────────────────────────────────────────

// ── Initialize Firebase Admin ──────────────────────────────────────────────────
let serviceAccount;
try {
  serviceAccount = require(SERVICE_ACCOUNT_PATH);
} catch {
  console.error(`\nERROR: Could not load service account from:\n  ${SERVICE_ACCOUNT_PATH}`);
  console.error('Place serviceAccount.json in scripts/ or set GOOGLE_APPLICATION_CREDENTIALS.\n');
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── Helpers ────────────────────────────────────────────────────────────────────

function parseExcelDate(raw) {
  if (!raw) return null;
  if (typeof raw === 'number') {
    // Excel serial date
    const parsed = XLSX.SSF.parse_date_code(raw);
    return admin.firestore.Timestamp.fromDate(
      new Date(parsed.y, parsed.m - 1, parsed.d)
    );
  }
  const d = new Date(raw);
  return isNaN(d) ? null : admin.firestore.Timestamp.fromDate(d);
}

function str(val) {
  return String(val ?? '').trim();
}

function num(val) {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : n;
}

const COURT_RATE   = 2.0;
const DEFAULT_RATE = 48.5;

// ── Main migration ─────────────────────────────────────────────────────────────

async function migrate() {
  console.log('\n=== Housing Counseling Migration ===');
  console.log(`Reading: ${EXCEL_FILE}\n`);

  let workbook;
  try {
    workbook = XLSX.readFile(EXCEL_FILE);
  } catch (err) {
    console.error(`ERROR: Could not read Excel file:\n  ${err.message}\n`);
    process.exit(1);
  }

  const sheet = workbook.Sheets[SHEET_NAME];
  if (!sheet) {
    const available = workbook.SheetNames.join(', ');
    console.error(`ERROR: Sheet "${SHEET_NAME}" not found.\nAvailable sheets: ${available}\n`);
    process.exit(1);
  }

  // Read all rows as arrays (row 0 = header, data starts at row 1)
  const allRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const dataRows = allRows.slice(1); // skip header row
  console.log(`Found ${dataRows.length} data row(s) (header excluded).\n`);

  const now = admin.firestore.Timestamp.now();
  let added   = 0;
  let skipped = 0;
  let batchNum = 0;

  for (let i = 0; i < dataRows.length; i += BATCH_SIZE) {
    const chunk = dataRows.slice(i, i + BATCH_SIZE);
    const writeBatch = db.batch();
    let batchWrites = 0;

    for (let j = 0; j < chunk.length; j++) {
      const excelRow = i + j + 2; // 1-indexed row number in Excel (2 = first data row)
      const row = chunk[j];

      // Column D (index 3) = clientName — skip if blank
      const clientName = str(row[3]);
      if (!clientName) {
        console.log(`  Row ${excelRow}: SKIPPED — blank clientName`);
        skipped++;
        continue;
      }

      const counselingType = str(row[4]);
      const dollarsAwarded = num(row[8]);
      const rate = counselingType === 'COURT' ? COURT_RATE : DEFAULT_RATE;
      const hours = rate > 0 ? parseFloat((dollarsAwarded / rate).toFixed(2)) : 0;

      const record = {
        // Core columns A–O
        caseNo:         str(row[0]),
        counselingDate: parseExcelDate(row[1]),
        counselor:      str(row[2]),
        clientName:     clientName,
        counselingType: counselingType,
        guarantor:      str(row[5]),
        zipCode:        str(row[6]),
        amiPercent:     str(row[7]),
        dollarsAwarded: dollarsAwarded,
        awardType:      str(row[9]),
        caseStatus:     str(row[10]),
        dollarsFor:     str(row[11]),
        outcome:        str(row[12]),
        notes:          str(row[13]),
        sourceMonth:    str(row[14]),

        // Derived / defaulted fields
        ratePerHour:    rate,
        hours:          hours,
        hispanic:       false,
        femaleHeaded:   false,
        reCode:         '',

        // Timestamps
        createdAt: now,
        updatedAt: now,
      };

      const docRef = db.collection('counselingLog').doc();
      writeBatch.set(docRef, record);
      batchWrites++;
      added++;
    }

    if (batchWrites > 0) {
      batchNum++;
      process.stdout.write(`  Committing batch ${batchNum} (${batchWrites} records)… `);
      await writeBatch.commit();
      console.log(`done. [total added: ${added}]`);
    }
  }

  console.log('\n=== Migration complete ===');
  console.log(`  Added:   ${added}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Total rows processed: ${dataRows.length}\n`);
  process.exit(0);
}

migrate().catch(err => {
  console.error('\nMigration failed:', err);
  process.exit(1);
});
