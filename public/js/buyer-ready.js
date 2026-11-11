import { db } from './firebase-config.js';
import { requireAuth, setupNav } from './auth.js?v=2';
import { amiCategory } from './data.js';
import {
  collection, getDocs, doc, getDoc, addDoc, updateDoc, deleteDoc, orderBy, query, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const STATUS_LABELS = { eligible: 'Eligible', under_contract: 'Under Contract', closed: 'Closed' };
const STATUS_COLORS = { eligible: 'badge-blue', under_contract: 'badge-green', closed: 'badge-gray' };

let allRows      = [];
let _allClients  = [];
let editingId    = null;
let _editingRecord = null;
let _editingAreas  = [];
let _workshops       = [];
let _workshopsLoaded = false;
let _clientSig       = null;  // base64 PNG data URL or null
let _repSig          = null;
let _clientSigDate   = null;  // ISO timestamp when first signed
let _repSigDate      = null;

requireAuth(async (user, profile) => {
  setupNav(profile, 'buyer-ready');

  const snap = await getDocs(query(collection(db, 'ccaList'), orderBy('enrolledAt', 'asc')));
  allRows = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => {
    const tier = r.confidentialityTier || 'standard';
    if (tier === 'standard') return true;
    if (profile.role === 'executive_director') return true;
    return (r.careTeam || []).includes(user.uid);
  });

  render();

  document.getElementById('filterSearch').addEventListener('input', render);
  document.getElementById('filterStatus').addEventListener('change', render);
  document.getElementById('showClosed').addEventListener('change', render);
  document.getElementById('editCcaStatus').addEventListener('change', toggleClosureSection);
  document.getElementById('editClosureOutcome').addEventListener('change', togglePurchaseFields);

  document.getElementById('ccaEditCancel').addEventListener('click', closeModal);
  document.getElementById('ccaEditSave').addEventListener('click', saveEdit);
  document.getElementById('ccaRemoveBtn').addEventListener('click', removeFromList);

  document.getElementById('addClientBtn').addEventListener('click', openClientSelector);
  document.getElementById('clientSelectorClose').addEventListener('click', closeClientSelector);
  document.getElementById('clientSelectorSearch').addEventListener('input', renderClientSelector);

  document.getElementById('ccaLinkSearch').addEventListener('input', renderLinkResults);
  document.getElementById('ccaResyncBtn').addEventListener('click', resyncFromClient);

  // Chip input — type a word and press Enter
  document.getElementById('areaChipInput').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const val = e.target.value.trim().toLowerCase();
    if (val && !_editingAreas.includes(val)) {
      _editingAreas.push(val);
      renderEditingChips();
    }
    e.target.value = '';
  });

  document.getElementById('areaChipsWrap').addEventListener('click', () => {
    document.getElementById('areaChipInput').focus();
  });

  document.getElementById('editClosingNA').addEventListener('change', e => {
    const dateInput = document.getElementById('editClosingDate');
    dateInput.disabled = e.target.checked;
    if (e.target.checked) dateInput.value = '';
  });

  document.getElementById('editWorkshopAttended').addEventListener('change', e => {
    document.getElementById('workshopSection').classList.toggle('hidden', !e.target.checked);
  });

  document.getElementById('editWorkshopId').addEventListener('change', e => {
    const ws = _workshops.find(w => w.id === e.target.value);
    if (ws?.date) {
      const d = ws.date.toDate ? ws.date.toDate() : new Date(ws.date);
      document.getElementById('editWorkshopDateManual').value = d.toISOString().split('T')[0];
    }
  });

  document.getElementById('ccaPrintDpaBtn').addEventListener('click', printDpaApplication);

  initSigPad('clientSigCanvas', 'clearClientSigBtn',
    sig  => { _clientSig = sig; if (!_clientSigDate) _clientSigDate = new Date().toISOString(); updateSigDateLabel('clientSigDateLabel', _clientSigDate); },
    ()   => { _clientSig = null; _clientSigDate = null; updateSigDateLabel('clientSigDateLabel', null); }
  );
  initSigPad('repSigCanvas', 'clearRepSigBtn',
    sig  => { _repSig = sig; if (!_repSigDate) _repSigDate = new Date().toISOString(); updateSigDateLabel('repSigDateLabel', _repSigDate); },
    ()   => { _repSig = null; _repSigDate = null; updateSigDateLabel('repSigDateLabel', null); }
  );
});

// ── Render table ──────────────────────────────────────────────────────────────

function render() {
  const search     = document.getElementById('filterSearch').value.toLowerCase().trim();
  const status     = document.getElementById('filterStatus').value;
  const showClosed = document.getElementById('showClosed').checked;

  const filtered = allRows.filter(r => {
    const isClosed = r.status === 'closed';
    if (status) {
      if (r.status !== status) return false;
    } else {
      if (isClosed && !showClosed) return false;
    }
    if (!search) return true;
    if ((r.clientName || '').toLowerCase().includes(search)) return true;
    if ((r.counselor  || '').toLowerCase().includes(search)) return true;
    if ((r.areasOfInterest || []).some(a => a.toLowerCase().includes(search))) return true;
    return false;
  });

  // Sort: soonest closing date first, nulls at bottom
  filtered.sort((a, b) => {
    const da = closingMs(a), db2 = closingMs(b);
    if (!da && !db2) return 0;
    if (!da) return 1;
    if (!db2) return -1;
    return da - db2;
  });

  const tbody = document.getElementById('ccaBody');
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="text-muted" style="padding:2rem;text-align:center;">No entries found.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(r => {
    const closingCell = r.closingDateNA
      ? '<span class="text-muted">N/A</span>'
      : (fmtDate(r.closingDate) || '<span class="text-muted">—</span>');
    const urgent = !r.closingDateNA && isUrgent(r.closingDate) ? ' style="color:var(--danger);font-weight:600;"' : '';

    const priceRange = (r.priceRangeMin || r.priceRangeMax)
      ? [
          r.priceRangeMin ? '$' + Number(r.priceRangeMin).toLocaleString('en-US') : '',
          r.priceRangeMax ? '$' + Number(r.priceRangeMax).toLocaleString('en-US') : '',
        ].filter(Boolean).join(' – ')
      : '<span class="text-muted">—</span>';

    const areas = (r.areasOfInterest || []).length
      ? r.areasOfInterest.map(a => `<span class="area-tag">${esc(a)}</span>`).join('')
      : '<span class="text-muted">—</span>';

    const statusLabel = STATUS_LABELS[r.status] || r.status || 'Eligible';
    const statusBadge = STATUS_COLORS[r.status] || 'badge-blue';

    return `<tr class="clickable-row" data-id="${r.id}" data-client-id="${r.clientId || ''}" style="${r.status === 'closed' ? 'opacity:0.55;' : ''}">
      <td style="font-weight:600;">${esc(toTitleCase(r.clientName))}</td>
      <td>${esc(r.counselor)}</td>
      <td><span class="badge ${statusBadge}">${statusLabel}</span></td>
      <td style="white-space:nowrap;">${priceRange}</td>
      <td style="max-width:14rem;">${areas}</td>
      <td>${r.bedrooms ? r.bedrooms + ' bd' : '<span class="text-muted">—</span>'}</td>
      <td${urgent}>${closingCell}</td>
      <td>${r.ccaAmount ? '$' + Number(r.ccaAmount).toLocaleString('en-US', {minimumFractionDigits:2}) : '—'}</td>
      <td><button class="btn btn-secondary btn-sm edit-entry-btn" data-id="${r.id}" style="white-space:nowrap;">Edit Entry</button></td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.clickable-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      if (e.target.closest('.edit-entry-btn')) {
        openEditModal(e.target.closest('.edit-entry-btn').dataset.id);
        return;
      }
      const clientId = row.dataset.clientId;
      if (clientId) {
        window.location.href = `client.html?id=${clientId}`;
      } else {
        openEditModal(row.dataset.id);
      }
    });
  });
}

// ── Signature pad ─────────────────────────────────────────────────────────────

function initSigPad(canvasId, clearBtnId, onSign, onClear) {
  const canvas = document.getElementById(canvasId);
  const ctx    = canvas.getContext('2d');
  let drawing  = false;

  function pos(e) {
    const rect   = canvas.getBoundingClientRect();
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    const src    = e.touches ? e.touches[0] : e;
    return { x: (src.clientX - rect.left) * scaleX, y: (src.clientY - rect.top) * scaleY };
  }

  function start(e) { e.preventDefault(); drawing = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); }

  function draw(e) {
    if (!drawing) return;
    e.preventDefault();
    const p = pos(e);
    ctx.lineWidth = 1.8; ctx.lineCap = 'round'; ctx.strokeStyle = '#000';
    ctx.lineTo(p.x, p.y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p.x, p.y);
  }

  function end(e) {
    if (!drawing) return;
    e.preventDefault();
    drawing = false;
    ctx.beginPath();
    // Capture with white background
    const tmp = document.createElement('canvas');
    tmp.width = canvas.width; tmp.height = canvas.height;
    const tCtx = tmp.getContext('2d');
    tCtx.fillStyle = '#fff';
    tCtx.fillRect(0, 0, tmp.width, tmp.height);
    tCtx.drawImage(canvas, 0, 0);
    onSign(tmp.toDataURL('image/png'));
  }

  canvas.addEventListener('mousedown',  start);
  canvas.addEventListener('mousemove',  draw);
  canvas.addEventListener('mouseup',    end);
  canvas.addEventListener('mouseleave', end);
  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove',  draw,  { passive: false });
  canvas.addEventListener('touchend',   end,   { passive: false });

  document.getElementById(clearBtnId).addEventListener('click', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    onClear();
  });
}

function loadSigToCanvas(canvasId, dataUrl) {
  const canvas = document.getElementById(canvasId);
  const ctx    = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!dataUrl) return;
  const img = new Image();
  img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  img.src = dataUrl;
}

function updateSigDateLabel(elId, isoDate) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = isoDate
    ? 'Signed ' + new Date(isoDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '';
}

// ── Workshops loader ──────────────────────────────────────────────────────────

async function loadWorkshops() {
  if (_workshopsLoaded) return;
  _workshopsLoaded = true;
  try {
    const snap = await getDocs(query(collection(db, 'workshops'), orderBy('date', 'desc')));
    _workshops = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (_) { _workshops = []; }

  const sel = document.getElementById('editWorkshopId');
  sel.innerHTML = '<option value="">— Select —</option>';
  _workshops.forEach(w => {
    const d = w.date?.toDate ? w.date.toDate() : (w.date ? new Date(w.date) : null);
    const label = w.title + (d ? ' — ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
    const o = document.createElement('option');
    o.value = w.id; o.textContent = label;
    sel.appendChild(o);
  });
}

// ── Edit modal ────────────────────────────────────────────────────────────────

function toggleClosureSection() {
  const isClosed = document.getElementById('editCcaStatus').value === 'closed';
  document.getElementById('closureSection').classList.toggle('hidden', !isClosed);
  if (isClosed && !document.getElementById('editSettlementDate').value) {
    document.getElementById('editSettlementDate').value = new Date().toISOString().split('T')[0];
  }
  if (isClosed) togglePurchaseFields();
}

function togglePurchaseFields() {
  const purchased = document.getElementById('editClosureOutcome').value === 'purchased';
  document.getElementById('purchasedFields').classList.toggle('hidden', !purchased);
  document.getElementById('didNotPurchaseFields').classList.toggle('hidden', purchased);
}

function openEditModal(id) {
  const r = allRows.find(x => x.id === id);
  if (!r) return;
  editingId      = id;
  _editingRecord = r;
  _editingAreas  = [...(r.areasOfInterest || [])];

  document.getElementById('ccaEditTitle').textContent      = toTitleCase(r.clientName);
  document.getElementById('editPriceMin').value            = r.priceRangeMin || '';
  document.getElementById('editPriceMax').value            = r.priceRangeMax || '';
  document.getElementById('editBedrooms').value            = r.bedrooms || '';
  document.getElementById('editCcaStatus').value           = r.status || 'eligible';
  document.getElementById('editCcaAmount').value           = r.ccaAmount || '';
  document.getElementById('editCcaNotes').value            = r.notes  || '';
  document.getElementById('areaChipInput').value           = '';
  document.getElementById('ccaEditError').classList.add('hidden');

  // Closure fields
  const isPurchased = r.closureOutcome === 'Purchased' || r.closureOutcomeType === 'purchased';
  document.getElementById('editClosureOutcome').value    = (r.closureOutcomeRaw === 'did_not_purchase' || (!isPurchased && r.closureOutcome)) ? 'did_not_purchase' : 'purchased';
  document.getElementById('editSettlementDate').value    = r.closureDate
    ? (r.closureDate.toDate ? r.closureDate.toDate() : new Date(r.closureDate)).toISOString().split('T')[0]
    : '';
  document.getElementById('editPurchasePrice').value     = r.closureOutcomeValue || '';
  document.getElementById('editLoanAmount').value        = r.loanAmount     || '';
  document.getElementById('editLenderName').value        = r.lenderName     || '';
  document.getElementById('editCcaProvided').value       = r.ccaAmountProvided || '';
  document.getElementById('editDnpReason').value         = r.dnpReason      || 'Could Not Qualify';
  document.getElementById('editClosureNotes').value      = r.closureNotes   || '';
  toggleClosureSection();

  const naChecked = !!r.closingDateNA;
  document.getElementById('editClosingNA').checked   = naChecked;
  document.getElementById('editClosingDate').disabled = naChecked;
  document.getElementById('editClosingDate').value    = naChecked ? '' : toDateInput(r.closingDate);

  renderEditingChips();

  // DPA fields
  loadWorkshops();
  const wsAttended = !!r.dpaWorkshopAttended;
  document.getElementById('editWorkshopAttended').checked = wsAttended;
  document.getElementById('workshopSection').classList.toggle('hidden', !wsAttended);
  document.getElementById('editWorkshopId').value          = r.dpaWorkshopId   || '';
  document.getElementById('editWorkshopDateManual').value  = r.dpaWorkshopDate || '';
  document.getElementById('editLoanType').value            = r.dpaLoanType     || '';

  // Signatures
  _clientSig     = r.dpaClientSig     || null;
  _repSig        = r.dpaRepSig        || null;
  _clientSigDate = r.dpaClientSigDate || null;
  _repSigDate    = r.dpaRepSigDate    || null;
  loadSigToCanvas('clientSigCanvas', _clientSig);
  loadSigToCanvas('repSigCanvas',    _repSig);
  updateSigDateLabel('clientSigDateLabel', _clientSigDate);
  updateSigDateLabel('repSigDateLabel',    _repSigDate);

  if (r.clientId) {
    const anchor = document.getElementById('ccaClientAnchor');
    anchor.href        = `client.html?id=${r.clientId}`;
    anchor.textContent = toTitleCase(r.clientName) || r.clientId;
    document.getElementById('ccaLinkedBar').classList.remove('hidden');
    document.getElementById('ccaLinkSection').classList.add('hidden');
  } else {
    document.getElementById('ccaLinkedBar').classList.add('hidden');
    document.getElementById('ccaLinkSection').classList.remove('hidden');
    document.getElementById('ccaLinkSearch').value = r.clientName || '';
    renderLinkResults();
  }

  document.getElementById('ccaEditModal').classList.remove('hidden');
}

function closeModal() {
  editingId = null;
  document.getElementById('ccaEditModal').classList.add('hidden');
}

function renderEditingChips() {
  const container = document.getElementById('areaChips');
  container.innerHTML = _editingAreas.map((tag, i) =>
    `<span class="chip">${esc(tag)}<span class="chip-del" data-i="${i}">&times;</span></span>`
  ).join('');
  container.querySelectorAll('.chip-del').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      _editingAreas.splice(parseInt(btn.dataset.i), 1);
      renderEditingChips();
    });
  });
}

async function saveEdit() {
  if (!editingId) return;
  const errorEl = document.getElementById('ccaEditError');
  const saveBtn = document.getElementById('ccaEditSave');
  errorEl.classList.add('hidden');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    const dateVal      = document.getElementById('editClosingDate').value;
    const naChecked    = document.getElementById('editClosingNA').checked;
    const status       = document.getElementById('editCcaStatus').value;
    const isClosed     = status === 'closed';
    const isPurchased  = document.getElementById('editClosureOutcome').value === 'purchased';

    const closureFields = isClosed ? (() => {
      if (isPurchased) {
        const settlementVal = document.getElementById('editSettlementDate').value;
        return {
          closureOutcomeRaw:   'purchased',
          closureOutcome:      'Purchased',
          closureDate:         settlementVal ? new Date(settlementVal + 'T12:00:00') : null,
          closureOutcomeValue: parseFloat(document.getElementById('editPurchasePrice').value) || 0,
          closureAwardType:    'Direct Assistance',
          loanAmount:          parseFloat(document.getElementById('editLoanAmount').value) || 0,
          lenderName:          document.getElementById('editLenderName').value.trim(),
          ccaAmountProvided:   parseFloat(document.getElementById('editCcaProvided').value) || 0,
          dnpReason:           '',
          closureNotes:        document.getElementById('editClosureNotes').value.trim(),
        };
      } else {
        const reason = document.getElementById('editDnpReason').value;
        return {
          closureOutcomeRaw:   'did_not_purchase',
          closureOutcome:      `Did Not Purchase — ${reason}`,
          closureDate:         new Date(),
          closureOutcomeValue: 0,
          closureAwardType:    '',
          loanAmount:          0,
          lenderName:          '',
          ccaAmountProvided:   0,
          dnpReason:           reason,
          closureNotes:        document.getElementById('editClosureNotes').value.trim(),
        };
      }
    })() : {};

    const updates = {
      priceRangeMin:   parseFloat(document.getElementById('editPriceMin').value) || 0,
      priceRangeMax:   parseFloat(document.getElementById('editPriceMax').value) || 0,
      bedrooms:        document.getElementById('editBedrooms').value || '',
      areasOfInterest: [..._editingAreas],
      status,
      closingDateNA:   naChecked,
      closingDate:     (!naChecked && dateVal) ? new Date(dateVal + 'T12:00:00') : null,
      ccaAmount:       parseFloat(document.getElementById('editCcaAmount').value) || 0,
      notes:           document.getElementById('editCcaNotes').value.trim(),
      dpaWorkshopAttended: document.getElementById('editWorkshopAttended').checked,
      dpaWorkshopId:       document.getElementById('editWorkshopId').value || '',
      dpaWorkshopDate:     document.getElementById('editWorkshopDateManual').value || '',
      dpaWorkshopName:     (() => { const ws = _workshops.find(w => w.id === document.getElementById('editWorkshopId').value); return ws?.title || ''; })(),
      dpaLoanType:         document.getElementById('editLoanType').value || '',
      dpaClientSig:        _clientSig     || null,
      dpaRepSig:           _repSig        || null,
      dpaClientSigDate:    _clientSigDate || null,
      dpaRepSigDate:       _repSigDate    || null,
      updatedAt:       serverTimestamp(),
      ...closureFields,
    };
    await updateDoc(doc(db, 'ccaList', editingId), updates);

    // Sync closure to linked client profile
    if (isClosed && _editingRecord?.clientId) {
      await updateDoc(doc(db, 'clients', _editingRecord.clientId), {
        status:              'closed',
        closureDate:         closureFields.closureDate || null,
        closureOutcome:      closureFields.closureOutcome || '',
        closureOutcomeValue: closureFields.closureOutcomeValue || 0,
        closureAwardType:    closureFields.closureAwardType || '',
        ccaAmountProvided:   closureFields.ccaAmountProvided || 0,
        updatedAt:           serverTimestamp(),
      });
    }

    const idx = allRows.findIndex(x => x.id === editingId);
    if (idx !== -1) allRows[idx] = { ...allRows[idx], ...updates };

    closeModal();
    render();
  } catch (err) {
    errorEl.textContent = 'Save failed: ' + err.message;
    errorEl.classList.remove('hidden');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
  }
}

async function removeFromList() {
  if (!editingId) return;
  const r = allRows.find(x => x.id === editingId);
  const name = toTitleCase(r?.clientName || 'this client');
  if (!confirm(`Remove ${name} from Buyer Ready? This only removes them from the list — their client profile is not affected.`)) return;

  try {
    await deleteDoc(doc(db, 'ccaList', editingId));
    allRows = allRows.filter(x => x.id !== editingId);
    closeModal();
    render();
  } catch (err) {
    document.getElementById('ccaEditError').textContent = 'Remove failed: ' + err.message;
    document.getElementById('ccaEditError').classList.remove('hidden');
  }
}

// ── Link search ───────────────────────────────────────────────────────────────

async function renderLinkResults() {
  const search    = document.getElementById('ccaLinkSearch').value.toLowerCase().trim();
  const resultsEl = document.getElementById('ccaLinkResults');

  if (!_allClients.length) {
    resultsEl.innerHTML = '<div style="padding:0.75rem;color:var(--text-muted);">Loading…</div>';
    try {
      const snap = await getDocs(collection(db, 'clients'));
      _allClients = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (_) { _allClients = []; }
  }

  if (!search) {
    resultsEl.innerHTML = '<div style="padding:0.75rem;color:var(--text-muted);">Start typing to search clients.</div>';
    return;
  }

  const matches = _allClients.filter(c =>
    (c.clientName || '').toLowerCase().includes(search) ||
    (c.counselor  || '').toLowerCase().includes(search) ||
    (c.rxNumbers  || []).some(rx => rx.toLowerCase().includes(search))
  ).slice(0, 20);

  if (!matches.length) {
    resultsEl.innerHTML = '<div style="padding:0.75rem;color:var(--text-muted);">No clients found.</div>';
    return;
  }

  resultsEl.innerHTML = matches.map(c => `
    <div class="client-selector-item" data-client-id="${c.id}">
      <div>
        <div class="cs-name">${esc(toTitleCase(c.clientName || ''))}</div>
        <div class="cs-meta">${esc(c.counselor || '')} · ${esc(c.counselingType || '')} · ${esc(amiCategory(c.amiPercent) || '')}</div>
      </div>
      <span style="font-size:0.75rem;color:var(--primary);font-weight:600;">Link →</span>
    </div>`).join('');

  resultsEl.querySelectorAll('.client-selector-item').forEach(item => {
    item.addEventListener('click', () => linkClientToEntry(item.dataset.clientId));
  });
}

async function linkClientToEntry(clientDocId) {
  if (!editingId) return;
  const errorEl = document.getElementById('ccaEditError');
  errorEl.classList.add('hidden');

  try {
    const clientSnap = await getDoc(doc(db, 'clients', clientDocId));
    if (!clientSnap.exists()) throw new Error('Client not found.');
    const c = clientSnap.data();

    const updates = {
      clientId:        clientDocId,
      clientName:      c.clientName      || _editingRecord.clientName || '',
      counselor:       c.counselor       || '',
      amiPercent:      c.amiPercent      || '',
      driveFolderId:   c.driveFolderId   || '',
      driveFolderName: c.driveFolderName || '',
      driveFolderUrl:  c.driveFolderUrl  || '',
      updatedAt:       serverTimestamp(),
    };

    await updateDoc(doc(db, 'ccaList', editingId), updates);

    const idx = allRows.findIndex(x => x.id === editingId);
    if (idx !== -1) allRows[idx] = { ...allRows[idx], ...updates };
    _editingRecord = { ..._editingRecord, ...updates };

    const anchor = document.getElementById('ccaClientAnchor');
    anchor.href        = `client.html?id=${clientDocId}`;
    anchor.textContent = toTitleCase(c.clientName || '') || clientDocId;
    document.getElementById('ccaLinkedBar').classList.remove('hidden');
    document.getElementById('ccaLinkSection').classList.add('hidden');
    document.getElementById('ccaEditTitle').textContent = toTitleCase(c.clientName || '');

    render();
  } catch (err) {
    errorEl.textContent = 'Link failed: ' + err.message;
    errorEl.classList.remove('hidden');
  }
}

async function resyncFromClient() {
  if (!editingId || !_editingRecord?.clientId) return;
  const btn = document.getElementById('ccaResyncBtn');
  btn.disabled = true;
  btn.textContent = 'Syncing…';

  try {
    const clientSnap = await getDoc(doc(db, 'clients', _editingRecord.clientId));
    if (!clientSnap.exists()) throw new Error('Client not found.');
    const c = clientSnap.data();

    const updates = {
      clientName:      c.clientName      || '',
      counselor:       c.counselor       || '',
      amiPercent:      c.amiPercent      || '',
      driveFolderId:   c.driveFolderId   || '',
      driveFolderName: c.driveFolderName || '',
      driveFolderUrl:  c.driveFolderUrl  || '',
      updatedAt:       serverTimestamp(),
    };

    await updateDoc(doc(db, 'ccaList', editingId), updates);

    const idx = allRows.findIndex(x => x.id === editingId);
    if (idx !== -1) allRows[idx] = { ...allRows[idx], ...updates };
    _editingRecord = { ..._editingRecord, ...updates };

    document.getElementById('ccaEditTitle').textContent = toTitleCase(c.clientName || '');
    render();
    btn.textContent = 'Synced ✓';
    setTimeout(() => { btn.textContent = 'Re-sync from client'; btn.disabled = false; }, 1500);
  } catch (err) {
    alert('Re-sync failed: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Re-sync from client';
  }
}

// ── Client selector ───────────────────────────────────────────────────────────

async function openClientSelector() {
  document.getElementById('clientSelectorSearch').value = '';
  document.getElementById('clientSelectorList').innerHTML =
    '<div style="padding:1.5rem;text-align:center;color:var(--text-muted);">Loading…</div>';
  document.getElementById('clientSelectorModal').classList.remove('hidden');

  if (!_allClients.length) {
    const snap = await getDocs(collection(db, 'clients'));
    _allClients = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  renderClientSelector();
}

function closeClientSelector() {
  document.getElementById('clientSelectorModal').classList.add('hidden');
}

function renderClientSelector() {
  const search    = document.getElementById('clientSelectorSearch').value.toLowerCase();
  const listedIds = new Set(allRows.map(r => r.clientId).filter(Boolean));

  const eligible = _allClients.filter(c =>
    c.counselingType === 'PRE' &&
    (c.status || 'active') === 'active' &&
    !listedIds.has(c.id) &&
    (!search ||
      (c.clientName || '').toLowerCase().includes(search) ||
      (c.counselor  || '').toLowerCase().includes(search))
  ).sort((a, b) => (a.clientName || '').localeCompare(b.clientName || ''));

  const list = document.getElementById('clientSelectorList');
  if (!eligible.length) {
    list.innerHTML = '<div style="padding:1.5rem;text-align:center;color:var(--text-muted);">No eligible PRE clients found.</div>';
    return;
  }

  list.innerHTML = eligible.map(c => `
    <div class="client-selector-item" data-client-id="${c.id}">
      <div>
        <div class="cs-name">${esc(toTitleCase(c.clientName))}</div>
        <div class="cs-meta">${esc(c.counselor || '')} · ${esc(amiCategory(c.amiPercent) || '')} · PRE</div>
      </div>
      <span style="font-size:0.75rem;color:var(--primary);font-weight:600;">Add →</span>
    </div>`).join('');

  list.querySelectorAll('.client-selector-item').forEach(item => {
    item.addEventListener('click', () => addClientToList(item.dataset.clientId));
  });
}

async function addClientToList(clientId) {
  const client = _allClients.find(c => c.id === clientId);
  if (!client) return;

  try {
    const newDoc = await addDoc(collection(db, 'ccaList'), {
      clientId,
      clientName:      client.clientName      || '',
      counselor:       client.counselor       || '',
      amiPercent:      client.amiPercent      || '',
      driveFolderId:   client.driveFolderId   || '',
      driveFolderName: client.driveFolderName || '',
      driveFolderUrl:  client.driveFolderUrl  || '',
      priceRangeMin:   0,
      priceRangeMax:   0,
      bedrooms:        '',
      areasOfInterest: [],
      closingDate:     null,
      ccaAmount:       0,
      notes:           '',
      enrolledAt:      serverTimestamp(),
      updatedAt:       serverTimestamp(),
    });

    allRows.push({
      id: newDoc.id, clientId,
      clientName: client.clientName, counselor: client.counselor,
      amiPercent: client.amiPercent, areasOfInterest: [],
      enrolledAt: new Date(),
    });
    closeClientSelector();
    render();
  } catch (err) {
    alert('Failed to add client: ' + err.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function closingMs(r) {
  if (!r.closingDate) return null;
  const d = r.closingDate.toDate ? r.closingDate.toDate() : new Date(r.closingDate);
  return d.getTime();
}

function isUrgent(closingDate) {
  if (!closingDate) return false;
  const d = closingDate.toDate ? closingDate.toDate() : new Date(closingDate);
  const days = (d - Date.now()) / (1000 * 60 * 60 * 24);
  return days >= 0 && days <= 14;
}

function toDateInput(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const dd   = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function esc(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function toTitleCase(str) {
  if (!str) return str;
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

// ── Print DPA Application ─────────────────────────────────────────────────────

async function printDpaApplication() {
  if (!editingId) return;
  const r = _editingRecord || {};

  // Pull extra fields from linked client profile
  let client = {};
  if (r.clientId) {
    try {
      const snap = await getDoc(doc(db, 'clients', r.clientId));
      if (snap.exists()) client = snap.data();
    } catch (_) {}
  }

  const name    = toTitleCase(r.clientName || '');
  const addr    = esc(client.streetAddress || '');
  const city    = esc(client.city          || '');
  const zip     = esc(client.zipCode       || '');
  const phone   = esc(client.homePhone || client.cellPhone || client.workPhone || '');
  const email   = esc(client.email         || '');

  const wsDate  = r.dpaWorkshopAttended && r.dpaWorkshopDate
    ? new Date(r.dpaWorkshopDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' })
    : '';

  const loanType  = r.dpaLoanType || '';
  const loanTypes = ['Conventional','FHA','VA','USDA','Other'];
  const loanBoxes = loanTypes.map(t =>
    `<span style="margin-right:1.2rem;">[${t === loanType ? 'X' : '&nbsp;'}] ${t}</span>`
  ).join('');

  const purchasePrice = r.closureOutcomeValue ? '$' + Number(r.closureOutcomeValue).toLocaleString('en-US') : '';
  const loanAmt       = r.loanAmount          ? '$' + Number(r.loanAmount).toLocaleString('en-US')          : '';
  const lender        = esc(r.lenderName      || '');

  const blank = (w = 180) => `<span style="display:inline-block;border-bottom:1px solid #000;min-width:${w}px;">&nbsp;</span>`;

  const sigImg = (dataUrl, w = 180) => dataUrl
    ? `<img src="${dataUrl}" style="max-width:${w}px;max-height:50px;vertical-align:bottom;border-bottom:1px solid #000;">`
    : blank(w);
  const sigDate = isoDate => isoDate
    ? new Date(isoDate).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' })
    : '';

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<title>DPA Application — ${name}</title>
<style>
  @page { margin: 0.75in; size: letter portrait; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 10pt; color: #000; margin: 0; }
  h2 { font-size: 10.5pt; font-weight: bold; margin: 1rem 0 0.3rem; }
  p { margin: 0.35rem 0; line-height: 1.5; }
  .page-break { page-break-after: always; height: 0; }
  table.hh { border-collapse: collapse; width: 100%; margin: 0.5rem 0; }
  table.hh th, table.hh td { border: 1px solid #000; padding: 0.3rem 0.5rem; }
  table.hh th { background: #f0f0f0; font-weight: bold; text-align: left; }
  .sig-block { margin-top: 2rem; }
  .req-para { margin: 0.6rem 0; }
  .req-para strong { font-weight: bold; }
  ul { margin: 0.4rem 0 0.4rem 1.5rem; }
  ul li { margin: 0.2rem 0; }
</style>
</head><body>

<!-- ══ Page 1: Applicant Information ══ -->
<div style="text-align:center;margin-bottom:0.75rem;border-bottom:2px solid #000;padding-bottom:0.5rem;">
  <div style="font-size:20pt;font-weight:900;letter-spacing:0.02em;line-height:1.1;">HOUSING</div>
  <div style="font-size:12pt;letter-spacing:0.08em;">OPPORTUNITIES INC.</div>
</div>
<p style="text-align:center;font-weight:bold;text-decoration:underline;font-size:11pt;margin-bottom:1rem;">
  Home Ownership Initiative Down Payment Assistance Application Form
</p>

<h2>Applicant Information:</h2>
<p style="font-size:9pt;font-style:italic;">(All information provided will be kept confidential.)</p>

<p>Full Name: ${name ? `<strong>${name}</strong>` : blank(280)}</p>
<p>Date of Birth (MM/DD/YYYY): ${blank(130)} &nbsp;&nbsp;&nbsp; Social Security Number: ${blank(130)}</p>
<p>Current Address: ${addr ? `<strong>${addr}</strong>` : blank(300)}</p>
<p>City: ${city ? `<strong>${city}</strong>` : blank(130)} &nbsp; State: ${blank(50)} &nbsp; Zip Code: ${zip ? `<strong>${zip}</strong>` : blank(80)}</p>
<p>Phone Number: ${phone ? `<strong>${phone}</strong>` : blank(140)} &nbsp;&nbsp;&nbsp; Email Address: ${email ? `<strong>${email}</strong>` : blank(160)}</p>
<p>Marital Status: &nbsp; [ ] Single &nbsp; [ ] Married &nbsp; [ ] Divorced &nbsp; [ ] Widowed</p>
<p>Number of Dependents (including yourself): ${blank(70)}</p>

<h2>Household Information:</h2>
<p style="font-size:9pt;font-style:italic;">(Please list all individuals who will be living in the home, including yourself.)</p>
<table class="hh">
  <thead><tr><th style="width:42%;">Name</th><th style="width:36%;">Relationship</th><th style="width:22%;">Age</th></tr></thead>
  <tbody>
    ${Array(5).fill('<tr><td style="height:1.4em;">&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>').join('')}
  </tbody>
</table>
<p style="font-size:9pt;font-style:italic;">(Attach an additional sheet if necessary.)</p>
<p>Total Annual Household Income: $${blank(150)}</p>

<div class="page-break"></div>

<!-- ══ Page 2: Program Requirements ══ -->
<h2>Program Requirements</h2>

<p class="req-para"><strong>Mandatory Counseling and Workshop Attendance:</strong> Client agrees to attend mandatory counseling sessions and workshops as outlined by HOI, understanding these are essential for program eligibility.</p>
<p>Date of Workshop Attended: ${wsDate ? `<strong>${wsDate}</strong>` : blank(180)}</p>

<p class="req-para"><strong>Application and Documentation:</strong> Client will complete all necessary applications and provide required documentation to support their eligibility for the Home Ownership Initiative.</p>

<p class="req-para"><strong>Asset Test Compliance:</strong> Client will comply with the asset test, ensuring liquid assets do not exceed the specified limit post-closing.</p>

<p class="req-para"><strong>Mandatory Home Inspections:</strong> Client agrees to arrange and complete mandatory home inspections within the stipulated time constraints.</p>

<p class="req-para"><strong>Understanding of Financial Assistance:</strong> Client acknowledges that financial assistance through the Home Ownership Initiative includes grants that are subject to specific criteria.</p>

<p class="req-para"><strong>No Guarantee of Funds:</strong> Client understands that applying for and meeting the eligibility criteria does not guarantee the receipt of funds. Availability of funds can fluctuate based on a number of factors including, but not limited to, funding cycles.</p>

<p class="req-para"><strong>Closing Process Compliance:</strong> Client agrees to comply with the closing process requirements, including signing necessary documents.</p>

<h2>Acknowledgment:</h2>
<p>This serves as an acknowledgment by the Client of all the requirements and conditions of the Home Ownership Initiative. Client's participation is contingent upon meeting these requirements and conditions. HOI reserves the right to make final decisions regarding grant allocation and program eligibility.</p>

<div class="sig-block">
  <p>Client Signature: ${sigImg(_clientSig, 220)} &nbsp;&nbsp; Date: ${sigDate(_clientSigDate) || blank(100)}</p>
  <br>
  <p>HOI Representative Signature: ${sigImg(_repSig, 200)} &nbsp;&nbsp; Date: ${sigDate(_repSigDate) || blank(100)}</p>
</div>

<div class="page-break"></div>

<!-- ══ Page 3: Home Purchase Information ══ -->
<h2>Home Purchase Information:</h2>

<p>Property Address: ${blank(340)}</p>
<p>City: ${blank(130)} &nbsp; State: ${blank(50)} &nbsp; Zip Code: ${blank(80)}</p>
<p>Purchase Price: ${purchasePrice ? `<strong>${purchasePrice}</strong>` : blank(130)} &nbsp;&nbsp;&nbsp; Loan Amount: ${loanAmt ? `<strong>${loanAmt}</strong>` : blank(130)}</p>
<p>Loan Type: ${loanBoxes}</p>
<p>Mortgage Lender: ${lender ? `<strong>${lender}</strong>` : blank(280)}</p>

<h2>Required Documentation:</h2>
<p>Please attach the following documents to your application:</p>
<ul>
  <li>Proof of income for all household members</li>
  <li>Mortgage pre-approval letter from a qualified lender</li>
  <li>Copy of signed Purchase and Sales Agreement</li>
  <li>Certificate of completion for a homeownership education course</li>
</ul>

<p style="margin-top:1rem;">By signing below, I, ${blank(220)} affirm that all information provided in this application and attached documentation is true and accurate to the best of my knowledge. I understand that any false or misleading information may result in disqualification from the Home Ownership Initiative Down Payment Assistance Program.</p>

<p style="margin-top:0.75rem;">By signing below, I, ${blank(160)}, consent to be featured in marketing materials if chosen as a grant recipient, and authorize the use of my name, image, &amp; story.</p>

<div class="sig-block">
  <p>Applicant Signature: ${sigImg(_clientSig, 220)} &nbsp;&nbsp; Date: ${sigDate(_clientSigDate) || blank(100)}</p>
</div>

<script>window.addEventListener('load', () => window.print());<\/script>
</body></html>`;

  const win = window.open('', '_blank');
  if (!win) { alert('Please allow pop-ups to print.'); return; }
  win.document.write(html);
  win.document.close();
}
