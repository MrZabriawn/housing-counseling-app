'use strict';
/**
 * lib/old-reports.js — single source of truth for reading & normalizing the
 * PHFA "RX CASES" exports in scripts/OldReports. Shared by the analysis,
 * verification, and (eventual) backfill scripts so the mappings never drift.
 *
 * Decisions baked in (confirmed with Z. Smith, 2026-07):
 *   • Case ID  IS  the Rx number.
 *   • guarantor  ← Funding Source  (see GUARANTOR_* below)
 *   • counselingType ← Case type:
 *        Default And Delinquency, HEMAP → OUTSTANDING
 *        Pre-Purchase                   → PRE
 *        Post-Purchase, Credit And Debt → POST
 *   • zipCode is NOT sourced from these files (address column ~2% populated).
 *   • outcome/ami/reCode/hispanic/femaleHeaded/hours/rate/dollars/notes are
 *     NOT present and are never touched.
 */

const fs   = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const DEFAULT_DIR = path.join(__dirname, '..', 'OldReports');

const RX_GUARANTORS = ['NOFA', 'Anti-Pred', 'CHCI', 'HEMAP', 'M&D', 'Non-Billable'];

const GUARANTOR_EXACT = {
  'Anti-Predatory Lending Initiative':             'Anti-Pred',
  'Mediation And Diversion Counseling Initiative': 'M&D',
  'NOFA 2024-1 COMP':                              'NOFA',
  'NOFA 2025-1 COMP':                              'NOFA',
  'CHCI Supplement':                               'CHCI',
  'CHCI Funding 2016':                             'CHCI',
  'Comprehensive Housing Counseling Initiative':   'CHCI',
  'HEMAP':                                         'HEMAP',
};
const GUARANTOR_PREFIX = [
  [/^NOFA\b/i,                           'NOFA'],
  [/^CHCI\b/i,                           'CHCI'],
  [/^Comprehensive Housing Counseling/i, 'CHCI'],
  [/^Anti-?Pred/i,                       'Anti-Pred'],
  [/^Mediation And Diversion/i,          'M&D'],
  [/^HEMAP\b/i,                          'HEMAP'],
];

function mapGuarantor(src) {
  const v = String(src || '').trim();
  if (!v) return { guarantor: null, matched: false, reason: 'blank' };
  if (GUARANTOR_EXACT[v]) return { guarantor: GUARANTOR_EXACT[v], matched: true };
  for (const [re, g] of GUARANTOR_PREFIX) if (re.test(v)) return { guarantor: g, matched: true, viaPrefix: true };
  return { guarantor: null, matched: false, reason: 'unmapped' };
}

// NOFA funding sources embed the initiative, e.g. "NOFA 2024-1 COMP" → "2024-1".
// Returns '' for non-NOFA sources.
function nofaInitiativeOf(src) {
  const m = String(src || '').match(/^NOFA\s+([0-9]{4}-[0-9]+)/i);
  return m ? m[1] : '';
}

// Returns { type, matched, assumed } — `assumed:true` marks the plain
// "Credit Counseling" family, folded into POST alongside "Credit And Debt".
function mapCounselingType(caseType) {
  const v = String(caseType || '').toLowerCase();
  if (!v) return { type: null, matched: false, reason: 'blank' };
  if (/post-?purchase/.test(v))          return { type: 'POST', matched: true };
  if (/pre-?purchase/.test(v))           return { type: 'PRE', matched: true };
  if (/default and delinquency/.test(v)) return { type: 'OUTSTANDING', matched: true };
  if (/hemap/.test(v))                   return { type: 'OUTSTANDING', matched: true };
  if (/credit and debt/.test(v))         return { type: 'POST', matched: true };
  if (/credit counseling/.test(v))       return { type: 'POST', matched: true, assumed: true };
  return { type: null, matched: false, reason: 'unmapped' };
}

// Load one workbook; auto-detect the header row (the one starting with "Case ID").
function loadFile(fileAbs) {
  const wb    = XLSX.readFile(fileAbs);
  const sheet = wb.SheetNames[0];
  const grid  = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, defval: '', blankrows: false });
  const hi    = grid.findIndex(r => String(r[0]).trim() === 'Case ID');
  if (hi === -1) throw new Error(`No 'Case ID' header row in ${path.basename(fileAbs)}`);
  const cols  = grid[hi].map(c => String(c).trim());
  const rows  = grid.slice(hi + 1).map(r => {
    const o = { _file: path.basename(fileAbs), _sheet: sheet };
    cols.forEach((c, i) => o[c] = r[i] == null ? '' : r[i]);
    return o;
  });
  return { file: path.basename(fileAbs), sheet, cols, rows };
}

function loadAll(dir = DEFAULT_DIR) {
  const files = fs.readdirSync(dir).filter(f => /\.xlsx$/i.test(f) && !f.startsWith('~'));
  return files.map(f => loadFile(path.join(dir, f)));
}

function rxOf(row) { return String(row['Case ID'] == null ? '' : row['Case ID']).trim(); }

// Collapse cross-file duplicates by Rx. Duplicates are self-consistent
// (verified: 0 guarantor / 0 agent conflicts), so first occurrence wins.
// Returns Map<rx, { row, files:Set }>.
function dedupeByRx(loaded) {
  const map = new Map();
  for (const L of loaded) for (const row of L.rows) {
    const rx = rxOf(row);
    if (!rx) continue;
    if (!map.has(rx)) map.set(rx, { row, files: new Set([L.file]) });
    else map.get(rx).files.add(L.file);
  }
  return map;
}

// Project a source row into the enrichable subset of the session model.
function toSessionPatch(row) {
  const g = mapGuarantor(row['Funding Source']);
  const t = mapCounselingType(row['Case type']);
  return {
    rxNumber:       rxOf(row),
    clientName:     String(row['Homeowner'] || '').trim(),
    counselor:      String(row['Assigned Agent'] || '').trim(),
    guarantor:      g.guarantor,
    guarantorRaw:   String(row['Funding Source'] || '').trim(),
    guarantorMatched: g.matched,
    counselingType: t.type,
    counselingTypeRaw: String(row['Case type'] || '').trim(),
    counselingTypeMatched: t.matched,
    counselingTypeAssumed: !!t.assumed,
    caseStatus:     String(row['Current Case Status'] || '').trim(),
    caseOpenDate:   String(row['Case Open Date'] || '').trim(),
  };
}

module.exports = {
  DEFAULT_DIR, RX_GUARANTORS, GUARANTOR_EXACT,
  mapGuarantor, mapCounselingType, nofaInitiativeOf,
  loadFile, loadAll, rxOf, dedupeByRx, toSessionPatch,
};
