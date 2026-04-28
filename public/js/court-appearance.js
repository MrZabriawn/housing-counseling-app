/**
 * court-appearance.js — Batch foreclosure court session logger
 *
 * Workflow:
 *   Step 1: Counselor fills in court details (county, date, hours, counselor).
 *   Step 2: Search active clients by name / counselor / Rx; click to add each
 *           person who appeared in court. Per-client Rx and notes are editable.
 *   Step 3: Click "Log Court Appearances" — the tool writes one session doc to
 *           clients/{id}/sessions for EVERY selected client simultaneously, then
 *           refreshes denormalized fields (sessionCount, lastSessionDate, etc.)
 *           on each client doc sequentially.
 *
 * Sessions are tagged with caseStatus = "Court — {County}" and store clientName
 * so the Reports page can query them with collectionGroup('sessions') without
 * having to load every client doc separately.
 */

import { db } from './firebase-config.js';
import { requireAuth, setupNav } from './auth.js';
import {
  collection, getDocs, doc, addDoc, updateDoc,
  query, orderBy, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

let _allClients  = [];   // full active client list, loaded once on page load
let _selected    = [];   // clients who appeared: [{ id, clientName, counselor, rxNumbers }]

requireAuth(async (user, profile) => {
  setupNav(profile, 'clients');

  await Promise.all([
    loadCounselors(),
    loadAllClients(),
  ]);

  wireUI();
});

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadCounselors() {
  try {
    const snap = await getDocs(query(collection(db, 'counselors'), orderBy('name')));
    const sel  = document.getElementById('courtCounselor');
    snap.docs
      .filter(d => d.data().active !== false)
      .forEach(d => {
        const o = document.createElement('option');
        o.value = d.data().name;
        o.textContent = d.data().name;
        sel.appendChild(o);
      });
  } catch (_) {}
}

async function loadAllClients() {
  const snap = await getDocs(
    query(collection(db, 'clients'), orderBy('clientName'))
  );
  _allClients = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(c => (c.status || 'active') === 'active');
}

// ── UI wiring ─────────────────────────────────────────────────────────────────

function wireUI() {
  document.getElementById('clientSearch').addEventListener('input', renderSearch);
  document.getElementById('submitBtn').addEventListener('click', submitBatch);
  document.getElementById('logAnotherBtn').addEventListener('click', resetForm);
}

// ── Search ────────────────────────────────────────────────────────────────────

function renderSearch() {
  const raw    = document.getElementById('clientSearch').value;
  const search = raw.toLowerCase().trim();
  const resultsEl = document.getElementById('clientResults');

  if (!search) {
    resultsEl.innerHTML = '<div class="empty-state">Start typing to find clients.</div>';
    return;
  }

  const selectedIds = new Set(_selected.map(c => c.id));

  const matches = _allClients.filter(c =>
    (c.clientName  || '').toLowerCase().includes(search) ||
    (c.counselor   || '').toLowerCase().includes(search) ||
    (c.rxNumbers   || []).some(rx => rx.toLowerCase().includes(search))
  ).slice(0, 40);

  if (!matches.length) {
    resultsEl.innerHTML = '<div class="empty-state">No clients found.</div>';
    return;
  }

  resultsEl.innerHTML = matches.map(c => {
    const already = selectedIds.has(c.id);
    const rxStr   = (c.rxNumbers || []).join(', ');
    return `
      <div class="client-result-item${already ? ' already-added' : ''}" data-client-id="${c.id}">
        <div>
          <div class="cri-name">${esc(toTitleCase(c.clientName))}</div>
          <div class="cri-meta">${esc(c.counselor || '')}${rxStr ? ' · Rx: ' + esc(rxStr) : ''}</div>
        </div>
        <span style="font-size:0.75rem;color:var(--primary);font-weight:600;">
          ${already ? 'Added' : 'Add →'}
        </span>
      </div>`;
  }).join('');

  resultsEl.querySelectorAll('.client-result-item:not(.already-added)').forEach(item => {
    item.addEventListener('click', () => addClient(item.dataset.clientId));
  });
}

// ── Selected clients ──────────────────────────────────────────────────────────

function addClient(clientId) {
  if (_selected.find(c => c.id === clientId)) return;
  const client = _allClients.find(c => c.id === clientId);
  if (!client) return;

  _selected.push({
    id:         client.id,
    clientName: client.clientName || '',
    counselor:  client.counselor  || '',
    rxNumbers:  client.rxNumbers  || [],
  });

  renderSelected();
  renderSearch(); // refresh to mark as added
}

function removeClient(clientId) {
  _selected = _selected.filter(c => c.id !== clientId);
  renderSelected();
  renderSearch();
}

function renderSelected() {
  const listEl        = document.getElementById('selectedList');
  const submitSection = document.getElementById('submitSection');
  const countEl       = document.getElementById('selectedCount');

  countEl.textContent = _selected.length;

  if (!_selected.length) {
    listEl.innerHTML = '<div class="empty-state">No clients added yet. Search and click a client to add them.</div>';
    submitSection.classList.add('hidden');
    return;
  }

  submitSection.classList.remove('hidden');

  listEl.innerHTML = _selected.map(c => {
    const rxDefault = (c.rxNumbers || [])[0] || '';
    return `
      <div class="selected-client-card" data-client-id="${c.id}">
        <div class="sc-header">
          <div>
            <div class="sc-name">${esc(toTitleCase(c.clientName))}</div>
            <div class="sc-meta">${esc(c.counselor)}</div>
          </div>
          <button class="remove-btn" data-remove-id="${c.id}" title="Remove">×</button>
        </div>
        <div class="form-group" style="margin-bottom:0.4rem;">
          <label style="font-size:0.75rem;">Rx Number</label>
          <input type="text" class="sc-rx" value="${esc(rxDefault)}" placeholder="Rx number…" style="max-width:160px;">
        </div>
        <div class="form-group" style="margin-bottom:0;">
          <label style="font-size:0.75rem;">Session Notes (optional)</label>
          <textarea class="sc-notes" rows="2" placeholder="Brief update for this client…" style="font-size:0.8125rem;"></textarea>
        </div>
      </div>`;
  }).join('');

  listEl.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', () => removeClient(btn.dataset.removeId));
  });
}

// ── Submit ────────────────────────────────────────────────────────────────────

async function submitBatch() {
  const errorEl  = document.getElementById('submitError');
  const submitBtn = document.getElementById('submitBtn');
  errorEl.classList.add('hidden');

  const county    = document.getElementById('courtCounty').value;
  const dateVal   = document.getElementById('courtDate').value;
  const hours     = parseFloat(document.getElementById('courtHours').value) || 0;
  const counselor = document.getElementById('courtCounselor').value;

  if (!county)  { showError('Please select a county.'); return; }
  if (!dateVal) { showError('Please select a court date.'); return; }
  if (!_selected.length) { showError('No clients selected.'); return; }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving…';

  const sessionDate  = new Date(dateVal + 'T12:00:00');
  const caseStatus   = 'Court — ' + county;

  // Collect per-client notes and Rx from the rendered cards
  const cards = document.querySelectorAll('.selected-client-card');
  const perClient = {};
  cards.forEach(card => {
    const id    = card.dataset.clientId;
    const notes = card.querySelector('.sc-notes').value.trim();
    const rx    = card.querySelector('.sc-rx').value.trim();
    perClient[id] = { notes, rx };
  });

  try {
    // Write all sessions in parallel
    await Promise.all(_selected.map(c => {
      const extras = perClient[c.id] || {};
      return addDoc(collection(db, 'clients', c.id, 'sessions'), {
        date:       sessionDate,
        counselor:  counselor || c.counselor || '',
        rxNumber:   extras.rx || (c.rxNumbers[0] || ''),
        hours,
        dollarsFor: '',
        caseStatus,
        outcome:    '',
        notes:      extras.notes || '',
        clientName: c.clientName || '',   // stored for court report queries
        createdAt:  serverTimestamp(),
        updatedAt:  serverTimestamp(),
      });
    }));

    // Refresh denormalized fields for each client (sequential to avoid hammering Firestore)
    for (const c of _selected) {
      await refreshDenormalized(c.id);
    }

    // Show success banner
    const count = _selected.length;
    document.getElementById('successMsg').textContent =
      `Logged ${count} court appearance${count !== 1 ? 's' : ''} for ${county} on ${fmtDateStr(sessionDate)}.`;
    document.getElementById('successBanner').classList.remove('hidden');
    document.querySelector('.court-layout').classList.add('hidden');
    document.querySelectorAll('.card').forEach(card => {
      if (!card.closest('#successBanner')) card.classList.add('hidden');
    });
  } catch (err) {
    showError('Save failed: ' + err.message);
    submitBtn.disabled = false;
    submitBtn.textContent = 'Log Court Appearances';
  }
}

// Re-reads all sessions for a single client and updates the denormalized
// summary fields on the client doc. Called after batch-writing court sessions
// so that sessionCount and lastSessionDate stay accurate on the Counseling Log.
async function refreshDenormalized(clientId) {
  try {
    const snap = await getDocs(
      query(collection(db, 'clients', clientId, 'sessions'), orderBy('date', 'asc'))
    );
    const sessions = snap.docs.map(d => d.data());

    const sessionCount     = sessions.length;
    const totalOutcomeValue = sessions.reduce((s, r) => s + (Number(r.dollarsAwarded) || 0), 0);
    const dated            = sessions.filter(s => s.date);
    const firstSessionDate = dated.length ? dated[0].date : null;
    const lastSessionDate  = dated.length ? dated[dated.length - 1].date : null;

    await updateDoc(doc(db, 'clients', clientId), {
      sessionCount,
      totalOutcomeValue,
      firstSessionDate,
      lastSessionDate,
      updatedAt: serverTimestamp(),
    });
  } catch (_) {}
}

// ── Reset ─────────────────────────────────────────────────────────────────────

function resetForm() {
  _selected = [];

  document.getElementById('courtCounty').value   = '';
  document.getElementById('courtDate').value     = '';
  document.getElementById('courtHours').value    = '2';
  document.getElementById('courtCounselor').value = '';
  document.getElementById('clientSearch').value  = '';
  document.getElementById('clientResults').innerHTML =
    '<div class="empty-state">Start typing to find clients.</div>';
  document.getElementById('submitError').classList.add('hidden');

  renderSelected();

  document.getElementById('successBanner').classList.add('hidden');
  document.querySelector('.court-layout').classList.remove('hidden');
  document.querySelectorAll('.card').forEach(card => {
    card.classList.remove('hidden');
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function showError(msg) {
  const el = document.getElementById('submitError');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function fmtDateStr(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function esc(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function toTitleCase(str) {
  if (!str) return str;
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}
