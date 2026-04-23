/**
 * hig-waitlist.js — "Repair Ready" page
 *
 * Manages the higWaitlist Firestore collection: POST clients on the home
 * repair grant waitlist, ranked by a weighted priority score.
 *
 * Priority score formula (calcScore):
 *   score = (amiScore * amiWeight + budgetScore * budgetWeight +
 *            timeScore * timeWeight + waitScore * waitTimeWeight) / totalWeight
 *
 *   - Lower AMI  → higher amiScore   (Extremely Low scores highest)
 *   - Smaller budget / fewer days → higher budgetScore / timeScore
 *   - Longer time on waitlist → higher waitScore
 *
 *   Weights are stored in config/higWeights and editable in ED Settings.
 *   AMI tier also determines assistance type: ≤50% = forgivable grant,
 *   50–80% = forgivable loan, 80–120% = cost-sharing.
 *
 * Row click behavior:
 *   - Has clientId → navigate to client.html?id={clientId} (full profile)
 *   - "Edit Entry" button → open modal for waitlist-specific fields
 *     (scope of work, budget, days, status, Drive documents)
 *
 * "+ Add Client" filters to active POST clients not already on the list.
 */

import { db } from './firebase-config.js';
import { requireAuth, setupNav } from './auth.js';
import { openDrivePicker, openDriveFolderPicker } from './picker.js';
import {
  collection, getDocs, doc, getDoc, addDoc, updateDoc, orderBy, query, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ── AMI helpers ───────────────────────────────────────────────────────────────

const AMI_NUMERIC = {
  'Extremely Low': 30,
  'Low':           50,
  'Moderate':      80,
  'Non Low-Moderate': 120,
};

function amiNumeric(label) {
  return AMI_NUMERIC[label] ?? 120;
}

function amiTier(label) {
  const n = amiNumeric(label);
  if (n <= 50)  return 'grant';
  if (n <= 80)  return 'loan';
  return 'sharing';
}

function assistanceLabel(label) {
  const tier = amiTier(label);
  if (tier === 'grant')   return '100% Forgivable Grant';
  if (tier === 'loan')    return '5-Year Forgivable Loan';
  return 'Cost-Sharing (up to 50%)';
}

// ── Score calculation ─────────────────────────────────────────────────────────

const BUDGET_MAX   = 200000;
const DAYS_MAX     = 730;
const WAIT_MAX_MS  = 730 * 24 * 60 * 60 * 1000; // 2 years

function calcScore(r, weights) {
  const amiVal  = amiNumeric(r.amiPercent);
  const amiScore     = Math.max(0, Math.min(100, (120 - amiVal) / 120 * 100));
  const budgetScore  = Math.max(0, Math.min(100, (BUDGET_MAX - (r.estimatedBudget || 0)) / BUDGET_MAX * 100));
  const timeScore    = Math.max(0, Math.min(100, (DAYS_MAX   - (r.estimatedDays   || 0)) / DAYS_MAX   * 100));
  const enrolledMs   = r.enrolledAt?.toDate ? r.enrolledAt.toDate().getTime() : (r.enrolledAt || 0);
  const waitScore    = Math.min(100, (Date.now() - enrolledMs) / WAIT_MAX_MS * 100);

  const total = weights.amiWeight + weights.budgetWeight + weights.timeWeight + weights.waitTimeWeight;
  if (total === 0) return 0;
  return (
    (amiScore    * weights.amiWeight +
     budgetScore * weights.budgetWeight +
     timeScore   * weights.timeWeight +
     waitScore   * weights.waitTimeWeight) / total
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

const STATUS_LABELS = {
  needs_scope:  'Needs Scope',
  er_review:    'ER Review',
  repair_ready: 'Repair Ready',
  complete:     'Complete',
};

const STATUS_COLORS = {
  needs_scope:  'badge-yellow',
  er_review:    'badge-blue',
  repair_ready: 'badge-green',
  complete:     'badge-gray',
};

let allRows        = [];
let _allClients    = [];   // cached for client selector + link search
let weights        = { amiWeight: 50, budgetWeight: 15, timeWeight: 15, waitTimeWeight: 20 };
let editingId      = null;
let _editingRecord = null; // full higWaitlist record currently open in the edit modal
let _editFile      = null;
let _editFolder    = null;

requireAuth(async (user, profile) => {
  setupNav(profile, 'hig-waitlist');

  // Load weights from Firestore config
  const wSnap = await getDoc(doc(db, 'config', 'higWeights'));
  if (wSnap.exists()) weights = { ...weights, ...wSnap.data() };

  const snap = await getDocs(query(collection(db, 'higWaitlist'), orderBy('enrolledAt', 'asc')));
  allRows = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  render();

  document.getElementById('filterStatus').addEventListener('change', render);
  document.getElementById('filterTier').addEventListener('input', render);
  document.getElementById('filterSearch').addEventListener('input', render);

  document.getElementById('higEditCancel').addEventListener('click', closeModal);
  document.getElementById('higEditSave').addEventListener('click', saveEdit);

  // Link search inside edit modal
  document.getElementById('higLinkSearch').addEventListener('input', renderHigLinkResults);
  document.getElementById('higResyncBtn').addEventListener('click', resyncHigFromClient);

  // Client selector
  document.getElementById('addClientBtn').addEventListener('click', openClientSelector);
  document.getElementById('clientSelectorClose').addEventListener('click', closeClientSelector);
  document.getElementById('clientSelectorSearch').addEventListener('input', renderClientSelector);

  // Drive link buttons
  document.getElementById('linkSowBtn').addEventListener('click', async () => {
    try {
      const file = await openDrivePicker();
      if (file) { _editFile = file; renderSowUI(); }
    } catch (err) { alert('Could not open Drive picker: ' + err.message); }
  });
  document.getElementById('unlinkSowBtn').addEventListener('click', () => {
    _editFile = null;
    renderSowUI();
  });
  document.getElementById('linkHigFolderBtn').addEventListener('click', async () => {
    try {
      const folder = await openDriveFolderPicker();
      if (folder) { _editFolder = folder; renderFolderUI(); }
    } catch (err) { alert('Could not open Drive picker: ' + err.message); }
  });
  document.getElementById('unlinkHigFolderBtn').addEventListener('click', () => {
    _editFolder = null;
    renderFolderUI();
  });
});

function render() {
  const statusFilter = document.getElementById('filterStatus').value;
  const tierFilter   = document.getElementById('filterTier').value;
  const search       = document.getElementById('filterSearch').value.toLowerCase();

  let filtered = allRows.filter(r => {
    if (statusFilter && r.status !== statusFilter) return false;
    if (tierFilter   && amiTier(r.amiPercent) !== tierFilter) return false;
    if (search       && !r.clientName?.toLowerCase().includes(search)) return false;
    return true;
  });

  // Score and rank
  filtered = filtered
    .map(r => ({ ...r, _score: calcScore(r, weights) }))
    .sort((a, b) => b._score - a._score);

  const tbody = document.getElementById('higBody');
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="11" class="text-muted" style="padding:2rem;text-align:center;">No entries found.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map((r, i) => {
    const enrolledMs = r.enrolledAt?.toDate ? r.enrolledAt.toDate().getTime() : 0;
    const daysWaiting = enrolledMs ? Math.floor((Date.now() - enrolledMs) / 86400000) : '—';
    const docLink = r.driveFileUrl
      ? `<a href="${r.driveFileUrl}" target="_blank" style="font-size:0.8rem;display:block;">📄 Doc</a>`
      : '';
    const folderLink = r.driveFolderUrl
      ? `<a href="${r.driveFolderUrl}" target="_blank" style="font-size:0.8rem;display:block;">📁 Folder</a>`
      : '';
    const docs = (docLink || folderLink) ? (docLink + folderLink) : '<span class="text-muted">—</span>';

    return `<tr class="clickable-row" data-id="${r.id}" data-client-id="${r.clientId || ''}">
      <td style="text-align:center;font-weight:600;color:var(--text-muted);">${i + 1}</td>
      <td style="font-weight:600;">${esc(toTitleCase(r.clientName))}</td>
      <td>${esc(r.amiPercent)}</td>
      <td style="font-size:0.8rem;">${assistanceLabel(r.amiPercent)}</td>
      <td>${r.estimatedBudget ? '$' + Number(r.estimatedBudget).toLocaleString() : '—'}</td>
      <td>${r.estimatedDays || '—'}</td>
      <td style="font-weight:600;">${r._score.toFixed(1)}</td>
      <td>${daysWaiting}</td>
      <td><span class="badge ${STATUS_COLORS[r.status] || ''}">${STATUS_LABELS[r.status] || r.status}</span></td>
      <td>${docs}</td>
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

function openEditModal(id) {
  const r = allRows.find(x => x.id === id);
  if (!r) return;
  editingId      = id;
  _editingRecord = r;

  document.getElementById('higEditTitle').textContent  = toTitleCase(r.clientName);
  document.getElementById('editHigScope').value        = r.scopeOfWork     || '';
  document.getElementById('editHigBudget').value       = r.estimatedBudget || '';
  document.getElementById('editHigDays').value         = r.estimatedDays   || '';
  document.getElementById('editHigStatus').value       = r.status          || 'waitlisted';
  document.getElementById('editHigNotes').value        = r.notes           || '';

  _editFile   = r.driveFileId   ? { id: r.driveFileId,   name: r.driveFileName   || '', url: r.driveFileUrl   || '' } : null;
  _editFolder = r.driveFolderId ? { id: r.driveFolderId, name: r.driveFolderName || '', url: r.driveFolderUrl || '' } : null;
  renderSowUI();
  renderFolderUI();

  document.getElementById('higEditError').classList.add('hidden');

  if (r.clientId) {
    const anchor = document.getElementById('higClientAnchor');
    anchor.href        = `client.html?id=${r.clientId}`;
    anchor.textContent = toTitleCase(r.clientName) || r.clientId;
    document.getElementById('higLinkedBar').classList.remove('hidden');
    document.getElementById('higLinkSection').classList.add('hidden');
  } else {
    document.getElementById('higLinkedBar').classList.add('hidden');
    document.getElementById('higLinkSection').classList.remove('hidden');
    document.getElementById('higLinkSearch').value = r.clientName || '';
    renderHigLinkResults();
  }

  document.getElementById('higEditModal').classList.remove('hidden');
}

function renderSowUI() {
  const link      = document.getElementById('editHigFileLink');
  const nameSpan  = document.getElementById('editHigFileName');
  const linkBtn   = document.getElementById('linkSowBtn');
  const unlinkBtn = document.getElementById('unlinkSowBtn');
  if (_editFile) {
    link.href = _editFile.url;
    link.classList.remove('hidden');
    nameSpan.textContent = _editFile.name;
    linkBtn.textContent  = 'Change Document';
    unlinkBtn.classList.remove('hidden');
  } else {
    link.classList.add('hidden');
    nameSpan.textContent = 'No document linked';
    linkBtn.textContent  = 'Link Document';
    unlinkBtn.classList.add('hidden');
  }
}

function renderFolderUI() {
  const link      = document.getElementById('editHigFolderLink');
  const nameSpan  = document.getElementById('editHigFolderName');
  const linkBtn   = document.getElementById('linkHigFolderBtn');
  const unlinkBtn = document.getElementById('unlinkHigFolderBtn');
  if (_editFolder) {
    link.href = _editFolder.url;
    link.classList.remove('hidden');
    nameSpan.textContent = _editFolder.name;
    linkBtn.textContent  = 'Change Folder';
    unlinkBtn.classList.remove('hidden');
  } else {
    link.classList.add('hidden');
    nameSpan.textContent = 'No folder linked';
    linkBtn.textContent  = 'Link Folder';
    unlinkBtn.classList.add('hidden');
  }
}

function closeModal() {
  editingId   = null;
  _editFile   = null;
  _editFolder = null;
  document.getElementById('higEditModal').classList.add('hidden');
}

async function saveEdit() {
  if (!editingId) return;
  const errorEl = document.getElementById('higEditError');
  const saveBtn = document.getElementById('higEditSave');
  errorEl.classList.add('hidden');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    const updates = {
      scopeOfWork:     document.getElementById('editHigScope').value.trim(),
      estimatedBudget: parseFloat(document.getElementById('editHigBudget').value) || 0,
      estimatedDays:   parseInt(document.getElementById('editHigDays').value, 10) || 0,
      status:          document.getElementById('editHigStatus').value,
      notes:           document.getElementById('editHigNotes').value.trim(),
      driveFileId:     _editFile?.id    || '',
      driveFileName:   _editFile?.name  || '',
      driveFileUrl:    _editFile?.url   || '',
      driveFolderId:   _editFolder?.id   || '',
      driveFolderName: _editFolder?.name || '',
      driveFolderUrl:  _editFolder?.url  || '',
      updatedAt:       serverTimestamp(),
    };
    await updateDoc(doc(db, 'higWaitlist', editingId), updates);

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

// ── Link search (inside edit modal for unlinked records) ─────────────────────

async function renderHigLinkResults() {
  const search    = document.getElementById('higLinkSearch').value.toLowerCase().trim();
  const resultsEl = document.getElementById('higLinkResults');

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
        <div class="cs-meta">${esc(c.counselor || '')} · ${esc(c.counselingType || '')} · ${esc(c.amiPercent || '')}</div>
      </div>
      <span style="font-size:0.75rem;color:var(--primary);font-weight:600;">Link →</span>
    </div>`).join('');

  resultsEl.querySelectorAll('.client-selector-item').forEach(item => {
    item.addEventListener('click', () => linkHigClientToEntry(item.dataset.clientId));
  });
}

async function linkHigClientToEntry(clientDocId) {
  if (!editingId) return;
  const errorEl = document.getElementById('higEditError');
  errorEl.classList.add('hidden');

  try {
    const clientSnap = await getDoc(doc(db, 'clients', clientDocId));
    if (!clientSnap.exists()) throw new Error('Client not found.');
    const c = clientSnap.data();

    const updates = {
      clientId:        clientDocId,
      clientName:      c.clientName      || _editingRecord.clientName || '',
      amiPercent:      c.amiPercent      || '',
      driveFolderId:   c.driveFolderId   || '',
      driveFolderName: c.driveFolderName || '',
      driveFolderUrl:  c.driveFolderUrl  || '',
      updatedAt:       serverTimestamp(),
    };

    await updateDoc(doc(db, 'higWaitlist', editingId), updates);

    const idx = allRows.findIndex(x => x.id === editingId);
    if (idx !== -1) allRows[idx] = { ...allRows[idx], ...updates };
    _editingRecord = { ..._editingRecord, ...updates };

    const anchor = document.getElementById('higClientAnchor');
    anchor.href        = `client.html?id=${clientDocId}`;
    anchor.textContent = toTitleCase(c.clientName || '') || clientDocId;
    document.getElementById('higLinkedBar').classList.remove('hidden');
    document.getElementById('higLinkSection').classList.add('hidden');
    document.getElementById('higEditTitle').textContent = toTitleCase(c.clientName || '');

    render();
  } catch (err) {
    errorEl.textContent = 'Link failed: ' + err.message;
    errorEl.classList.remove('hidden');
  }
}

async function resyncHigFromClient() {
  if (!editingId || !_editingRecord?.clientId) return;
  const btn = document.getElementById('higResyncBtn');
  btn.disabled = true;
  btn.textContent = 'Syncing…';

  try {
    const clientSnap = await getDoc(doc(db, 'clients', _editingRecord.clientId));
    if (!clientSnap.exists()) throw new Error('Client not found.');
    const c = clientSnap.data();

    const updates = {
      clientName:      c.clientName      || '',
      amiPercent:      c.amiPercent      || '',
      driveFolderId:   c.driveFolderId   || '',
      driveFolderName: c.driveFolderName || '',
      driveFolderUrl:  c.driveFolderUrl  || '',
      updatedAt:       serverTimestamp(),
    };

    await updateDoc(doc(db, 'higWaitlist', editingId), updates);

    const idx = allRows.findIndex(x => x.id === editingId);
    if (idx !== -1) allRows[idx] = { ...allRows[idx], ...updates };
    _editingRecord = { ..._editingRecord, ...updates };

    document.getElementById('higEditTitle').textContent = toTitleCase(c.clientName || '');
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

  // Load all clients once and cache
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

  // Eligible: POST clients not already on the list
  const eligible = _allClients.filter(c =>
    c.counselingType === 'POST' &&
    (c.status || 'active') === 'active' &&
    !listedIds.has(c.id) &&
    (!search ||
      (c.clientName || '').toLowerCase().includes(search) ||
      (c.counselor  || '').toLowerCase().includes(search))
  ).sort((a, b) => (a.clientName || '').localeCompare(b.clientName || ''));

  const list = document.getElementById('clientSelectorList');
  if (!eligible.length) {
    list.innerHTML = '<div style="padding:1.5rem;text-align:center;color:var(--text-muted);">No eligible POST clients found.</div>';
    return;
  }

  list.innerHTML = eligible.map(c => `
    <div class="client-selector-item" data-client-id="${c.id}">
      <div>
        <div class="cs-name">${esc(toTitleCase(c.clientName))}</div>
        <div class="cs-meta">${esc(c.counselor || '')} · ${esc(c.amiPercent || '')} · POST</div>
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
    const newDoc = await addDoc(collection(db, 'higWaitlist'), {
      clientId,
      clientName:      client.clientName      || '',
      amiPercent:      client.amiPercent       || '',
      driveFolderId:   client.driveFolderId    || '',
      driveFolderName: client.driveFolderName  || '',
      driveFolderUrl:  client.driveFolderUrl   || '',
      scopeOfWork:     '',
      estimatedBudget: 0,
      estimatedDays:   0,
      status:          'needs_scope',
      notes:           '',
      enrolledAt:      serverTimestamp(),
      updatedAt:       serverTimestamp(),
    });

    // Add to local list immediately
    allRows.push({ id: newDoc.id, clientId, clientName: client.clientName,
      amiPercent: client.amiPercent, status: 'needs_scope', enrolledAt: new Date() });
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
