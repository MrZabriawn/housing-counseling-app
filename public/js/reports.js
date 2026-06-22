import { db } from './firebase-config.js';
import { isDemoMode, demoClientName } from './demo-mode.js';
import { MONTHS, RE_CODES, RE_CODE_LABELS, AMI_LEVELS, amiCategory, amiCdbgCategory, DEFAULT_RATE, COURT_RATE } from './data.js';
import {
  collection, collectionGroup, getDocs, getDoc, doc, deleteDoc, updateDoc, query, where, orderBy
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

let reportData = null; // { unique, rows, month, year }

export async function initCdbgReports(user, profile) {
  // Populate month select
  const monthSel = document.getElementById('reportMonth');
  MONTHS.forEach(m => {
    const o = document.createElement('option');
    o.value = m; o.textContent = m;
    monthSel.appendChild(o);
  });
  monthSel.value = MONTHS[new Date().getMonth()];
  document.getElementById('reportYear').value   = new Date().getFullYear();
  document.getElementById('reportPerson').value = profile.name || '';

  // Populate counselor filter
  try {
    const snap = await getDocs(query(collection(db, 'counselors'), orderBy('name')));
    const sel  = document.getElementById('reportCounselor');
    snap.docs.filter(d => d.data().active !== false).forEach(d => {
      const o = document.createElement('option');
      o.value = d.data().name; o.textContent = d.data().name;
      sel.appendChild(o);
    });
  } catch (_) {}

  monthSel.addEventListener('change', loadMonth);
  document.getElementById('reportYear').addEventListener('change', loadMonth);
  document.getElementById('reportCounselor').addEventListener('change', loadMonth);

  document.getElementById('printCdbgBtn').addEventListener('click', () => {
    if (isDemoMode()) return;
    const dateEl = document.getElementById('printInvoiceDate');
    if (dateEl) dateEl.textContent = new Date().toLocaleDateString('en-US');
    window.print();
  });

  await loadMonth();

  // Court report — default to current month
  const now = new Date();
  document.getElementById('courtReportMonth').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  document.getElementById('courtReportYear').value  = now.getFullYear();
  document.getElementById('loadCourtReportBtn').addEventListener('click', loadCourtReport);

  // Court counselor filter
  try {
    const cSnap = await getDocs(query(collection(db, 'counselors'), orderBy('name')));
    const cSel  = document.getElementById('courtReportCounselor');
    cSnap.docs.filter(d => d.data().active !== false).forEach(d => {
      const o = document.createElement('option');
      o.value = d.data().name; o.textContent = d.data().name;
      cSel.appendChild(o);
    });
  } catch (_) {}
}

// ── Load & render CDBG data ───────────────────────────────────────────────────

function toDate(ts) {
  if (!ts) return null;
  return ts.toDate ? ts.toDate() : new Date(ts);
}

async function loadMonth() {
  const month  = document.getElementById('reportMonth').value;
  const year   = parseInt(document.getElementById('reportYear').value, 10);
  const card   = document.getElementById('cdbgCard');
  const status = document.getElementById('reportStatus');

  if (!month || !year) { card.style.display = 'none'; return; }

  status.textContent = 'Loading data…';
  card.style.display = 'none';

  const counselorVal = document.getElementById('reportCounselor').value;
  const monthIdx     = MONTHS.indexOf(month);
  const start        = new Date(year, monthIdx, 1);
  const end          = new Date(year, monthIdx + 1, 0, 23, 59, 59);

  // Load clients, all sessions (filter client-side — no index needed), legacy counselingLog, and billing rates in parallel
  const [clientsSnap, sessionsSnap, logSnap, ratesSnap] = await Promise.all([
    getDocs(collection(db, 'clients')),
    getDocs(collectionGroup(db, 'sessions')),
    getDocs(collection(db, 'counselingLog')),
    getDoc(doc(db, 'config', 'billing')).catch(() => null),
  ]);

  const ratesData    = ratesSnap?.exists?.() ? ratesSnap.data() : {};
  const defaultRate  = ratesData.defaultRate ?? DEFAULT_RATE;
  const courtRate    = ratesData.courtRate   ?? COURT_RATE;

  // Build client demographics lookup
  const clientsMap = {};
  clientsSnap.docs.forEach(d => { clientsMap[d.id] = { id: d.id, ...d.data() }; });

  // Sessions → filter to the selected month/year (and optional counselor), enrich with client demographics
  const sessionRows = [];
  sessionsSnap.docs.forEach(d => {
    const s     = d.data();
    const sDate = toDate(s.date);
    if (!sDate) return;
    if (sDate < start || sDate > end) return;

    const clientId     = d.ref.parent.parent.id;
    const client       = clientsMap[clientId] || {};
    const rowCounselor = (s.counselor || client.counselor || '').trim();
    if (counselorVal && rowCounselor.toLowerCase() !== counselorVal.toLowerCase()) return;
    const cType = client.counselingType || '';
    const isCourtSession = cType === 'COURT' || (s.billingType || '') === 'Court';
    const rate  = isCourtSession ? courtRate : defaultRate;
    sessionRows.push({
      _sessionId:     d.id,
      _clientId:      clientId,
      clientName:     client.clientName || '',
      caseNo:         (client.rxNumbers || [])[0] || '',
      counselor:      s.counselor || client.counselor || '',
      counselingType: cType,
      billingType:    s.billingType || '',
      hours:          typeof s.hours === 'number' ? s.hours : (parseFloat(s.hours) || 0),
      rate,
      amiPercent:     client.amiPercent || '',
      reCode:         client.reCode || '',
      hispanic:       !!client.hispanic,
      femaleHeaded:   !!client.femaleHeaded,
      counselingDate: s.date,
    });
  });

  // Legacy counselingLog entries filtered to the selected month/year
  let logRows = logSnap.docs.map(d => ({ _clientId: null, id: d.id, ...d.data() }));
  logRows = logRows.filter(r => {
    if (r.sourceMonth !== month) return false;
    const d = toDate(r.counselingDate);
    if (!d) return true;
    return d.getFullYear() === year;
  });

  if (counselorVal) {
    logRows = logRows.filter(r => (r.counselor || '') === counselorVal);
  }

  // Only add legacy entries for clients not already captured via sessions.
  // Match on normalized name (collapse whitespace) OR case/Rx number.
  function normName(s) { return (s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
  const sessionNames = new Set(sessionRows.map(r => normName(r.clientName)).filter(Boolean));
  const sessionCaseNos = new Set(sessionRows.map(r => (r.caseNo || '').trim()).filter(Boolean));

  const legacyOnly = logRows.filter(r => {
    const name    = normName(r.clientName);
    const caseNo  = (r.caseNo || r.rxNumber || '').trim();
    if (!name) return false;
    if (sessionNames.has(name)) return false;
    if (caseNo && sessionCaseNos.has(caseNo)) return false;
    return true;
  });

  const allRows = [...sessionRows, ...legacyOnly];

  // Deduplicate to one row per household (clientId > clientName)
  const seen   = new Set();
  const unique = allRows.filter(r => {
    const key = r._clientId || (r.caseNo || '').trim() || (r.clientName || '').toLowerCase().trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  reportData = { unique, rows: allRows, sessionRows, month, year };

  const counselorLabel = counselorVal ? ` · ${counselorVal}` : '';
  status.textContent =
    `${unique.length} unique household${unique.length !== 1 ? 's' : ''} · ${allRows.length} session${allRows.length !== 1 ? 's' : ''} for ${month} ${year}${counselorLabel}`;

  renderPreviews(unique);
  updatePrintArea(month, year);

  card.style.display = 'block';
}

// ── Screen preview tables ─────────────────────────────────────────────────────

function renderPreviews(unique) {
  renderR1Preview(unique);
  renderR2Preview(unique);
  renderClientDetail(reportData.rows, unique);
  renderInvoiceTable(reportData.sessionRows);
}

const CDBG_AMI_LEVELS = ['Extremely Low', 'Very Low', 'Low', 'Moderate', 'Non Low-Moderate'];

function countCdbgAmi(rows) {
  const counts = {};
  CDBG_AMI_LEVELS.forEach(k => { counts[k] = 0; });
  rows.forEach(r => {
    const cat = amiCdbgCategory(r.amiPercent);
    if (cat in counts) counts[cat]++;
  });
  return counts;
}

function renderR1Preview(unique) {
  const counts      = countCdbgAmi(unique);
  const unspecified = unique.filter(r => !CDBG_AMI_LEVELS.includes(amiCdbgCategory(r.amiPercent))).length;
  const total       = unique.length;
  document.getElementById('r1PreviewBody').innerHTML =
    CDBG_AMI_LEVELS.map(level => `
      <tr>
        <td style="border:1px solid var(--border);padding:0.35rem 0.6rem;text-align:right;">${counts[level] || 0}</td>
        <td style="border:1px solid var(--border);padding:0.35rem 0.6rem;">${amiLabel(level)}</td>
      </tr>`).join('') +
    (unspecified > 0 ? `
      <tr>
        <td style="border:1px solid var(--border);padding:0.35rem 0.6rem;text-align:right;color:var(--danger);">${unspecified}</td>
        <td style="border:1px solid var(--border);padding:0.35rem 0.6rem;color:var(--danger);">Not Specified — AMI field blank</td>
      </tr>` : '') + `
    <tr>
      <td style="border:1px solid var(--border);padding:0.35rem 0.6rem;text-align:right;font-weight:700;">${total}</td>
      <td style="border:1px solid var(--border);padding:0.35rem 0.6rem;font-weight:700;">Total persons served</td>
    </tr>`;
}

function renderR2Preview(unique) {
  const counts      = countByField(unique, 'reCode', RE_CODES);
  const unspecified = unique.filter(r => !RE_CODES.includes(r.reCode)).length;
  const total       = unique.length;
  const femaleCt    = unique.filter(r => r.femaleHeaded).length;
  document.getElementById('r2PreviewBody').innerHTML =
    RE_CODES.map(code => {
      const hispCt = unique.filter(r => r.reCode === code && r.hispanic).length;
      return `<tr>
        <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;text-align:right;">${counts[code] || 0}</td>
        <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;font-size:0.8rem;">${RE_CODE_LABELS[code] || code}</td>
        <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;text-align:right;">${hispCt}</td>
      </tr>`;
    }).join('') +
    (unspecified > 0 ? `
      <tr>
        <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;text-align:right;color:var(--danger);">${unspecified}</td>
        <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;color:var(--danger);">Not Specified — Race/Ethnicity blank</td>
        <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;"></td>
      </tr>` : '') + `
    <tr>
      <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;text-align:right;font-weight:700;">${total}</td>
      <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;font-weight:700;">Total Households served</td>
      <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;"></td>
    </tr>
    <tr>
      <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;text-align:right;font-weight:700;">${femaleCt}</td>
      <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;font-weight:700;" colspan="2">Number of Female-Headed Households</td>
    </tr>`;
}

// ── Print-area population ─────────────────────────────────────────────────────

function updatePrintArea(month, year) {
  const { unique } = reportData;
  const today      = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const person     = document.getElementById('reportPerson').value;

  document.getElementById('cdbgCardSubtitle').textContent = `${month} ${year}`;
  document.getElementById('printMonthLine').textContent   = `Report Month: ${month} ${year}`;
  document.getElementById('printPersonLine').textContent  = `Completed By: ${person}`;
  document.getElementById('printDateLine').textContent    = `Date Prepared: ${today}`;

  // Report 1 print table
  const counts1      = countCdbgAmi(unique);
  const unspecified1 = unique.filter(r => !CDBG_AMI_LEVELS.includes(amiCdbgCategory(r.amiPercent))).length;
  document.getElementById('r1PrintBody').innerHTML =
    CDBG_AMI_LEVELS.map(level => `
      <tr>
        <td class="num">${counts1[level] || 0}</td>
        <td>${amiLabel(level)}</td>
      </tr>`).join('') +
    (unspecified1 > 0 ? `<tr><td class="num">${unspecified1}</td><td>Not Specified</td></tr>` : '') + `
    <tr style="font-weight:700;">
      <td class="num">${unique.length}</td>
      <td>Total persons served</td>
    </tr>`;

  // Report 2 print table
  const counts2      = countByField(unique, 'reCode', RE_CODES);
  const unspecified2 = unique.filter(r => !RE_CODES.includes(r.reCode)).length;
  const femaleCt     = unique.filter(r => r.femaleHeaded).length;
  document.getElementById('r2PrintBody').innerHTML =
    RE_CODES.map(code => {
      const hispCt = unique.filter(r => r.reCode === code && r.hispanic).length;
      return `<tr>
        <td class="num">${counts2[code] || 0}</td>
        <td>${RE_CODE_LABELS[code] || code}</td>
        <td class="num">${hispCt}</td>
      </tr>`;
    }).join('') +
    (unspecified2 > 0 ? `<tr><td class="num">${unspecified2}</td><td>Not Specified</td><td></td></tr>` : '') + `
    <tr style="font-weight:700;">
      <td class="num">${unique.length}</td><td>Total Households served</td><td></td>
    </tr>
    <tr style="font-weight:700;">
      <td class="num">${femaleCt}</td><td colspan="2">Number of Female-Headed Households</td>
    </tr>`;

  // Copy client detail and invoice tables into print area
  const cdPrint  = document.getElementById('clientDetailPrintBody');
  const invPrint = document.getElementById('invoicePrintBody');
  if (cdPrint)  cdPrint.innerHTML  = document.getElementById('clientDetailBody')?.innerHTML  || '';
  if (invPrint) invPrint.innerHTML = document.getElementById('invoiceTableBody')?.innerHTML  || '';
}

// ── Client detail table ───────────────────────────────────────────────────────

function renderClientDetail(allRows, unique) {
  const el = document.getElementById('clientDetailBody');
  if (!el) return;

  // Group all sessions by client key
  const byClient = {};
  allRows.forEach(r => {
    const key = r._clientId || (r.caseNo || '').trim() || (r.clientName || '').toLowerCase().trim();
    if (!key) return;
    if (!byClient[key]) byClient[key] = { r, sessions: [] };
    const d = toDate(r.counselingDate);
    byClient[key].sessions.push(d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—');
  });

  const rows = Object.values(byClient).sort((a, b) =>
    (a.r.clientName || '').localeCompare(b.r.clientName || '')
  );

  if (!rows.length) { el.textContent = 'No clients.'; return; }

  const amiOpts = ['', ...AMI_LEVELS]
    .map(l => `<option value="${l}">${l || '— Unknown —'}</option>`).join('');

  const reOpts = ['', ...RE_CODES]
    .map(c => `<option value="${c}">${c ? (RE_CODE_LABELS[c] || c) : '— Unknown —'}</option>`).join('');

  el.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:0.8125rem;">
      <thead>
        <tr style="background:#f8f9fb;">
          <th style="border:1px solid var(--border);padding:0.3rem 0.5rem;text-align:right;width:32px;">#</th>
          <th style="border:1px solid var(--border);padding:0.3rem 0.5rem;">Client Name</th>
          <th style="border:1px solid var(--border);padding:0.3rem 0.5rem;">Counselor</th>
          <th style="border:1px solid var(--border);padding:0.3rem 0.5rem;">Session Date(s)</th>
          <th style="border:1px solid var(--border);padding:0.3rem 0.5rem;">Source</th>
          <th style="border:1px solid var(--border);padding:0.3rem 0.5rem;">AMI</th>
          <th style="border:1px solid var(--border);padding:0.3rem 0.5rem;">Race &amp; Ethnicity</th>
          <th style="border:1px solid var(--border);padding:0.3rem 0.5rem;">Type</th>
          <th style="border:1px solid var(--border);padding:0.3rem 0.5rem;width:32px;"></th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((entry, i) => {
          const r = entry.r;
          const isLegacy   = !r._clientId;
          const src        = isLegacy ? 'Legacy Log' : 'Sessions';
          const srcColor   = isLegacy ? '#b45309' : 'var(--primary)';
          const curAmi     = amiCategory(r.amiPercent) || '';
          const missingAmi = !curAmi;
          const curRe      = r.reCode || '';
          const missingRe  = !curRe;

          const amiCell = r._clientId
            ? `<select data-ami-client="${esc(r._clientId)}" style="font-size:0.75rem;border:1px solid ${missingAmi ? 'var(--danger)' : 'var(--border)'};border-radius:3px;padding:1px 3px;background:${missingAmi ? '#fff5f5' : 'transparent'};max-width:130px;">
                ${amiOpts.replace(`value="${curAmi}"`, `value="${curAmi}" selected`)}
               </select>`
            : esc(curAmi || '—');

          const reCell = r._clientId
            ? `<select data-re-client="${esc(r._clientId)}" style="font-size:0.75rem;border:1px solid ${missingRe ? 'var(--danger)' : 'var(--border)'};border-radius:3px;padding:1px 3px;background:${missingRe ? '#fff5f5' : 'transparent'};max-width:180px;">
                ${reOpts.replace(`value="${curRe}"`, `value="${curRe}" selected`)}
               </select>`
            : esc(curRe || '—');

          const delBtn = isLegacy && r.id
            ? `<button data-legacy-id="${esc(r.id)}" title="Delete this legacy log entry" style="background:none;border:none;cursor:pointer;color:var(--danger);font-size:1rem;padding:0 4px;line-height:1;">&#10005;</button>`
            : '';

          return `<tr>
            <td style="border:1px solid var(--border);padding:0.28rem 0.5rem;text-align:right;color:var(--text-muted);">${i + 1}</td>
            <td style="border:1px solid var(--border);padding:0.28rem 0.5rem;font-weight:600;">${esc(isDemoMode() ? demoClientName(r._clientId) : (r.clientName || '—'))}</td>
            <td style="border:1px solid var(--border);padding:0.28rem 0.5rem;">${esc(r.counselor || '—')}</td>
            <td style="border:1px solid var(--border);padding:0.28rem 0.5rem;font-size:0.775rem;">${entry.sessions.join(', ')}</td>
            <td style="border:1px solid var(--border);padding:0.28rem 0.5rem;font-size:0.75rem;font-weight:700;color:${srcColor};">${src}</td>
            <td style="border:1px solid var(--border);padding:0.28rem 0.5rem;">${amiCell}</td>
            <td style="border:1px solid var(--border);padding:0.28rem 0.5rem;">${reCell}</td>
            <td style="border:1px solid var(--border);padding:0.28rem 0.5rem;font-size:0.775rem;">${esc(r.counselingType || '—')}</td>
            <td style="border:1px solid var(--border);padding:0.28rem 0.5rem;text-align:center;">${delBtn}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;

  // AMI selects — save directly to client doc
  el.querySelectorAll('[data-ami-client]').forEach(sel => {
    sel.addEventListener('change', async () => {
      const clientId = sel.dataset.amiClient;
      sel.style.opacity = '0.5';
      try {
        await updateDoc(doc(db, 'clients', clientId), { amiPercent: sel.value });
        sel.style.opacity = '1';
        sel.style.borderColor = '#16a34a';
        sel.style.background = 'transparent';
        setTimeout(() => { sel.style.borderColor = ''; }, 1500);
      } catch (err) {
        alert('Save failed: ' + err.message);
        sel.style.opacity = '1';
      }
    });
  });

  // RE code selects — save directly to client doc
  el.querySelectorAll('[data-re-client]').forEach(sel => {
    sel.addEventListener('change', async () => {
      const clientId = sel.dataset.reClient;
      sel.style.opacity = '0.5';
      try {
        await updateDoc(doc(db, 'clients', clientId), { reCode: sel.value });
        sel.style.opacity = '1';
        sel.style.borderColor = '#16a34a';
        sel.style.background = 'transparent';
        setTimeout(() => { sel.style.borderColor = ''; }, 1500);
      } catch (err) {
        alert('Save failed: ' + err.message);
        sel.style.opacity = '1';
      }
    });
  });

  // Delete buttons for legacy log rows
  el.querySelectorAll('[data-legacy-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const legacyId = btn.dataset.legacyId;
      const name = btn.closest('tr')?.querySelector('td:nth-child(2)')?.textContent || legacyId;
      if (!confirm(`Delete legacy log entry for "${name}"? This cannot be undone.`)) return;
      btn.disabled = true;
      try {
        await deleteDoc(doc(db, 'counselingLog', legacyId));
        btn.closest('tr').remove();
      } catch (err) {
        alert('Delete failed: ' + err.message);
        btn.disabled = false;
      }
    });
  });
}

// ── Invoice Calculator Table ──────────────────────────────────────────────────

function renderInvoiceTable(sessionRows) {
  const el = document.getElementById('invoiceTableBody');
  if (!el) return;

  if (!sessionRows.length) {
    el.innerHTML = '<p style="color:var(--text-muted);font-size:0.875rem;">No sessions this month.</p>';
    return;
  }

  // Group by counselor (preserve insertion order, then sort alpha)
  const byCounselor = {};
  sessionRows.forEach(r => {
    const key = (r.counselor || 'Unassigned').trim();
    if (!byCounselor[key]) byCounselor[key] = [];
    byCounselor[key].push(r);
  });
  const counselors = Object.keys(byCounselor).sort();

  const $  = (n) => `$${n.toFixed(2)}`;
  const td = (content, style = '') =>
    `<td style="border:1px solid var(--border);padding:0.28rem 0.5rem;${style}">${content}</td>`;

  let grandHours  = 0;
  let grandAmount = 0;

  const rows = counselors.map(counselor => {
    const sessions = byCounselor[counselor].sort((a, b) => {
      const ta = toDate(a.counselingDate) || 0;
      const tb = toDate(b.counselingDate) || 0;
      return ta - tb;
    });

    let subtotalHours  = 0;
    let subtotalAmount = 0;

    const sessionHtml = sessions.map(r => {
      const d         = toDate(r.counselingDate);
      const dateStr   = d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—';
      const missing   = !r.hours;
      const amount    = r.hours * r.rate;
      subtotalHours  += r.hours;
      subtotalAmount += amount;
      const typeLabel = r.billingType || r.counselingType || '—';
      const rowStyle  = missing ? 'background:#fff5f5;' : '';
      const hoursInput = `<input type="number"
        data-hours-client="${esc(r._clientId)}"
        data-hours-session="${esc(r._sessionId)}"
        data-rate="${r.rate}"
        value="${r.hours || ''}"
        min="0" step="0.5" placeholder="0"
        style="width:58px;text-align:right;border:1px solid ${missing ? 'var(--danger)' : 'var(--border)'};border-radius:3px;padding:2px 4px;font-size:0.8rem;background:transparent;">`;
      const amountCell = `<span data-amount-for="${esc(r._sessionId)}">${missing ? '<span style="color:var(--danger);">$0.00</span>' : $(amount)}</span>`;
      return `<tr style="${rowStyle}" data-row-session="${esc(r._sessionId)}">
        ${td('')}
        ${td(esc(r.clientName || '—'), missing ? 'font-weight:600;color:var(--danger);' : 'font-weight:600;')}
        ${td(dateStr, 'white-space:nowrap;')}
        ${td(esc(typeLabel), 'font-size:0.775rem;color:var(--text-muted);')}
        ${td(hoursInput, 'text-align:right;padding:0.1rem 0.3rem;')}
        ${td($(r.rate), 'text-align:right;font-size:0.775rem;color:var(--text-muted);')}
        ${td(amountCell, 'text-align:right;font-weight:600;')}
      </tr>`;
    }).join('');

    grandHours  += subtotalHours;
    grandAmount += subtotalAmount;

    return `
      <tr style="background:#f8f9fb;">
        ${td(`<strong>${esc(counselor)}</strong>`, 'font-size:0.8rem;font-weight:700;color:var(--primary);')}
        ${td('', 'background:#f8f9fb;')}
        ${td('', 'background:#f8f9fb;')}
        ${td('', 'background:#f8f9fb;')}
        ${td(`<strong>${subtotalHours}</strong>`, 'text-align:right;background:#f8f9fb;')}
        ${td('', 'background:#f8f9fb;')}
        ${td(`<strong>${$(subtotalAmount)}</strong>`, 'text-align:right;background:#f8f9fb;')}
      </tr>
      ${sessionHtml}`;
  }).join('');

  el.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:0.8125rem;">
      <thead>
        <tr style="background:#f0f4ff;">
          <th style="border:1px solid var(--border);padding:0.35rem 0.5rem;width:130px;">Counselor</th>
          <th style="border:1px solid var(--border);padding:0.35rem 0.5rem;">Client</th>
          <th style="border:1px solid var(--border);padding:0.35rem 0.5rem;white-space:nowrap;">Session Date</th>
          <th style="border:1px solid var(--border);padding:0.35rem 0.5rem;">Type</th>
          <th style="border:1px solid var(--border);padding:0.35rem 0.5rem;text-align:right;">Hours</th>
          <th style="border:1px solid var(--border);padding:0.35rem 0.5rem;text-align:right;">Rate</th>
          <th style="border:1px solid var(--border);padding:0.35rem 0.5rem;text-align:right;">Amount</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr style="background:#e8f0fe;">
          <td colspan="4" style="border:1px solid var(--border);padding:0.35rem 0.5rem;font-weight:700;">Grand Total</td>
          <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;text-align:right;font-weight:700;" id="invoiceGrandHours">${grandHours}</td>
          <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;"></td>
          <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;text-align:right;font-weight:700;" id="invoiceGrandAmount">${$(grandAmount)}</td>
        </tr>
      </tfoot>
    </table>`;

  // Hours inputs — save to session doc, update amount cell live
  el.querySelectorAll('[data-hours-client]').forEach(input => {
    input.addEventListener('change', async () => {
      const clientId  = input.dataset.hoursClient;
      const sessionId = input.dataset.hoursSession;
      const rate      = parseFloat(input.dataset.rate) || 0;
      const hours     = parseFloat(input.value) || 0;
      const amount    = hours * rate;

      input.style.opacity = '0.5';
      try {
        await updateDoc(doc(db, 'clients', clientId, 'sessions', sessionId), { hours });
        input.style.opacity = '1';
        input.style.borderColor = '#16a34a';
        setTimeout(() => { input.style.borderColor = ''; }, 1500);

        // Update amount cell for this row
        const amountSpan = el.querySelector(`[data-amount-for="${sessionId}"]`);
        if (amountSpan) amountSpan.innerHTML = `$${amount.toFixed(2)}`;

        // Recalculate grand totals from all current input values
        let gh = 0, ga = 0;
        el.querySelectorAll('[data-hours-client]').forEach(inp => {
          const h = parseFloat(inp.value) || 0;
          const r = parseFloat(inp.dataset.rate) || 0;
          gh += h; ga += h * r;
        });
        const ghEl = document.getElementById('invoiceGrandHours');
        const gaEl = document.getElementById('invoiceGrandAmount');
        if (ghEl) ghEl.textContent = gh;
        if (gaEl) gaEl.textContent = `$${ga.toFixed(2)}`;

        // Remove red highlight from row if hours now set
        if (hours > 0) {
          const row = input.closest('tr');
          if (row) row.style.background = '';
          input.style.border = '1px solid var(--border)';
        }
      } catch (err) {
        alert('Save failed: ' + err.message);
        input.style.opacity = '1';
      }
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function countByField(rows, field, orderedKeys) {
  const counts = {};
  orderedKeys.forEach(k => { counts[k] = 0; });
  rows.forEach(r => { if (r[field] in counts) counts[r[field]]++; });
  return counts;
}

function amiLabel(level) {
  return level;
}

// ── Court Appearance Report ───────────────────────────────────────────────────

async function loadCourtReport() {
  const monthVal  = document.getElementById('courtReportMonth').value; // "YYYY-MM" or ""
  const year      = parseInt(document.getElementById('courtReportYear').value, 10);
  const counselor = document.getElementById('courtReportCounselor').value;
  const resultEl  = document.getElementById('courtReportResult');

  // Month takes priority over year; if neither, load all time
  let startDate, endDate, rangeLabel;
  if (monthVal) {
    const [yr, mo] = monthVal.split('-').map(Number);
    startDate  = new Date(`${yr}-${String(mo).padStart(2,'0')}-01T00:00:00`);
    endDate    = new Date(yr, mo, 0, 23, 59, 59); // last day of month
    rangeLabel = startDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  } else if (year && !isNaN(year)) {
    startDate  = new Date(`${year}-01-01T00:00:00`);
    endDate    = new Date(`${year}-12-31T23:59:59`);
    rangeLabel = String(year);
  } else {
    startDate  = null;
    endDate    = null;
    rangeLabel = 'all time';
  }

  resultEl.textContent = 'Loading…';
  document.getElementById('loadCourtReportBtn').disabled = true;

  try {
    const snap = await getDocs(collectionGroup(db, 'sessions'));

    let sessions = snap.docs
      .map(d => ({ id: d.id, clientId: d.ref.parent.parent.id, ...d.data() }))
      .filter(s => {
        if (!(s.caseStatus || '').startsWith('Court')) return false;
        if (startDate || endDate) {
          const d = s.date?.toDate ? s.date.toDate() : (s.date ? new Date(s.date) : null);
          if (!d) return false;
          if (startDate && d < startDate) return false;
          if (endDate   && d > endDate)   return false;
        }
        return true;
      });

    if (counselor) sessions = sessions.filter(s => s.counselor === counselor);

    if (!sessions.length) {
      resultEl.innerHTML = `<span style="color:var(--text-muted);">No court appearances found for ${counselor ? counselor + ' in ' : ''}${rangeLabel}.</span>`;
      return;
    }

    const groups = {};
    for (const s of sessions) {
      const dateMs  = s.date?.toDate ? s.date.toDate() : new Date(s.date);
      const dateStr = dateMs.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
      const county  = (s.caseStatus || '').replace(/^Court\s*[—-]\s*/i, '').trim() || 'Unknown County';
      const key     = `${dateMs.toISOString().split('T')[0]}|${county}`;

      if (!groups[key]) groups[key] = { dateStr, dateMs, county, counselors: new Set(), clients: [] };
      const g = groups[key];
      if (s.counselor) g.counselors.add(s.counselor);
      const name = (s.clientName || '').trim();
      const cid  = s.clientId || '';
      if ((name || cid) && !g.clients.find(c => c.clientId === cid && c.name === name)) {
        g.clients.push({ name, clientId: cid, notes: s.notes || '' });
      }
    }

    const sorted       = Object.values(groups).sort((a, b) => b.dateMs - a.dateMs);
    const totalDates   = sorted.length;
    const totalClients = sorted.reduce((s, g) => s + g.clients.length, 0);
    const filterNote   = counselor ? ` · Counselor: ${esc(counselor)}` : '';

    resultEl.innerHTML = `
      <div style="margin-bottom:0.75rem;font-size:0.8125rem;color:var(--text-muted);">
        <strong style="color:var(--text);">${totalDates}</strong> court date${totalDates !== 1 ? 's' : ''} &nbsp;·&nbsp;
        <strong style="color:var(--text);">${totalClients}</strong> total client appearances &nbsp;·&nbsp; ${esc(rangeLabel)}${filterNote}
      </div>
      <table style="font-size:0.875rem;">
        <thead>
          <tr>
            <th>Court Date</th><th>County</th>
            <th style="text-align:right;"># Clients</th>
            <th>Counselor(s)</th><th>Clients</th><th>Notes</th>
          </tr>
        </thead>
        <tbody>
          ${sorted.map(g => `
            <tr>
              <td style="white-space:nowrap;">${esc(g.dateStr)}</td>
              <td>${esc(g.county)}</td>
              <td style="text-align:right;font-weight:600;">${g.clients.length}</td>
              <td>${esc([...g.counselors].join(', ') || '—')}</td>
              <td style="font-size:0.8rem;">${g.clients.map(c => esc(isDemoMode() ? demoClientName(c.clientId) : titleCase(c.name))).join(', ') || '—'}</td>
              <td style="font-size:0.78rem;color:var(--text-muted);">${
                g.clients.some(c => c.notes) ? g.clients.filter(c => c.notes).map(c => esc(c.notes)).join('; ') : '—'
              }</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  } catch (err) {
    resultEl.innerHTML = `<span style="color:var(--danger);">Failed to load: ${esc(err.message)}</span>`;
  } finally {
    document.getElementById('loadCourtReportBtn').disabled = false;
  }
}

function esc(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function titleCase(str) {
  return (str || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}
