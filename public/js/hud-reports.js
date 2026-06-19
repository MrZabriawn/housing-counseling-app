import { db } from './firebase-config.js';
import {
  collection, collectionGroup, addDoc, getDocs, query, where, orderBy, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const AGENCY_NAME   = 'Housing Opportunities Inc.';
const AGENCY_NUMBER = '101';
const AUTH_NAME     = 'Zabriawn Smith';
const XLSX_MIME     = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// PAR grid layout
const S1_ROWS = {
  'Processing-Intake':  21,
  'Processing-Billing': 34,
  'Supervision':        40,
  'Management':         42,
  'Counseling':         46,
  'Group Education':    52,
};
const S1_LABELS = {
  'Processing-Intake':  'Processing – Intake and Follow-Up',
  'Processing-Billing': 'Processing – Billing',
  'Supervision':        'Supervision',
  'Management':         'Management and Related',
  'Counseling':         'Counseling',
  'Group Education':    'Group Education',
};
const S1_TOTAL_ROW = 58;
const S2_ROW       = 64;   // Training
const S2_TOTAL_ROW = 74;
const S3_ROW       = 80;   // Marketing
const S4_ROW       = 87;   // Non-HUD
const GRID_HDR_ROW = 18;
const LABEL_COL    = 1;
const TOTAL_COL    = 33;   // column AG
// Day d → column d+1

// ── Module state ──────────────────────────────────────────────────────────────
let _counselors = [];
let _year       = 0;
let _mon        = 0;
let _dataCache  = null;
let _cacheKey   = '';

// ── Entry point ───────────────────────────────────────────────────────────────
export async function initHudReports(user, profile) {
  const now = new Date();
  _year = now.getFullYear();
  _mon  = now.getMonth() + 1;
  document.getElementById('hudMonthPicker').value =
    `${_year}-${String(_mon).padStart(2, '0')}`;

  document.getElementById('hudMonthPicker').addEventListener('change', (e) => {
    const [y, m] = e.target.value.split('-').map(Number);
    _year = y; _mon = m;
    _dataCache = null; _cacheKey = '';
  });

  document.getElementById('refreshBtn').addEventListener('click', refreshStatus);

  document.getElementById('genCalBtn').addEventListener('click',     () => runExport(genCAL));
  document.getElementById('genAllParsBtn').addEventListener('click', () => runExport(genAllPARs));
  document.getElementById('genAllCmlsBtn').addEventListener('click', () => runExport(genAllCMLs));
  document.getElementById('genTalBtn').addEventListener('click',     () => runExport(genTAL));
  document.getElementById('genInvBtn').addEventListener('click',     () => runExport(genINV));
  document.getElementById('genAllBtn').addEventListener('click',     () => runExport(genAll));

  document.getElementById('importSessionsBtn').addEventListener('click', runImport);

  await refreshStatus();
}

// ── Status table ──────────────────────────────────────────────────────────────
async function refreshStatus() {
  const wrap = document.getElementById('statusTableWrap');
  wrap.innerHTML = '<p style="color:var(--text-muted);font-size:0.875rem;">Loading…</p>';

  try {
    const data = await getOrLoadData();
    _counselors = data.counselors;

    const TH = 'style="text-align:left;padding:0.4rem 0.75rem;border-bottom:2px solid var(--border);font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);"';
    const TD = 'style="padding:0.45rem 0.75rem;border-bottom:1px solid var(--border);"';

    wrap.innerHTML = `
      <table class="status-table">
        <thead>
          <tr>
            <th ${TH}>Counselor</th>
            <th ${TH} style="text-align:center;">PAR Entries</th>
            <th ${TH} style="text-align:center;">CML Entries</th>
            <th ${TH} style="text-align:center;">TAL Entries</th>
            <th ${TH}>Issues</th>
          </tr>
        </thead>
        <tbody>
          ${data.counselors.filter(c => c.active !== false).map(c => {
            const mySessions = data.sessions.filter(s => s.counselor === c.name && data.nofaRxSet.has((s.rxNumber||'').trim()));
            const myTM       = data.hudEvents.filter(e => e.counselorId === c.id);
            const parEntries = mySessions.length + myTM.length;
            const cmlCnt  = mySessions.filter(s => s.hudType === 'case_management').length;
            const talCnt  = myTM.length;
            const issues  = [];
            if (!c.staffNumber) issues.push('missing Staff #');
            if (!c.staffTitle)  issues.push('missing Title');
            if (!c.baseSalary)  issues.push('missing Base Salary');
            return `<tr>
              <td ${TD}>${escHtml(c.name)}</td>
              <td ${TD} style="text-align:center;">${parEntries}</td>
              <td ${TD} style="text-align:center;">${cmlCnt}</td>
              <td ${TD} style="text-align:center;">${talCnt}</td>
              <td ${TD}>${issues.length ? issues.map(i => `<span class="warn-badge">⚠ ${i}</span>`).join(' ') : '<span style="color:var(--accent);font-size:0.8rem;">✓ OK</span>'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;

    renderExportButtons(data.counselors.filter(c => c.active !== false));
  } catch (err) {
    wrap.innerHTML = `<p class="error-msg">Failed to load: ${err.message}</p>`;
    console.error(err);
  }
}

function renderExportButtons(counselors) {
  const parWrap = document.getElementById('parButtons');
  const cmlWrap = document.getElementById('cmlButtons');

  parWrap.innerHTML = counselors.map(c => {
    const blocked = !c.staffNumber || !c.staffTitle;
    const lastName = (c.name || '').split(' ').pop();
    return `<button class="btn btn-secondary btn-sm gen-par-btn"
      data-id="${escAttr(c.id)}" ${blocked ? 'disabled title="Fix issues in Settings first"' : ''}>
      PAR – ${escHtml(c.name)}
    </button>`;
  }).join('');

  cmlWrap.innerHTML = counselors.map(c => {
    const blocked = !c.staffNumber || !c.staffTitle;
    return `<button class="btn btn-secondary btn-sm gen-cml-btn"
      data-id="${escAttr(c.id)}" ${blocked ? 'disabled title="Fix issues in Settings first"' : ''}>
      CML – ${escHtml(c.name)}
    </button>`;
  }).join('');

  document.querySelectorAll('.gen-par-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const c = _counselors.find(x => x.id === btn.dataset.id);
      if (c) runExport(data => genPAR(c, data));
    });
  });
  document.querySelectorAll('.gen-cml-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const c = _counselors.find(x => x.id === btn.dataset.id);
      if (c) runExport(data => genCML(c, data));
    });
  });
}

// ── Data loading ──────────────────────────────────────────────────────────────
async function getOrLoadData() {
  const key = `${_year}-${_mon}`;
  if (_dataCache && _cacheKey === key) return _dataCache;
  _dataCache  = await loadAllData(_year, _mon);
  _cacheKey   = key;
  return _dataCache;
}

async function loadAllData(year, mon) {
  const monthKey  = `${year}-${String(mon).padStart(2, '0')}`;
  const ld        = lastDay(year, mon);

  const [counselorSnap, clientSnap, rxSnap, sessSnap, hudEventsSnap, schedSnap] = await Promise.all([
    getDocs(query(collection(db, 'counselors'), orderBy('name'))),
    getDocs(collection(db, 'clients')),
    getDocs(collectionGroup(db, 'rxNumbers')),
    getDocs(collectionGroup(db, 'sessions')),
    getDocs(query(collection(db, 'hudEvents'), where('month', '==', monthKey))),
    getDocs(collection(db, 'hudScheduledHours')),
  ]);

  const counselors = counselorSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const clientMap = {};
  clientSnap.docs.forEach(d => {
    const c = d.data();
    const parts = (c.clientName || '').trim().split(/\s+/);
    clientMap[d.id] = {
      clientName:  c.clientName || '',
      firstName:   parts[0] || '',
      lastName:    parts.slice(1).join(' ') || '',
      billingType: c.billingType || null,
      guarantor:   c.guarantor  || null,
    };
  });

  // Set of all active NOFA rxNumber strings — used to check session.rxNumber directly
  const nofaRxSet = new Set();
  rxSnap.docs.forEach(d => {
    const r = d.data();
    if (r.guarantor === 'NOFA' && r.active !== false && r.rxNumber) {
      nofaRxSet.add(r.rxNumber.trim());
    }
  });

  // Sessions filtered to selected month
  const sessions = [];
  sessSnap.docs.forEach(d => {
    const s        = d.data();
    const clientId = d.ref.parent.parent.id;
    const dateObj  = toDateObj(s.date);
    if (!dateObj) return;
    if (dateObj.getFullYear() !== year || (dateObj.getMonth() + 1) !== mon) return;
    sessions.push({ sessionId: d.id, clientId, dateObj, ...s });
  });

  // hudEvents — training/marketing only (S2/S3 on PAR; counseling comes from sessions)
  const hudEvents = hudEventsSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(e => e.type === 'training_marketing');
  const scheduledHoursMap = {};
  schedSnap.docs.forEach(d => { scheduledHoursMap[d.id] = d.data(); });

  return { year, mon, ld, lastDayFmt: fmtDate(ld), fileDateStr: fileDate(year, mon),
           counselors, clientMap, nofaRxSet, sessions, hudEvents, scheduledHoursMap };
}

// ── Export runner ─────────────────────────────────────────────────────────────
async function runExport(fn) {
  const msg = document.getElementById('statusMsg');
  msg.textContent = 'Generating…';
  msg.style.color = 'var(--text-muted)';
  msg.classList.remove('hidden');
  try {
    const data = await getOrLoadData();
    await fn(data);
    msg.textContent = 'Done.';
    msg.style.color = 'var(--accent)';
  } catch (err) {
    msg.textContent = 'Error: ' + err.message;
    msg.style.color = 'var(--danger)';
    console.error(err);
  }
  setTimeout(() => msg.classList.add('hidden'), 4000);
}

// ── CAL ───────────────────────────────────────────────────────────────────────
async function genCAL(data) {
  const { year, mon, lastDayFmt, fileDateStr, counselors, clientMap, nofaRxSet, sessions } = data;

  // All sessions in this month whose rxNumber is an active NOFA Rx
  const rows = sessions
    .filter(s => nofaRxSet.has((s.rxNumber || '').trim()))
    .map(s => {
      const c = clientMap[s.clientId] || {};
      return {
        dateStr:   fmtDate(s.dateObj),
        dateObj:   s.dateObj,
        rxNum:     (s.rxNumber || '').trim(),
        counselor: s.counselor || '',
        firstName: c.firstName || '',
        lastName:  c.lastName  || '',
        delivery:  'In-Person',
        minutes:   roundTo15((parseFloat(s.hours) || 0) * 60),
      };
    })
    .sort((a, b) => a.dateObj - b.dateObj);

  const wb = newWB();
  const ws = wb.addWorksheet('CAL');

  ws.getColumn(1).width = 14;
  ws.getColumn(2).width = 18;
  ws.getColumn(3).width = 22;
  ws.getColumn(4).width = 16;
  ws.getColumn(5).width = 16;
  ws.getColumn(6).width = 22;
  ws.getColumn(7).width = 18;
  ws.getColumn(8).width = 10;

  // Header block
  hdr(ws, 1, 'Agency Name:',        AGENCY_NAME);
  hdr(ws, 2, 'Agency Number:',      AGENCY_NUMBER);
  hdr(ws, 3, 'Period of Activity:', lastDayFmt);

  // Staff list
  const activeCounselors = counselors.filter(c => c.active !== false);
  activeCounselors.forEach((c, i) => {
    hdr(ws, 4 + i * 2,     'Staff Name:',  c.name || '');
    hdr(ws, 4 + i * 2 + 1, 'Staff Title:', c.staffTitle || '');
  });

  const dataStartRow = 4 + activeCounselors.length * 2 + 2;

  // Column headers
  const hdrs = ['Date', 'RX Case #', 'Counselor', 'First Name', 'Last Name', 'Counseling Type', 'Case Status', 'Minutes'];
  hdrs.forEach((h, i) => {
    const cell = ws.getCell(dataStartRow, i + 1);
    cell.value = h;
    cell.font  = { bold: true };
    cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8FF' } };
  });

  // Data rows
  rows.forEach((row, i) => {
    const r = dataStartRow + 1 + i;
    ws.getCell(r, 1).value = row.dateStr;
    ws.getCell(r, 2).value = row.rxNum;
    ws.getCell(r, 3).value = row.counselor;
    ws.getCell(r, 4).value = row.firstName;
    ws.getCell(r, 5).value = row.lastName;
    ws.getCell(r, 6).value = row.delivery;
    ws.getCell(r, 7).value = 'Under Progress';
    ws.getCell(r, 8).value = row.minutes;
  });

  downloadBuffer(await wb.xlsx.writeBuffer(), `101_HUD_${fileDateStr}CAL.xlsx`);
}

// ── PAR ───────────────────────────────────────────────────────────────────────
function requireCounselorFields(c) {
  const missing = [];
  if (!c.staffNumber) missing.push('Staff #');
  if (!c.staffTitle)  missing.push('Staff Title');
  if (missing.length) throw new Error(`${c.name} is missing: ${missing.join(', ')}. Fix in Settings first.`);
}

async function genPAR(counselor, data) {
  requireCounselorFields(counselor);
  const buf = await buildPAR(counselor, data);
  const lastName = (counselor.name || '').split(/\s+/).pop();
  downloadBuffer(buf, `101_${lastName}_HUD_${data.fileDateStr}PAR.xlsx`);
}

async function genAllPARs(data) {
  const active = data.counselors.filter(c => c.active !== false && c.staffNumber && c.staffTitle);
  if (!active.length) throw new Error('No counselors with complete Staff # and Title.');
  const zip  = new window.JSZip();
  for (const c of active) {
    const buf      = await buildPAR(c, data);
    const lastName = (c.name || '').split(/\s+/).pop();
    zip.file(`101_${lastName}_HUD_${data.fileDateStr}PAR.xlsx`, buf);
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  downloadBlob(blob, `PARs_${data.fileDateStr}.zip`);
}

async function buildPAR(counselor, data) {
  const { year, mon, ld, lastDayFmt, fileDateStr, sessions, nofaRxSet, hudEvents, scheduledHoursMap } = data;
  const daysInMonth = ld.getDate();

  const schedHrs = scheduledHoursMap[counselor.id] || {};

  // Section 1: from sessions — NOFA Rx, this counselor, this month (already month-filtered)
  const s1DayTotals = {};
  Object.keys(S1_ROWS).forEach(row => { s1DayTotals[row] = {}; });

  sessions
    .filter(s => s.counselor === counselor.name && nofaRxSet.has((s.rxNumber || '').trim()))
    .forEach(s => {
      const day = s.dateObj.getDate();
      // hudType 'case_management' → Processing-Intake; default → Counseling
      const row = s.hudType === 'case_management' ? 'Processing-Intake' : 'Counseling';
      s1DayTotals[row][day] = (s1DayTotals[row][day] || 0) + (parseFloat(s.hours) || 0);
    });

  // Section 2: Training — from hudEvents (training_marketing, costType T)
  const myTM = hudEvents.filter(e => e.counselorId === counselor.id);
  const s2Days = {};
  myTM.filter(e => e.costType === 'T').forEach(e => {
    const day = parseInt((e.date || '').split('-')[2], 10);
    if (!day) return;
    s2Days[day] = (s2Days[day] || 0) + (e.durationMinutes || 0) / 60;
  });

  // Section 3: Marketing — from hudEvents (training_marketing, costType M)
  const s3Days = {};
  myTM.filter(e => e.costType === 'M').forEach(e => {
    const day = parseInt((e.date || '').split('-')[2], 10);
    if (!day) return;
    s3Days[day] = (s3Days[day] || 0) + (e.durationMinutes || 0) / 60;
  });

  const wb = newWB();
  const ws = wb.addWorksheet('PAR');

  // Column widths: label col wide, day cols narrow
  ws.getColumn(LABEL_COL).width = 32;
  for (let d = 1; d <= 31; d++) ws.getColumn(d + 1).width = 5;
  ws.getColumn(TOTAL_COL).width = 8;

  // ── Header block ────────────────────────────────────────────────────────────
  hdr(ws, 1,  'PERSONNEL ACTIVITY REPORT', '');
  hdr(ws, 3,  'Agency Name:',        AGENCY_NAME);
  hdr(ws, 4,  'Agency Number:',      AGENCY_NUMBER);
  hdr(ws, 5,  'Period of Activity:', lastDayFmt);
  hdr(ws, 7,  'Employee Name:',      counselor.name || '');
  hdr(ws, 8,  'Employee Number:',    counselor.staffNumber || '');
  hdr(ws, 9,  'Employee Title:',     counselor.staffTitle  || '');
  hdr(ws, 10, 'Pay Rate-Base:',      counselor.baseSalary  != null ? counselor.baseSalary : '');
  hdr(ws, 11, 'Pay Rate-Fringe:',    counselor.fringe      != null ? counselor.fringe     : '');
  hdr(ws, 12, 'Effective Date:',     '');

  // ── Day column headers (row 18) ─────────────────────────────────────────────
  ws.getCell(GRID_HDR_ROW, LABEL_COL).value = 'Activity';
  ws.getCell(GRID_HDR_ROW, LABEL_COL).font  = { bold: true };
  for (let d = 1; d <= 31; d++) {
    const cell = ws.getCell(GRID_HDR_ROW, d + 1);
    cell.value     = d;
    cell.font      = { bold: true, size: 8 };
    cell.alignment = { horizontal: 'center' };
  }
  ws.getCell(GRID_HDR_ROW, TOTAL_COL).value = 'Total';
  ws.getCell(GRID_HDR_ROW, TOTAL_COL).font  = { bold: true };

  // ── Section 1 rows ──────────────────────────────────────────────────────────
  ws.getCell(19, LABEL_COL).value = 'SECTION 1 – PROGRAM ACTIVITY (Counseling and Related)';
  ws.getCell(19, LABEL_COL).font  = { bold: true };

  Object.entries(S1_ROWS).forEach(([rowKey, excelRow]) => {
    const label = S1_LABELS[rowKey] || rowKey;
    const days  = s1DayTotals[rowKey] || {};
    ws.getCell(excelRow, LABEL_COL).value = label;
    let rowTotal = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const hrs = days[d] || 0;
      if (hrs) {
        ws.getCell(excelRow, d + 1).value = hrs;
        rowTotal += hrs;
      }
    }
    if (rowTotal) ws.getCell(excelRow, TOTAL_COL).value = rowTotal;
  });

  // S1 Total row
  ws.getCell(S1_TOTAL_ROW, LABEL_COL).value = 'TOTAL SECTION 1';
  ws.getCell(S1_TOTAL_ROW, LABEL_COL).font  = { bold: true };
  for (let d = 1; d <= daysInMonth; d++) {
    let sum = 0;
    Object.values(s1DayTotals).forEach(days => { sum += days[d] || 0; });
    if (sum) ws.getCell(S1_TOTAL_ROW, d + 1).value = sum;
  }
  const s1GrandTotal = Object.values(s1DayTotals).reduce((t, days) => t + Object.values(days).reduce((a, h) => a + h, 0), 0);
  if (s1GrandTotal) ws.getCell(S1_TOTAL_ROW, TOTAL_COL).value = s1GrandTotal;

  // ── Section 2 ────────────────────────────────────────────────────────────────
  ws.getCell(59, LABEL_COL).value = 'SECTION 2 – TRAINING/CERTIFICATION';
  ws.getCell(59, LABEL_COL).font  = { bold: true };
  ws.getCell(S2_ROW, LABEL_COL).value = 'Training / Certification';
  let s2Total = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const hrs = s2Days[d] || 0;
    if (hrs) { ws.getCell(S2_ROW, d + 1).value = hrs; s2Total += hrs; }
  }
  ws.getCell(S2_TOTAL_ROW, LABEL_COL).value = 'TOTAL SECTION 2';
  ws.getCell(S2_TOTAL_ROW, LABEL_COL).font  = { bold: true };
  for (let d = 1; d <= daysInMonth; d++) {
    const hrs = s2Days[d] || 0;
    if (hrs) ws.getCell(S2_TOTAL_ROW, d + 1).value = hrs;
  }
  if (s2Total) ws.getCell(S2_TOTAL_ROW, TOTAL_COL).value = s2Total;

  // ── Section 3 ────────────────────────────────────────────────────────────────
  ws.getCell(75, LABEL_COL).value = 'SECTION 3 – MARKETING / OUTREACH';
  ws.getCell(75, LABEL_COL).font  = { bold: true };
  ws.getCell(S3_ROW, LABEL_COL).value = 'Marketing / Outreach';
  let s3Total = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const hrs = s3Days[d] || 0;
    if (hrs) { ws.getCell(S3_ROW, d + 1).value = hrs; s3Total += hrs; }
  }

  // ── Section 4 (non-HUD hours) ─────────────────────────────────────────────
  ws.getCell(85, LABEL_COL).value = 'SECTION 4 – NON-HUD HOURS';
  ws.getCell(85, LABEL_COL).font  = { bold: true };
  ws.getCell(S4_ROW, LABEL_COL).value = 'Non-HUD Hours (scheduled − grant hours, min 0)';
  let s4Total = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const s1h = Object.values(s1DayTotals).reduce((t, days) => t + (days[d] || 0), 0);
    const s2h = s2Days[d] || 0;
    const s3h = s3Days[d] || 0;
    const grantHrs = s1h + s2h + s3h;
    const dateStr = `${year}-${String(mon).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const sched = parseFloat(schedHrs[dateStr]) || 0;
    if (grantHrs === 0 && sched === 0) continue; // no entries → leave blank
    const fill = sched > 0 ? Math.max(0, sched - grantHrs) : Math.max(0, 8 - grantHrs);
    if (fill > 0) {
      ws.getCell(S4_ROW, d + 1).value = +fill.toFixed(4);
      s4Total += fill;
    }
  }
  if (s4Total) ws.getCell(S4_ROW, TOTAL_COL).value = +s4Total.toFixed(4);

  return wb.xlsx.writeBuffer();
}

// ── CML ───────────────────────────────────────────────────────────────────────
async function genCML(counselor, data) {
  requireCounselorFields(counselor);
  const buf      = await buildCML(counselor, data);
  const lastName = (counselor.name || '').split(/\s+/).pop();
  downloadBuffer(buf, `101_${lastName}_HUD_${data.fileDateStr}CML.xlsx`);
}

async function genAllCMLs(data) {
  const active = data.counselors.filter(c => c.active !== false && c.staffNumber && c.staffTitle);
  if (!active.length) throw new Error('No counselors with complete Staff # and Title.');
  const zip = new window.JSZip();
  for (const c of active) {
    const buf      = await buildCML(c, data);
    const lastName = (c.name || '').split(/\s+/).pop();
    zip.file(`101_${lastName}_HUD_${data.fileDateStr}CML.xlsx`, buf);
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  downloadBlob(blob, `CMLs_${data.fileDateStr}.zip`);
}

async function buildCML(counselor, data) {
  const { lastDayFmt, fileDateStr, clientMap, sessions, nofaRxSet } = data;

  // Sessions logged as Case Management with a NOFA Rx for this counselor
  const cmSessions = sessions.filter(s =>
    s.counselor === counselor.name &&
    s.hudType === 'case_management' &&
    nofaRxSet.has((s.rxNumber || '').trim())
  );

  const wb = newWB();
  const ws = wb.addWorksheet('CML');
  ws.getColumn(1).width = 14;
  ws.getColumn(2).width = 22;
  ws.getColumn(3).width = 40;
  ws.getColumn(4).width = 10;

  hdr(ws, 1, 'Agency Name:',        AGENCY_NAME);
  hdr(ws, 2, 'Agency Number:',      AGENCY_NUMBER);
  hdr(ws, 3, 'Employee Name:',      counselor.name || '');
  hdr(ws, 4, 'Employee Number:',    counselor.staffNumber || '');
  hdr(ws, 5, 'Period of Activity:', lastDayFmt);

  const dataStart = 8;
  ['Date', 'Staff Name', 'Description', 'Minutes'].forEach((h, i) => {
    const cell = ws.getCell(dataStart, i + 1);
    cell.value = h; cell.font = { bold: true };
    cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8FF' } };
  });

  const rows = cmSessions.map(s => ({
    date:    fmtDate(s.dateObj),
    name:    counselor.name,
    desc:    clientMap[s.clientId]?.clientName || s.notes || '',
    minutes: roundTo15((parseFloat(s.hours) || 0) * 60),
  })).sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  rows.forEach((r, i) => {
    const row = dataStart + 1 + i;
    ws.getCell(row, 1).value = r.date instanceof Date ? fmtDate(r.date) : (r.date || '');
    ws.getCell(row, 2).value = r.name;
    ws.getCell(row, 3).value = r.desc;
    ws.getCell(row, 4).value = r.minutes;
  });

  return wb.xlsx.writeBuffer();
}

// ── TAL ───────────────────────────────────────────────────────────────────────
async function genTAL(data) {
  const { lastDayFmt, fileDateStr, hudEvents, counselors } = data;

  const counselorMap = {};
  counselors.forEach(c => { counselorMap[c.id] = c; });

  const rows = [...hudEvents].sort((a, b) => {
      const dc = (a.date || '').localeCompare(b.date || '');
      return dc !== 0 ? dc : (a.counselorName || '').localeCompare(b.counselorName || '');
    });

  const wb = newWB();
  const ws = wb.addWorksheet('TAL');
  [16, 10, 12, 22, 36, 12, 18, 12].forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  hdr(ws, 1, 'Agency Name:',        AGENCY_NAME);
  hdr(ws, 2, 'Agency Number:',      AGENCY_NUMBER);
  hdr(ws, 3, 'Period of Activity:', lastDayFmt);

  const dataStart = 6;
  const hdrs = ['Date', 'Time', 'Staff #', 'Staff Name', 'Description', 'Activity Type', 'Type of Cost', 'Duration (hrs)'];
  hdrs.forEach((h, i) => {
    const cell = ws.getCell(dataStart, i + 1);
    cell.value = h; cell.font = { bold: true };
    cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8FF' } };
  });

  rows.forEach((e, i) => {
    const c = counselorMap[e.counselorId] || {};
    const r = dataStart + 1 + i;
    ws.getCell(r, 1).value = e.date      || '';
    ws.getCell(r, 2).value = e.startTime || '';
    ws.getCell(r, 3).value = c.staffNumber || '';
    ws.getCell(r, 4).value = e.counselorName || c.name || '';
    ws.getCell(r, 5).value = e.description || '';
    ws.getCell(r, 6).value = e.costType === 'M' ? 'Marketing' : 'Training';
    ws.getCell(r, 7).value = e.costType || '';
    ws.getCell(r, 8).value = +((e.durationMinutes || 0) / 60).toFixed(4);
  });

  downloadBuffer(await wb.xlsx.writeBuffer(), `101_HUD_${fileDateStr}TAL.xlsx`);
}

// ── INV ───────────────────────────────────────────────────────────────────────
async function genINV(data) {
  const { lastDayFmt, fileDateStr, counselors, sessions, nofaRxSet, hudEvents } = data;

  const activeCounselors = counselors.filter(c => c.active !== false);
  const wb = newWB();
  const ws = wb.addWorksheet('INV');
  [8, 24, 14, 14, 16, 18, 18].forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  hdr(ws, 1, 'Agency Name:',        AGENCY_NAME);
  hdr(ws, 2, 'Agency Number:',      AGENCY_NUMBER);
  hdr(ws, 3, 'Period of Activity:', lastDayFmt);
  hdr(ws, 4, 'Authorized Name:',    AUTH_NAME);

  const s1Start = 7;
  const hdrs = ['Emp #', 'Employee Name', 'Base Salary ($/hr)', 'Fringe ($/hr)', 'Total HUD Hrs', 'Salary Cost', 'Total Cost'];
  hdrs.forEach((h, i) => {
    const cell = ws.getCell(s1Start, i + 1);
    cell.value = h; cell.font = { bold: true };
    cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8FF' } };
  });

  let rowIdx = s1Start + 1;
  let totalSalaryCost = 0, totalCost = 0;

  activeCounselors.forEach(c => {
    const s1Hrs = sessions
      .filter(s => s.counselor === c.name && nofaRxSet.has((s.rxNumber || '').trim()))
      .reduce((sum, s) => sum + (parseFloat(s.hours) || 0), 0);
    const s23Hrs = hudEvents
      .filter(e => e.counselorId === c.id)
      .reduce((sum, e) => sum + (e.durationMinutes || 0) / 60, 0);
    const totalHrs = s1Hrs + s23Hrs;
    if (!totalHrs) return;
    const base        = parseFloat(c.baseSalary) || 0;
    const fringe      = parseFloat(c.fringe)     || 0;
    const salaryCost  = +(base * totalHrs).toFixed(2);
    const fullCost    = +((base + fringe) * totalHrs).toFixed(2);
    totalSalaryCost  += salaryCost;
    totalCost        += fullCost;

    ws.getCell(rowIdx, 1).value = c.staffNumber || '';
    ws.getCell(rowIdx, 2).value = c.name || '';
    ws.getCell(rowIdx, 3).value = base;
    ws.getCell(rowIdx, 4).value = fringe;
    ws.getCell(rowIdx, 5).value = totalHrs;
    ws.getCell(rowIdx, 6).value = salaryCost;
    ws.getCell(rowIdx, 7).value = fullCost;
    rowIdx++;
  });

  // Totals row
  ws.getCell(rowIdx, 2).value = 'TOTAL';
  ws.getCell(rowIdx, 2).font  = { bold: true };
  ws.getCell(rowIdx, 6).value = +totalSalaryCost.toFixed(2);
  ws.getCell(rowIdx, 7).value = +totalCost.toFixed(2);
  ws.getCell(rowIdx, 6).font  = { bold: true };
  ws.getCell(rowIdx, 7).font  = { bold: true };

  rowIdx += 3;
  ws.getCell(rowIdx, 1).value = 'SECTION 2: Training Costs — enter manually';
  ws.getCell(rowIdx, 1).font  = { color: { argb: 'FF888888' }, italic: true };
  rowIdx += 2;
  ws.getCell(rowIdx, 1).value = 'SECTION 3: Indirect Costs — enter manually';
  ws.getCell(rowIdx, 1).font  = { color: { argb: 'FF888888' }, italic: true };
  rowIdx += 2;
  ws.getCell(rowIdx, 1).value = 'SECTION 4: For PHFA Use Only';
  ws.getCell(rowIdx, 1).font  = { color: { argb: 'FF888888' }, italic: true };

  downloadBuffer(await wb.xlsx.writeBuffer(), `101_HUD_INV_${fileDateStr}.xlsx`);
}

// ── Generate All (ZIP) ────────────────────────────────────────────────────────
async function genAll(data) {
  const { counselors, fileDateStr } = data;
  const active = counselors.filter(c => c.active !== false && c.staffNumber && c.staffTitle);
  const zip = new window.JSZip();

  // CAL
  const calBuf = await (async () => {
    const { lastDayFmt, clientMap, nofaRxSet, sessions } = data;
    const rows = sessions
      .filter(s => nofaRxSet.has((s.rxNumber||'').trim()))
      .map(s => {
        const c = clientMap[s.clientId] || {};
        return { dateStr: fmtDate(s.dateObj), dateObj: s.dateObj,
                 rxNum: (s.rxNumber||'').trim(), counselor: s.counselor||'',
                 firstName: c.firstName||'', lastName: c.lastName||'',
                 minutes: roundTo15((parseFloat(s.hours)||0)*60) };
      }).sort((a,b) => a.dateObj-b.dateObj);
    const wb = newWB(); const ws = wb.addWorksheet('CAL');
    hdr(ws,1,'Agency Name:',AGENCY_NAME); hdr(ws,2,'Agency Number:',AGENCY_NUMBER); hdr(ws,3,'Period of Activity:',lastDayFmt);
    const dsr = 6;
    ['Date','RX Case #','Counselor','First Name','Last Name','Counseling Type','Case Status','Minutes']
      .forEach((h,i) => { ws.getCell(dsr,i+1).value=h; ws.getCell(dsr,i+1).font={bold:true}; });
    rows.forEach((row,i) => {
      const r = dsr+1+i;
      ws.getCell(r,1).value=row.dateStr; ws.getCell(r,2).value=row.rxNum;
      ws.getCell(r,3).value=row.counselor; ws.getCell(r,4).value=row.firstName; ws.getCell(r,5).value=row.lastName;
      ws.getCell(r,6).value='In-Person'; ws.getCell(r,7).value='Under Progress'; ws.getCell(r,8).value=row.minutes;
    });
    return wb.xlsx.writeBuffer();
  })();
  zip.file(`101_HUD_${fileDateStr}CAL.xlsx`, calBuf);

  // PARs & CMLs
  for (const c of active) {
    const lastName = (c.name || '').split(/\s+/).pop();
    zip.file(`101_${lastName}_HUD_${fileDateStr}PAR.xlsx`, await buildPAR(c, data));
    zip.file(`101_${lastName}_HUD_${fileDateStr}CML.xlsx`, await buildCML(c, data));
  }

  // TAL — generate buffer inline
  const talWb = newWB(); const talWs = talWb.addWorksheet('TAL');
  hdr(talWs, 1, 'Agency Name:', AGENCY_NAME);
  hdr(talWs, 2, 'Agency Number:', AGENCY_NUMBER);
  hdr(talWs, 3, 'Period of Activity:', data.lastDayFmt);
  ['Date','Time','Staff #','Staff Name','Description','Activity Type','Type of Cost','Duration (hrs)']
    .forEach((h, i) => { talWs.getCell(6, i+1).value = h; talWs.getCell(6, i+1).font = { bold: true }; });
  const cMap = {}; data.counselors.forEach(c => { cMap[c.id] = c; });
  [...data.hudEvents].sort((a,b) => (a.date||'').localeCompare(b.date||'')).forEach((e, i) => {
    const c = cMap[e.counselorId] || {}; const r = 7 + i;
    talWs.getCell(r,1).value = e.date||''; talWs.getCell(r,2).value = e.startTime||'';
    talWs.getCell(r,3).value = c.staffNumber||''; talWs.getCell(r,4).value = e.counselorName||'';
    talWs.getCell(r,5).value = e.description||'';
    talWs.getCell(r,6).value = e.costType==='M'?'Marketing':'Training';
    talWs.getCell(r,7).value = e.costType||'';
    talWs.getCell(r,8).value = +((e.durationMinutes||0)/60).toFixed(4);
  });
  zip.file(`101_HUD_${fileDateStr}TAL.xlsx`, await talWb.xlsx.writeBuffer());

  // INV — reuse genINV logic
  const invWb = newWB(); const invWs = invWb.addWorksheet('INV');
  hdr(invWs,1,'Agency Name:',AGENCY_NAME); hdr(invWs,2,'Agency Number:',AGENCY_NUMBER);
  hdr(invWs,3,'Period of Activity:',data.lastDayFmt); hdr(invWs,4,'Authorized Name:',AUTH_NAME);
  ['Emp #','Employee Name','Base ($/hr)','Fringe ($/hr)','HUD Hrs','Salary Cost','Total Cost']
    .forEach((h,i)=>{ invWs.getCell(7,i+1).value=h; invWs.getCell(7,i+1).font={bold:true}; });
  let ri=8, tSal=0, tTot=0;
  active.forEach(c => {
    const s1h = data.sessions.filter(s=>s.counselor===c.name&&data.nofaRxSet.has((s.rxNumber||'').trim()))
                  .reduce((sum,s)=>sum+(parseFloat(s.hours)||0),0);
    const s23h = data.hudEvents.filter(e=>e.counselorId===c.id)
                  .reduce((sum,e)=>sum+(e.durationMinutes||0)/60,0);
    const hrs = s1h + s23h;
    if (!hrs) return;
    const b=parseFloat(c.baseSalary)||0, f=parseFloat(c.fringe)||0;
    const sc=+(b*hrs).toFixed(2), tc=+((b+f)*hrs).toFixed(2);
    invWs.getCell(ri,1).value=c.staffNumber||''; invWs.getCell(ri,2).value=c.name||'';
    invWs.getCell(ri,3).value=b; invWs.getCell(ri,4).value=f;
    invWs.getCell(ri,5).value=hrs; invWs.getCell(ri,6).value=sc; invWs.getCell(ri,7).value=tc;
    tSal+=sc; tTot+=tc; ri++;
  });
  invWs.getCell(ri,2).value='TOTAL'; invWs.getCell(ri,2).font={bold:true};
  invWs.getCell(ri,6).value=+tSal.toFixed(2); invWs.getCell(ri,7).value=+tTot.toFixed(2);
  zip.file(`101_HUD_INV_${fileDateStr}.xlsx`, await invWb.xlsx.writeBuffer());

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  downloadBlob(blob, `HOI_HUD_Submission_${fileDateStr}.zip`);
}

// ── Session Import ────────────────────────────────────────────────────────────
async function runImport() {
  const btn = document.getElementById('importSessionsBtn');
  const msg = document.getElementById('importMsg');
  btn.disabled = true;
  msg.textContent = 'Scanning sessions… this may take a moment.';
  msg.style.color = 'var(--text-muted)';
  msg.classList.remove('hidden');
  try {
    const { created, skipped, noHours } = await importFromSessions();
    msg.textContent = `Done. Created ${created} new HUD entries, skipped ${skipped} already imported, skipped ${noHours} with no hours.`;
    msg.style.color = 'var(--accent)';
    _dataCache = null; _cacheKey = '';
    await refreshStatus();
  } catch (err) {
    msg.textContent = 'Import failed: ' + err.message;
    msg.style.color = 'var(--danger)';
    console.error(err);
  }
  btn.disabled = false;
}

async function importFromSessions() {
  const CUTOFF = '2026-01-01';

  const [clientSnap, rxSnap, counselorSnap, sessSnap, existingSnap] = await Promise.all([
    getDocs(collection(db, 'clients')),
    getDocs(collectionGroup(db, 'rxNumbers')),
    getDocs(query(collection(db, 'counselors'), orderBy('name'))),
    getDocs(collectionGroup(db, 'sessions')),
    getDocs(collection(db, 'hudEvents')),
  ]);

  const billingTypeMap = {};
  clientSnap.docs.forEach(d => { billingTypeMap[d.id] = d.data().billingType || null; });

  const nofaRxMap = {}; // rxNumber → { nofaInitiative }
  rxSnap.docs.forEach(d => {
    const r = d.data();
    if (r.active !== false && r.rxNumber && r.guarantor === 'NOFA') {
      nofaRxMap[r.rxNumber.trim()] = { nofaInitiative: r.nofaInitiative || '' };
    }
  });

  const counselorNameToId = {};
  counselorSnap.docs.forEach(d => { counselorNameToId[d.data().name] = d.id; });

  const importedIds = new Set(existingSnap.docs.map(d => d.data().sourceSessionId).filter(Boolean));

  let created = 0, skipped = 0, noHours = 0;

  for (const d of sessSnap.docs) {
    const clientId = d.ref.parent.parent.id;
    const s = d.data();

    // Parse date
    let dateStr;
    const rawDate = s.date;
    if (rawDate?.toDate) dateStr = rawDate.toDate().toISOString().split('T')[0];
    else if (typeof rawDate === 'string') dateStr = rawDate.slice(0, 10);
    else continue;

    if (!dateStr || dateStr < CUTOFF) continue;

    if (importedIds.has(d.id)) { skipped++; continue; }

    const rxNum  = (s.rxNumber || '').trim();
    const rxInfo = nofaRxMap[rxNum];
    if (!rxInfo) continue;

    const billing = billingTypeMap[clientId];
    let type, parRow;
    if (billing === 'In-Person') {
      type = 'counseling_session'; parRow = 'Counseling';
    } else if (billing === 'Case Management Activity' || billing === 'Court') {
      type = 'case_management'; parRow = 'Processing-Intake';
    } else {
      continue;
    }

    const rawHours = parseFloat(s.hours) || 0;
    if (!rawHours) { noHours++; continue; }
    const durationMinutes = Math.round(rawHours * 60 / 15) * 15;

    const counselorName = s.counselor || '';
    const counselorId   = counselorNameToId[counselorName] || '';
    const month = dateStr.slice(0, 7);

    await addDoc(collection(db, 'hudEvents'), {
      counselorId,
      counselorName,
      month,
      date: dateStr,
      type,
      parSection: 'S1',
      parRow,
      rxCaseNo: rxNum,
      clientId,
      clientName: '',
      guarantor: 'NOFA',
      nofaInitiative: rxInfo.nofaInitiative,
      activityNote: '',
      delivery: type === 'counseling_session' ? 'face-to-face' : undefined,
      durationMinutes,
      sourceSessionId: d.id,
      createdAt: serverTimestamp(),
    });
    importedIds.add(d.id);
    created++;
  }

  return { created, skipped, noHours };
}

// ── ExcelJS helpers ───────────────────────────────────────────────────────────
function newWB() {
  const wb          = new window.ExcelJS.Workbook();
  wb.creator        = AGENCY_NAME;
  wb.created        = new Date();
  return wb;
}

function hdr(ws, row, label, value) {
  ws.getCell(row, 1).value = label;
  ws.getCell(row, 1).font  = { bold: true };
  ws.getCell(row, 2).value = value;
}

function downloadBuffer(buf, filename) {
  downloadBlob(new Blob([buf], { type: XLSX_MIME }), filename);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function lastDay(year, mon) {
  return new Date(year, mon, 0); // mon is 1-based; day 0 = last day of previous month
}

function fmtDate(d) {
  if (!d) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getFullYear()}`;
}

function fileDate(year, mon) {
  const ld = lastDay(year, mon);
  const mm = String(ld.getMonth() + 1).padStart(2, '0');
  const dd = String(ld.getDate()).padStart(2, '0');
  return `${mm}${dd}${ld.getFullYear()}`;
}

function roundTo15(minutes) {
  return Math.round(minutes / 15) * 15;
}

function toDateObj(raw) {
  if (!raw) return null;
  if (raw.toDate) return raw.toDate();
  if (raw instanceof Date) return raw;
  if (typeof raw === 'string') return new Date(raw + 'T12:00:00');
  return null;
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function escAttr(str) {
  return String(str ?? '').replace(/"/g,'&quot;');
}
