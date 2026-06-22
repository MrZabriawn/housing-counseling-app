import { db } from './firebase-config.js';
import { requireAuth, setupNav } from './auth.js';
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
