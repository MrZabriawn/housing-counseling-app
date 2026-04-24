/**
 * cca-list.js — "Buyer Ready" page
 *
 * Manages the ccaList Firestore collection: PRE clients enrolled in the
 * Closing Cost Assistance program.
 *
 * Row click behavior:
 *   - If the record has a clientId → navigate to client.html?id={clientId}
 *     for the full editable client profile.
 *   - "Edit Entry" button → open modal to edit CCA-specific fields only
 *     (status, closing date, amount, notes) without leaving the page.
 *
 * "+ Add Client" opens a selector modal filtered to active PRE clients
 * not already on the list. Adding a client creates a new ccaList doc with
 * clientId set, which enables the row navigation and cross-collection sync.
 *
 * Client name / counselor / AMI / Drive folder are kept in sync automatically
 * by syncClientToLists() in client.js whenever the client profile is saved.
 */

/**
 * cca-list.js — "Buyer Ready" page
 *
 * Manages the ccaList Firestore collection: PRE clients enrolled in the
 * Closing Cost Assistance program.
 *
 * Row click behavior:
 *   - If the record has a clientId → navigate to client.html?id={clientId}
 *     for the full editable client profile.
 *   - "Edit Entry" button → open modal to edit CCA-specific fields only
 *     (status, closing date, amount, notes) without leaving the page.
 *
 * "+ Add Client" opens a selector modal filtered to active PRE clients
 * not already on the list. Adding a client creates a new ccaList doc with
 * clientId set, which enables the row navigation and cross-collection sync.
 *
 * Client name / counselor / AMI / Drive folder are kept in sync automatically
 * by syncClientToLists() in client.js whenever the client profile is saved.
 */

import { db } from './firebase-config.js';
import { requireAuth, setupNav } from './auth.js';
import {
  collection, getDocs, doc, getDoc, addDoc, updateDoc, orderBy, query, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const STATUS_LABELS = {
  eligible: 'Eligible',
  applied:  'Applied',
  approved: 'Approved',
  funded:   'Funded',
  closed:   'Closed',
};

const STATUS_COLORS = {
  eligible: 'badge-blue',
  applied:  'badge-yellow',
  approved: 'badge-green',
  funded:   'badge-green',
  closed:   'badge-gray',
};

let allRows      = [];
let _allClients  = [];   // lazy-loaded full client list (for Add + Link searches)
let editingId    = null;
let _editingRecord = null; // full ccaList record currently open in the edit modal

requireAuth(async (user, profile) => {
  setupNav(profile, 'cca-list');

  const snap = await getDocs(query(collection(db, 'ccaList'), orderBy('enrolledAt', 'asc')));
  allRows = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => {
    const tier = r.confidentialityTier || 'standard';
    if (tier === 'standard') return true;
    if (profile.role === 'executive_director') return true;
    return (r.careTeam || []).includes(user.uid);
  });

  render();

  document.getElementById('filterStatus').addEventListener('change', render);
  document.getElementById('filterSearch').addEventListener('input', render);

  document.getElementById('ccaEditCancel').addEventListener('click', closeModal);
  document.getElementById('ccaEditSave').addEventListener('click', saveEdit);

  document.getElementById('addClientBtn').addEventListener('click', openClientSelector);
  document.getElementById('clientSelectorClose').addEventListener('click', closeClientSelector);
  document.getElementById('clientSelectorSearch').addEventListener('input', renderClientSelector);

  // Link search inside the edit modal
  document.getElementById('ccaLinkSearch').addEventListener('input', renderLinkResults);
  document.getElementById('ccaResyncBtn').addEventListener('click', resyncFromClient);
});

function render() {
  const status = document.getElementById('filterStatus').value;
  const search = document.getElementById('filterSearch').value.toLowerCase();

  const filtered = allRows.filter(r => {
    if (status && r.status !== status) return false;
    if (search && !r.clientName?.toLowerCase().includes(search) &&
                  !r.counselor?.toLowerCase().includes(search)) return false;
    return true;
  });

  // Sort: soonest closing date first, then nulls at bottom
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
    const closing = fmtDate(r.closingDate);
    const urgent  = isUrgent(r.closingDate) ? ' style="color:var(--danger);font-weight:600;"' : '';
    const folder  = r.driveFolderUrl
      ? `<a href="${r.driveFolderUrl}" target="_blank" style="font-size:0.8rem;">📁 ${r.driveFolderName || 'Folder'}</a>`
      : '<span class="text-muted">—</span>';

    return `<tr class="clickable-row" data-id="${r.id}" data-client-id="${r.clientId || ''}">
      <td style="font-weight:600;">${esc(toTitleCase(r.clientName))}</td>
      <td>${esc(r.counselor)}</td>
      <td>${esc(r.amiPercent)}</td>
      <td${urgent}>${closing || '—'}</td>
      <td>${r.ccaAmount ? '$' + Number(r.ccaAmount).toLocaleString('en-US', {minimumFractionDigits:2}) : '—'}</td>
      <td><span class="badge ${STATUS_COLORS[r.status] || ''}">${STATUS_LABELS[r.status] || r.status}</span></td>
      <td>${folder}</td>
      <td>${fmtDate(r.enrolledAt)}</td>
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

function openEditModal(id) {
  const r = allRows.find(x => x.id === id);
  if (!r) return;
  editingId     = id;
  _editingRecord = r;

  document.getElementById('ccaEditTitle').textContent = toTitleCase(r.clientName);
  document.getElementById('editClosingDate').value = toDateInput(r.closingDate);
  document.getElementById('editCcaAmount').value   = r.ccaAmount || '';
  document.getElementById('editCcaStatus').value   = r.status || 'eligible';
  document.getElementById('editCcaNotes').value    = r.notes  || '';
  document.getElementById('ccaEditError').classList.add('hidden');

  if (r.clientId) {
    // Record is linked — show the profile link and re-sync button
    const anchor = document.getElementById('ccaClientAnchor');
    anchor.href        = `client.html?id=${r.clientId}`;
    anchor.textContent = toTitleCase(r.clientName) || r.clientId;
    document.getElementById('ccaLinkedBar').classList.remove('hidden');
    document.getElementById('ccaLinkSection').classList.add('hidden');
  } else {
    // Record is not linked — show the link search, pre-filled with the stored name
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

async function saveEdit() {
  if (!editingId) return;
  const errorEl = document.getElementById('ccaEditError');
  const saveBtn = document.getElementById('ccaEditSave');
  errorEl.classList.add('hidden');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    const dateVal = document.getElementById('editClosingDate').value;
    const updates = {
      closingDate: dateVal ? new Date(dateVal) : null,
      ccaAmount:   parseFloat(document.getElementById('editCcaAmount').value) || 0,
      status:      document.getElementById('editCcaStatus').value,
      notes:       document.getElementById('editCcaNotes').value.trim(),
      updatedAt:   serverTimestamp(),
    };
    await updateDoc(doc(db, 'ccaList', editingId), updates);

    // Update local copy
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

function toDateInput(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toISOString().split('T')[0];
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Link search (inside edit modal for unlinked records) ─────────────────────

async function renderLinkResults() {
  const search     = document.getElementById('ccaLinkSearch').value.toLowerCase().trim();
  const resultsEl  = document.getElementById('ccaLinkResults');

  // Lazy-load clients on first search
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
    (c.clientName  || '').toLowerCase().includes(search) ||
    (c.counselor   || '').toLowerCase().includes(search) ||
    (c.rxNumbers   || []).some(rx => rx.toLowerCase().includes(search))
  ).slice(0, 20);

  if (!matches.length) {
    resultsEl.innerHTML = '<div style="padding:0.75rem;color:var(--text-muted);">No clients found.</div>';
    return;
  }

  resultsEl.innerHTML = matches.map(c => `
    <div class="client-selector-item" data-client-id="${c.id}">
      <div>
        <div class="cs-name">${esc(toTitleCase(c.clientName || ''))}</div>
        <div class="cs-meta">${esc(c.counselor || '')} · ${esc(c.counselingType || '')} · ${esc(c.amiPercent || '')}</div>
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
    // Load the real client doc to pull fresh canonical data
    const clientSnap = await getDoc(doc(db, 'clients', clientDocId));
    if (!clientSnap.exists()) { throw new Error('Client not found.'); }
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

    // Update local cache
    const idx = allRows.findIndex(x => x.id === editingId);
    if (idx !== -1) allRows[idx] = { ...allRows[idx], ...updates };
    _editingRecord = { ..._editingRecord, ...updates };

    // Flip the modal to show the linked state
    const anchor = document.getElementById('ccaClientAnchor');
    anchor.href        = `client.html?id=${clientDocId}`;
    anchor.textContent = toTitleCase(c.clientName || '') || clientDocId;
    document.getElementById('ccaLinkedBar').classList.remove('hidden');
    document.getElementById('ccaLinkSection').classList.add('hidden');
    document.getElementById('ccaEditTitle').textContent = toTitleCase(c.clientName || '');

    render(); // refresh table so the row shows updated counselor name
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
        <div class="cs-meta">${esc(c.counselor || '')} · ${esc(c.amiPercent || '')} · PRE</div>
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
      counselor:       client.counselor        || '',
      amiPercent:      client.amiPercent        || '',
      driveFolderId:   client.driveFolderId    || '',
      driveFolderName: client.driveFolderName  || '',
      driveFolderUrl:  client.driveFolderUrl   || '',
      closingDate:     null,
      ccaAmount:       0,
      status:          'eligible',
      notes:           '',
      enrolledAt:      serverTimestamp(),
      updatedAt:       serverTimestamp(),
    });

    allRows.push({ id: newDoc.id, clientId, clientName: client.clientName,
      counselor: client.counselor, amiPercent: client.amiPercent,
      status: 'eligible', enrolledAt: new Date() });
    closeClientSelector();
    render();
  } catch (err) {
    alert('Failed to add client: ' + err.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function toTitleCase(str) {
  if (!str) return str;
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}
