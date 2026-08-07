// CHCI billing — parse Rx Office reports, generate PHFA invoice Excel files,
// bundle them as a named ZIP, upload to Firebase Storage, and maintain a
// persistent history of past submissions.

import { db, storage, auth } from './firebase-config.js';
import {
  collection, addDoc, getDocs, query, orderBy, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// Storage SDK is imported lazily inside generateAll() so a CDN hiccup doesn't
// prevent the file-parsing listeners from being wired on page load.

const _parsed = { f2f: null, md: null, dd: null };

export function initChciReports() {
  document.getElementById('f2fUpload').addEventListener('change', e => handleUpload('f2f', e));
  document.getElementById('mdUpload').addEventListener('change',  e => handleUpload('md',  e));
  document.getElementById('ddUpload').addEventListener('change',  e => handleUpload('dd',  e));
  document.getElementById('generateChciBtn').addEventListener('click', generateAll);
  loadChciHistory();
}

// ── Parse uploaded report ─────────────────────────────────────────────────────

async function handleUpload(type, e) {
  const file = e.target.files[0];
  if (!file) return;

  const statusEl = document.getElementById(`${type}Status`);
  statusEl.textContent = 'Parsing…';

  try {
    const buf = await file.arrayBuffer();
    const wb  = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];

    const rows = extractRows(ws, type);
    _parsed[type] = rows;
    showPreview(type, rows);
    statusEl.textContent = `${rows.length} session${rows.length !== 1 ? 's' : ''} loaded`;
    statusEl.style.color = 'var(--primary)';
  } catch (err) {
    statusEl.textContent = 'Parse failed: ' + err.message;
    statusEl.style.color = 'var(--danger)';
  }

  updateGenerateBtn();
}

function extractRows(ws, type) {
  const hdrMap = {};
  ws.getRow(1).eachCell((cell, col) => {
    if (cell.value != null) hdrMap[String(cell.value).trim()] = col - 1;
  });

  const rows = [];
  ws.eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    const vals = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => { vals[col - 1] = cell.value; });
    const col = (name) => vals[hdrMap[name] ?? hdrMap[name + ' '] ?? -1];

    const date           = col('Date');
    const caseNo         = col('Case No.') ?? col('Case No. ');
    const lastName       = col('Last Name');
    const firstName      = col('First Name');
    const caseStatus     = col('Case Status');
    const counselingType = col('Counseling Type');
    const duration       = col('Duration(min)');

    if (!date || !caseNo || !lastName) return;
    rows.push({
      date,
      caseNo:         String(Math.round(parseFloat(caseNo))),
      lastName:       String(lastName ?? ''),
      firstName:      String(firstName ?? ''),
      caseStatus:     String(caseStatus ?? ''),
      counselingType: String(counselingType ?? ''),
      duration:       parseFloat(duration) || 0,
    });
  });

  rows.sort((a, b) => toDate(a.date) - toDate(b.date));
  return rows;
}

function toDate(val) {
  if (!val) return 0;
  if (val instanceof Date) return val.getTime();
  if (typeof val === 'string') {
    const [m, d, y] = val.split('/');
    return new Date(+y, +m - 1, +d).getTime();
  }
  return new Date(val).getTime();
}

function fmtDate(val) {
  const d = new Date(toDate(val));
  if (isNaN(d)) return '';
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

// ── Preview table ─────────────────────────────────────────────────────────────

function showPreview(type, rows) {
  const el = document.getElementById(`${type}Preview`);
  if (!rows.length) {
    el.innerHTML = '<p style="color:var(--text-muted);font-size:0.875rem;">No data rows found.</p>';
    return;
  }

  const th = (t, align = '') =>
    `<th style="border:1px solid var(--border);padding:0.3rem 0.4rem;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-muted);${align ? `text-align:${align};` : ''}">${t}</th>`;
  const td = (v, align = '') =>
    `<td style="border:1px solid var(--border);padding:0.25rem 0.5rem;font-size:0.8125rem;${align ? `text-align:${align};` : ''}">${v ?? ''}</td>`;

  let totalMin = 0, totalAmt = 0;
  const bodyRows = rows.map(r => {
    const amt = Math.round(r.duration / 60 * 100);
    totalMin += r.duration;
    totalAmt += amt;
    return `<tr>
      ${td(fmtDate(r.date))}${td(r.caseNo)}${td(r.lastName)}${td(r.firstName)}
      ${td(r.caseStatus)}${td(r.counselingType)}${td(r.duration, 'right')}${td('$' + amt, 'right')}
    </tr>`;
  }).join('');

  el.innerHTML = `
    <div style="overflow-x:auto;">
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr style="background:#f8f9fb;">
        ${th('Date')}${th('Case #')}${th('Last Name')}${th('First Name')}
        ${th('Case Status')}${th('Counseling Type')}${th('Min','right')}${th('Amt','right')}
      </tr></thead>
      <tbody>${bodyRows}</tbody>
      <tfoot>
        <tr style="background:#e8f0fe;font-weight:700;">
          <td colspan="6" style="border:1px solid var(--border);padding:0.28rem 0.5rem;font-size:0.8125rem;">Total — ${rows.length} session${rows.length !== 1 ? 's' : ''}</td>
          <td style="border:1px solid var(--border);padding:0.28rem 0.5rem;text-align:right;font-size:0.8125rem;">${totalMin}</td>
          <td style="border:1px solid var(--border);padding:0.28rem 0.5rem;text-align:right;font-size:0.8125rem;">$${totalAmt}</td>
        </tr>
      </tfoot>
    </table></div>`;
}

function updateGenerateBtn() {
  const btn = document.getElementById('generateChciBtn');
  btn.disabled = !Object.values(_parsed).some(v => v && v.length > 0);
}

// ── Build one invoice workbook, return buffer + total amount ──────────────────

async function buildInvoiceBuffer(rows, { key, tag, typeLabel }) {
  const wb        = new ExcelJS.Workbook();
  const firstDate = new Date(toDate(rows[0].date));
  const monthName = firstDate.toLocaleString('en-US', { month: 'long' });
  const year      = firstDate.getFullYear();
  const isF2F     = key === 'f2f';
  const headerRow = isF2F ? 19 : 15;
  const dataStart = isF2F ? 20 : 16;

  const ws = wb.addWorksheet(monthName);

  cell(ws, 4, 1, 'Agency #');         cell(ws, 4, 3, 101);
  cell(ws, 5, 1, 'Agency Name');      cell(ws, 5, 3, 'Housing Opportunities Inc.');
  cell(ws, 6, 1, 'Agency Contact');   cell(ws, 6, 3, 'Zabriawn Smith');
  if (tag === 'D&D') cell(ws, 6, 7, 'D&D');
  if (tag === 'M&D') cell(ws, 6, 7, 'M&D');
  cell(ws, 7, 1, 'Agency Contact Phone #'); cell(ws, 7, 3, '(724) 728-7511');
  cell(ws, 9, 1, 'SEND TO:   CHCIBilling@PHFA.org');

  if (isF2F) {
    cell(ws, 13, 1, 'Questions? Call Shanice Moul 717-480-5334');
  } else {
    cell(ws, 13, 1, 'Questions?  '); cell(ws, 13, 2, 'Call Shanice');
    cell(ws, 13, 3, 'Moul   717-'); cell(ws, 13, 4, '480-5334');
  }

  const hdr = ws.getRow(headerRow);
  ['Date', 'Case #', 'Last Name', 'First Name', 'Case Status', 'Counseling Type', 'Minutes', isF2F ? ' Amount ' : 'Amount']
    .forEach((v, i) => { hdr.getCell(i + 1).value = v; });
  hdr.font = { bold: true };

  let totalMin = 0, totalAmt = 0;
  rows.forEach((r, i) => {
    const rowNum   = dataStart + i;
    const amt      = Math.round(r.duration / 60 * 100);
    totalMin      += r.duration;
    totalAmt      += amt;
    const dateCell = ws.getCell(rowNum, 1);
    dateCell.value  = new Date(toDate(r.date));
    dateCell.numFmt = 'mm/dd/yyyy';
    cell(ws, rowNum, 2, parseInt(r.caseNo));
    cell(ws, rowNum, 3, r.lastName);
    cell(ws, rowNum, 4, r.firstName);
    cell(ws, rowNum, 5, r.caseStatus);
    cell(ws, rowNum, 6, r.counselingType);
    cell(ws, rowNum, 7, r.duration);
    cell(ws, rowNum, 8, amt);
  });

  const totRow = dataStart + rows.length + 1;
  if (isF2F) {
    cell(ws, totRow, 6, 'TOTAL'); cell(ws, totRow, 8, totalAmt);
  } else {
    cell(ws, totRow, 6, 'Totals'); cell(ws, totRow, 7, totalMin); cell(ws, totRow, 8, totalAmt);
  }
  ws.getRow(totRow).font = { bold: true };

  ws.getColumn(1).width = 14; ws.getColumn(2).width = 12; ws.getColumn(3).width = 18;
  ws.getColumn(4).width = 14; ws.getColumn(5).width = 28; ws.getColumn(6).width = 34;
  ws.getColumn(7).width = 10; ws.getColumn(8).width = 10;

  const buf = await wb.xlsx.writeBuffer();
  return { buf, totalAmt, monthName, year };
}

// ── Generate, zip, upload, record ────────────────────────────────────────────

async function generateAll() {
  const btn    = document.getElementById('generateChciBtn');
  const statusEl = document.getElementById('chciUploadStatus');
  btn.disabled = true;
  btn.textContent = 'Generating…';
  statusEl.textContent = '';
  statusEl.className = '';

  try {
    const configs = [
      { key: 'f2f', tag: 'Face-to-Face', typeLabel: 'F2F' },
      { key: 'md',  tag: 'M&D',          typeLabel: 'M&D' },
      { key: 'dd',  tag: 'D&D',          typeLabel: 'D&D' },
    ];

    const zip     = new JSZip();
    const amounts = {};      // { f2f: 480, md: 240, ... }
    let monthName = '', year = '';

    for (const cfg of configs) {
      const rows = _parsed[cfg.key];
      if (!rows || !rows.length) continue;
      const { buf, totalAmt, monthName: mn, year: yr } = await buildInvoiceBuffer(rows, cfg);
      zip.file(`CHCI ${cfg.typeLabel} Invoice - ${mn} ${yr}.xlsx`, buf);
      amounts[cfg.key] = totalAmt;
      monthName = mn;
      year      = yr;
    }

    // Build the zip filename — e.g. "CHCI Invoice - D&D $480 M&D $240 - January 2025.zip"
    const amtParts = [];
    if (amounts.f2f) amtParts.push(`F2F $${amounts.f2f}`);
    if (amounts.md)  amtParts.push(`M&D $${amounts.md}`);
    if (amounts.dd)  amtParts.push(`D&D $${amounts.dd}`);
    const zipName = `CHCI Invoice - ${amtParts.join(' ')} - ${monthName} ${year}.zip`;

    statusEl.textContent = 'Zipping…';
    const zipBlob = await zip.generateAsync({ type: 'blob' });

    // Trigger local download immediately — don't wait on upload
    triggerDownload(zipBlob, zipName);

    // Upload to Firebase Storage (lazy import keeps the module resilient)
    statusEl.textContent = 'Uploading…';
    const { ref, uploadBytes, getDownloadURL } = await import(
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js'
    );
    const monthPad  = String(['January','February','March','April','May','June',
      'July','August','September','October','November','December'].indexOf(monthName) + 1).padStart(2, '0');
    const storageRef = ref(storage, `chci-reports/${year}-${monthPad}/${zipName}`);
    await uploadBytes(storageRef, zipBlob, { contentType: 'application/zip' });
    const downloadUrl = await getDownloadURL(storageRef);

    // Record in Firestore
    await addDoc(collection(db, 'chciReports'), {
      fileName:   zipName,
      month:      `${monthName} ${year}`,
      amounts,
      downloadUrl,
      createdAt:  serverTimestamp(),
      createdBy:  auth.currentUser?.displayName || auth.currentUser?.email || 'Unknown',
    });

    statusEl.textContent = '✓ Saved online';
    statusEl.style.color = 'var(--primary)';

    await loadChciHistory();

  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Upload failed — file was still downloaded locally. Error: ' + err.message;
    statusEl.style.color = 'var(--danger)';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate & Save Zip';
    updateGenerateBtn();
  }
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ── History ───────────────────────────────────────────────────────────────────

export async function loadChciHistory() {
  const el = document.getElementById('chciHistory');
  if (!el) return;

  try {
    const snap = await getDocs(
      query(collection(db, 'chciReports'), orderBy('createdAt', 'desc'))
    );

    if (snap.empty) {
      el.innerHTML = '<p style="color:var(--text-muted);font-size:0.875rem;">No saved reports yet.</p>';
      return;
    }

    const th = (t, a = '') =>
      `<th style="border:1px solid var(--border);padding:0.3rem 0.5rem;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-muted);white-space:nowrap;${a ? `text-align:${a};` : ''}">${t}</th>`;
    const td = (v, a = '', extra = '') =>
      `<td style="border:1px solid var(--border);padding:0.28rem 0.5rem;font-size:0.8125rem;${a ? `text-align:${a};` : ''}${extra}">${v}</td>`;

    const rows = snap.docs.map(d => {
      const r    = d.data();
      const date = r.createdAt?.toDate?.() ?? new Date();
      const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const f2f  = r.amounts?.f2f ? `$${r.amounts.f2f}` : '—';
      const md   = r.amounts?.md  ? `$${r.amounts.md}`  : '—';
      const dd   = r.amounts?.dd  ? `$${r.amounts.dd}`  : '—';
      const by   = r.createdBy || '';
      return `<tr>
        ${td(dateStr)}
        ${td(r.month || '')}
        ${td(f2f, 'right')}
        ${td(md,  'right')}
        ${td(dd,  'right')}
        ${td(by,  '', 'color:var(--text-muted);')}
        ${td(`<a href="${r.downloadUrl}" target="_blank" rel="noopener"
                style="color:var(--primary);font-weight:600;text-decoration:none;">↓ Download</a>`)}
      </tr>`;
    }).join('');

    el.innerHTML = `
      <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr style="background:#f8f9fb;">
          ${th('Generated')}${th('Month')}${th('F2F','right')}${th('M&D','right')}${th('D&D','right')}${th('By')}${th('')}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  } catch (err) {
    el.innerHTML = `<p style="color:var(--danger);font-size:0.875rem;">Could not load history: ${err.message}</p>`;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function cell(ws, row, col, value) {
  ws.getCell(row, col).value = value;
}
