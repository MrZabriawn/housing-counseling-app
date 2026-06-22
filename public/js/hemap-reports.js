import { db } from './firebase-config.js';
import { isAdmin } from './auth.js';
import {
  collection, getDocs, addDoc, updateDoc, deleteDoc, doc,
  query, orderBy, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const HEMAP_RATE          = 75;
const HEMAP_DEFAULT_HOURS = 5;
const MIN_PRINT_ROWS      = 15;

let _profile     = null;
let _allClients  = [];
let _submissions = [];
let _editingId   = null;

function esc(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function fmtDate(val) {
  if (!val) return '—';
  const d = typeof val === 'string'
    ? new Date(val + 'T12:00:00')
    : (val.toDate ? val.toDate() : new Date(val));
  return d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' });
}

function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });
}

// ── Init ──────────────────────────────────────────────────────────────────────

export async function initHemapLog(user, profile) {
  _profile = profile;

  try {
    const snap = await getDocs(collection(db, 'clients'));
    _allClients = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (_) {}

  // Load counselors dropdown
  try {
    const cSnap = await getDocs(query(collection(db, 'counselors'), orderBy('name')));
    const sel   = document.getElementById('hemapCounselor');
    cSnap.docs.filter(d => d.data().active !== false && d.data().isCounselor !== false).forEach(d => {
      const o = document.createElement('option');
      o.value = d.data().name; o.textContent = d.data().name;
      sel.appendChild(o);
    });
    if (profile.name) sel.value = profile.name;
  } catch (_) {}

  const genBtn = document.getElementById('hemapGenerateBtn');
  if (genBtn) {
    if (isAdmin(profile)) genBtn.classList.remove('hidden');
    genBtn.addEventListener('click', generateInvoice);
  }

  document.getElementById('hemapAddBtn').addEventListener('click', () => openHemapModal());
  document.getElementById('hemapModalCancel').addEventListener('click', closeHemapModal);
  document.getElementById('hemapModalSave').addEventListener('click', saveHemapEntry);
  document.getElementById('hemapModalDelete').addEventListener('click', deleteHemapEntry);
  document.getElementById('hemapHours').addEventListener('input', updateHemapTotal);

  document.getElementById('hemapModal').addEventListener('click', e => {
    if (e.target === document.getElementById('hemapModal')) closeHemapModal();
  });

  wireHemapClientSearch();
  await loadHemapSubmissions();
}

// ── Data ──────────────────────────────────────────────────────────────────────

async function loadHemapSubmissions() {
  try {
    const snap = await getDocs(query(collection(db, 'hemapSubmissions'), orderBy('createdAt', 'desc')));
    _submissions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderHemapPending();
    renderHemapBilled();
  } catch (err) {
    document.getElementById('hemapPendingBody').innerHTML =
      `<tr><td colspan="7" style="color:var(--danger,#c62828);padding:1rem;">Failed to load: ${esc(err.message)}</td></tr>`;
  }
}

// ── Pending table ─────────────────────────────────────────────────────────────

function renderHemapPending() {
  const tbody   = document.getElementById('hemapPendingBody');
  const pending = _submissions.filter(s => s.status !== 'billed');

  if (!pending.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:2rem;color:var(--text-muted);">No pending submissions.</td></tr>';
    document.getElementById('hemapPendingTotal').textContent = '$0.00';
    return;
  }

  const TD = 'style="padding:0.5rem 0.75rem;border-bottom:1px solid var(--border);"';
  tbody.innerHTML = pending.map(s => `
    <tr>
      <td ${TD}>${s.clientId
        ? `<a href="client.html?id=${esc(s.clientId)}" style="color:var(--primary);font-weight:600;">${esc(s.clientName)}</a>`
        : esc(s.clientName || '—')}</td>
      <td ${TD} style="font-size:0.8125rem;">${esc(s.propertyAddress || '—')}</td>
      <td ${TD} style="white-space:nowrap;">${fmtDate(s.dateSent)}</td>
      <td ${TD} style="text-align:center;">${s.hours ?? HEMAP_DEFAULT_HOURS}</td>
      <td ${TD} style="text-align:right;">${fmtMoney(s.total)}</td>
      <td ${TD} style="font-size:0.8125rem;">${esc(s.comments || '—')}</td>
      <td ${TD}><button class="btn btn-sm btn-secondary hemap-edit-btn" data-id="${esc(s.id)}">Edit</button></td>
    </tr>`).join('');

  tbody.querySelectorAll('.hemap-edit-btn').forEach(btn =>
    btn.addEventListener('click', () => openHemapModal(btn.dataset.id)));

  const total = pending.reduce((sum, s) => sum + (s.total || 0), 0);
  document.getElementById('hemapPendingTotal').textContent = fmtMoney(total);
}

// ── Billed section ────────────────────────────────────────────────────────────

function renderHemapBilled() {
  const billed    = _submissions.filter(s => s.status === 'billed');
  const container = document.getElementById('hemapBilledContent');

  if (!billed.length) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:0.875rem;padding:0.5rem 0;">No billed submissions yet.</p>';
    return;
  }

  const groups = {};
  billed.forEach(s => {
    const key = s.invoiceId || 'unknown';
    if (!groups[key]) groups[key] = { entries: [], invoicedAt: s.invoicedAt, monthEnding: s.monthEnding };
    groups[key].entries.push(s);
  });

  const TH = 'style="padding:0.4rem 0.6rem;text-align:left;border-bottom:2px solid var(--border);font-size:0.75rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);"';
  const TD = 'style="padding:0.4rem 0.6rem;border-bottom:1px solid var(--border);"';

  container.innerHTML = Object.entries(groups).map(([, group]) => {
    const total = group.entries.reduce((sum, s) => sum + (s.total || 0), 0);
    const ts    = group.invoicedAt;
    const dateStr = ts
      ? (ts.toDate ? ts.toDate() : new Date(ts)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : '—';
    return `
      <details style="margin-bottom:0.75rem;border:1px solid var(--border);border-radius:var(--radius);">
        <summary style="padding:0.65rem 1rem;cursor:pointer;font-size:0.875rem;font-weight:600;background:#f8f9fb;border-radius:var(--radius);list-style:none;display:flex;justify-content:space-between;align-items:center;">
          <span>Invoice generated ${esc(dateStr)} &nbsp;·&nbsp; ${esc(group.monthEnding || '')}</span>
          <span style="font-weight:400;color:var(--text-muted);">${group.entries.length} submission${group.entries.length !== 1 ? 's' : ''} &nbsp;·&nbsp; ${fmtMoney(total)}</span>
        </summary>
        <div style="overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:0.8125rem;">
            <thead><tr style="background:#f8f9fb;">
              <th ${TH}>Client</th><th ${TH}>Address</th><th ${TH}>Date Sent</th>
              <th ${TH} style="text-align:center;">Hrs</th><th ${TH} style="text-align:right;">Total</th><th ${TH}>Comments</th>
            </tr></thead>
            <tbody>${group.entries.map(s => `
              <tr>
                <td ${TD}>${esc(s.clientName || '—')}</td>
                <td ${TD} style="font-size:0.8rem;">${esc(s.propertyAddress || '—')}</td>
                <td ${TD} style="white-space:nowrap;">${fmtDate(s.dateSent)}</td>
                <td ${TD} style="text-align:center;">${s.hours ?? 5}</td>
                <td ${TD} style="text-align:right;">${fmtMoney(s.total)}</td>
                <td ${TD}>${esc(s.comments || '—')}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </details>`;
  }).join('');
}

// ── Modal ─────────────────────────────────────────────────────────────────────

function openHemapModal(id = null) {
  _editingId = id;
  document.getElementById('hemapModalError').classList.add('hidden');
  document.getElementById('hemapModalDelete').classList.toggle('hidden', !id);
  document.getElementById('hemapModalTitle').textContent = id ? 'Edit HEMAP Entry' : 'Add HEMAP Entry';

  if (id) {
    const s = _submissions.find(e => e.id === id);
    if (!s) return;
    if (s.clientId) {
      setHemapClientChip(s.clientId, s.clientName);
    } else {
      clearHemapClientChip();
    }
    document.getElementById('hemapClientName').value = s.clientName      || '';
    document.getElementById('hemapAddress').value    = s.propertyAddress || '';
    document.getElementById('hemapDateSent').value   = s.dateSent        || '';
    document.getElementById('hemapHours').value      = s.hours           ?? HEMAP_DEFAULT_HOURS;
    document.getElementById('hemapComments').value   = s.comments        || '';
    document.getElementById('hemapCounselor').value  = s.counselor       || '';
  } else {
    clearHemapClientChip();
    ['hemapClientName','hemapAddress','hemapDateSent','hemapComments'].forEach(id => {
      document.getElementById(id).value = '';
    });
    document.getElementById('hemapHours').value     = HEMAP_DEFAULT_HOURS;
    document.getElementById('hemapCounselor').value = _profile?.name || '';
  }

  updateHemapTotal();
  document.getElementById('hemapModal').classList.remove('hidden');
}

function closeHemapModal() {
  document.getElementById('hemapModal').classList.add('hidden');
  _editingId = null;
}

function updateHemapTotal() {
  const hours = parseFloat(document.getElementById('hemapHours').value) || 0;
  document.getElementById('hemapTotalDisplay').textContent = fmtMoney(hours * HEMAP_RATE);
}

// ── Client search ─────────────────────────────────────────────────────────────

function wireHemapClientSearch() {
  const searchEl = document.getElementById('hemapClientSearch');
  const dropEl   = document.getElementById('hemapClientDropdown');
  if (!searchEl) return;

  searchEl.addEventListener('input', () => {
    const q = searchEl.value.toLowerCase().trim();
    if (!q) { dropEl.style.display = 'none'; return; }
    const matches = _allClients.filter(c => (c.clientName || '').toLowerCase().includes(q)).slice(0, 8);
    if (!matches.length) { dropEl.style.display = 'none'; return; }
    dropEl.innerHTML = matches.map(c =>
      `<li data-id="${esc(c.id)}" style="padding:0.4rem 0.75rem;cursor:pointer;list-style:none;font-size:0.875rem;border-bottom:1px solid var(--border);">
        ${esc(c.clientName)} <span style="color:var(--text-muted);font-size:0.8rem;">${esc(c.counselor || '')}</span>
      </li>`).join('');
    dropEl.style.display = 'block';
    dropEl.querySelectorAll('li').forEach(li =>
      li.addEventListener('click', () => selectHemapClient(li.dataset.id)));
  });
}

function selectHemapClient(clientId) {
  const c = _allClients.find(x => x.id === clientId);
  if (!c) return;
  document.getElementById('hemapClientName').value = c.clientName || '';
  const addrParts = [
    c.streetAddress || c.address || c.street || '',
    c.city || c.county || '',
    c.zipCode || c.zip || '',
  ].filter(Boolean);
  if (addrParts.length) document.getElementById('hemapAddress').value = addrParts.join(', ');
  setHemapClientChip(clientId, c.clientName);
}

function setHemapClientChip(clientId, clientName) {
  document.getElementById('hemapClientId').value     = clientId;
  document.getElementById('hemapClientSearch').style.display = 'none';
  document.getElementById('hemapClientSearch').value = '';
  document.getElementById('hemapClientDropdown').style.display = 'none';
  document.getElementById('hemapClientChip').innerHTML = `
    <span style="display:inline-flex;align-items:center;gap:0.4rem;background:#e8f0fe;color:var(--primary);padding:0.25rem 0.6rem;border-radius:20px;font-size:0.8125rem;font-weight:600;margin-bottom:0.3rem;">
      ${esc(clientName)}
      <button type="button" id="hemapClientClear" style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:0.9rem;line-height:1;padding:0;">✕</button>
    </span>`;
  document.getElementById('hemapClientClear').addEventListener('click', clearHemapClientChip);
}

function clearHemapClientChip() {
  document.getElementById('hemapClientId').value             = '';
  document.getElementById('hemapClientChip').innerHTML       = '';
  document.getElementById('hemapClientSearch').style.display = '';
  document.getElementById('hemapClientSearch').value         = '';
  document.getElementById('hemapClientDropdown').style.display = 'none';
}

// ── Save / Delete ─────────────────────────────────────────────────────────────

async function saveHemapEntry() {
  const errEl   = document.getElementById('hemapModalError');
  const saveBtn = document.getElementById('hemapModalSave');
  errEl.classList.add('hidden');

  const clientName = document.getElementById('hemapClientName').value.trim();
  const address    = document.getElementById('hemapAddress').value.trim();
  const dateSent   = document.getElementById('hemapDateSent').value;
  const hours      = parseFloat(document.getElementById('hemapHours').value) || HEMAP_DEFAULT_HOURS;
  const comments   = document.getElementById('hemapComments').value.trim();
  const counselor  = document.getElementById('hemapCounselor').value.trim();
  const clientId   = document.getElementById('hemapClientId').value || null;

  if (!clientName) { errEl.textContent = 'Client name is required.'; errEl.classList.remove('hidden'); return; }
  if (!dateSent)   { errEl.textContent = 'Date sent is required.';   errEl.classList.remove('hidden'); return; }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  const data = {
    clientId, clientName, propertyAddress: address, dateSent,
    hours, total: hours * HEMAP_RATE, comments, counselor,
    status: 'pending', updatedAt: serverTimestamp(),
  };

  try {
    if (_editingId) {
      await updateDoc(doc(db, 'hemapSubmissions', _editingId), data);
    } else {
      await addDoc(collection(db, 'hemapSubmissions'), { ...data, createdAt: serverTimestamp() });
    }
    closeHemapModal();
    await loadHemapSubmissions();
  } catch (err) {
    errEl.textContent = 'Save failed: ' + err.message;
    errEl.classList.remove('hidden');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
  }
}

async function deleteHemapEntry() {
  if (!_editingId || !confirm('Delete this HEMAP entry? This cannot be undone.')) return;
  try {
    await deleteDoc(doc(db, 'hemapSubmissions', _editingId));
    closeHemapModal();
    await loadHemapSubmissions();
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
}

// ── Generate Invoice ──────────────────────────────────────────────────────────

async function generateInvoice() {
  const pending = _submissions.filter(s => s.status !== 'billed');
  if (!pending.length) { alert('No pending submissions to invoice.'); return; }
  if (!confirm(`Generate invoice for ${pending.length} submission${pending.length !== 1 ? 's' : ''}?\n\nThis will mark them as billed and cannot be undone.`)) return;

  const now      = new Date();
  const lastDay  = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const monthEnd = lastDay.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const total    = pending.reduce((sum, s) => sum + (s.total || 0), 0);

  // Populate print area
  const rows = [...pending];
  while (rows.length < MIN_PRINT_ROWS) rows.push(null);

  document.getElementById('hemapPrintMonth').textContent = monthEnd;
  document.getElementById('hemapPrintRows').innerHTML = rows.map(s => s
    ? `<tr>
        <td class="hp-td">${esc(s.clientName || '')}</td>
        <td class="hp-td">${esc(s.propertyAddress || '')}</td>
        <td class="hp-td" style="white-space:nowrap;">${s.dateSent ? new Date(s.dateSent + 'T12:00:00').toLocaleDateString('en-US') : ''}</td>
        <td class="hp-td" style="text-align:center;">${s.hours ?? 5}</td>
        <td class="hp-td" style="text-align:right;">${fmtMoney(s.total)}</td>
        <td class="hp-td">${esc(s.comments || '')}</td>
       </tr>`
    : `<tr><td class="hp-td">&nbsp;</td><td class="hp-td"></td><td class="hp-td"></td><td class="hp-td"></td><td class="hp-td"></td><td class="hp-td"></td></tr>`
  ).join('');
  document.getElementById('hemapPrintTotal').textContent = fmtMoney(total);

  // Print
  document.body.classList.add('printing-hemap');
  window.print();
  document.body.classList.remove('printing-hemap');

  // Mark as billed
  try {
    const invoiceId  = `HEMAP-${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}-${now.getTime()}`;
    const invoicedAt = serverTimestamp();

    await addDoc(collection(db, 'hemapInvoices'), {
      monthEnding: monthEnd, generatedAt: invoicedAt,
      generatedBy: _profile?.name || '', totalAmount: total, entryCount: pending.length,
    });

    await Promise.all(pending.map(s =>
      updateDoc(doc(db, 'hemapSubmissions', s.id), {
        status: 'billed', invoiceId, invoicedAt, monthEnding: monthEnd,
      })
    ));

    await loadHemapSubmissions();
  } catch (err) {
    alert('Invoice printed but failed to mark entries as billed: ' + err.message);
  }
}
