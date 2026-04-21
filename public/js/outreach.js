/**
 * outreach.js — Outreach page: CMC batch letters + phone call log
 *
 * Two independent features on one page:
 *
 * 1. CMC Letters
 *    Counselors enter recipients row-by-row, pick a county template
 *    (Beaver / Lawrence / Mercer), and click "Generate Letters & Log All".
 *    The tool writes one doc to the `cmcLog` collection per row, then opens
 *    a print window with all letters ready to print. Past letters can be
 *    re-generated without re-logging.
 *
 *    Templates:
 *      'dan'     → Beaver County  (Daniel Bernabie)
 *      'andrusa' → Lawrence County (Andrusa Lawson) — no lender field
 *      'mercer'  → Mercer County — green letterhead, counselor name from login
 *
 * 2. Call Log
 *    "+ Log a Call" opens a modal with two contact types:
 *      'client'   → search existing clients and link the call to their record
 *      'prospect' → free-text name + phone for people not yet intaked
 *    All calls are stored in the `outreachCalls` collection.
 *    Client calls show a link to the full profile in the log table.
 */

import { db } from './firebase-config.js';
import { requireAuth, setupNav } from './auth.js';
import {
  collection, addDoc, getDocs, query, orderBy, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

let _county       = 'dan';    // active CMC template: 'dan' | 'andrusa' | 'mercer'
let _allRecords   = [];       // cached cmcLog documents (past letters)
let _allCalls     = [];       // cached outreachCalls documents
let _allClients   = [];       // lazy-loaded client list for the call modal search
let _callType     = 'client'; // current call modal type: 'client' | 'prospect'
let _selectedClientId   = null; // clientId chosen in the call modal client search
let _selectedClientName = null; // display name for the chosen client

// ── Entry point ───────────────────────────────────────────────────────────────

requireAuth(async (user, profile) => {
  setupNav(profile, 'outreach');
  window._currentCounselor = profile.name || profile.email || '';

  document.getElementById('batchDate').value = new Date().toISOString().split('T')[0];
  document.getElementById('callDate').value  = new Date().toISOString().split('T')[0];

  await loadCounselorOptions();

  // County toggle
  document.querySelectorAll('.county-tab').forEach(tab => {
    tab.addEventListener('click', () => selectCounty(tab.dataset.county));
  });

  // CMC batch buttons
  document.getElementById('addRowBtn').addEventListener('click', addBatchRow);
  document.getElementById('clearBatchBtn').addEventListener('click', clearBatch);
  document.getElementById('generateLogBtn').addEventListener('click', generateAndLog);

  // Past-log controls
  document.getElementById('selectAll').addEventListener('change', (e) => {
    document.querySelectorAll('.row-cb').forEach(cb => { cb.checked = e.target.checked; });
    updateGenerateBar();
  });
  document.getElementById('generateBtn').addEventListener('click', reGenerateSelected);
  document.getElementById('clearSelBtn').addEventListener('click', () => {
    document.querySelectorAll('.row-cb').forEach(cb => { cb.checked = false; });
    document.getElementById('selectAll').checked = false;
    updateGenerateBar();
  });

  // Call modal
  document.getElementById('logCallBtn').addEventListener('click', openCallModal);
  document.getElementById('callModalCancel').addEventListener('click', closeCallModal);
  document.getElementById('callModalSave').addEventListener('click', saveCall);
  document.getElementById('callModal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('callModal')) closeCallModal();
  });

  // Call type toggle
  document.querySelectorAll('.call-type-btn').forEach(btn => {
    btn.addEventListener('click', () => setCallType(btn.dataset.type));
  });

  // Client search in call modal
  document.getElementById('callClientSearch').addEventListener('input', renderCallClientSearch);
  document.getElementById('callClientClear').addEventListener('click', clearCallClientSelection);

  addBatchRow();
  await Promise.all([loadRecords(), loadCalls()]);
});

// ── Counselor options ─────────────────────────────────────────────────────────

async function loadCounselorOptions() {
  try {
    const snap = await getDocs(query(collection(db, 'counselors'), orderBy('name')));
    const sel  = document.getElementById('callCounselor');
    snap.docs
      .filter(d => d.data().active !== false)
      .forEach(d => {
        const o = document.createElement('option');
        o.value = d.data().name;
        o.textContent = d.data().name;
        sel.appendChild(o);
      });
    // Pre-select current counselor
    sel.value = window._currentCounselor;
  } catch (_) {}
}

// ── County toggle ─────────────────────────────────────────────────────────────

function selectCounty(county) {
  _county = county;
  document.querySelectorAll('.county-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.county === county);
  });
  const showLender = county !== 'andrusa';
  document.getElementById('lenderHeader').style.display = showLender ? '' : 'none';
  document.querySelectorAll('.lender-cell').forEach(cell => {
    cell.style.display = showLender ? '' : 'none';
  });
}

// ── Batch rows ────────────────────────────────────────────────────────────────

function addBatchRow() {
  const tbody      = document.getElementById('batchBody');
  const rowIndex   = tbody.rows.length + 1;
  const showLender = _county !== 'andrusa';

  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="row-num">${rowIndex}</td>
    <td><input type="text" class="r-name"  placeholder="First Last"></td>
    <td><input type="text" class="r-addr1" placeholder="123 Main St"></td>
    <td><input type="text" class="r-addr2" placeholder="Pittsburgh, PA 15201"></td>
    <td><input type="text" class="r-prop"  placeholder="456 Oak Ave, City, PA"></td>
    <td class="lender-cell" style="display:${showLender ? '' : 'none'}">
      <input type="text" class="r-lender" placeholder="Bank Name, N.A.">
    </td>
    <td class="del-col"><button type="button" class="del-btn" title="Remove row">&times;</button></td>`;

  tr.querySelector('.del-btn').addEventListener('click', () => {
    tr.remove();
    reNumberRows();
  });
  tbody.appendChild(tr);
  tr.querySelector('.r-name').focus();
}

function reNumberRows() {
  document.querySelectorAll('#batchBody tr').forEach((tr, i) => {
    tr.querySelector('.row-num').textContent = i + 1;
  });
}

function clearBatch() {
  document.getElementById('batchBody').innerHTML = '';
  addBatchRow();
}

function readBatchRows() {
  return [...document.querySelectorAll('#batchBody tr')].map(tr => ({
    name:     tr.querySelector('.r-name')?.value.trim()   || '',
    addr1:    tr.querySelector('.r-addr1')?.value.trim()  || '',
    addr2:    tr.querySelector('.r-addr2')?.value.trim()  || '',
    propAddr: tr.querySelector('.r-prop')?.value.trim()   || '',
    lender:   tr.querySelector('.r-lender')?.value.trim() || '',
  }));
}

// ── Generate + Log ────────────────────────────────────────────────────────────

async function generateAndLog() {
  const errorEl = document.getElementById('batchError');
  const genBtn  = document.getElementById('generateLogBtn');
  errorEl.classList.add('hidden');

  const rows = readBatchRows().filter(r => r.name || r.addr1 || r.propAddr);
  if (!rows.length) {
    showBatchError('Add at least one recipient before generating.');
    return;
  }

  const needsLender = _county !== 'andrusa';
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.name)               { showBatchError(`Row ${i+1}: Recipient name is required.`);       return; }
    if (!r.addr1 || !r.addr2)  { showBatchError(`Row ${i+1}: Both mailing address lines are required.`); return; }
    if (!r.propAddr)           { showBatchError(`Row ${i+1}: Property address is required.`);     return; }
    if (needsLender && !r.lender) { showBatchError(`Row ${i+1}: Lender / Plaintiff is required.`); return; }
  }

  genBtn.disabled    = true;
  genBtn.textContent = 'Generating…';

  try {
    const dateVal = document.getElementById('batchDate').value;

    await Promise.all(rows.map(r =>
      addDoc(collection(db, 'cmcLog'), {
        recipientName:     r.name,
        mailingAddress:    r.addr1,
        mailingAddress2:   r.addr2,
        propertyAddress:   r.propAddr,
        lender:            r.lender,
        counselorTemplate: _county,
        dateSent:          dateVal ? new Date(dateVal + 'T12:00:00') : null,
        counselor:         window._currentCounselor,
        linkedClientId:    null,
        linkedClientName:  null,
        createdAt:         serverTimestamp(),
        updatedAt:         serverTimestamp(),
      })
    ));

    const dateDisplay = dateVal
      ? new Date(dateVal + 'T12:00:00').toLocaleDateString('en-US',
          { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
      : new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    const logoUrl = window.location.origin + '/img/logo.png';
    const pages   = rows.map(r => buildLetterHTML({
      recipientName:     r.name,
      mailingAddress:    r.addr1,
      mailingAddress2:   r.addr2,
      propertyAddress:   r.propAddr,
      lender:            r.lender,
      counselorTemplate: _county,
      dateSent:          dateVal ? new Date(dateVal + 'T12:00:00') : null,
      counselor:         window._currentCounselor,
    }, dateDisplay, logoUrl)).join('');

    openPrintWindow(pages);
    await loadRecords();
    clearBatch();
  } catch (err) {
    showBatchError('Failed: ' + err.message);
  } finally {
    genBtn.disabled    = false;
    genBtn.textContent = 'Generate Letters & Log All';
  }
}

function showBatchError(msg) {
  const el = document.getElementById('batchError');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ── Past-log load & render ────────────────────────────────────────────────────

async function loadRecords() {
  const tbody = document.getElementById('cmcTableBody');
  tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--text-muted)">Loading…</td></tr>';
  try {
    const snap = await getDocs(query(collection(db, 'cmcLog'), orderBy('dateSent', 'desc')));
    _allRecords = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (_) {
    _allRecords = [];
  }
  renderTable(_allRecords);
  renderStats(_allRecords);
}

function renderTable(records) {
  const tbody = document.getElementById('cmcTableBody');
  if (!records.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--text-muted)">No letters logged yet.</td></tr>';
    return;
  }

  tbody.innerHTML = records.map(r => {
    const linkedCell = r.linkedClientId
      ? `<a href="client.html?id=${r.linkedClientId}" style="font-weight:600;">${escHtml(r.linkedClientName || 'View Client')}</a>`
      : '<span style="color:var(--text-muted);">—</span>';
    const mailingDisplay = [r.mailingAddress, r.mailingAddress2].filter(Boolean).join(', ');

    return `<tr>
      <td class="cb-col"><input type="checkbox" class="row-cb" data-id="${escAttr(r.id)}"></td>
      <td style="white-space:nowrap">${fmtDate(r.dateSent)}</td>
      <td>${escHtml(r.recipientName || '—')}</td>
      <td style="font-size:0.8rem;">${escHtml(mailingDisplay || '—')}</td>
      <td style="font-size:0.8rem;">${escHtml(r.propertyAddress || '—')}</td>
      <td style="font-size:0.8rem;white-space:nowrap;">${countyLabel(r.counselorTemplate)}</td>
      <td style="font-size:0.8rem;">${escHtml(r.counselor || '—')}</td>
      <td>${linkedCell}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.row-cb').forEach(cb => {
    cb.addEventListener('change', updateGenerateBar);
  });
}

function renderStats(records) {
  const total  = records.length;
  const linked = records.filter(r => r.linkedClientId).length;
  const rate   = total > 0 ? Math.round((linked / total) * 100) + '%' : '—';
  document.getElementById('statTotal').textContent  = total;
  document.getElementById('statLinked').textContent = linked;
  document.getElementById('statRate').textContent   = rate;
}

// ── Re-generate selected past letters ────────────────────────────────────────

function reGenerateSelected() {
  const checkedIds = new Set([...document.querySelectorAll('.row-cb:checked')].map(cb => cb.dataset.id));
  const selected   = _allRecords.filter(r => checkedIds.has(r.id));
  if (!selected.length) return;

  const today   = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const logoUrl = window.location.origin + '/img/logo.png';
  const pages   = selected.map(r => buildLetterHTML(r, today, logoUrl)).join('');
  openPrintWindow(pages);
}

function updateGenerateBar() {
  const checked = document.querySelectorAll('.row-cb:checked').length;
  const bar = document.getElementById('generateBar');
  document.getElementById('selectedCount').textContent = `${checked} selected`;
  bar.style.display = checked > 0 ? 'flex' : 'none';
}

// ── Call Log ──────────────────────────────────────────────────────────────────

async function loadCalls() {
  const tbody = document.getElementById('callLogBody');
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--text-muted)">Loading…</td></tr>';
  try {
    const snap = await getDocs(query(collection(db, 'outreachCalls'), orderBy('date', 'desc')));
    _allCalls = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (_) {
    _allCalls = [];
  }
  renderCallLog(_allCalls);
}

function renderCallLog(calls) {
  const tbody = document.getElementById('callLogBody');
  if (!calls.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--text-muted)">No calls logged yet.</td></tr>';
    return;
  }

  tbody.innerHTML = calls.map(c => {
    const typeBadge = c.type === 'prospect'
      ? '<span class="badge badge-yellow">Prospect</span>'
      : '<span class="badge badge-pre">Client</span>';
    const nameCell = c.linkedClientId
      ? `<a href="client.html?id=${c.linkedClientId}" style="font-weight:600;">${escHtml(toTitleCase(c.contactName || ''))}</a>`
      : escHtml(toTitleCase(c.contactName || '—'));
    const phoneStr = c.phone ? ` <span style="font-size:0.78rem;color:var(--text-muted);">${escHtml(c.phone)}</span>` : '';

    return `<tr>
      <td style="white-space:nowrap;">${fmtDate(c.date)}</td>
      <td>${typeBadge}</td>
      <td>${nameCell}${phoneStr}</td>
      <td style="font-size:0.875rem;">${escHtml(c.counselor || '—')}</td>
      <td style="font-size:0.875rem;">${escHtml(c.outcome || '—')}</td>
      <td style="font-size:0.8rem;color:var(--text-muted);max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escAttr(c.notes || '')}">${escHtml(c.notes || '—')}</td>
    </tr>`;
  }).join('');
}

// ── Call Modal ────────────────────────────────────────────────────────────────

function openCallModal() {
  document.getElementById('callDate').value         = new Date().toISOString().split('T')[0];
  document.getElementById('callCounselor').value    = window._currentCounselor;
  document.getElementById('callOutcome').value      = '';
  document.getElementById('callNotes').value        = '';
  document.getElementById('callClientSearch').value = '';
  document.getElementById('callClientResults').innerHTML =
    '<div style="padding:1rem;color:var(--text-muted);font-size:0.875rem;">Start typing to find a client.</div>';
  document.getElementById('callModalError').classList.add('hidden');
  clearCallClientSelection();
  setCallType('client');

  document.getElementById('callModal').classList.remove('hidden');
}

function closeCallModal() {
  document.getElementById('callModal').classList.add('hidden');
}

function setCallType(type) {
  _callType = type;
  document.querySelectorAll('.call-type-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.type === type);
  });
  document.getElementById('clientSearchSection').classList.toggle('hidden', type !== 'client');
  const prospectSection = document.getElementById('prospectSection');
  if (type === 'prospect') {
    prospectSection.classList.remove('hidden');
    prospectSection.style.display = 'contents';
  } else {
    prospectSection.classList.add('hidden');
    prospectSection.style.display = 'none';
  }
}

async function renderCallClientSearch() {
  const search = document.getElementById('callClientSearch').value.toLowerCase().trim();
  const resultsEl = document.getElementById('callClientResults');

  if (!search) {
    resultsEl.innerHTML = '<div style="padding:1rem;color:var(--text-muted);font-size:0.875rem;">Start typing to find a client.</div>';
    return;
  }

  // Lazy-load client list
  if (!_allClients.length) {
    resultsEl.innerHTML = '<div style="padding:1rem;color:var(--text-muted);font-size:0.875rem;">Loading…</div>';
    try {
      const snap = await getDocs(query(collection(db, 'clients'), orderBy('clientName')));
      _allClients = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (_) { _allClients = []; }
  }

  const matches = _allClients.filter(c =>
    (c.clientName  || '').toLowerCase().includes(search) ||
    (c.counselor   || '').toLowerCase().includes(search) ||
    (c.rxNumbers   || []).some(rx => rx.toLowerCase().includes(search))
  ).slice(0, 30);

  if (!matches.length) {
    resultsEl.innerHTML = '<div style="padding:1rem;color:var(--text-muted);font-size:0.875rem;">No clients found.</div>';
    return;
  }

  resultsEl.innerHTML = matches.map(c => `
    <div class="csr-item${_selectedClientId === c.id ? ' selected' : ''}" data-id="${c.id}" data-name="${escAttr(c.clientName || '')}">
      <div class="csr-name">${escHtml(toTitleCase(c.clientName || ''))}</div>
      <div class="csr-meta">${escHtml(c.counselor || '')} · ${escHtml(c.counselingType || '')}</div>
    </div>`).join('');

  resultsEl.querySelectorAll('.csr-item').forEach(item => {
    item.addEventListener('click', () => selectCallClient(item.dataset.id, item.dataset.name));
  });
}

function selectCallClient(id, name) {
  _selectedClientId   = id;
  _selectedClientName = name;
  document.getElementById('callClientId').value = id;
  document.getElementById('callClientSelectedName').textContent = toTitleCase(name);
  document.getElementById('callClientSelected').classList.remove('hidden');
  document.getElementById('callClientSearch').value = '';
  document.getElementById('callClientResults').innerHTML =
    '<div style="padding:1rem;color:var(--text-muted);font-size:0.875rem;">Client selected above.</div>';
}

function clearCallClientSelection() {
  _selectedClientId   = null;
  _selectedClientName = null;
  document.getElementById('callClientId').value = '';
  document.getElementById('callClientSelected').classList.add('hidden');
  document.getElementById('callClientSelectedName').textContent = '';
}

async function saveCall() {
  const errorEl = document.getElementById('callModalError');
  const saveBtn = document.getElementById('callModalSave');
  errorEl.classList.add('hidden');

  const dateVal   = document.getElementById('callDate').value;
  const counselor = document.getElementById('callCounselor').value;
  const outcome   = document.getElementById('callOutcome').value.trim();
  const notes     = document.getElementById('callNotes').value.trim();

  // Validate
  if (!dateVal) { showCallError('Please select a date.'); return; }

  let contactName   = '';
  let linkedClientId = null;
  let phone          = '';

  if (_callType === 'client') {
    if (!_selectedClientId) { showCallError('Please select a client or switch to Prospect.'); return; }
    linkedClientId = _selectedClientId;
    contactName    = _selectedClientName || '';
  } else {
    contactName = document.getElementById('prospectName').value.trim();
    phone       = document.getElementById('prospectPhone').value.trim();
    if (!contactName) { showCallError('Please enter a prospect name.'); return; }
  }

  saveBtn.disabled    = true;
  saveBtn.textContent = 'Saving…';

  try {
    await addDoc(collection(db, 'outreachCalls'), {
      date:           new Date(dateVal + 'T12:00:00'),
      counselor,
      type:           _callType,
      linkedClientId,
      contactName,
      phone,
      outcome,
      notes,
      createdAt:      serverTimestamp(),
      updatedAt:      serverTimestamp(),
    });

    closeCallModal();
    await loadCalls();
  } catch (err) {
    showCallError('Save failed: ' + err.message);
  } finally {
    saveBtn.disabled    = false;
    saveBtn.textContent = 'Save Call';
  }
}

function showCallError(msg) {
  const el = document.getElementById('callModalError');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ── Print window ──────────────────────────────────────────────────────────────

function openPrintWindow(pages) {
  const win = window.open('', '_blank');
  if (!win) { alert('Pop-up blocked. Please allow pop-ups for this site.'); return; }
  win.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>CMC Letters</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:"Times New Roman",Times,serif; font-size:12pt; color:#000; }
    .letter-page {
      width:8.5in; min-height:11in;
      padding:1in 1.1in 1in 1.1in;
      page-break-after:always;
      position:relative;
    }
    .letter-page:last-child { page-break-after:auto; }
    .date-line  { margin-bottom:1.5em; }
    .addr-block { margin-bottom:1.5em; line-height:1.4; }
    .salutation { margin-bottom:1em; }
    .body-para  { margin-bottom:1em; line-height:1.6; text-align:justify; }
    .closing    { margin-top:2.5em; }
    .sig-block  { margin-top:3.5em; line-height:1.5; }
    .mercer-page { padding:0; display:flex; flex-direction:column; }
    .mc-header   { background:#2d6a4f; padding:0.5in 1.1in; display:flex; justify-content:flex-end; align-items:center; }
    .mc-logo     { height:0.65in; background:#fff; padding:0.07in 0.14in; border-radius:4px; }
    .mc-body     { flex:1; padding:0.55in 1.1in 0.35in 1.1in; }
    .mc-footer   { border-top:2px solid #2d6a4f; padding:0.15in 1.1in; display:flex; align-items:center; gap:0.25in; }
    .mc-footer-logo { height:0.35in; }
    .mc-footer-text { font-size:9pt; line-height:1.5; }
    @media print {
      @page { size:letter; margin:0; }
      body  { print-color-adjust:exact; -webkit-print-color-adjust:exact; }
    }
  </style>
</head>
<body>
${pages}
<script>window.onload = () => { window.print(); }<\/script>
</body>
</html>`);
  win.document.close();
}

// ── Letter templates ──────────────────────────────────────────────────────────

function buildLetterHTML(r, fallbackDate, logoUrl) {
  const dateLine  = r.dateSent ? fmtDateLong(r.dateSent) : fallbackDate;
  const name      = escHtml(r.recipientName   || '');
  const addr1     = escHtml(r.mailingAddress  || '');
  const addr2     = escHtml(r.mailingAddress2 || '');
  const propAddr  = escHtml(r.propertyAddress || '');
  const lender    = escHtml(r.lender          || '');
  const counselor = escHtml(r.counselor       || '');

  if (r.counselorTemplate === 'andrusa') return andrusaletter(dateLine, name, addr1, addr2, propAddr);
  if (r.counselorTemplate === 'mercer')  return mercerLetter(dateLine, name, addr1, addr2, propAddr, lender, counselor, logoUrl);
  return danLetter(dateLine, name, addr1, addr2, propAddr, lender);
}

function danLetter(date, name, addr1, addr2, propAddr, lender) {
  return `<div class="letter-page">
  <p class="date-line">${date}</p>
  <div class="addr-block"><p>${name}</p><p>${addr1}</p>${addr2 ? `<p>${addr2}</p>` : ''}</div>
  <p class="salutation">Dear ${name},</p>
  <p class="body-para">Our agency has received notification that a Complaint in Mortgage Foreclosure has been filed against you by Plaintiff, ${lender || '[LENDER]'}, in the Court of Common Pleas of Beaver County, PA. This Complaint regards your mortgaged property on ${propAddr || '[PROPERTY ADDRESS]'}.</p>
  <p class="body-para">Housing Opportunities Inc. (HOI) is a HUD Approved Housing Counseling Agency located in Rochester, PA. We provide free services and advice for homeowners facing foreclosure enabling them to make an informed decision. Also, we can represent your case in Beaver County Mortgage Conciliation Court at no charge. If you choose to utilize our services, we require your written authorization during an in-office appointment at our location in Beaver to gather pertinent documents and information.</p>
  <p class="body-para">Please call HOBC at 724.728.7511 to discuss your situation. We will be glad to assist your effort to navigate through the foreclosure process with a goal to retain your home.</p>
  <p class="closing">Sincerely,</p>
  <div class="sig-block"><p>Daniel Bernabie</p><p>HUD Certified Housing Counselor</p></div>
</div>`;
}

function andrusaletter(date, name, addr1, addr2, propAddr) {
  return `<div class="letter-page">
  <p class="date-line">${date}</p>
  <div class="addr-block"><p>${name}</p><p>${addr1}</p>${addr2 ? `<p>${addr2}</p>` : ''}</div>
  <p class="salutation">Dear ${name},</p>
  <p class="body-para">Our agency has received notification that a Complaint in Foreclosure has been filed against you in the Court of Common Pleas. This Complaint regards your mortgaged property on ${propAddr || '[PROPERTY ADDRESS]'}.</p>
  <p class="body-para">Housing Opportunities Inc is a HUD Approved Housing Counseling Agency located in New Castle, PA. We provide free services and advice for homeowners facing foreclosure enabling them to make an informed decision. Also, we can represent your case in Mortgage Conciliation Court at no charge. If you choose to utilize our services, we require your written authorization during an in-office appointment at our location in New Castle to gather pertinent documents, information and advocate on your behalf.</p>
  <p class="body-para">Please call us at 724.728.7511 to discuss your situation. We are here to help you navigate through the foreclosure process and find the best available solution.</p>
  <p class="closing">Sincerely,</p>
  <div class="sig-block"><p>Andrusa Lawson</p><p>HUD Certified Housing Counselor</p><p>724-513-1385</p></div>
</div>`;
}

function mercerLetter(date, name, addr1, addr2, propAddr, lender, counselor, logoUrl) {
  return `<div class="letter-page mercer-page">
  <div class="mc-header">
    <img class="mc-logo" src="${logoUrl}" alt="Housing Opportunities Inc.">
  </div>
  <div class="mc-body">
    <p class="date-line">${date}</p>
    <div class="addr-block"><p>${name}</p><p>${addr1}</p>${addr2 ? `<p>${addr2}</p>` : ''}</div>
    <p class="salutation">Dear ${name},</p>
    <p class="body-para">Our agency has received notification that a Complaint in Foreclosure has been filed against you by Plaintiff, ${lender || '[BANK NAME]'}, in the Court of Common Pleas of Mercer County, PA.</p>
    <p class="body-para">This Complaint regards your mortgaged property on ${propAddr || '[PROPERTY ADDRESS]'}.</p>
    <p class="body-para">Housing Opportunities Inc is a HUD Approved Housing Counseling Agency located in New Castle, PA. We provide free services and advice for homeowners facing foreclosure enabling them to make an informed decision. Also, we can represent your case in Mercer County Mortgage Conciliation Court at no charge. If you choose to utilize our services, we require your written authorization during an in-office appointment at our location in New Castle to gather pertinent documents, information and advocate on your behalf.</p>
    <p class="body-para">Please call us at 724.728.7511 to discuss your situation. We are here to help you navigate through the foreclosure process and find the best available solution.</p>
    <p class="closing">Sincerely,</p>
    <div class="sig-block"><p>${counselor || '[COUNSELOR]'}</p><p>HUD Certified Housing Counselor</p></div>
  </div>
  <div class="mc-footer">
    <img class="mc-footer-logo" src="${logoUrl}" alt="">
    <div class="mc-footer-text">
      <p>2418 Willmington Road, Suite C &nbsp;&middot;&nbsp; New Castle, PA 16101</p>
      <p>www.HousingOpps.org &nbsp;&middot;&nbsp; 724-728-7511</p>
    </div>
  </div>
</div>`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function countyLabel(template) {
  if (template === 'andrusa') return 'Lawrence County';
  if (template === 'mercer')  return 'Mercer County';
  return 'Beaver County';
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-US', { timeZone: 'UTC' });
}

function fmtDateLong(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
}

function toTitleCase(str) {
  if (!str) return str;
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function escHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(str) {
  return (str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
