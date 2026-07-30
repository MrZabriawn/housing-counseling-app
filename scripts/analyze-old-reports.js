'use strict';
/**
 * analyze-old-reports.js  (READ-ONLY — no Firestore writes, no file mutation)
 *
 * Loads the PHFA "RX CASES" exports in scripts/OldReports and views each row
 * through the lens of a current session/entry (the counselingLog / sessions
 * shape), then reports where the source data is CONSISTENT with that model and
 * where it is NOT. This is the discovery step before any Rx / guarantor backfill.
 *
 * It answers three questions:
 *   1. Guarantor mapping — do all Funding Source values map to RX_GUARANTORS?
 *   2. Per-variable coverage — which session fields can be backfilled, and how
 *      completely, vs. which are simply absent from these exports?
 *   3. Cross-file consistency — schema drift between files, duplicate Case IDs
 *      across files, and whether a duplicated case agrees with itself.
 *
 * Usage:
 *   node scripts/analyze-old-reports.js
 *   node scripts/analyze-old-reports.js --json   (also writes old-reports-analysis.json)
 */

const fs   = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const DIR = path.join(__dirname, 'OldReports');
const WRITE_JSON = process.argv.includes('--json');

// ── Target model: the session/entry "variables" we compare against ─────────────
// (mirrors readForm() in public/js/new-entry.js)
const SESSION_FIELDS = [
  'rxNumber', 'clientName', 'counselingDate', 'counselor', 'guarantor',
  'zipCode', 'counselingType', 'sourceMonth', 'caseStatus', 'outcome',
  'amiPercent', 'reCode', 'hispanic', 'femaleHeaded', 'hours', 'ratePerHour',
  'dollarsAwarded', 'awardType', 'dollarsFor', 'notes',
];

// Allowed guarantor values in the app (public/js/data.js → RX_GUARANTORS)
const RX_GUARANTORS = ['NOFA', 'Anti-Pred', 'CHCI', 'HEMAP', 'M&D', 'Non-Billable'];

// Funding Source (PHFA) → app guarantor. Exact matches first; PREFIX rules below
// catch future dated variants (e.g. "NOFA 2026-1 COMP") so the map self-heals.
const GUARANTOR_EXACT = {
  'Anti-Predatory Lending Initiative':            'Anti-Pred',
  'Mediation And Diversion Counseling Initiative':'M&D',
  'NOFA 2024-1 COMP':                             'NOFA',
  'NOFA 2025-1 COMP':                             'NOFA',
  'CHCI Supplement':                              'CHCI',
  'CHCI Funding 2016':                            'CHCI',
  'Comprehensive Housing Counseling Initiative':  'CHCI',
  'HEMAP':                                        'HEMAP',
};
const GUARANTOR_PREFIX = [
  [/^NOFA\b/i,                          'NOFA'],
  [/^CHCI\b/i,                          'CHCI'],
  [/^Comprehensive Housing Counseling/i,'CHCI'],
  [/^Anti-?Pred/i,                      'Anti-Pred'],
  [/^Mediation And Diversion/i,         'M&D'],
  [/^HEMAP\b/i,                         'HEMAP'],
];

function mapGuarantor(src) {
  const v = String(src || '').trim();
  if (!v) return { guarantor: null, matched: false, reason: 'blank' };
  if (GUARANTOR_EXACT[v]) return { guarantor: GUARANTOR_EXACT[v], matched: true };
  for (const [re, g] of GUARANTOR_PREFIX) if (re.test(v)) return { guarantor: g, matched: true, viaPrefix: true };
  return { guarantor: null, matched: false, reason: 'unmapped' };
}

// Source column → session field. A source column of null means "not present in
// these exports" (documented so the gap is explicit rather than silently empty).
const COLUMN_MAP = {
  rxNumber:       'Case ID',
  clientName:     'Homeowner',
  counselingDate: 'Case Open Date',
  counselor:      'Assigned Agent',
  guarantor:      'Funding Source',   // via mapGuarantor()
  zipCode:        'Property Address',  // parsed out of the address string
  caseStatus:     'Current Case Status',
  counselingType: 'Case type',        // NOTE: does not map cleanly — see report
  sourceMonth:    'Case Open Date',   // derived (month name)
  // Absent from these exports (session-time data, not case-open data):
  outcome: null, amiPercent: null, reCode: null, hispanic: null,
  femaleHeaded: null, hours: null, ratePerHour: null, dollarsAwarded: null,
  awardType: null, dollarsFor: null, notes: null,
};

const MONTHS = ['January','February','March','April','May','June','July',
  'August','September','October','November','December'];

// ── Loading ────────────────────────────────────────────────────────────────────
function loadFile(file) {
  const wb    = XLSX.readFile(path.join(DIR, file));
  const sheet = wb.SheetNames[0];
  const grid  = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, defval: '', blankrows: false });
  const hi    = grid.findIndex(r => String(r[0]).trim() === 'Case ID');
  if (hi === -1) throw new Error(`No 'Case ID' header row in ${file}`);
  const cols  = grid[hi].map(c => String(c).trim());
  const rows  = grid.slice(hi + 1).map(r => {
    const o = {}; cols.forEach((c, i) => o[c] = r[i] == null ? '' : r[i]); return o;
  });
  return { file, sheet, cols, rows };
}

function parseZip(addr) {
  const m = String(addr || '').match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : '';
}
function parseMonth(dateStr) {
  const m = String(dateStr || '').match(/^(\d{1,2})\/\d{1,2}\/\d{2,4}/);
  return m ? MONTHS[+m[1] - 1] : '';
}

// Project one source row into the session shape.
function toSession(row) {
  const g = mapGuarantor(row['Funding Source']);
  return {
    rxNumber:       String(row['Case ID'] || '').trim(),
    clientName:     String(row['Homeowner'] || '').trim(),
    counselingDate: String(row['Case Open Date'] || '').trim(),
    counselor:      String(row['Assigned Agent'] || '').trim(),
    guarantor:      g.guarantor,
    guarantorRaw:   String(row['Funding Source'] || '').trim(),
    guarantorMatched: g.matched,
    zipCode:        parseZip(row['Property Address']),
    caseStatus:     String(row['Current Case Status'] || '').trim(),
    counselingType: String(row['Case type'] || '').trim(),
    sourceMonth:    parseMonth(row['Case Open Date']),
  };
}

// ── Analysis ───────────────────────────────────────────────────────────────────
function pct(n, d) { return d ? (100 * n / d).toFixed(1) + '%' : '—'; }
function line(c = '─', n = 78) { return c.repeat(n); }

function main() {
  const files = fs.readdirSync(DIR).filter(f => /\.xlsx$/i.test(f) && !f.startsWith('~'));
  if (!files.length) { console.error('No .xlsx files in', DIR); process.exit(1); }

  const loaded = files.map(loadFile);
  const report = { files: {}, schema: {}, guarantorMap: {}, coverage: {}, dedup: {}, warnings: [] };

  // 1) Per-file schema
  console.log(line('═'));
  console.log('PHFA OLD-REPORTS ANALYSIS  (read-only)');
  console.log(line('═'));
  console.log('\n1. FILES & SHEETS');
  for (const L of loaded) {
    console.log(`   • ${L.file}`);
    console.log(`       sheet="${L.sheet}"  rows=${L.rows.length}  cols=${L.cols.length}`);
    report.files[L.file] = { sheet: L.sheet, rows: L.rows.length, cols: L.cols.length, columns: L.cols };
  }

  // 2) Column presence matrix (schema drift)
  const allCols = [...new Set(loaded.flatMap(L => L.cols))];
  // Tag each file by the counselor initials embedded in its name (DRB / AL / ZS),
  // falling back to a short slug so the overlap table stays readable.
  const tagFor = f => (f.match(/\b(DRB|AL|ZS)\b/i) || [])[1]?.toUpperCase()
    || f.replace(/\.xlsx$/i, '').replace(/RX CASES|JAN.*$/gi, '').trim().slice(0, 4) || '?';
  const tags = loaded.map(L => tagFor(L.file));
  console.log('\n2. COLUMN PRESENCE  (' + tags.join(' ') + ')');
  const commonCols = [], divergentCols = [];
  for (const c of allCols) {
    const present = loaded.map(L => L.cols.includes(c));
    if (present.every(Boolean)) commonCols.push(c); else divergentCols.push(c);
  }
  console.log(`   Shared by all files : ${commonCols.length}`);
  console.log(`   Divergent columns   : ${divergentCols.length}`);
  for (const c of divergentCols) {
    console.log(`     ! ${c.padEnd(30)} ${loaded.map(L => L.cols.includes(c) ? 'Y' : '-').join(' ')}`);
  }
  report.schema = { commonCols, divergentColumns: divergentCols.map(c => ({
    column: c, presentIn: loaded.filter(L => L.cols.includes(c)).map(L => L.file) })) };
  if (divergentCols.length) report.warnings.push(`Schema drift: ${divergentCols.length} columns not shared by all files.`);

  // Flatten all rows, remembering their origin file
  const allRows = loaded.flatMap(L => L.rows.map(r => ({ _file: L.file, ...r })));

  // 3) Guarantor mapping
  console.log('\n3. GUARANTOR MAP  (Funding Source → RX_GUARANTORS)');
  const fsCounts = new Map();
  for (const r of allRows) {
    const v = String(r['Funding Source'] || '').trim() || '(blank)';
    fsCounts.set(v, (fsCounts.get(v) || 0) + 1);
  }
  const gm = [];
  for (const [src, n] of [...fsCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const g = src === '(blank)' ? { guarantor: null, matched: false } : mapGuarantor(src);
    gm.push({ source: src, count: n, guarantor: g.guarantor, matched: g.matched });
    const flag = g.matched ? (g.viaPrefix ? '≈' : '→') : '✗ UNMAPPED';
    console.log(`   ${String(n).padStart(4)}  ${src.padEnd(48)} ${flag} ${g.guarantor || ''}`);
  }
  report.guarantorMap = gm;
  const unmapped = gm.filter(x => !x.matched);
  if (unmapped.length) report.warnings.push(`Unmapped Funding Source values: ${unmapped.map(u => u.source).join(', ')}`);

  // 4) Per-session-variable coverage (consistency with the session model)
  console.log('\n4. SESSION-VARIABLE COVERAGE  (across all ' + allRows.length + ' rows, pre-dedup)');
  console.log('   variable          source column           populated / total');
  console.log('   ' + line('·', 70));
  const sessions = allRows.map(toSession);
  const cov = {};
  for (const field of SESSION_FIELDS) {
    const src = COLUMN_MAP[field];
    if (src === null) {
      console.log(`   ${field.padEnd(17)} ${'(not in exports)'.padEnd(24)} —        ABSENT`);
      cov[field] = { source: null, populated: 0, total: sessions.length, note: 'absent from exports' };
      continue;
    }
    let filled = 0;
    for (const s of sessions) {
      const v = s[field];
      if (v !== '' && v != null) filled++;
    }
    console.log(`   ${field.padEnd(17)} ${String(src).padEnd(24)} ${String(filled).padStart(5)}/${sessions.length}   ${pct(filled, sessions.length)}`);
    cov[field] = { source: src, populated: filled, total: sessions.length };
  }
  report.coverage = cov;

  // guarantor match rate specifically
  const gMatched = sessions.filter(s => s.guarantorMatched).length;
  console.log(`\n   guarantor mapped OK : ${gMatched}/${sessions.length}  (${pct(gMatched, sessions.length)})`);

  // counselingType flagged as non-clean
  report.warnings.push('counselingType has no clean mapping: PHFA "Case type" values (Default And Delinquency, HEMAP, Credit And Debt, Pre/Post-Purchase) do not line up 1:1 with COUNSELING_TYPES — needs a decision.');
  console.log('\n   ⚠ counselingType: PHFA "Case type" does NOT map 1:1 to COUNSELING_TYPES — needs your rules.');

  // 5) Cross-file de-duplication by Case ID (rxNumber)
  console.log('\n5. CROSS-FILE DE-DUP  (by Case ID / rxNumber)');
  const byId = new Map();
  for (const r of allRows) {
    const id = String(r['Case ID'] || '').trim();
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(r);
  }
  const uniqueIds = byId.size;
  const dupAcross = [...byId.values()].filter(v => v.length > 1).length;
  console.log(`   Total rows          : ${allRows.length}`);
  console.log(`   Unique Case IDs     : ${uniqueIds}`);
  console.log(`   IDs in >1 file      : ${dupAcross}`);

  // pairwise overlap
  console.log('   Pairwise overlap:');
  for (let i = 0; i < loaded.length; i++) for (let j = i + 1; j < loaded.length; j++) {
    const a = new Set(loaded[i].rows.map(r => String(r['Case ID']).trim()));
    const b = new Set(loaded[j].rows.map(r => String(r['Case ID']).trim()));
    const ov = [...a].filter(x => b.has(x)).length;
    console.log(`     ${tags[i]} ∩ ${tags[j]} = ${ov}`);
  }

  // conflict check: same Case ID, disagreeing guarantor or agent
  let guarConflicts = 0, agentConflicts = 0;
  const conflictSamples = [];
  for (const [id, rs] of byId) {
    if (rs.length < 2) continue;
    const gs = new Set(rs.map(r => mapGuarantor(r['Funding Source']).guarantor));
    const as = new Set(rs.map(r => String(r['Assigned Agent']).trim()));
    if (gs.size > 1) { guarConflicts++; if (conflictSamples.length < 5) conflictSamples.push({ id, type: 'guarantor', values: [...gs] }); }
    if (as.size > 1) { agentConflicts++; if (conflictSamples.length < 5) conflictSamples.push({ id, type: 'agent', values: [...as] }); }
  }
  console.log(`   Duplicated IDs with conflicting guarantor : ${guarConflicts}`);
  console.log(`   Duplicated IDs with conflicting agent     : ${agentConflicts}`);
  conflictSamples.forEach(c => console.log(`     e.g. Case ${c.id}: ${c.type} = ${c.values.join(' vs ')}`));
  report.dedup = { totalRows: allRows.length, uniqueIds, idsInMultipleFiles: dupAcross, guarConflicts, agentConflicts, conflictSamples };
  if (guarConflicts || agentConflicts) report.warnings.push(`Duplicate Case IDs disagree with themselves: ${guarConflicts} guarantor, ${agentConflicts} agent conflicts.`);

  // agents present (files are per-counselor by name, but agents overlap)
  const agentCounts = new Map();
  for (const r of allRows) { const a = String(r['Assigned Agent']).trim() || '(blank)'; agentCounts.set(a, (agentCounts.get(a) || 0) + 1); }
  console.log('\n6. ASSIGNED AGENTS (pre-dedup counts)');
  [...agentCounts.entries()].sort((a, b) => b[1] - a[1]).forEach(([a, n]) => console.log(`   ${String(n).padStart(4)}  ${a}`));

  // Warnings summary
  console.log('\n' + line('═'));
  console.log('WARNINGS / DECISIONS NEEDED');
  console.log(line('═'));
  report.warnings.forEach((w, i) => console.log(`  ${i + 1}. ${w}`));

  if (WRITE_JSON) {
    const out = path.join(__dirname, 'old-reports-analysis.json');
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(`\nWrote ${out}`);
  }
}

main();
