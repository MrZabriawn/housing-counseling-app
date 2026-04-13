import { db } from './firebase-config.js';
import { requireAuth, setupNav } from './auth.js';
import {
  collection, getDocs, doc, getDoc, updateDoc, orderBy, query, serverTimestamp
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
  waitlisted:   'Waitlisted',
  under_review: 'Under Review',
  approved:     'Approved',
  in_progress:  'In Progress',
  complete:     'Complete',
};

const STATUS_COLORS = {
  waitlisted:   'badge-blue',
  under_review: 'badge-yellow',
  approved:     'badge-green',
  in_progress:  'badge-yellow',
  complete:     'badge-gray',
};

let allRows = [];
let weights = { amiWeight: 50, budgetWeight: 15, timeWeight: 15, waitTimeWeight: 20 };
let editingId = null;

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
    tbody.innerHTML = '<tr><td colspan="10" class="text-muted" style="padding:2rem;text-align:center;">No entries found.</td></tr>';
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

    return `<tr class="clickable-row" data-id="${r.id}">
      <td style="text-align:center;font-weight:600;color:var(--text-muted);">${i + 1}</td>
      <td>${esc(toTitleCase(r.clientName))}</td>
      <td>${esc(r.amiPercent)}</td>
      <td style="font-size:0.8rem;">${assistanceLabel(r.amiPercent)}</td>
      <td>${r.estimatedBudget ? '$' + Number(r.estimatedBudget).toLocaleString() : '—'}</td>
      <td>${r.estimatedDays || '—'}</td>
      <td style="font-weight:600;">${r._score.toFixed(1)}</td>
      <td>${daysWaiting}</td>
      <td><span class="badge ${STATUS_COLORS[r.status] || ''}">${STATUS_LABELS[r.status] || r.status}</span></td>
      <td>${docs}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.clickable-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.tagName === 'A') return; // don't open modal when clicking links
      openEditModal(row.dataset.id);
    });
  });
}

function openEditModal(id) {
  const r = allRows.find(x => x.id === id);
  if (!r) return;
  editingId = id;

  document.getElementById('higEditTitle').textContent  = toTitleCase(r.clientName);
  document.getElementById('editHigScope').value        = r.scopeOfWork    || '';
  document.getElementById('editHigBudget').value       = r.estimatedBudget || '';
  document.getElementById('editHigDays').value         = r.estimatedDays   || '';
  document.getElementById('editHigStatus').value       = r.status          || 'waitlisted';
  document.getElementById('editHigNotes').value        = r.notes           || '';

  const fileLink = document.getElementById('editHigFileLink');
  const fileName = document.getElementById('editHigFileName');
  if (r.driveFileUrl) {
    fileLink.href = r.driveFileUrl;
    fileLink.classList.remove('hidden');
    fileName.textContent = r.driveFileName || '';
  } else {
    fileLink.classList.add('hidden');
    fileName.textContent = 'No document linked';
  }

  const folderLink = document.getElementById('editHigFolderLink');
  const folderName = document.getElementById('editHigFolderName');
  if (r.driveFolderUrl) {
    folderLink.href = r.driveFolderUrl;
    folderLink.classList.remove('hidden');
    folderName.textContent = r.driveFolderName || '';
  } else {
    folderLink.classList.add('hidden');
    folderName.textContent = 'No folder linked';
  }

  document.getElementById('higEditError').classList.add('hidden');
  document.getElementById('higEditModal').classList.remove('hidden');
}

function closeModal() {
  editingId = null;
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

function esc(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function toTitleCase(str) {
  if (!str) return str;
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}
