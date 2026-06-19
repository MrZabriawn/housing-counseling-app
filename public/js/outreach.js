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
import { isDemoMode, demoClientName } from './demo-mode.js';
import { COUNSELING_TYPES } from './data.js';
import {
  collection, addDoc, getDocs, getDoc, doc, updateDoc, query, orderBy, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

let _county       = 'dan';    // active CMC template: 'dan' | 'andrusa' | 'mercer'
let _allRecords   = [];       // cached cmcLog documents (past letters)
let _allCalls     = [];       // cached outreachCalls documents
let _allClients   = [];       // lazy-loaded client list for the call modal search
let _callType     = 'client'; // current call modal type: 'client' | 'prospect'
let _selectedClientId   = null; // clientId chosen in the call modal client search
let _selectedClientName = null; // display name for the chosen client
let _convertCallId      = null; // outreachCall ID being converted to a client

// TAL Hours modal state
let _talStaffNum    = null;  // staffNumber from counselors collection for logged-in user
let _talStaffName   = '';    // display name of logged-in user
let _talCounselorId = '';    // counselors doc ID for logged-in user (for hudTrainingEntries)
let _talUserId      = '';    // firebase uid for hudTrainingEntries.counselorId fallback

// Workshop state
let _wsAttendees       = [];   // array of { type, id?, clientName, phone, email, address }
let _wsSelectedClient  = null; // { id, clientName } chosen from search

// ── Entry point ───────────────────────────────────────────────────────────────

requireAuth(async (user, profile) => {
  setupNav(profile, 'outreach');
  window._currentCounselor = profile.name || profile.email || '';
  _talUserId   = user.uid;
  _talStaffName = profile.name || profile.email || '';

  document.getElementById('batchDate').value = new Date().toISOString().split('T')[0];
  document.getElementById('callDate').value  = new Date().toISOString().split('T')[0];

  // Tab switching
  document.querySelectorAll('.outreach-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.outreach-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.outreach-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(tab.dataset.panel).classList.add('active');
    });
  });

  // CMC link modal wiring
  document.getElementById('cmcLinkCancel').addEventListener('click', closeCmcLinkModal);
  document.getElementById('cmcLinkModal').addEventListener('click', e => {
    if (e.target === document.getElementById('cmcLinkModal')) closeCmcLinkModal();
  });
  document.getElementById('cmcClientSearch').addEventListener('input', renderCmcClientSearch);
  document.getElementById('cmcClientClear').addEventListener('click', clearCmcClientSelection);
  document.getElementById('cmcLinkConfirm').addEventListener('click', confirmCmcLink);

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

  // TAL Hours modal
  document.getElementById('openTalBtn').addEventListener('click', openTalModal);
  document.getElementById('talCancelBtn').addEventListener('click', closeTalModal);
  document.getElementById('talSaveBtn').addEventListener('click', saveTal);
  document.getElementById('talModal').addEventListener('click', e => {
    if (e.target === document.getElementById('talModal')) closeTalModal();
  });

  // Court tab
  document.getElementById('courtClientSearch').addEventListener('input', renderCourtClientSearch);
  document.getElementById('courtSubmitBtn').addEventListener('click', submitCourtBatch);
  document.getElementById('courtLogAnotherBtn').addEventListener('click', resetCourtForm);

  // Convert prospect modal
  document.getElementById('convertSaveBtn').addEventListener('click', submitConvertProspect);
  document.getElementById('convertCancelBtn').addEventListener('click', closeConvertModal);
  document.getElementById('convertDoneBtn').addEventListener('click', closeConvertModal);
  document.getElementById('convertProspectModal').addEventListener('click', e => {
    if (e.target === document.getElementById('convertProspectModal')) closeConvertModal();
  });
  COUNSELING_TYPES.forEach(t => {
    const o = document.createElement('option');
    o.value = t; o.textContent = t;
    document.getElementById('convertType').appendChild(o);
  });

  // Workshop tab
  document.getElementById('wsClientSearch').addEventListener('input', renderWsClientSearch);
  document.getElementById('wsAddExistingBtn').addEventListener('click', addExistingToWorkshop);
  document.getElementById('wsShowNewFormBtn').addEventListener('click', () => {
    document.getElementById('wsNewAttendeeForm').classList.remove('hidden');
    document.getElementById('wsShowNewFormBtn').classList.add('hidden');
  });
  document.getElementById('wsCancelNewBtn').addEventListener('click', () => {
    document.getElementById('wsNewAttendeeForm').classList.add('hidden');
    document.getElementById('wsShowNewFormBtn').classList.remove('hidden');
    document.getElementById('wsNewName').value    = '';
    document.getElementById('wsNewPhone').value   = '';
    document.getElementById('wsNewEmail').value   = '';
    document.getElementById('wsNewAddress').value = '';
  });
  document.getElementById('wsAddNewBtn').addEventListener('click', addNewToWorkshop);
  document.getElementById('wsSaveWorkshopBtn').addEventListener('click', saveWorkshop);

  addBatchRow();
  await Promise.all([loadRecords(), loadCalls()]);
});

// ── Counselor options ─────────────────────────────────────────────────────────

async function loadCounselorOptions() {
  try {
    const snap   = await getDocs(query(collection(db, 'counselors'), orderBy('name')));
    const sel    = document.getElementById('callCounselor');
    const selCrt = document.getElementById('courtCounselorOut');
    const selCnv = document.getElementById('convertCounselor');
    const selWs  = document.getElementById('wsWorkshopCounselor');
    snap.docs
      .filter(d => d.data().active !== false)
      .forEach(d => {
        const name = d.data().name;
        [sel, selCrt, selCnv, selWs].forEach(s => {
          const o = document.createElement('option');
          o.value = name; o.textContent = name;
          s.appendChild(o);
        });
      });
    // Pre-select current counselor
    sel.value    = window._currentCounselor;
    selCrt.value = window._currentCounselor;
    selCnv.value = window._currentCounselor;
    selWs.value  = window._currentCounselor;

    // Capture staffNumber + doc ID for the logged-in counselor (used by TAL modal)
    const myDoc = snap.docs.find(
      d => d.data().name === window._currentCounselor && d.data().active !== false
    );
    if (myDoc) {
      _talStaffNum    = myDoc.data().staffNumber ?? null;
      _talCounselorId = myDoc.id;
    }
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

    const logoUrl   = window.location.origin + '/img/logo.png';
    const bannerUrl = window.location.origin + '/img/banner-blue.png';
    const pages     = rows.map(r => buildLetterHTML({
      recipientName:     r.name,
      mailingAddress:    r.addr1,
      mailingAddress2:   r.addr2,
      propertyAddress:   r.propAddr,
      lender:            r.lender,
      counselorTemplate: _county,
      dateSent:          dateVal ? new Date(dateVal + 'T12:00:00') : null,
      counselor:         window._currentCounselor,
    }, dateDisplay, logoUrl, bannerUrl)).join('');

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
      : `<button class="btn btn-secondary btn-sm cmc-link-btn" data-id="${escAttr(r.id)}" style="white-space:nowrap;">Link to Client</button>`;
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

  tbody.querySelectorAll('.cmc-link-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const record = _allRecords.find(r => r.id === btn.dataset.id);
      if (record) openCmcLinkModal(record);
    });
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

  const today     = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const logoUrl   = window.location.origin + '/img/logo.png';
  const bannerUrl = window.location.origin + '/img/banner-blue.png';
  const pages     = selected.map(r => buildLetterHTML(r, today, logoUrl, bannerUrl)).join('');
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
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:2rem;color:var(--text-muted)">No calls logged yet.</td></tr>';
    return;
  }

  tbody.innerHTML = calls.map(c => {
    const typeBadge = c.type === 'prospect'
      ? '<span class="badge badge-yellow">Prospect</span>'
      : '<span class="badge badge-pre">Client</span>';
    const demo = isDemoMode();
    const displayContactName = demo
      ? (c.linkedClientId ? demoClientName(c.linkedClientId) : '—')
      : toTitleCase(c.contactName || '—');
    const nameCell = c.linkedClientId
      ? `<a href="client.html?id=${c.linkedClientId}" style="font-weight:600;">${escHtml(displayContactName)}</a>`
      : escHtml(displayContactName);
    const phoneStr = (!demo && c.phone) ? ` <span style="font-size:0.78rem;color:var(--text-muted);">${escHtml(c.phone)}</span>` : '';
    const linkedName = demo && c.linkedClientId ? demoClientName(c.linkedClientId) : (c.linkedClientName || 'View Client');
    const linkedCell = c.linkedClientId
      ? `<a href="client.html?id=${c.linkedClientId}" style="font-weight:600;font-size:0.875rem;">${escHtml(linkedName)}</a>`
      : (c.type === 'prospect'
          ? `<div style="display:flex;gap:4px;flex-wrap:wrap;">
               <button class="btn btn-primary btn-sm call-convert-btn" data-id="${escAttr(c.id)}" data-name="${escAttr(c.contactName||'')}" data-phone="${escAttr(c.phone||'')}" style="white-space:nowrap;">Open Client File</button>
               <button class="btn btn-secondary btn-sm call-link-btn" data-id="${escAttr(c.id)}" style="white-space:nowrap;">Link to Existing</button>
             </div>`
          : `<button class="btn btn-secondary btn-sm call-link-btn" data-id="${escAttr(c.id)}" style="white-space:nowrap;">Link to Client</button>`);

    return `<tr>
      <td style="white-space:nowrap;">${fmtDate(c.date)}</td>
      <td>${typeBadge}</td>
      <td>${nameCell}${phoneStr}</td>
      <td style="font-size:0.875rem;">${escHtml(c.counselor || '—')}</td>
      <td style="font-size:0.875rem;">${escHtml(c.outcome || '—')}</td>
      <td style="font-size:0.8rem;color:var(--text-muted);max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escAttr(c.notes || '')}">${escHtml(c.notes || '—')}</td>
      <td>${linkedCell}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.call-link-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const record = _allCalls.find(r => r.id === btn.dataset.id);
      if (record) openCmcLinkModal(record, 'call');
    });
  });

  tbody.querySelectorAll('.call-convert-btn').forEach(btn => {
    btn.addEventListener('click', () => openConvertModal(btn.dataset.id, btn.dataset.name, btn.dataset.phone));
  });
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
  if (isDemoMode()) return;
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
      padding:0 1.1in 1in 1.1in;
      page-break-after:always;
      position:relative;
    }
    .letter-page:last-child { page-break-after:auto; }
    .lh-banner     { width:calc(100% + 2.2in); margin-left:-1.1in; margin-bottom:0.45in; }
    .lh-banner img { width:100%; display:block; }
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

function buildLetterHTML(r, fallbackDate, logoUrl, bannerUrl) {
  const dateLine  = r.dateSent ? fmtDateLong(r.dateSent) : fallbackDate;
  const name      = escHtml(r.recipientName   || '');
  const addr1     = escHtml(r.mailingAddress  || '');
  const addr2     = escHtml(r.mailingAddress2 || '');
  const propAddr  = escHtml(r.propertyAddress || '');
  const lender    = escHtml(r.lender          || '');
  const counselor = escHtml(r.counselor       || '');

  if (r.counselorTemplate === 'andrusa') return andrusaletter(dateLine, name, addr1, addr2, propAddr, bannerUrl);
  if (r.counselorTemplate === 'mercer')  return mercerLetter(dateLine, name, addr1, addr2, propAddr, lender, counselor, logoUrl);
  return danLetter(dateLine, name, addr1, addr2, propAddr, lender, bannerUrl);
}

function danLetter(date, name, addr1, addr2, propAddr, lender, bannerUrl) {
  return `<div class="letter-page">
  <div class="lh-banner"><img src="${bannerUrl}" alt="Housing Opportunities Inc."></div>
  <p class="date-line">${date}</p>
  <div class="addr-block"><p>${name}</p><p>${addr1}</p>${addr2 ? `<p>${addr2}</p>` : ''}</div>
  <p class="salutation">Dear ${name},</p>
  <p class="body-para">Our agency has received notification that a Complaint in Mortgage Foreclosure has been filed against you by Plaintiff, ${lender || '[LENDER]'}, in the Court of Common Pleas of Beaver County, PA. This Complaint regards your mortgaged property on ${propAddr || '[PROPERTY ADDRESS]'}.</p>
  <p class="body-para">Housing Opportunities Inc. (HOI) is a HUD Approved Housing Counseling Agency located in Rochester, PA. We provide free services and advice for homeowners facing foreclosure enabling them to make an informed decision. Also, we can represent your case in Beaver County Mortgage Conciliation Court at no charge. If you choose to utilize our services, we require your written authorization during an in-office appointment at our location in Beaver to gather pertinent documents and information.</p>
  <p class="body-para">Please call HOI at 724.728.7511 to discuss your situation. We will be glad to assist your effort to navigate through the foreclosure process with a goal to retain your home.</p>
  <p class="closing">Sincerely,</p>
  <div class="sig-block"><p>Daniel Bernabie</p><p>HUD Certified Housing Counselor</p></div>
</div>`;
}

function andrusaletter(date, name, addr1, addr2, propAddr, bannerUrl) {
  return `<div class="letter-page">
  <div class="lh-banner"><img src="${bannerUrl}" alt="Housing Opportunities Inc."></div>
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

// ── CMC → Client link modal ───────────────────────────────────────────────────

let _cmcLinkRecord      = null;
let _cmcSelectedClient  = null;
let _linkTargetType     = 'cmc'; // 'cmc' | 'call'

function openCmcLinkModal(record, targetType = 'cmc') {
  _cmcLinkRecord     = record;
  _cmcSelectedClient = null;
  _linkTargetType    = targetType;
  document.getElementById('cmcLinkSubtitle').textContent =
    `Letter to: ${record.recipientName || '—'} · ${fmtDate(record.dateSent)}`;
  document.getElementById('cmcClientSearch').value = '';
  document.getElementById('cmcClientResults').innerHTML =
    '<div style="padding:1rem;color:var(--text-muted);font-size:0.875rem;">Start typing to find a client.</div>';
  document.getElementById('cmcClientSelected').classList.add('hidden');
  document.getElementById('cmcLinkConfirm').disabled = true;
  document.getElementById('cmcLinkError').classList.add('hidden');
  document.getElementById('cmcLinkModal').classList.remove('hidden');
  document.getElementById('cmcClientSearch').focus();
}

function closeCmcLinkModal() {
  _cmcLinkRecord     = null;
  _cmcSelectedClient = null;
  document.getElementById('cmcLinkModal').classList.add('hidden');
}

async function renderCmcClientSearch() {
  const q       = document.getElementById('cmcClientSearch').value.toLowerCase().trim();
  const results = document.getElementById('cmcClientResults');
  if (!q) {
    results.innerHTML = '<div style="padding:1rem;color:var(--text-muted);font-size:0.875rem;">Start typing to find a client.</div>';
    return;
  }

  if (!_allClients.length) {
    results.innerHTML = '<div style="padding:1rem;color:var(--text-muted);font-size:0.875rem;">Loading…</div>';
    try {
      const snap = await getDocs(collection(db, 'clients'));
      _allClients = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (_) { _allClients = []; }
  }

  const matches = _allClients.filter(c =>
    (c.clientName || '').toLowerCase().includes(q) ||
    (c.counselor  || '').toLowerCase().includes(q) ||
    (c.rxNumbers  || []).some(rx => String(rx).toLowerCase().includes(q))
  ).slice(0, 20);

  if (!matches.length) {
    results.innerHTML = '<div style="padding:1rem;color:var(--text-muted);font-size:0.875rem;">No clients found.</div>';
    return;
  }

  results.innerHTML = matches.map(c => `
    <div class="csr-item" data-client-id="${escAttr(c.id)}">
      <div class="csr-name">${escHtml(c.clientName || '—')}</div>
      <div class="csr-meta">${escHtml(c.counselor || '')} · ${escHtml(c.counselingType || '')}</div>
    </div>`).join('');

  results.querySelectorAll('.csr-item').forEach(item => {
    item.addEventListener('click', () => {
      _cmcSelectedClient = _allClients.find(c => c.id === item.dataset.clientId);
      document.getElementById('cmcClientSelectedName').textContent = _cmcSelectedClient?.clientName || '';
      document.getElementById('cmcClientSelected').classList.remove('hidden');
      document.getElementById('cmcClientResults').innerHTML = '';
      document.getElementById('cmcClientSearch').value = '';
      document.getElementById('cmcLinkConfirm').disabled = false;
    });
  });
}

function clearCmcClientSelection() {
  _cmcSelectedClient = null;
  document.getElementById('cmcClientSelected').classList.add('hidden');
  document.getElementById('cmcLinkConfirm').disabled = true;
  document.getElementById('cmcClientSearch').value = '';
  document.getElementById('cmcClientResults').innerHTML =
    '<div style="padding:1rem;color:var(--text-muted);font-size:0.875rem;">Start typing to find a client.</div>';
}

async function confirmCmcLink() {
  if (!_cmcLinkRecord || !_cmcSelectedClient) return;
  const btn   = document.getElementById('cmcLinkConfirm');
  const errEl = document.getElementById('cmcLinkError');
  btn.disabled    = true;
  btn.textContent = 'Linking…';
  errEl.classList.add('hidden');

  try {
    const clientId   = _cmcSelectedClient.id;
    const clientName = _cmcSelectedClient.clientName || '';

    if (_linkTargetType === 'call') {
      // Link call record — no session added (call lives in phone log)
      await updateDoc(doc(db, 'outreachCalls', _cmcLinkRecord.id), {
        linkedClientId:   clientId,
        linkedClientName: clientName,
        updatedAt:        serverTimestamp(),
      });
      const idx = _allCalls.findIndex(r => r.id === _cmcLinkRecord.id);
      if (idx !== -1) {
        _allCalls[idx] = { ..._allCalls[idx], linkedClientId: clientId, linkedClientName: clientName };
      }
      renderCallLog(_allCalls);
    } else {
      // Link CMC letter — also creates a session on the client profile
      await updateDoc(doc(db, 'cmcLog', _cmcLinkRecord.id), {
        linkedClientId:   clientId,
        linkedClientName: clientName,
        updatedAt:        serverTimestamp(),
      });
      const letterDate = _cmcLinkRecord.dateSent
        ? (_cmcLinkRecord.dateSent.toDate ? _cmcLinkRecord.dateSent.toDate() : new Date(_cmcLinkRecord.dateSent))
        : new Date();
      await addDoc(collection(db, 'clients', clientId, 'sessions'), {
        date:        letterDate,
        counselor:   _cmcLinkRecord.counselor || '',
        caseStatus:  'CMC Outreach',
        notes:       `CMC letter sent to ${_cmcLinkRecord.recipientName || 'client'}`,
        source:      'cmc',
        cmcLogId:    _cmcLinkRecord.id,
        hours:       0,
        createdAt:   serverTimestamp(),
      });
      const idx = _allRecords.findIndex(r => r.id === _cmcLinkRecord.id);
      if (idx !== -1) {
        _allRecords[idx] = { ..._allRecords[idx], linkedClientId: clientId, linkedClientName: clientName };
      }
      renderTable(_allRecords);
      renderStats(_allRecords);
    }
    closeCmcLinkModal();
  } catch (err) {
    errEl.textContent = 'Link failed: ' + err.message;
    errEl.classList.remove('hidden');
    btn.disabled    = false;
    btn.textContent = 'Link & Add to Sessions';
  }
}

// ── Convert Prospect to Client ────────────────────────────────────────────────

function openConvertModal(callId, name, phone) {
  _convertCallId = callId;
  document.getElementById('convertName').value      = name || '';
  document.getElementById('convertPhone').value     = phone || '';
  document.getElementById('convertType').value      = '';
  document.getElementById('convertCounselor').value = window._currentCounselor;
  document.getElementById('convertDate').value      = new Date().toISOString().split('T')[0];
  document.getElementById('convertError').classList.add('hidden');
  document.getElementById('convertForm').classList.remove('hidden');
  document.getElementById('convertSuccess').classList.add('hidden');
  document.getElementById('convertProspectModal').classList.remove('hidden');
}

function closeConvertModal() {
  _convertCallId = null;
  document.getElementById('convertProspectModal').classList.add('hidden');
}

async function submitConvertProspect() {
  const errEl = document.getElementById('convertError');
  const btn   = document.getElementById('convertSaveBtn');
  errEl.classList.add('hidden');

  const name      = document.getElementById('convertName').value.trim();
  const phone     = document.getElementById('convertPhone').value.trim();
  const type      = document.getElementById('convertType').value;
  const counselor = document.getElementById('convertCounselor').value;
  const dateVal   = document.getElementById('convertDate').value;

  if (!name)      { errEl.textContent = 'Client name is required.'; errEl.classList.remove('hidden'); return; }
  if (!type)      { errEl.textContent = 'Please select a counseling type.'; errEl.classList.remove('hidden'); return; }
  if (!counselor) { errEl.textContent = 'Please select a counselor.'; errEl.classList.remove('hidden'); return; }

  btn.disabled    = true;
  btn.textContent = 'Creating…';

  try {
    const clientDoc = await addDoc(collection(db, 'clients'), {
      clientName:    name,
      phone,
      counselingType: type,
      counselor,
      intakeDate:    dateVal ? new Date(dateVal + 'T12:00:00') : null,
      createdAt:     serverTimestamp(),
      updatedAt:     serverTimestamp(),
    });

    if (_convertCallId) {
      await updateDoc(doc(db, 'outreachCalls', _convertCallId), {
        linkedClientId:   clientDoc.id,
        linkedClientName: name,
        updatedAt:        serverTimestamp(),
      });
      const idx = _allCalls.findIndex(r => r.id === _convertCallId);
      if (idx !== -1) {
        _allCalls[idx] = { ..._allCalls[idx], linkedClientId: clientDoc.id, linkedClientName: name };
      }
    }

    document.getElementById('convertForm').classList.add('hidden');
    document.getElementById('convertSuccessLink').innerHTML =
      `<a href="client.html?id=${clientDoc.id}" class="btn btn-primary" style="text-decoration:none;">Open Client File →</a>`;
    document.getElementById('convertSuccess').classList.remove('hidden');

    renderCallLog(_allCalls);
  } catch (err) {
    errEl.textContent = 'Error: ' + err.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Create Client File';
  }
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

// ── TAL Hours modal ───────────────────────────────────────────────────────────

function openTalModal() {
  document.getElementById('talDate').value      = new Date().toISOString().split('T')[0];
  document.getElementById('talTime').value      = '';
  document.getElementById('talStaffNum').value  = _talStaffNum !== null ? String(_talStaffNum) : '';
  document.getElementById('talStaffName').value = _talStaffName;
  document.getElementById('talType').value      = '';
  document.getElementById('talCost').value      = '';
  document.getElementById('talDesc').value      = '';
  document.getElementById('talDuration').value  = '';
  document.getElementById('talError').classList.add('hidden');
  document.getElementById('talModal').classList.remove('hidden');
}

function closeTalModal() {
  document.getElementById('talModal').classList.add('hidden');
}

function toAMPM(timeVal) {
  if (!timeVal) return '';
  const [h, m] = timeVal.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12    = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

async function saveTal() {
  const date      = document.getElementById('talDate').value;
  const time      = document.getElementById('talTime').value;
  const staffNumR = document.getElementById('talStaffNum').value.trim();
  const staffName = document.getElementById('talStaffName').value.trim();
  const certType  = document.getElementById('talType').value;
  const costType  = document.getElementById('talCost').value.trim();
  const desc      = document.getElementById('talDesc').value.trim();
  const duration  = parseFloat(document.getElementById('talDuration').value) || 0;
  const errEl     = document.getElementById('talError');
  const saveBtn   = document.getElementById('talSaveBtn');

  errEl.classList.add('hidden');
  if (!date)       { showTalErr('Date is required.');                        return; }
  if (!time)       { showTalErr('Time is required.');                        return; }
  if (!staffName)  { showTalErr('Staff name is required.');                  return; }
  if (!certType)   { showTalErr('Select a certification activity type.');    return; }
  if (!desc)       { showTalErr('Description is required.');                 return; }
  if (duration <= 0) { showTalErr('Duration must be greater than 0.');      return; }

  const staffNum = staffNumR !== '' ? parseInt(staffNumR, 10) : 0;

  saveBtn.disabled = true; saveBtn.textContent = 'Saving…';

  try {
    await addDoc(collection(db, 'hudTrainingEntries'), {
      counselorId:               _talCounselorId || _talUserId,
      counselorName:             staffName,
      staffNumber:               isNaN(staffNum) ? 0 : staffNum,
      month:                     date.substring(0, 7),
      date,
      time:                      toAMPM(time),
      activityDescription:       desc,
      certificationActivityType: certType,
      costType:                  costType || '',
      durationHours:             duration,
      createdAt:                 serverTimestamp(),
    });
    closeTalModal();
  } catch (err) {
    showTalErr('Save failed: ' + err.message);
  } finally {
    saveBtn.disabled = false; saveBtn.textContent = 'Save';
  }
}

function showTalErr(msg) {
  const el = document.getElementById('talError');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ── Court batch log ────────────────────────────────────────────────────────────

let _courtSelected = []; // [{ id, clientName, counselor, rxNumbers }]

async function renderCourtClientSearch() {
  const raw     = document.getElementById('courtClientSearch').value;
  const search  = raw.toLowerCase().trim();
  const results = document.getElementById('courtClientResults');

  if (!search) { results.style.display = 'none'; return; }

  if (!_allClients.length) {
    results.innerHTML = '<div style="padding:0.6rem 0.75rem;color:var(--text-muted);">Loading…</div>';
    results.style.display = 'block';
    try {
      const snap = await getDocs(query(collection(db, 'clients'), orderBy('clientName')));
      _allClients = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (_) { _allClients = []; }
  }

  const selectedIds = new Set(_courtSelected.map(c => c.id));
  const matches = _allClients.filter(c =>
    (c.clientName || '').toLowerCase().includes(search) ||
    (c.counselor  || '').toLowerCase().includes(search) ||
    (c.rxNumbers  || []).some(rx => rx.toLowerCase().includes(search))
  ).slice(0, 30);

  if (!matches.length) {
    results.innerHTML = '<div style="padding:0.6rem 0.75rem;color:var(--text-muted);">No clients found.</div>';
    results.style.display = 'block';
    return;
  }

  results.innerHTML = matches.map(c => {
    const added  = selectedIds.has(c.id);
    const rxStr  = (c.rxNumbers || []).join(', ');
    return `<div class="csr-item court-client-result${added ? ' selected' : ''}" data-id="${esc(c.id)}"
              style="cursor:${added ? 'default' : 'pointer'};">
      <div class="csr-name">${esc(toTitleCase(c.clientName))} ${added ? '<span style="color:var(--accent);font-size:0.72rem;">(added)</span>' : ''}</div>
      <div class="csr-meta">${esc(c.counselor || '')}${rxStr ? ' · Rx: ' + esc(rxStr) : ''}</div>
    </div>`;
  }).join('');
  results.style.display = 'block';

  results.querySelectorAll('.court-client-result:not(.selected)').forEach(item => {
    item.addEventListener('click', () => {
      const client = _allClients.find(c => c.id === item.dataset.id);
      if (client && !_courtSelected.find(c => c.id === client.id)) {
        _courtSelected.push({ id: client.id, clientName: client.clientName || '', counselor: client.counselor || '', rxNumbers: client.rxNumbers || [] });
        renderCourtSelected();
        renderCourtClientSearch();
      }
    });
  });
}

function renderCourtSelected() {
  const listEl    = document.getElementById('courtSelectedList');
  const countEl   = document.getElementById('courtSelectedCount');
  countEl.textContent = _courtSelected.length;

  if (!_courtSelected.length) {
    listEl.innerHTML = '<span style="color:var(--text-muted);">No clients added yet. Search above to add clients.</span>';
    return;
  }

  listEl.innerHTML = _courtSelected.map(c => `
    <div style="display:flex;align-items:center;gap:0.5rem;padding:0.35rem 0.5rem;background:#f8f9fb;border:1px solid var(--border);border-radius:var(--radius);">
      <span style="flex:1;font-weight:600;">${esc(toTitleCase(c.clientName))}</span>
      <span style="font-size:0.775rem;color:var(--text-muted);">${esc(c.counselor)}</span>
      <button class="court-remove-btn" data-id="${esc(c.id)}"
        style="background:none;border:none;cursor:pointer;color:var(--danger);font-size:1.1rem;line-height:1;padding:0.1rem 0.3rem;border-radius:4px;"
        title="Remove">×</button>
    </div>`).join('');

  listEl.querySelectorAll('.court-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _courtSelected = _courtSelected.filter(c => c.id !== btn.dataset.id);
      renderCourtSelected();
      renderCourtClientSearch();
    });
  });
}

async function submitCourtBatch() {
  const btn      = document.getElementById('courtSubmitBtn');
  const errorEl  = document.getElementById('courtSubmitError');
  errorEl.classList.add('hidden');

  const dateVal   = document.getElementById('courtDate').value;
  const county    = document.getElementById('courtCounty').value;
  const counselor = document.getElementById('courtCounselorOut').value;
  const hours     = parseFloat(document.getElementById('courtHoursOut').value) || 2;
  const notes     = document.getElementById('courtNotesOut').value.trim();

  if (!dateVal)   { showCourtErr('Please enter the court date.'); return; }
  if (!county)    { showCourtErr('Please select a county.'); return; }
  if (!counselor) { showCourtErr('Please select a counselor.'); return; }
  if (!_courtSelected.length) { showCourtErr('Add at least one client.'); return; }

  btn.disabled    = true;
  btn.textContent = 'Saving…';

  const sessionDate = new Date(dateVal + 'T12:00:00');
  const caseStatus  = `Court — ${county}`;

  try {
    await Promise.all(_courtSelected.map(c =>
      addDoc(collection(db, 'clients', c.id, 'sessions'), {
        date:       sessionDate,
        counselor:  counselor,
        rxNumber:   (c.rxNumbers[0] || ''),
        hours,
        dollarsFor: '',
        caseStatus,
        outcome:    '',
        notes,
        clientName: c.clientName || '',
        createdAt:  serverTimestamp(),
        updatedAt:  serverTimestamp(),
      })
    ));

    // Refresh denormalized fields
    for (const c of _courtSelected) {
      try {
        const snap = await getDocs(query(collection(db, 'clients', c.id, 'sessions'), orderBy('date', 'asc')));
        const sessions = snap.docs.map(d => d.data());
        const dated    = sessions.filter(s => s.date);
        await updateDoc(doc(db, 'clients', c.id), {
          sessionCount:     sessions.length,
          totalOutcomeValue: sessions.reduce((s, r) => s + (Number(r.dollarsAwarded) || 0), 0),
          firstSessionDate: dated.length ? dated[0].date : null,
          lastSessionDate:  dated.length ? dated[dated.length - 1].date : null,
          updatedAt:        serverTimestamp(),
        });
      } catch (_) {}
    }

    const count = _courtSelected.length;
    document.getElementById('courtSuccessMsg').textContent =
      `Logged ${count} court appearance${count !== 1 ? 's' : ''} for ${county} on ${sessionDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}.`;
    document.getElementById('courtSuccessBanner').classList.remove('hidden');
    document.getElementById('courtForm').classList.add('hidden');
  } catch (err) {
    showCourtErr('Save failed: ' + err.message);
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Log Court Appearances';
  }
}

function resetCourtForm() {
  _courtSelected = [];
  document.getElementById('courtDate').value        = '';
  document.getElementById('courtCounty').value      = '';
  document.getElementById('courtHoursOut').value    = '2';
  document.getElementById('courtNotesOut').value    = '';
  document.getElementById('courtClientSearch').value = '';
  document.getElementById('courtClientResults').style.display = 'none';
  document.getElementById('courtSubmitError').classList.add('hidden');
  renderCourtSelected();
  document.getElementById('courtSuccessBanner').classList.add('hidden');
  document.getElementById('courtForm').classList.remove('hidden');
}

function showCourtErr(msg) {
  const el = document.getElementById('courtSubmitError');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ── Workshop ──────────────────────────────────────────────────────────────────

async function renderWsClientSearch() {
  const q    = document.getElementById('wsClientSearch').value.trim().toLowerCase();
  const box  = document.getElementById('wsClientResults');
  _wsSelectedClient = null;
  document.getElementById('wsAddExistingBtn').disabled = true;

  if (!q || q.length < 2) { box.style.display = 'none'; return; }

  if (!_allClients.length) {
    box.innerHTML = '<div style="padding:0.6rem 0.75rem;color:var(--text-muted);">Loading…</div>';
    box.style.display = 'block';
    try {
      const snap = await getDocs(query(collection(db, 'clients'), orderBy('clientName')));
      _allClients = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (_) { _allClients = []; }
  }

  const matches = _allClients
    .filter(c => (c.clientName || '').toLowerCase().includes(q))
    .slice(0, 8);

  if (!matches.length) { box.style.display = 'none'; return; }

  box.innerHTML = '';
  matches.forEach(c => {
    const item = document.createElement('div');
    item.className = 'client-result-item';
    item.textContent = c.clientName;
    item.addEventListener('click', () => {
      _wsSelectedClient = { id: c.id, clientName: c.clientName };
      document.getElementById('wsClientSearch').value = c.clientName;
      box.style.display = 'none';
      document.getElementById('wsAddExistingBtn').disabled = false;
    });
    box.appendChild(item);
  });
  box.style.display = 'block';
}

function addExistingToWorkshop() {
  if (!_wsSelectedClient) return;
  if (_wsAttendees.find(a => a.id === _wsSelectedClient.id)) {
    document.getElementById('wsClientSearch').value = '';
    _wsSelectedClient = null;
    document.getElementById('wsAddExistingBtn').disabled = true;
    return;
  }
  _wsAttendees.push({ type: 'existing', id: _wsSelectedClient.id, clientName: _wsSelectedClient.clientName });
  document.getElementById('wsClientSearch').value = '';
  document.getElementById('wsClientResults').style.display = 'none';
  _wsSelectedClient = null;
  document.getElementById('wsAddExistingBtn').disabled = true;
  renderAttendeeList();
}

function addNewToWorkshop() {
  const name = document.getElementById('wsNewName').value.trim();
  if (!name) {
    document.getElementById('wsNewName').focus();
    return;
  }
  _wsAttendees.push({
    type:       'new',
    clientName: name,
    phone:      document.getElementById('wsNewPhone').value.trim(),
    email:      document.getElementById('wsNewEmail').value.trim(),
    address:    document.getElementById('wsNewAddress').value.trim(),
  });
  document.getElementById('wsNewName').value    = '';
  document.getElementById('wsNewPhone').value   = '';
  document.getElementById('wsNewEmail').value   = '';
  document.getElementById('wsNewAddress').value = '';
  document.getElementById('wsNewAttendeeForm').classList.add('hidden');
  document.getElementById('wsShowNewFormBtn').classList.remove('hidden');
  renderAttendeeList();
}

function renderAttendeeList() {
  const list  = document.getElementById('wsAttendeeList');
  const empty = document.getElementById('wsAttendeeEmpty');
  const count = document.getElementById('wsAttendeeCount');

  count.textContent = _wsAttendees.length
    ? `${_wsAttendees.length} attendee${_wsAttendees.length !== 1 ? 's' : ''}`
    : '';

  if (!_wsAttendees.length) {
    empty.classList.remove('hidden');
    list.querySelectorAll('.ws-attendee-row').forEach(r => r.remove());
    return;
  }
  empty.classList.add('hidden');

  list.querySelectorAll('.ws-attendee-row').forEach(r => r.remove());
  _wsAttendees.forEach((a, i) => {
    const row = document.createElement('div');
    row.className = 'ws-attendee-row';
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:0.35rem 0;border-bottom:1px solid var(--border-color);';
    const badge = a.type === 'new' ? '<span style="font-size:0.7rem;color:var(--text-muted);margin-left:0.35rem;">new</span>' : '';
    row.innerHTML = `<span>${escHtml(a.clientName)}${badge}</span><button style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:1rem;padding:0 0.25rem;" data-i="${i}" aria-label="Remove">×</button>`;
    row.querySelector('button').addEventListener('click', () => {
      _wsAttendees.splice(i, 1);
      renderAttendeeList();
    });
    list.appendChild(row);
  });
}

async function saveWorkshop() {
  const btn     = document.getElementById('wsSaveWorkshopBtn');
  const msgEl   = document.getElementById('wsWorkshopMsg');
  msgEl.textContent = '';
  msgEl.style.color = '';

  const workshopName = document.getElementById('wsWorkshopName').value.trim();
  const date         = document.getElementById('wsWorkshopDate').value;
  const counselor    = document.getElementById('wsWorkshopCounselor').value;
  const hours        = document.getElementById('wsWorkshopHours').value;

  if (!workshopName) { msgEl.textContent = 'Workshop name is required.'; msgEl.style.color = 'var(--danger)'; return; }
  if (!date)         { msgEl.textContent = 'Date is required.';           msgEl.style.color = 'var(--danger)'; return; }
  if (!counselor)    { msgEl.textContent = 'Counselor is required.';      msgEl.style.color = 'var(--danger)'; return; }
  if (!_wsAttendees.length) { msgEl.textContent = 'Add at least one attendee.'; msgEl.style.color = 'var(--danger)'; return; }

  btn.disabled    = true;
  btn.textContent = 'Saving…';

  const sessionData = {
    counselingType: 'Workshop',
    hudType:        'Group Education',
    date,
    hours:          Number(hours) || 0,
    counselor,
    workshopName,
    source:         'workshop',
    createdAt:      serverTimestamp(),
  };

  try {
    let saved = 0;
    for (const a of _wsAttendees) {
      let clientId = a.id;

      if (a.type === 'new') {
        const clientRef = await addDoc(collection(db, 'clients'), {
          clientName:  a.clientName,
          phone:       a.phone  || '',
          email:       a.email  || '',
          address:     a.address || '',
          counselor,
          intakeDate:  date,
          status:      'Active',
          createdAt:   serverTimestamp(),
          updatedAt:   serverTimestamp(),
          sessionCount: 0,
          totalOutcomeValue: 0,
        });
        clientId = clientRef.id;
      }

      await addDoc(collection(db, 'clients', clientId, 'sessions'), { ...sessionData });
      saved++;
    }

    msgEl.textContent = `Saved ${saved} session${saved !== 1 ? 's' : ''} for "${workshopName}".`;
    msgEl.style.color = 'var(--success, green)';

    // Reset form
    _wsAttendees = [];
    renderAttendeeList();
    document.getElementById('wsWorkshopName').value  = '';
    document.getElementById('wsWorkshopDate').value  = '';
    document.getElementById('wsWorkshopHours').value = '1';
    document.getElementById('wsWorkshopCounselor').value = window._currentCounselor || '';
  } catch (err) {
    msgEl.textContent = 'Save failed: ' + err.message;
    msgEl.style.color = 'var(--danger)';
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Save Workshop';
  }
}

