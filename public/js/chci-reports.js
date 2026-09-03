// CHCI billing — parse Rx Office reports, generate PHFA invoice Excel files,
// bundle them as a named ZIP, upload to Firebase Storage, and maintain a
// persistent history of past submissions.

import { db, storage, auth } from './firebase-config.js';
import {
  collection, addDoc, getDocs, deleteDoc, doc, updateDoc, query, orderBy, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// Storage SDK is imported lazily inside generateAll() so a CDN hiccup doesn't
// prevent the file-parsing listeners from being wired on page load.

const _parsed    = { f2f: null, md: null, dd: null };
const _rawFiles  = { f2f: null, md: null, dd: null }; // { name, buf } of original uploaded reports

export function initChciReports() {
  document.getElementById('f2fUpload').addEventListener('change', e => handleUpload('f2f', e));
  document.getElementById('mdUpload').addEventListener('change',  e => handleUpload('md',  e));
  document.getElementById('ddUpload').addEventListener('change',  e => handleUpload('dd',  e));
  document.getElementById('generateChciBtn').addEventListener('click', generateAll);
  document.getElementById('chciBackfillZip').addEventListener('change', handleBackfillZip);
  document.getElementById('chciBackfillSaveBtn').addEventListener('click', saveBackfill);
  document.getElementById('chciHistory').addEventListener('click', e => {
    const delBtn = e.target.closest('[data-del-doc]');
    if (delBtn) { deleteChciReport(delBtn.dataset.delDoc, delBtn.dataset.delUrl); return; }
    const editBtn = e.target.closest('[data-edit-doc]');
    if (editBtn) { startChciEdit(editBtn); return; }
    const saveBtn = e.target.closest('[data-save-doc]');
    if (saveBtn) { saveChciEdit(saveBtn.dataset.saveDoc, saveBtn.closest('tr')); return; }
    const cancelBtn = e.target.closest('[data-cancel-edit]');
    if (cancelBtn) { loadChciHistory(); return; }
  });
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
    _rawFiles[type] = { name: file.name, buf };   // keep original for zip

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

      // Also include the original Rx Office report that was uploaded
      const raw = _rawFiles[cfg.key];
      if (raw) zip.file(raw.name, raw.buf);
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

// ── Backfill — upload past invoices (mix of ZIPs and loose Excel files) ────────

let _backfillZipBlob = null; // the combined ZIP we'll upload
let _backfillZipName = '';

async function handleBackfillZip(e) {
  const files = [...e.target.files];
  if (!files.length) return;

  const fileNameEl = document.getElementById('chciBackfillFileName');
  const statusEl   = document.getElementById('chciBackfillStatus');
  fileNameEl.textContent = `${files.length} file${files.length !== 1 ? 's' : ''} selected`;
  statusEl.textContent   = 'Reading files…';
  statusEl.style.color   = 'var(--text-muted)';

  ['chciBackfillF2F','chciBackfillMD','chciBackfillDD','chciBackfillMonth']
    .forEach(id => { document.getElementById(id).value = ''; });
  _backfillZipBlob = null;
  _backfillZipName = '';

  try {
    // ── Collect all Excel entries from every uploaded file ──────────────────
    // Each entry: { name, buffer (ArrayBuffer) }
    const excelEntries = [];

    for (const file of files) {
      if (file.name.match(/\.zip$/i)) {
        const buf = await file.arrayBuffer();
        const zip = await JSZip.loadAsync(buf);
        for (const [entryName, zipEntry] of Object.entries(zip.files)) {
          if (zipEntry.dir || !entryName.match(/\.xlsx?$/i)) continue;
          const xlsBuf = await zipEntry.async('arraybuffer');
          excelEntries.push({ name: entryName.split('/').pop(), buffer: xlsBuf });
        }
      } else if (file.name.match(/\.xlsx?$/i)) {
        const buf = await file.arrayBuffer();
        excelEntries.push({ name: file.name, buffer: buf });
      }
    }

    if (!excelEntries.length) {
      statusEl.textContent = 'No Excel files found in the selected files.';
      statusEl.style.color = 'var(--danger)';
      return;
    }

    // ── Parse each Excel file ────────────────────────────────────────────────
    const amounts = { f2f: 0, md: 0, dd: 0 };
    let monthName = '', year = '';

    for (const entry of excelEntries) {
      const upper = entry.name.toUpperCase();
      let type = null;
      if      (upper.includes('F2F'))                           type = 'f2f';
      else if (upper.includes('M&D') || upper.includes('M_D')) type = 'md';
      else if (upper.includes('D&D') || upper.includes('D_D')) type = 'dd';

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(entry.buffer);
      const ws = wb.worksheets[0];
      if (!ws) continue;

      // Pull month/year from the first recognisable date in column 1
      if (!monthName) {
        ws.eachRow(row => {
          if (monthName) return;
          const v = row.getCell(1).value;
          const d = v instanceof Date ? v
                  : typeof v === 'number' ? new Date((v - 25569) * 86400000)
                  : null;
          if (d && !isNaN(d) && d.getFullYear() > 2000) {
            monthName = d.toLocaleString('en-US', { month: 'long' });
            year      = String(d.getFullYear());
          }
        });
      }

      // Sum totals by type (handles multiple files of the same type)
      if (type) {
        ws.eachRow(row => {
          const label = String(row.getCell(6).value ?? '').trim().toUpperCase();
          if (label === 'TOTAL' || label === 'TOTALS') {
            const amt = parseFloat(row.getCell(8).value) || 0;
            if (amt) amounts[type] += Math.round(amt);
          }
        });
      }
    }

    // ── Bundle everything into one new ZIP ───────────────────────────────────
    const newZip = new JSZip();
    for (const entry of excelEntries) newZip.file(entry.name, entry.buffer);
    _backfillZipBlob = await newZip.generateAsync({ type: 'blob' });

    // Build the canonical ZIP name (will be overridden at save time from form values)
    const amtParts = [];
    if (amounts.f2f) amtParts.push(`F2F $${amounts.f2f}`);
    if (amounts.md)  amtParts.push(`M&D $${amounts.md}`);
    if (amounts.dd)  amtParts.push(`D&D $${amounts.dd}`);
    _backfillZipName = `CHCI Invoice - ${amtParts.join(' ') || 'Import'} - ${monthName || 'Unknown'} ${year || ''}.zip`;

    // ── Populate form ────────────────────────────────────────────────────────
    document.getElementById('chciBackfillForm').style.display = 'block';
    document.getElementById('chciBackfillF2F').value = amounts.f2f || '';
    document.getElementById('chciBackfillMD').value  = amounts.md  || '';
    document.getElementById('chciBackfillDD').value  = amounts.dd  || '';

    if (monthName && year) {
      const MONTHS = ['January','February','March','April','May','June',
                      'July','August','September','October','November','December'];
      const mIdx = MONTHS.indexOf(monthName);
      if (mIdx !== -1)
        document.getElementById('chciBackfillMonth').value = `${year}-${String(mIdx + 1).padStart(2, '0')}`;
    }

    const typeCount = Object.values(amounts).filter(v => v > 0).length;
    statusEl.textContent = `Read ${excelEntries.length} invoice file${excelEntries.length !== 1 ? 's' : ''}, ${typeCount} type${typeCount !== 1 ? 's' : ''} detected — verify and save.`;
    statusEl.style.color = typeCount ? 'var(--primary)' : 'var(--text-muted)';

  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Parse error — enter amounts manually. (' + err.message + ')';
    statusEl.style.color = 'var(--danger)';
    document.getElementById('chciBackfillForm').style.display = 'block';
  }
}

async function saveBackfill() {
  if (!_backfillZipBlob) return;

  const btn      = document.getElementById('chciBackfillSaveBtn');
  const statusEl = document.getElementById('chciBackfillStatus');
  const monthVal = document.getElementById('chciBackfillMonth').value; // "2025-01"

  if (!monthVal) {
    statusEl.textContent = 'Please select a month.';
    statusEl.style.color = 'var(--danger)';
    return;
  }

  btn.disabled         = true;
  btn.textContent      = 'Uploading…';
  statusEl.textContent = '';

  try {
    const [year, monthPad] = monthVal.split('-');
    const MONTHS    = ['January','February','March','April','May','June',
                       'July','August','September','October','November','December'];
    const monthName = MONTHS[parseInt(monthPad, 10) - 1];

    const amounts = {};
    const f2f = parseInt(document.getElementById('chciBackfillF2F').value || '0', 10);
    const md  = parseInt(document.getElementById('chciBackfillMD').value  || '0', 10);
    const dd  = parseInt(document.getElementById('chciBackfillDD').value  || '0', 10);
    if (f2f) amounts.f2f = f2f;
    if (md)  amounts.md  = md;
    if (dd)  amounts.dd  = dd;

    // Rebuild ZIP name from the (possibly user-edited) form values
    const amtParts = [];
    if (f2f) amtParts.push(`F2F $${f2f}`);
    if (md)  amtParts.push(`M&D $${md}`);
    if (dd)  amtParts.push(`D&D $${dd}`);
    const zipName = `CHCI Invoice - ${amtParts.join(' ') || 'Import'} - ${monthName} ${year}.zip`;

    const { ref, uploadBytes, getDownloadURL } = await import(
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js'
    );

    const storageRef  = ref(storage, `chci-reports/${year}-${monthPad}/${zipName}`);
    await uploadBytes(storageRef, _backfillZipBlob, { contentType: 'application/zip' });
    const downloadUrl = await getDownloadURL(storageRef);

    await addDoc(collection(db, 'chciReports'), {
      fileName:   zipName,
      month:      `${monthName} ${year}`,
      amounts,
      downloadUrl,
      createdAt:  serverTimestamp(),
      createdBy:  auth.currentUser?.displayName || auth.currentUser?.email || 'Unknown',
      backfilled: true,
    });

    statusEl.textContent = '✓ Added to history';
    statusEl.style.color = 'var(--primary)';

    // Reset
    _backfillZipBlob = null;
    _backfillZipName = '';
    document.getElementById('chciBackfillZip').value             = '';
    document.getElementById('chciBackfillFileName').textContent  = 'No files selected';
    document.getElementById('chciBackfillForm').style.display    = 'none';

    await loadChciHistory();
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Failed: ' + err.message;
    statusEl.style.color = 'var(--danger)';
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Save to History';
  }
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
      const monthMM = monthStrToYYYYMM(r.month || '');
      return `<tr>
        ${td(dateStr)}
        ${td(r.month || '')}
        ${td(f2f, 'right')}
        ${td(md,  'right')}
        ${td(dd,  'right')}
        ${td(by,  '', 'color:var(--text-muted);')}
        ${td(`<a href="${r.downloadUrl}" target="_blank" rel="noopener"
                style="color:var(--primary);font-weight:600;text-decoration:none;">↓ Download</a>`)}
        ${td(`<button data-edit-doc="${d.id}"
                data-edit-month="${monthMM}"
                data-edit-f2f="${r.amounts?.f2f || ''}"
                data-edit-md="${r.amounts?.md   || ''}"
                data-edit-dd="${r.amounts?.dd   || ''}"
                style="background:none;border:none;cursor:pointer;color:var(--primary);font-size:0.875rem;padding:0.1rem 0.4rem;line-height:1;font-weight:600;"
                title="Edit">✏</button>
              <button data-del-doc="${d.id}" data-del-url="${encodeURIComponent(r.downloadUrl || '')}"
                style="background:none;border:none;cursor:pointer;color:var(--danger);font-size:1rem;padding:0.1rem 0.3rem;line-height:1;"
                title="Delete">×</button>`)}
      </tr>`;
    }).join('');

    el.innerHTML = `
      <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr style="background:#f8f9fb;">
          ${th('Generated')}${th('Month')}${th('F2F','right')}${th('M&D','right')}${th('D&D','right')}${th('By')}${th('')}${th('')}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  } catch (err) {
    el.innerHTML = `<p style="color:var(--danger);font-size:0.875rem;">Could not load history: ${err.message}</p>`;
  }
}

// ── Inline-edit a history row ─────────────────────────────────────────────────

function monthStrToYYYYMM(monthStr) {
  const MONTHS = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  const parts = (monthStr || '').split(' ');
  const idx = MONTHS.indexOf(parts[0]);
  if (idx === -1 || !parts[1]) return '';
  return `${parts[1]}-${String(idx + 1).padStart(2, '0')}`;
}

function startChciEdit(btn) {
  const docId   = btn.dataset.editDoc;
  const monthIn = btn.dataset.editMonth;
  const f2f     = btn.dataset.editF2f || '';
  const md      = btn.dataset.editMd  || '';
  const dd      = btn.dataset.editDd  || '';

  const inp = (cls, val, ph) =>
    `<input type="number" class="${cls}" value="${val}" min="0" step="1" placeholder="${ph}"
      style="width:80px;font-size:0.8125rem;border:1px solid var(--border);border-radius:var(--radius);padding:0.2rem 0.4rem;">`;

  btn.closest('tr').innerHTML = `
    <td colspan="7" style="border:1px solid var(--border);padding:0.45rem 0.6rem;">
      <div style="display:flex;gap:0.75rem;align-items:flex-end;flex-wrap:wrap;">
        <div>
          <label style="font-size:0.68rem;font-weight:700;text-transform:uppercase;color:var(--text-muted);display:block;margin-bottom:2px;">Month</label>
          <input type="month" class="edit-month" value="${monthIn}"
            style="font-size:0.8125rem;border:1px solid var(--border);border-radius:var(--radius);padding:0.2rem 0.4rem;">
        </div>
        <div>
          <label style="font-size:0.68rem;font-weight:700;text-transform:uppercase;color:var(--text-muted);display:block;margin-bottom:2px;">F2F ($)</label>
          ${inp('edit-f2f', f2f, '0')}
        </div>
        <div>
          <label style="font-size:0.68rem;font-weight:700;text-transform:uppercase;color:var(--text-muted);display:block;margin-bottom:2px;">M&amp;D ($)</label>
          ${inp('edit-md', md, '0')}
        </div>
        <div>
          <label style="font-size:0.68rem;font-weight:700;text-transform:uppercase;color:var(--text-muted);display:block;margin-bottom:2px;">D&amp;D ($)</label>
          ${inp('edit-dd', dd, '0')}
        </div>
        <div style="display:flex;gap:0.35rem;">
          <button data-save-doc="${docId}" class="btn btn-primary btn-sm">Save</button>
          <button data-cancel-edit class="btn btn-secondary btn-sm">Cancel</button>
        </div>
      </div>
    </td>
    <td style="border:1px solid var(--border);"></td>`;
}

async function saveChciEdit(docId, row) {
  const monthVal = row.querySelector('.edit-month')?.value || '';
  const f2fVal   = parseInt(row.querySelector('.edit-f2f')?.value  || '0', 10);
  const mdVal    = parseInt(row.querySelector('.edit-md')?.value   || '0', 10);
  const ddVal    = parseInt(row.querySelector('.edit-dd')?.value   || '0', 10);

  if (!monthVal) { alert('Please select a month.'); return; }

  const saveBtn = row.querySelector('[data-save-doc]');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

  try {
    const [year, monthPad] = monthVal.split('-');
    const MONTHS    = ['January','February','March','April','May','June',
                       'July','August','September','October','November','December'];
    const monthName = MONTHS[parseInt(monthPad, 10) - 1];

    const amounts = {};
    if (f2fVal) amounts.f2f = f2fVal;
    if (mdVal)  amounts.md  = mdVal;
    if (ddVal)  amounts.dd  = ddVal;

    const amtParts = [];
    if (f2fVal) amtParts.push(`F2F $${f2fVal}`);
    if (mdVal)  amtParts.push(`M&D $${mdVal}`);
    if (ddVal)  amtParts.push(`D&D $${ddVal}`);
    const fileName = `CHCI Invoice - ${amtParts.join(' ') || 'Import'} - ${monthName} ${year}.zip`;

    await updateDoc(doc(db, 'chciReports', docId), {
      month:    `${monthName} ${year}`,
      amounts,
      fileName,
    });

    await loadChciHistory();
  } catch (err) {
    alert('Save failed: ' + err.message);
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
  }
}

// ── Delete a history record ───────────────────────────────────────────────────

async function deleteChciReport(docId, encodedUrl) {
  if (!confirm('Delete this report from history? The file will also be removed from storage.')) return;

  try {
    // Delete the Storage file first (best-effort — don't block on failure)
    try {
      const downloadUrl = decodeURIComponent(encodedUrl);
      const { ref: sRef, deleteObject } = await import(
        'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js'
      );
      // Derive the storage path from the download URL
      const u         = new URL(downloadUrl);
      const pathMatch = u.pathname.match(/\/o\/(.+)$/);
      if (pathMatch) {
        const storagePath = decodeURIComponent(pathMatch[1]);
        await deleteObject(sRef(storage, storagePath));
      }
    } catch (_) { /* Storage delete failed — still remove the Firestore record */ }

    await deleteDoc(doc(db, 'chciReports', docId));
    await loadChciHistory();
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function cell(ws, row, col, value) {
  ws.getCell(row, col).value = value;
}
