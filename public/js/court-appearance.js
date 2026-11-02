/**
 * court-appearance.js — Batch foreclosure court session logger / editor
 *
 * One court session per month per county is enforced. Selecting a county + date
 * that already has sessions for that month loads them into edit mode instead of
 * creating duplicates.
 *
 * _selected entries:
 *   { id, clientName, counselor, rxNumbers, sessionId, savedRx, savedNotes }
 *   sessionId = existing Firestore doc ID, or null for a newly added client.
 *
 * On submit:
 *   updateDoc  → clients with sessionId (existing)
 *   addDoc     → clients with sessionId == null (newly added)
 *   deleteDoc  → entries in _removedToDelete (removed from existing session)
 */

import { db } from './firebase-config.js';
import { requireAuth, setupNav } from './auth.js?v=2';
import {
  collection, collectionGroup, getDocs, doc, addDoc, updateDoc, deleteDoc,
  query, orderBy, where, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

let _allClients      = [];
let _selected        = [];   // { id, clientName, counselor, rxNumbers, sessionId, savedRx, savedNotes, savedCourtStatus }
let _removedToDelete = [];   // { clientId, sessionId } — deleted on submit
let _editMode        = false;

requireAuth(async (user, profile) => {
  setupNav(profile, 'clients');
  await Promise.all([loadCounselors(), loadAllClients()]);
  wireUI();
});

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadCounselors() {
  try {
    const snap = await getDocs(query(collection(db, 'counselors'), orderBy('name')));
    const sel  = document.getElementById('courtCounselor');
    snap.docs
      .filter(d => d.data().active !== false && d.data().isCounselor !== false)
      .forEach(d => {
        const o = document.createElement('option');
        o.value = d.data().name;
        o.textContent = d.data().name;
        sel.appendChild(o);
      });
  } catch (_) {}
}

async function loadAllClients() {
  const snap = await getDocs(query(collection(db, 'clients'), orderBy('clientName')));
  _allClients = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(c => (c.status || 'active') === 'active');
}

// ── UI wiring ─────────────────────────────────────────────────────────────────

function wireUI() {
  document.getElementById('clientSearch').addEventListener('input', renderSearch);
  document.getElementById('submitBtn').addEventListener('click', submitBatch);
  document.getElementById('logAnotherBtn').addEventListener('click', resetForm);
  document.getElementById('courtCounty').addEventListener('change', checkForExisting);
  document.getElementById('courtDate').addEventListener('change', checkForExisting);
  document.getElementById('resolveInferredBtn').addEventListener('click', resolveInferredStatuses);
  loadPendingStatuses();
}

// ── Existing session check (enforces one-per-month-per-county) ────────────────

async function checkForExisting() {
  const county  = document.getElementById('courtCounty').value;
  const dateVal = document.getElementById('courtDate').value;
  if (!county || !dateVal) return;

  const selectedDate = new Date(dateVal + 'T12:00:00');
  const monthKey     = selectedDate.toISOString().substring(0, 7); // "YYYY-MM"
  const caseStatus   = 'Court — ' + county;

  // Reset state whenever county/date changes
  _selected        = [];
  _removedToDelete = [];
  setEditMode(false);
  renderSelected();

  try {
    const snap = await getDocs(
      query(collectionGroup(db, 'sessions'), where('caseStatus', '==', caseStatus))
    );

    // Filter to sessions in the same calendar month as the chosen date
    const existing = snap.docs.filter(d => {
      const raw = d.data().date;
      const dt  = raw?.toDate ? raw.toDate() : new Date(raw);
      return dt.toISOString().substring(0, 7) === monthKey;
    });

    if (!existing.length) return; // nothing found — normal create mode

    // Found → switch to edit mode and populate _selected
    setEditMode(true);

    for (const d of existing) {
      const s        = d.data();
      const clientId = d.ref.parent.parent.id;
      if (_selected.find(c => c.id === clientId)) continue;

      const clientDoc = _allClients.find(c => c.id === clientId);
      _selected.push({
        id:               clientId,
        clientName:       s.clientName || clientDoc?.clientName || '',
        counselor:        s.counselor  || clientDoc?.counselor  || '',
        rxNumbers:        clientDoc?.rxNumbers || [],
        sessionId:        d.id,
        savedRx:          s.rxNumber    || '',
        savedNotes:       s.notes       || '',
        savedCourtStatus: s.courtStatus || '',
      });
    }

    // Pre-fill court-level fields from the first saved session
    const first = existing[0].data();
    const dt = first.date?.toDate ? first.date.toDate() : new Date(first.date);
    document.getElementById('courtDate').value = dt.toISOString().split('T')[0];
    if (first.counselor) document.getElementById('courtCounselor').value = first.counselor;
    if (first.hours != null) document.getElementById('courtHours').value = first.hours;

    renderSelected();
  } catch (err) {
    console.warn('Court existence check failed:', err.message);
  }
}

function setEditMode(on) {
  _editMode = on;
  document.getElementById('editModeBanner').style.display = on ? '' : 'none';
  const btn = document.getElementById('submitBtn');
  if (btn) btn.textContent = on ? 'Update Court Appearances' : 'Log Court Appearances';
}

// ── Search ────────────────────────────────────────────────────────────────────

function renderSearch() {
  const search    = document.getElementById('clientSearch').value.toLowerCase().trim();
  const resultsEl = document.getElementById('clientResults');

  if (!search) {
    resultsEl.innerHTML = '<div class="empty-state">Start typing to find clients.</div>';
    return;
  }

  const selectedIds = new Set(_selected.map(c => c.id));

  const matches = _allClients.filter(c =>
    (c.clientName || '').toLowerCase().includes(search) ||
    (c.counselor  || '').toLowerCase().includes(search) ||
    (c.rxNumbers  || []).some(rx => rx.toLowerCase().includes(search))
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
    id:               client.id,
    clientName:       client.clientName || '',
    counselor:        client.counselor  || '',
    rxNumbers:        client.rxNumbers  || [],
    sessionId:        null,
    savedRx:          (client.rxNumbers || [])[0] || '',
    savedNotes:       '',
    savedCourtStatus: '',
  });

  renderSelected();
  renderSearch();
}

function removeClient(clientId) {
  const entry = _selected.find(c => c.id === clientId);
  if (entry?.sessionId) {
    _removedToDelete.push({ clientId, sessionId: entry.sessionId });
  }
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
    const isNew = !c.sessionId;
    return `
      <div class="selected-client-card" data-client-id="${c.id}">
        <div class="sc-header">
          <div>
            <div class="sc-name">${esc(toTitleCase(c.clientName))}${isNew && _editMode ? ' <span style="font-size:0.7rem;background:var(--primary);color:#fff;border-radius:3px;padding:0.05rem 0.4rem;margin-left:0.35rem;">NEW</span>' : ''}</div>
            <div class="sc-meta">${esc(c.counselor)}</div>
          </div>
          <button class="remove-btn" data-remove-id="${c.id}" title="Remove">×</button>
        </div>
        <div class="form-group" style="margin-bottom:0.4rem;">
          <label style="font-size:0.75rem;">Rx Number</label>
          <input type="text" class="sc-rx" value="${esc(c.savedRx || '')}" placeholder="Rx number…" style="max-width:160px;">
        </div>
        <div class="form-group" style="margin-bottom:0.4rem;">
          <label style="font-size:0.75rem;">Session Notes (optional)</label>
          <textarea class="sc-notes" rows="2" placeholder="Brief update for this client…" style="font-size:0.8125rem;">${esc(c.savedNotes || '')}</textarea>
        </div>
        <div class="form-group" style="margin-bottom:0;">
          <label style="font-size:0.75rem;">Outcome *</label>
          <div style="display:flex;gap:1rem;flex-wrap:wrap;margin-top:0.25rem;">
            ${['continued','resolved','discontinued'].map(v => `
            <label style="display:flex;align-items:center;gap:0.3rem;font-size:0.825rem;font-weight:500;cursor:pointer;">
              <input type="radio" class="sc-court-status" name="cs-${esc(c.id)}" value="${v}" ${c.savedCourtStatus === v ? 'checked' : ''}>
              ${v.charAt(0).toUpperCase() + v.slice(1)}
            </label>`).join('')}
          </div>
        </div>
      </div>`;
  }).join('');

  listEl.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', () => removeClient(btn.dataset.removeId));
  });
}

// ── Submit ────────────────────────────────────────────────────────────────────

async function submitBatch() {
  const errorEl   = document.getElementById('submitError');
  const submitBtn = document.getElementById('submitBtn');
  errorEl.classList.add('hidden');

  const county    = document.getElementById('courtCounty').value;
  const dateVal   = document.getElementById('courtDate').value;
  const hours     = parseFloat(document.getElementById('courtHours').value) || 0;
  const counselor = document.getElementById('courtCounselor').value;

  if (!county)           { showError('Please select a county.'); return; }
  if (!dateVal)          { showError('Please select a court date.'); return; }
  if (!_selected.length && !_removedToDelete.length) { showError('No clients selected.'); return; }

  submitBtn.disabled    = true;
  submitBtn.textContent = 'Saving…';

  const sessionDate = new Date(dateVal + 'T12:00:00');
  const caseStatus  = 'Court — ' + county;

  // Collect per-client rx, notes, and court status from the rendered cards
  const perClient = {};
  document.querySelectorAll('.selected-client-card').forEach(card => {
    const statusInput = card.querySelector('.sc-court-status:checked');
    perClient[card.dataset.clientId] = {
      notes:       card.querySelector('.sc-notes').value.trim(),
      rx:          card.querySelector('.sc-rx').value.trim(),
      courtStatus: statusInput ? statusInput.value : '',
    };
  });

  // Require a status for every client
  const missingStatus = _selected.filter(c => !perClient[c.id]?.courtStatus);
  if (missingStatus.length) {
    showError(`Please select an outcome (Continued / Resolved / Discontinued) for: ${missingStatus.map(c => c.clientName || c.id).join(', ')}`);
    submitBtn.disabled    = false;
    submitBtn.textContent = _editMode ? 'Update Court Appearances' : 'Log Court Appearances';
    return;
  }

  try {
    // 1. Delete removed sessions
    await Promise.all(_removedToDelete.map(({ clientId, sessionId }) =>
      deleteDoc(doc(db, 'clients', clientId, 'sessions', sessionId))
    ));

    // 2. Update existing sessions
    await Promise.all(_selected.filter(c => c.sessionId).map(c => {
      const extras = perClient[c.id] || {};
      return updateDoc(doc(db, 'clients', c.id, 'sessions', c.sessionId), {
        date:           sessionDate,
        counselor:      counselor || c.counselor || '',
        rxNumber:       extras.rx || c.savedRx || '',
        counselingType: 'COURT',
        billingType:    'Court',
        hours,
        caseStatus,
        courtStatus:    extras.courtStatus || '',
        notes:          extras.notes || '',
        clientName:     c.clientName || '',
        updatedAt:      serverTimestamp(),
      });
    }));

    // 3. Create sessions for newly added clients
    await Promise.all(_selected.filter(c => !c.sessionId).map(c => {
      const extras = perClient[c.id] || {};
      return addDoc(collection(db, 'clients', c.id, 'sessions'), {
        date:           sessionDate,
        counselor:      counselor || c.counselor || '',
        rxNumber:       extras.rx || (c.rxNumbers[0] || ''),
        counselingType: 'COURT',
        billingType:    'Court',
        hours,
        dollarsFor:     '',
        caseStatus,
        courtStatus:    extras.courtStatus || '',
        outcome:        '',
        notes:          extras.notes || '',
        clientName:     c.clientName || '',
        createdAt:      serverTimestamp(),
        updatedAt:      serverTimestamp(),
      });
    }));

    // 4. Auto-mark prior court sessions (same county, older date) as 'continued'
    await inferPriorCourtStatuses(_selected.map(c => c.id), county, sessionDate);

    // 5. Refresh denormalized fields for all affected clients
    const allAffected = new Set([
      ..._selected.map(c => c.id),
      ..._removedToDelete.map(r => r.clientId),
    ]);
    for (const clientId of allAffected) {
      await refreshDenormalized(clientId);
    }

    const count  = _selected.length;
    const action = _editMode ? 'Updated' : 'Logged';
    document.getElementById('successMsg').textContent =
      `${action} ${count} court appearance${count !== 1 ? 's' : ''} for ${county} on ${fmtDateStr(sessionDate)}.`;
    document.getElementById('successBanner').classList.remove('hidden');
    document.querySelector('.court-layout').classList.add('hidden');
    document.querySelectorAll('.card').forEach(card => {
      if (!card.closest('#successBanner') && !card.closest('#pendingStatusBanner')) card.classList.add('hidden');
    });
    document.getElementById('editModeBanner').style.display = 'none';
    loadPendingStatuses();

  } catch (err) {
    showError('Save failed: ' + err.message);
    submitBtn.disabled    = false;
    submitBtn.textContent = _editMode ? 'Update Court Appearances' : 'Log Court Appearances';
  }
}

// ── Court status inference ────────────────────────────────────────────────────

async function inferPriorCourtStatuses(clientIds, county, beforeDate) {
  const caseStatus = 'Court — ' + county;
  for (const clientId of clientIds) {
    try {
      const snap = await getDocs(
        query(collection(db, 'clients', clientId, 'sessions'), where('caseStatus', '==', caseStatus))
      );
      for (const d of snap.docs) {
        const s = d.data();
        if (s.courtStatus) continue;
        const dt = s.date?.toDate ? s.date.toDate() : new Date(s.date);
        if (dt < beforeDate) {
          await updateDoc(doc(db, 'clients', clientId, 'sessions', d.id), {
            courtStatus: 'continued',
            updatedAt:   serverTimestamp(),
          });
        }
      }
    } catch (_) {}
  }
}

const COURT_COUNTIES = ['Beaver County', 'Lawrence County', 'Mercer County'];

async function loadPendingStatuses() {
  try {
    const allSessions = [];
    await Promise.all(COURT_COUNTIES.map(async county => {
      const cs = 'Court — ' + county;
      const snap = await getDocs(
        query(collectionGroup(db, 'sessions'), where('caseStatus', '==', cs))
      );
      snap.docs.forEach(d => {
        if (!d.data().deleted) {
          allSessions.push({ id: d.id, clientId: d.ref.parent.parent.id, county, ...d.data() });
        }
      });
    }));

    // Group by clientId + county, sort ascending by date
    const groups = {};
    for (const s of allSessions) {
      const key = `${s.clientId}|${s.county}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(s);
    }
    for (const sessions of Object.values(groups)) {
      sessions.sort((a, b) => {
        const da = a.date?.toDate ? a.date.toDate() : new Date(a.date);
        const db2 = b.date?.toDate ? b.date.toDate() : new Date(b.date);
        return da - db2;
      });
    }

    let canInfer = 0;
    let needsManual = 0;
    for (const sessions of Object.values(groups)) {
      for (let i = 0; i < sessions.length; i++) {
        if (!sessions[i].courtStatus) {
          if (i < sessions.length - 1) canInfer++;
          else needsManual++;
        }
      }
    }

    const banner = document.getElementById('pendingStatusBanner');
    if (!banner) return;
    if (canInfer === 0 && needsManual === 0) { banner.style.display = 'none'; return; }

    const parts = [];
    if (canInfer > 0)    parts.push(`${canInfer} prior session${canInfer !== 1 ? 's' : ''} can be auto-marked Continued`);
    if (needsManual > 0) parts.push(`${needsManual} recent session${needsManual !== 1 ? 's' : ''} need a manual outcome`);
    document.getElementById('pendingStatusMsg').textContent = parts.join(' · ');

    const resolveBtn = document.getElementById('resolveInferredBtn');
    resolveBtn.style.display = canInfer > 0 ? '' : 'none';
    banner.style.display = '';
  } catch (e) {
    console.warn('loadPendingStatuses:', e.message);
  }
}

async function resolveInferredStatuses() {
  const btn = document.getElementById('resolveInferredBtn');
  btn.disabled    = true;
  btn.textContent = 'Resolving…';
  try {
    await Promise.all(COURT_COUNTIES.map(async county => {
      const cs = 'Court — ' + county;
      const snap = await getDocs(
        query(collectionGroup(db, 'sessions'), where('caseStatus', '==', cs))
      );

      // Group by client, sort, mark non-latest as continued
      const byClient = {};
      snap.docs.forEach(d => {
        if (!d.data().deleted) {
          const cid = d.ref.parent.parent.id;
          if (!byClient[cid]) byClient[cid] = [];
          byClient[cid].push({ ref: d.ref, ...d.data() });
        }
      });

      for (const sessions of Object.values(byClient)) {
        sessions.sort((a, b) => {
          const da = a.date?.toDate ? a.date.toDate() : new Date(a.date);
          const db2 = b.date?.toDate ? b.date.toDate() : new Date(b.date);
          return da - db2;
        });
        for (let i = 0; i < sessions.length - 1; i++) {
          if (!sessions[i].courtStatus) {
            await updateDoc(sessions[i].ref, { courtStatus: 'continued', updatedAt: serverTimestamp() });
          }
        }
      }
    }));
    await loadPendingStatuses();
  } catch (e) {
    console.warn('resolveInferredStatuses:', e.message);
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Auto-resolve Continued';
  }
}

// ── Denormalized refresh ──────────────────────────────────────────────────────

async function refreshDenormalized(clientId) {
  try {
    const snap     = await getDocs(query(collection(db, 'clients', clientId, 'sessions'), orderBy('date', 'asc')));
    const sessions = snap.docs.map(d => d.data());
    const dated    = sessions.filter(s => s.date);
    await updateDoc(doc(db, 'clients', clientId), {
      sessionCount:      sessions.length,
      totalOutcomeValue: sessions.reduce((s, r) => s + (Number(r.dollarsAwarded) || 0), 0),
      firstSessionDate:  dated.length ? dated[0].date : null,
      lastSessionDate:   dated.length ? dated[dated.length - 1].date : null,
      updatedAt:         serverTimestamp(),
    });
  } catch (_) {}
}

// ── Reset ─────────────────────────────────────────────────────────────────────

function resetForm() {
  _selected        = [];
  _removedToDelete = [];
  setEditMode(false);

  document.getElementById('courtCounty').value    = '';
  document.getElementById('courtDate').value      = '';
  document.getElementById('courtHours').value     = '2';
  document.getElementById('courtCounselor').value = '';
  document.getElementById('clientSearch').value   = '';
  document.getElementById('clientResults').innerHTML =
    '<div class="empty-state">Start typing to find clients.</div>';
  document.getElementById('submitError').classList.add('hidden');

  const submitBtn = document.getElementById('submitBtn');
  submitBtn.disabled    = false;
  submitBtn.textContent = 'Log Court Appearances';

  renderSelected();
  document.getElementById('successBanner').classList.add('hidden');
  document.querySelector('.court-layout').classList.remove('hidden');
  document.querySelectorAll('.card').forEach(card => card.classList.remove('hidden'));
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
