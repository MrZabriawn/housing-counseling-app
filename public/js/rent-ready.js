import { db } from './firebase-config.js';
import { requireAuth, setupNav } from './auth.js?v=2';
import { amiCategory } from './data.js';
import {
  collection, getDocs, doc, getDoc, addDoc, updateDoc, deleteDoc, orderBy, query, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const STATUS_LABELS = { waitlisted: 'Waitlisted', placed: 'Placed', inactive: 'Inactive' };
const STATUS_COLORS = { waitlisted: 'badge-blue', placed: 'badge-green', inactive: 'badge-gray' };

let allRows        = [];
let _allClients    = [];
let editingId      = null;
let _editingRecord = null;
let _editingAreas  = [];

requireAuth(async (user, profile) => {
  setupNav(profile, 'rent-ready');

  const snap = await getDocs(query(collection(db, 'rentList'), orderBy('enrolledAt', 'asc')));
  allRows = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => {
    const tier = r.confidentialityTier || 'standard';
    if (tier === 'standard') return true;
    if (profile.role === 'executive_director') return true;
    return (r.careTeam || []).includes(user.uid);
  });

  render();

  document.getElementById('filterSearch').addEventListener('input', render);
  document.getElementById('filterStatus').addEventListener('change', render);
  document.getElementById('showInactive').addEventListener('change', render);
  document.getElementById('editRrStatus').addEventListener('change', toggleClosureSections);

  document.getElementById('rrEditCancel').addEventListener('click', closeModal);
  document.getElementById('rrEditSave').addEventListener('click', saveEdit);
  document.getElementById('rrRemoveBtn').addEventListener('click', removeFromList);

  document.getElementById('addClientBtn').addEventListener('click', openClientSelector);
  document.getElementById('clientSelectorClose').addEventListener('click', closeClientSelector);
  document.getElementById('clientSelectorSearch').addEventListener('input', renderClientSelector);

  document.getElementById('rrLinkSearch').addEventListener('input', renderLinkResults);
  document.getElementById('rrResyncBtn').addEventListener('click', resyncFromClient);

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
});

// ── Render table ──────────────────────────────────────────────────────────────

function render() {
  const search      = document.getElementById('filterSearch').value.toLowerCase().trim();
  const status      = document.getElementById('filterStatus').value;
  const showDone    = document.getElementById('showInactive').checked;

  const filtered = allRows.filter(r => {
    const isDone = r.status === 'placed' || r.status === 'inactive';
    if (status) {
      if (r.status !== status) return false;
    } else {
      if (isDone && !showDone) return false;
    }
    if (!search) return true;
    if ((r.clientName || '').toLowerCase().includes(search)) return true;
    if ((r.counselor  || '').toLowerCase().includes(search)) return true;
    if ((r.areasOfInterest || []).some(a => a.toLowerCase().includes(search))) return true;
    return false;
  });

  // Sort: soonest target move-in first, nulls at bottom
  filtered.sort((a, b) => {
    const da = moveInMs(a), db2 = moveInMs(b);
    if (!da && !db2) return 0;
    if (!da) return 1;
    if (!db2) return -1;
    return da - db2;
  });

  const tbody = document.getElementById('rrBody');
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-muted" style="padding:2rem;text-align:center;">No entries found.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(r => {
    const isDone  = r.status === 'placed' || r.status === 'inactive';
    const moveIn  = fmtDate(r.targetMoveInDate) || '<span class="text-muted">—</span>';
    const urgent  = isUrgent(r.targetMoveInDate) ? ' style="color:var(--danger);font-weight:600;"' : '';

    const rentRange = (r.rentRangeMin || r.rentRangeMax)
      ? [
          r.rentRangeMin ? '$' + Number(r.rentRangeMin).toLocaleString('en-US') : '',
          r.rentRangeMax ? '$' + Number(r.rentRangeMax).toLocaleString('en-US') : '',
        ].filter(Boolean).join(' – ') + '/mo.'
      : '<span class="text-muted">—</span>';

    const areas = (r.areasOfInterest || []).length
      ? r.areasOfInterest.map(a => `<span class="area-tag">${esc(a)}</span>`).join('')
      : '<span class="text-muted">—</span>';

    const statusLabel = STATUS_LABELS[r.status] || r.status || 'Waitlisted';
    const statusBadge = STATUS_COLORS[r.status] || 'badge-blue';

    return `<tr class="clickable-row" data-id="${r.id}" data-client-id="${r.clientId || ''}" style="${isDone ? 'opacity:0.55;' : ''}">
      <td style="font-weight:600;">${esc(toTitleCase(r.clientName))}</td>
      <td>${esc(r.counselor || '')}</td>
      <td><span class="badge ${statusBadge}">${statusLabel}</span></td>
      <td style="white-space:nowrap;">${rentRange}</td>
      <td style="max-width:14rem;">${areas}</td>
      <td>${r.bedrooms ? r.bedrooms + ' bd' : '<span class="text-muted">—</span>'}</td>
      <td${urgent}>${moveIn}</td>
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

function toggleClosureSections() {
  const status = document.getElementById('editRrStatus').value;
  document.getElementById('placedSection').classList.toggle('hidden',   status !== 'placed');
  document.getElementById('inactiveSection').classList.toggle('hidden', status !== 'inactive');
}

function openEditModal(id) {
  const r = allRows.find(x => x.id === id);
  if (!r) return;
  editingId      = id;
  _editingRecord = r;
  _editingAreas  = [...(r.areasOfInterest || [])];

  document.getElementById('rrEditTitle').textContent    = toTitleCase(r.clientName);
  document.getElementById('editRentMin').value          = r.rentRangeMin || '';
  document.getElementById('editRentMax').value          = r.rentRangeMax || '';
  document.getElementById('editBedrooms').value         = r.bedrooms || '';
  document.getElementById('editMoveInDate').value       = toDateInput(r.targetMoveInDate);
  document.getElementById('editRrStatus').value         = r.status || 'waitlisted';
  document.getElementById('editRrNotes').value          = r.notes || '';
  document.getElementById('areaChipInput').value        = '';
  document.getElementById('rrEditError').classList.add('hidden');

  // Placement fields
  document.getElementById('editPropertyAddress').value  = r.propertyAddress  || '';
  document.getElementById('editPlacedMoveInDate').value = toDateInput(r.placedMoveInDate);
  document.getElementById('editMonthlyRent').value      = r.monthlyRentAgreed || '';

  // Inactive fields
  document.getElementById('editInactiveReason').value   = r.inactiveReason || 'Could Not Secure';

  toggleClosureSections();
  renderEditingChips();

  if (r.clientId) {
    const anchor = document.getElementById('rrClientAnchor');
    anchor.href        = `client.html?id=${r.clientId}`;
    anchor.textContent = toTitleCase(r.clientName) || r.clientId;
    document.getElementById('rrLinkedBar').classList.remove('hidden');
    document.getElementById('rrLinkSection').classList.add('hidden');
  } else {
    document.getElementById('rrLinkedBar').classList.add('hidden');
    document.getElementById('rrLinkSection').classList.remove('hidden');
    document.getElementById('rrLinkSearch').value = r.clientName || '';
    renderLinkResults();
  }

  document.getElementById('rrEditModal').classList.remove('hidden');
}

function closeModal() {
  editingId = null;
  document.getElementById('rrEditModal').classList.add('hidden');
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
  const errorEl = document.getElementById('rrEditError');
  const saveBtn = document.getElementById('rrEditSave');
  errorEl.classList.add('hidden');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    const status     = document.getElementById('editRrStatus').value;
    const isPlaced   = status === 'placed';
    const isInactive = status === 'inactive';

    const closureFields = (() => {
      if (isPlaced) {
        const moveInVal = document.getElementById('editPlacedMoveInDate').value;
        return {
          propertyAddress:   document.getElementById('editPropertyAddress').value.trim(),
          placedMoveInDate:  moveInVal ? new Date(moveInVal + 'T12:00:00') : null,
          monthlyRentAgreed: parseFloat(document.getElementById('editMonthlyRent').value) || 0,
          inactiveReason:    '',
        };
      } else if (isInactive) {
        return {
          inactiveReason:    document.getElementById('editInactiveReason').value,
          propertyAddress:   '',
          placedMoveInDate:  null,
          monthlyRentAgreed: 0,
        };
      }
      return {};
    })();

    const moveInVal = document.getElementById('editMoveInDate').value;
    const updates = {
      rentRangeMin:    parseFloat(document.getElementById('editRentMin').value) || 0,
      rentRangeMax:    parseFloat(document.getElementById('editRentMax').value) || 0,
      bedrooms:        document.getElementById('editBedrooms').value || '',
      areasOfInterest: [..._editingAreas],
      targetMoveInDate: moveInVal ? new Date(moveInVal + 'T12:00:00') : null,
      status,
      notes:           document.getElementById('editRrNotes').value.trim(),
      updatedAt:       serverTimestamp(),
      ...closureFields,
    };

    await updateDoc(doc(db, 'rentList', editingId), updates);

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
  const r    = allRows.find(x => x.id === editingId);
  const name = toTitleCase(r?.clientName || 'this client');
  if (!confirm(`Remove ${name} from Rent Ready? This only removes them from the list — their client profile is not affected.`)) return;

  try {
    await deleteDoc(doc(db, 'rentList', editingId));
    allRows = allRows.filter(x => x.id !== editingId);
    closeModal();
    render();
  } catch (err) {
    document.getElementById('rrEditError').textContent = 'Remove failed: ' + err.message;
    document.getElementById('rrEditError').classList.remove('hidden');
  }
}

// ── Link search ───────────────────────────────────────────────────────────────

async function renderLinkResults() {
  const search    = document.getElementById('rrLinkSearch').value.toLowerCase().trim();
  const resultsEl = document.getElementById('rrLinkResults');

  if (!_allClients.length) {
    resultsEl.innerHTML = '<div style="padding:0.75rem;color:var(--text-muted);">Loading…</div>';
    try {
      const snap  = await getDocs(collection(db, 'clients'));
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
  const errorEl = document.getElementById('rrEditError');
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

    await updateDoc(doc(db, 'rentList', editingId), updates);

    const idx = allRows.findIndex(x => x.id === editingId);
    if (idx !== -1) allRows[idx] = { ...allRows[idx], ...updates };
    _editingRecord = { ..._editingRecord, ...updates };

    const anchor = document.getElementById('rrClientAnchor');
    anchor.href        = `client.html?id=${clientDocId}`;
    anchor.textContent = toTitleCase(c.clientName || '') || clientDocId;
    document.getElementById('rrLinkedBar').classList.remove('hidden');
    document.getElementById('rrLinkSection').classList.add('hidden');
    document.getElementById('rrEditTitle').textContent = toTitleCase(c.clientName || '');

    render();
  } catch (err) {
    errorEl.textContent = 'Link failed: ' + err.message;
    errorEl.classList.remove('hidden');
  }
}

async function resyncFromClient() {
  if (!editingId || !_editingRecord?.clientId) return;
  const btn = document.getElementById('rrResyncBtn');
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

    await updateDoc(doc(db, 'rentList', editingId), updates);

    const idx = allRows.findIndex(x => x.id === editingId);
    if (idx !== -1) allRows[idx] = { ...allRows[idx], ...updates };
    _editingRecord = { ..._editingRecord, ...updates };

    document.getElementById('rrEditTitle').textContent = toTitleCase(c.clientName || '');
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
    const snap  = await getDocs(collection(db, 'clients'));
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
    (c.status || 'active') === 'active' &&
    !listedIds.has(c.id) &&
    (!search ||
      (c.clientName || '').toLowerCase().includes(search) ||
      (c.counselor  || '').toLowerCase().includes(search))
  ).sort((a, b) => (a.clientName || '').localeCompare(b.clientName || ''));

  const list = document.getElementById('clientSelectorList');
  if (!eligible.length) {
    list.innerHTML = '<div style="padding:1.5rem;text-align:center;color:var(--text-muted);">No active clients found.</div>';
    return;
  }

  list.innerHTML = eligible.map(c => `
    <div class="client-selector-item" data-client-id="${c.id}">
      <div>
        <div class="cs-name">${esc(toTitleCase(c.clientName))}</div>
        <div class="cs-meta">${esc(c.counselor || '')} · ${esc(c.counselingType || '')} · ${esc(amiCategory(c.amiPercent) || '')}</div>
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
    const newDoc = await addDoc(collection(db, 'rentList'), {
      clientId,
      clientName:          client.clientName          || '',
      counselor:           client.counselor           || '',
      amiPercent:          client.amiPercent          || '',
      driveFolderId:       client.driveFolderId        || '',
      driveFolderName:     client.driveFolderName      || '',
      driveFolderUrl:      client.driveFolderUrl       || '',
      confidentialityTier: client.confidentialityTier  || 'standard',
      careTeam:            client.careTeam             || [],
      status:              'waitlisted',
      rentRangeMin:        0,
      rentRangeMax:        0,
      bedrooms:            '',
      areasOfInterest:     [],
      targetMoveInDate:    null,
      notes:               '',
      enrolledAt:          serverTimestamp(),
      updatedAt:           serverTimestamp(),
    });

    allRows.push({
      id: newDoc.id, clientId,
      clientName: client.clientName, counselor: client.counselor,
      amiPercent: client.amiPercent, areasOfInterest: [],
      status: 'waitlisted', enrolledAt: new Date(),
    });
    closeClientSelector();
    render();
  } catch (err) {
    alert('Failed to add client: ' + err.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function moveInMs(r) {
  if (!r.targetMoveInDate) return null;
  const d = r.targetMoveInDate.toDate ? r.targetMoveInDate.toDate() : new Date(r.targetMoveInDate);
  return d.getTime();
}

function isUrgent(ts) {
  if (!ts) return false;
  const d    = ts.toDate ? ts.toDate() : new Date(ts);
  const days = (d - Date.now()) / (1000 * 60 * 60 * 24);
  return days >= 0 && days <= 14;
}

function toDateInput(ts) {
  if (!ts) return '';
  const d  = ts.toDate ? ts.toDate() : new Date(ts);
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
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
