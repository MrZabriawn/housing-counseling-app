'use strict';
// One-time backfill: imports historical billing register entries from the
// Housing Opportunities Financial Outlook PDF (Jan 2026 – Sep 2026).
// Safe to re-run — does not deduplicate, so only run once.

const admin = require('firebase-admin');
const serviceAccount = require('./housing-counseling-firebase-adminsdk-fbsvc-7c2887a805.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const TS   = admin.firestore.FieldValue.serverTimestamp();
const BASE = { sourceType: 'manual', sourceId: null, paidAmount: null, paidDate: null, createdBy: 'backfill', createdAt: TS };

// Rows transcribed from the Financial Outlook PDF.
// 'notes' field holds the billing stream (D&D, F2F, M&D, HUD, TMCRF, YOUTH).
// Three May and one June row had no program/stream visible in the PDF — flagged.
const ENTRIES = [
  // ── January 2026 ─────────────────────────────────────────────────────────
  { program: 'CHCI',  billingMonth: 'Jan 2026', amount: 7200.00,  status: 'paid',   notes: 'D&D' },
  { program: 'CHCI',  billingMonth: 'Jan 2026', amount: 1600.00,  status: 'paid',   notes: 'F2F' },
  { program: 'CHCI',  billingMonth: 'Jan 2026', amount: 2400.00,  status: 'paid',   notes: 'M&D' },
  { program: 'HUD',   billingMonth: 'Jan 2026', amount: 4694.36,  status: 'paid',   notes: 'HUD' },
  { program: 'HUD',   billingMonth: 'Jan 2026', amount: 877.55,   status: 'paid',   notes: 'TMCRF' },
  // ── February 2026 ────────────────────────────────────────────────────────
  { program: 'CHCI',  billingMonth: 'Feb 2026', amount: 2000.00,  status: 'paid',   notes: 'D&D' },
  { program: 'CHCI',  billingMonth: 'Feb 2026', amount: 3400.00,  status: 'paid',   notes: 'F2F' },
  { program: 'CHCI',  billingMonth: 'Feb 2026', amount: 1800.00,  status: 'paid',   notes: 'M&D' },
  { program: 'HUD',   billingMonth: 'Feb 2026', amount: 5602.21,  status: 'paid',   notes: 'HUD' },
  { program: 'HUD',   billingMonth: 'Feb 2026', amount: 408.60,   status: 'paid',   notes: 'TMCRF' },
  // ── March 2026 ───────────────────────────────────────────────────────────
  { program: 'CHCI',  billingMonth: 'Mar 2026', amount: 3200.00,  status: 'paid',   notes: 'D&D' },
  { program: 'CHCI',  billingMonth: 'Mar 2026', amount: 5600.00,  status: 'paid',   notes: 'F2F' },
  { program: 'CHCI',  billingMonth: 'Mar 2026', amount: 400.00,   status: 'paid',   notes: 'M&D' },
  { program: 'HUD',   billingMonth: 'Mar 2026', amount: 4976.43,  status: 'paid',   notes: 'HUD' },
  { program: 'HUD',   billingMonth: 'Mar 2026', amount: 778.80,   status: 'paid',   notes: 'TMCRF' },
  // ── April 2026 ───────────────────────────────────────────────────────────
  { program: 'CHCI',  billingMonth: 'Apr 2026', amount: 1600.00,  status: 'paid',   notes: 'D&D' },
  { program: 'CHCI',  billingMonth: 'Apr 2026', amount: 6400.00,  status: 'paid',   notes: 'F2F' },
  { program: 'CHCI',  billingMonth: 'Apr 2026', amount: 400.00,   status: 'paid',   notes: 'M&D' },
  { program: 'HUD',   billingMonth: 'Apr 2026', amount: 3116.70,  status: 'paid',   notes: 'HUD' },
  { program: 'HUD',   billingMonth: 'Apr 2026', amount: 1150.20,  status: 'billed', notes: 'TMCRF' },
  // ── May 2026 — three rows had no program/stream label in source PDF ──────
  { program: 'CHCI',  billingMonth: 'May 2026', amount: 1000.00,  status: 'paid',   notes: 'stream unclear — verify' },
  { program: 'CHCI',  billingMonth: 'May 2026', amount: 1600.00,  status: 'paid',   notes: 'stream unclear — verify' },
  { program: 'CHCI',  billingMonth: 'May 2026', amount: 3600.00,  status: 'paid',   notes: 'stream unclear — verify' },
  { program: 'HUD',   billingMonth: 'May 2026', amount: 5773.53,  status: 'paid',   notes: 'HUD' },
  { program: 'HUD',   billingMonth: 'May 2026', amount: 888.00,   status: 'billed', notes: 'TMCRF' },
  // ── June 2026 — one row had no program/stream label in source PDF ─────────
  { program: 'CHCI',  billingMonth: 'Jun 2026', amount: 1200.00,  status: 'billed', notes: 'M&D' },
  { program: 'CHCI',  billingMonth: 'Jun 2026', amount: 6400.00,  status: 'paid',   notes: 'stream unclear — verify' },
  { program: 'HEMAP', billingMonth: 'Jun 2026', amount: 3375.00,  status: 'paid',   notes: 'HEMAP' },
  { program: 'HUD',   billingMonth: 'Jun 2026', amount: 2158.64,  status: 'paid',   notes: 'HUD' },
  { program: 'HUD',   billingMonth: 'Jun 2026', amount: 600.00,   status: 'paid',   notes: 'TMCRF' },
  // ── July 2026 ────────────────────────────────────────────────────────────
  { program: 'CHCI',  billingMonth: 'Jul 2026', amount: 10400.00, status: 'paid',   notes: 'F2F' },
  { program: 'HUD',   billingMonth: 'Jul 2026', amount: 5030.92,  status: 'billed', notes: 'HUD' },
  { program: 'HUD',   billingMonth: 'Jul 2026', amount: 1249.40,  status: 'billed', notes: 'TMCRF' },
  // ── August 2026 ──────────────────────────────────────────────────────────
  { program: 'CHCI',  billingMonth: 'Aug 2026', amount: 4000.00,  status: 'paid',   notes: 'D&D' },
  { program: 'CHCI',  billingMonth: 'Aug 2026', amount: 8400.00,  status: 'paid',   notes: 'F2F' },
  { program: 'HUD',   billingMonth: 'Aug 2026', amount: 5367.01,  status: 'billed', notes: 'HUD' },
  { program: 'CHCI',  billingMonth: 'Aug 2026', amount: 1200.00,  status: 'billed', notes: 'M&D' },
  // ── September 2026 — JTBC Youth (individual counselor entries) ───────────
  { program: 'JTBC',  billingMonth: 'Sep 2026', amount: 621.00,   status: 'paid',   notes: 'YOUTH · J Denson' },
  { program: 'JTBC',  billingMonth: 'Sep 2026', amount: 900.00,   status: 'paid',   notes: 'YOUTH · M Shegog' },
  { program: 'JTBC',  billingMonth: 'Sep 2026', amount: 900.00,   status: 'paid',   notes: 'YOUTH · Simmons' },
  { program: 'JTBC',  billingMonth: 'Sep 2026', amount: 900.00,   status: 'paid',   notes: 'YOUTH · Simmons' },
  { program: 'JTBC',  billingMonth: 'Sep 2026', amount: 900.00,   status: 'paid',   notes: 'YOUTH · M Shegog' },
  // ── September 2026 — CHCI + HUD ─────────────────────────────────────────
  { program: 'CHCI',  billingMonth: 'Sep 2026', amount: 6000.00,  status: 'billed', notes: 'D&D' },
  { program: 'CHCI',  billingMonth: 'Sep 2026', amount: 7600.00,  status: 'billed', notes: 'F2F' },
  { program: 'CHCI',  billingMonth: 'Sep 2026', amount: 2400.00,  status: 'billed', notes: 'M&D' },
  { program: 'HUD',   billingMonth: 'Sep 2026', amount: 674.60,   status: 'billed', notes: 'TMCRF' },
  { program: 'HUD',   billingMonth: 'Sep 2026', amount: 5927.13,  status: 'billed', notes: 'HUD' },
  // October 2026 rows had no amounts in the PDF — skipped
];

async function run() {
  const col = db.collection('billingRegister');
  let ok = 0;
  for (const entry of ENTRIES) {
    await col.add({ ...BASE, ...entry });
    console.log(`  added  ${entry.billingMonth}  ${entry.program}  ${entry.notes}  $${entry.amount}  [${entry.status}]`);
    ok++;
  }
  console.log(`\nDone — ${ok} entries added.`);
}

run().catch(err => { console.error(err); process.exit(1); });
