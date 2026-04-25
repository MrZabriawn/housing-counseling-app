import { db } from './firebase-config.js';
import { requireAuth, setupNav } from './auth.js';
import {
  collection, collectionGroup, addDoc, deleteDoc, updateDoc,
  getDocs, doc, query, where, orderBy, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ── PAR section → row options ──────────────────────────────────────────────
const PAR_ROWS = {
  'PAR-S1': ['Processing-Intake', 'Processing-Billing', 'Supervision', 'Management', 'Counseling', 'Group Education'],
  'PAR-S2': ['Training'],
  'PAR-S3': ['Marketing'],
  'CML':    ['Case Management'],
};

const SECTION_LABELS = {
  'PAR-S1': 'Section 1',
  'PAR-S2': 'Section 2',
  'PAR-S3': 'Section 3',
  'CML':    'CML',
};

// ── Module state ────────────────────────────────────────────────────────────
let _user     = null;
let _myId     = '';
let _myName   = '';

let _month    = '';
let _entries  = [];   // all hudTimeEntries for this counselor + month

let _activeTab  = 'par';
let _openAddDay = null;
let _openDays   = new Set();

let _pendingDeleteId = null;
let _editingEntry    = null;

// ED-only state
let _isED               = false;
let _edCounselors       = [];
let _counselorDataCache = {}; // `${counselorId}-${month}` → entries array

// ── Entry point ─────────────────────────────────────────────────────────────
requireAuth(async (user, profile) => {
  _user   = user;
  _myName = profile.name || profile.email || '';
  setupNav(profile, 'hud-time');

  try {
    const snap = await getDocs(query(collection(db, 'counselors'), where('email', '==', user.email)));
    if (!snap.empty) _myId = snap.docs[0].id;
  } catch (_) {}
  if (!_myId) _myId = user.uid;

  const now = new Date();
  _month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  document.getElementById('monthPicker').value = _month;

  document.getElementById('monthPicker').addEventListener('change', async (e) => {
    _month = e.target.value;
    _openDays.clear();
    _openAddDay = null;
    _counselorDataCache = {};
    await loadData();
    renderAll();
    if (_activeTab.startsWith('counselor-')) {
      loadCounselorTab(_activeTab.replace('counselor-', ''));
    }
  });

  document.querySelectorAll('.hud-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('deleteConfirmBtn').addEventListener('click', confirmDelete);
  document.getElementById('deleteCancelBtn').addEventListener('click', () => {
    _pendingDeleteId = null;
    document.getElementById('deleteModal').classList.add('hidden');
  });

  document.getElementById('editSaveBtn').addEventListener('click', saveEdit);
  document.getElementById('editCancelBtn').addEventListener('click', closeEditModal);
  document.getElementById('editSection').addEventListener('change', updateEditRowOptions);

  await loadData();
  renderAll();

  if (profile.role === 'executive_director') {
    _isED = true;
    await loadEdCounselors();
    renderCounselorTabs();
  }
});

// ── Data loading ─────────────────────────────────────────────────────────────
async function loadData() {
  await loadEntries();
  const created = await syncDerivedSessions();
  if (created) await loadEntries(); // pick up newly written docs
}

async function loadEntries() {
  try {
    const snap = await getDocs(
      query(
        collection(db, 'hudTimeEntries'),
        where('counselorId', '==', _myId),
        where('month', '==', _month),
      )
    );
    _entries = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  } catch (_) {
    _entries = [];
  }
}

// Write real hudTimeEntries for NOFA sessions not yet imported.
// Returns true if any new docs were created.
async function syncDerivedSessions() {
  if (!_month) return false;

  const [year, mon] = _month.split('-').map(Number);
  const startDate = new Date(year, mon - 1, 1, 12, 0, 0);
  const endDate   = new Date(year, mon,     1, 12, 0, 0);

  const existingSourceIds = new Set(_entries.map(e => e.sourceSessionId).filter(Boolean));

  try {
    // Build billingType map from client docs
    const clientSnap = await getDocs(collection(db, 'clients'));
    const billingTypeMap = {};
    clientSnap.docs.forEach(d => {
      billingTypeMap[d.id] = d.data().billingType || null;
    });

    // Build rxNumber → guarantor map from the rxNumbers subcollection
    // Only active Rx numbers are considered
    const rxSnap = await getDocs(collectionGroup(db, 'rxNumbers'));
    const rxGuarantorMap = {}; // rxNumber string → guarantor
    rxSnap.docs.forEach(d => {
      const r = d.data();
      if (r.active !== false && r.rxNumber) {
        rxGuarantorMap[r.rxNumber.trim()] = r.guarantor || null;
      }
    });

    const sessSnap = await getDocs(collectionGroup(db, 'sessions'));
    let created = false;

    for (const d of sessSnap.docs) {
      const clientId = d.ref.parent.parent.id;
      const data     = d.data();

      if (data.counselor !== _myName) continue;

      // Match this session's Rx number to the subcollection guarantor
      const sessionRx = (data.rxNumber || '').trim();
      if (!sessionRx || rxGuarantorMap[sessionRx] !== 'NOFA') continue;

      if (existingSourceIds.has(d.id)) continue;

      const rawDate = data.date;
      let dateObj;
      if (rawDate?.toDate)              dateObj = rawDate.toDate();
      else if (typeof rawDate === 'string') dateObj = new Date(rawDate + 'T12:00:00');
      else if (rawDate instanceof Date)    dateObj = rawDate;
      else continue;

      if (dateObj < startDate || dateObj >= endDate) continue;

      const dateStr = dateObj.toISOString().split('T')[0];
      const hours   = parseFloat(data.hours) || 0;
      const billing = billingTypeMap[clientId];

      let section, parRow;
      if (billing === 'In-Person') {
        section = 'PAR-S1'; parRow = 'Counseling';
      } else if (billing === 'Case Management Activity' || billing === 'Court') {
        section = 'CML'; parRow = 'Case Management';
      } else {
        continue; // billingType not set — skip
      }

      await addDoc(collection(db, 'hudTimeEntries'), {
        counselorId:         _myId,
        counselorName:       _myName,
        month:               _month,
        date:                dateStr,
        section,
        parRow,
        activityDescription: `${data.rxNumber || clientId}`,
        hours,
        enteredBy:           _user.uid,
        sourceSessionId:     d.id,   // prevents re-import on next load
        autoCreated:         true,
        createdAt:           serverTimestamp(),
      });
      created = true;
    }

    return created;
  } catch (err) {
    console.warn('syncDerivedSessions error:', err);
    return false;
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────
function renderAll() {
  renderParLog();
  renderMonthlySummary();
  renderMyEntries();
}

function switchTab(tab) {
  _activeTab = tab;
  document.querySelectorAll('.hud-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('tabPar').classList.toggle('hidden', tab !== 'par');
  document.getElementById('tabEntries').classList.toggle('hidden', tab !== 'entries');
  document.querySelectorAll('.counselor-panel').forEach(p => p.classList.add('hidden'));
  if (tab.startsWith('counselor-')) {
    const panel = document.getElementById(`tab-${tab}`);
    if (panel) panel.classList.remove('hidden');
    loadCounselorTab(tab.replace('counselor-', ''));
  }
}

// ── PAR Log tab ──────────────────────────────────────────────────────────────
function renderParLog() {
  const container = document.getElementById('parDayList');
  if (!_month) { container.innerHTML = '<p style="color:var(--text-muted)">Select a month above.</p>'; return; }

  const [year, mon] = _month.split('-').map(Number);
  const daysInMonth = new Date(year, mon, 0).getDate();
  const days = [];
  for (let d = 1; d <= daysInMonth; d++) {
    days.push(`${_month}-${String(d).padStart(2, '0')}`);
  }

  container.innerHTML = days.map(dateStr => buildDayRow(dateStr)).join('');

  container.querySelectorAll('.day-header').forEach(header => {
    header.addEventListener('click', (e) => {
      if (e.target.closest('.add-entry-form')) return;
      toggleDay(header.dataset.date);
    });
  });

  attachDayListeners(container);
}

function buildDayRow(dateStr) {
  const dayDate   = new Date(dateStr + 'T12:00:00');
  const dayOfWeek = dayDate.getUTCDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const dayLabel  = dayDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

  const dayEntries = _entries.filter(e => e.date === dateStr);
  const totalHrs   = dayEntries.reduce((s, e) => s + (e.hours || 0), 0);
  const isOpen     = _openDays.has(dateStr);
  const hasAddForm = _openAddDay === dateStr;

  const chips = dayEntries.map(e => {
    const isAuto    = !!e.autoCreated;
    const autoBadge = isAuto ? `<span class="derived-badge">NOFA</span>` : '';
    return `
      <div class="entry-chip">
        <div class="entry-chip-info">
          <div class="entry-chip-row">${esc(e.parRow || e.section)} ${autoBadge}</div>
          ${e.activityDescription ? `<div class="entry-chip-desc">${esc(e.activityDescription)}</div>` : ''}
        </div>
        <div class="entry-chip-hrs">${e.hours}h</div>
        <button class="entry-chip-edit" data-id="${esc(e.id)}" title="Edit">✎</button>
        ${isAuto ? '' : `<button class="entry-chip-del" data-id="${esc(e.id)}" title="Delete">×</button>`}
      </div>`;
  }).join('');

  const addFormHtml = hasAddForm ? buildAddForm(dateStr) : `
    <div style="margin-top:${dayEntries.length > 0 ? '0.5rem' : '0'};">
      <button class="btn btn-secondary btn-sm add-day-btn" data-date="${dateStr}">+ Add Entry</button>
    </div>`;

  return `
    <div class="day-row ${isOpen ? 'open' : ''}" id="day-${dateStr}">
      <div class="day-header ${isWeekend ? 'weekend' : ''}" data-date="${dateStr}">
        <span class="day-arrow">▶</span>
        <span class="day-label">${dayLabel}</span>
        <span class="day-hours">${totalHrs > 0 ? totalHrs + 'h' : ''}</span>
      </div>
      <div class="day-body">
        ${chips}
        ${addFormHtml}
      </div>
    </div>`;
}

function attachDayListeners(container) {
  container.querySelectorAll('.entry-chip-edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const entry = _entries.find(x => x.id === btn.dataset.id);
      if (entry) openEditModal(entry);
    });
  });

  container.querySelectorAll('.entry-chip-del').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openDeleteModal(btn.dataset.id);
    });
  });

  container.querySelectorAll('.add-day-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _openAddDay = btn.dataset.date;
      _openDays.add(btn.dataset.date);
      renderParLog();
    });
  });

  container.querySelectorAll('.par-section-radio').forEach(radio => {
    radio.addEventListener('change', () => updateRowOptions(radio.closest('.add-entry-form')));
  });

  container.querySelectorAll('.add-form-save').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); saveEntry(btn.dataset.date); });
  });
  container.querySelectorAll('.add-form-cancel').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); _openAddDay = null; renderParLog(); });
  });
}

function buildAddForm(dateStr) {
  return `
    <div class="add-entry-form" onclick="event.stopPropagation()">
      <div class="section-radios">
        <label><input type="radio" name="parSection_${dateStr}" class="par-section-radio" value="PAR-S1" checked> Section 1</label>
        <label><input type="radio" name="parSection_${dateStr}" class="par-section-radio" value="PAR-S2"> Section 2</label>
        <label><input type="radio" name="parSection_${dateStr}" class="par-section-radio" value="PAR-S3"> Section 3</label>
      </div>
      <div class="add-form-row">
        <div class="form-group" style="flex:0 0 210px;">
          <label style="font-size:0.75rem;">PAR Row</label>
          <select class="par-row-select">
            ${PAR_ROWS['PAR-S1'].map(r => `<option value="${r}">${r}</option>`).join('')}
          </select>
        </div>
        <div class="form-group" style="flex:1;min-width:180px;">
          <label style="font-size:0.75rem;">Description</label>
          <textarea class="par-desc" rows="2" placeholder="Brief activity description…"></textarea>
        </div>
        <div class="form-group" style="flex:0 0 90px;">
          <label style="font-size:0.75rem;">Hours</label>
          <input type="number" class="par-hours" min="0.25" max="24" step="0.25" value="0.25">
        </div>
      </div>
      <p class="par-error error-msg hidden" style="font-size:0.8rem;margin:0.25rem 0;"></p>
      <div class="add-form-actions">
        <button class="btn btn-primary btn-sm add-form-save" data-date="${dateStr}">Save</button>
        <button class="btn btn-secondary btn-sm add-form-cancel" data-date="${dateStr}">Cancel</button>
      </div>
    </div>`;
}

function updateRowOptions(formEl) {
  const section  = formEl.querySelector('.par-section-radio:checked')?.value || 'PAR-S1';
  const selectEl = formEl.querySelector('.par-row-select');
  selectEl.innerHTML = (PAR_ROWS[section] || []).map(r => `<option value="${r}">${r}</option>`).join('');
}

function toggleDay(dateStr) {
  if (_openDays.has(dateStr)) {
    _openDays.delete(dateStr);
    if (_openAddDay === dateStr) _openAddDay = null;
  } else {
    _openDays.add(dateStr);
  }
  renderParLog();
}

// ── Save new entry ────────────────────────────────────────────────────────────
async function saveEntry(dateStr) {
  const container = document.getElementById(`day-${dateStr}`);
  const form      = container.querySelector('.add-entry-form');
  const section   = form.querySelector('.par-section-radio:checked')?.value || '';
  const parRow    = form.querySelector('.par-row-select')?.value || '';
  const desc      = form.querySelector('.par-desc')?.value.trim() || '';
  const hoursRaw  = parseFloat(form.querySelector('.par-hours')?.value) || 0;
  const errEl     = form.querySelector('.par-error');

  errEl.classList.add('hidden');
  if (!section)      { showFormErr(errEl, 'Select a section.');             return; }
  if (!parRow)       { showFormErr(errEl, 'Select a PAR row.');             return; }
  if (!desc)         { showFormErr(errEl, 'Description is required.');      return; }
  if (hoursRaw <= 0) { showFormErr(errEl, 'Hours must be greater than 0.'); return; }
  const hours = Math.round(hoursRaw * 4) / 4;

  const saveBtn = form.querySelector('.add-form-save');
  saveBtn.disabled = true; saveBtn.textContent = 'Saving…';

  try {
    await addDoc(collection(db, 'hudTimeEntries'), {
      counselorId: _myId, counselorName: _myName,
      month: _month, date: dateStr,
      section, parRow, activityDescription: desc, hours,
      enteredBy: _user.uid, createdAt: serverTimestamp(),
    });
    _openAddDay = null;
    await loadEntries();
    renderAll();
  } catch (err) {
    saveBtn.disabled = false; saveBtn.textContent = 'Save';
    showFormErr(errEl, 'Error saving. Try again.');
    console.error(err);
  }
}

function showFormErr(el, msg) { el.textContent = msg; el.classList.remove('hidden'); }

// ── Edit entry ────────────────────────────────────────────────────────────────
function openEditModal(entry) {
  _editingEntry = entry;

  const sectionEl = document.getElementById('editSection');
  sectionEl.value = entry.section || 'PAR-S1';
  updateEditRowOptions();
  document.getElementById('editParRow').value = entry.parRow || '';
  document.getElementById('editDesc').value   = entry.activityDescription || '';
  document.getElementById('editHours').value  = entry.hours || 0.25;

  document.getElementById('editError').classList.add('hidden');
  document.getElementById('editModal').classList.remove('hidden');
}

function closeEditModal() {
  _editingEntry = null;
  document.getElementById('editModal').classList.add('hidden');
}

function updateEditRowOptions() {
  const section = document.getElementById('editSection').value || 'PAR-S1';
  const sel     = document.getElementById('editParRow');
  const prev    = sel.value;
  sel.innerHTML = (PAR_ROWS[section] || []).map(r => `<option value="${r}">${r}</option>`).join('');
  if ((PAR_ROWS[section] || []).includes(prev)) sel.value = prev;
}

async function saveEdit() {
  if (!_editingEntry) return;
  const section  = document.getElementById('editSection').value;
  const parRow   = document.getElementById('editParRow').value;
  const desc     = document.getElementById('editDesc').value.trim();
  const hoursRaw = parseFloat(document.getElementById('editHours').value) || 0;
  const errEl    = document.getElementById('editError');

  errEl.classList.add('hidden');
  if (!parRow)       { errEl.textContent = 'Select a PAR row.';             errEl.classList.remove('hidden'); return; }
  if (!desc)         { errEl.textContent = 'Description is required.';       errEl.classList.remove('hidden'); return; }
  if (hoursRaw <= 0) { errEl.textContent = 'Hours must be greater than 0.'; errEl.classList.remove('hidden'); return; }
  const hours = Math.round(hoursRaw * 4) / 4;

  const saveBtn = document.getElementById('editSaveBtn');
  saveBtn.disabled = true; saveBtn.textContent = 'Saving…';

  try {
    await updateDoc(doc(db, 'hudTimeEntries', _editingEntry.id), { section, parRow, activityDescription: desc, hours });
    closeEditModal();
    await loadEntries();
    renderAll();
  } catch (err) {
    errEl.textContent = 'Error saving. Try again.';
    errEl.classList.remove('hidden');
    console.error(err);
  } finally {
    saveBtn.disabled = false; saveBtn.textContent = 'Save';
  }
}

// ── Delete entry ──────────────────────────────────────────────────────────────
function openDeleteModal(docId) {
  _pendingDeleteId = docId;
  document.getElementById('deleteModalError').classList.add('hidden');
  document.getElementById('deleteModal').classList.remove('hidden');
}

async function confirmDelete() {
  if (!_pendingDeleteId) return;
  const btn = document.getElementById('deleteConfirmBtn');
  btn.disabled = true; btn.textContent = 'Deleting…';
  try {
    await deleteDoc(doc(db, 'hudTimeEntries', _pendingDeleteId));
    document.getElementById('deleteModal').classList.add('hidden');
    _pendingDeleteId = null;
    await loadEntries();
    renderAll();
  } catch (err) {
    document.getElementById('deleteModalError').textContent = 'Error deleting. Try again.';
    document.getElementById('deleteModalError').classList.remove('hidden');
    console.error(err);
  } finally {
    btn.disabled = false; btn.textContent = 'Delete';
  }
}

// ── Monthly summary ───────────────────────────────────────────────────────────
function renderMonthlySummary() {
  const container = document.getElementById('parSummary');
  const rowTotals = {};

  _entries.forEach(e => {
    const sectionLabel = SECTION_LABELS[e.section] || e.section || '';
    const key = `${sectionLabel} — ${e.parRow || e.section}`;
    rowTotals[key] = (rowTotals[key] || 0) + (e.hours || 0);
  });

  if (Object.keys(rowTotals).length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:0.875rem;">No entries this month.</p>';
    return;
  }

  const totalHrs = Object.values(rowTotals).reduce((s, h) => s + h, 0);
  const rows     = Object.entries(rowTotals).sort((a, b) => a[0].localeCompare(b[0]));

  container.innerHTML = `
    <table class="summary-table">
      <thead><tr><th>Section / Row</th><th style="text-align:right;">Hours</th></tr></thead>
      <tbody>
        ${rows.map(([key, hrs]) => `<tr><td>${esc(key)}</td><td style="text-align:right;">${hrs}h</td></tr>`).join('')}
        <tr><td>Total</td><td style="text-align:right;">${totalHrs}h</td></tr>
      </tbody>
    </table>`;
}

// ── My Entries tab ────────────────────────────────────────────────────────────
function renderMyEntries() {
  const body = document.getElementById('myEntriesBody');
  if (_entries.length === 0) {
    body.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--text-muted)">No entries for this month.</td></tr>';
    return;
  }

  body.innerHTML = _entries.map(e => {
    const dateObj  = new Date(e.date + 'T12:00:00');
    const dateDisp = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', weekday: 'short', timeZone: 'UTC' });
    const isAuto   = !!e.autoCreated;
    const autoBadge = isAuto ? `<span class="derived-badge" style="margin-left:4px;">NOFA</span>` : '';
    return `
      <tr>
        <td style="white-space:nowrap;">${dateDisp}</td>
        <td>${esc(SECTION_LABELS[e.section] || e.section || '')}${autoBadge}</td>
        <td>${esc(e.parRow || '—')}</td>
        <td style="max-width:320px;">${esc(e.activityDescription || '')}</td>
        <td style="text-align:right;">${e.hours || 0}h</td>
        <td style="text-align:center;white-space:nowrap;">
          <button class="entry-chip-edit" data-id="${esc(e.id)}" title="Edit" style="margin-right:0.25rem;">✎</button>
          ${isAuto ? '' : `<button class="entry-chip-del" data-id="${esc(e.id)}" title="Delete">×</button>`}
        </td>
      </tr>`;
  }).join('');

  body.querySelectorAll('.entry-chip-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const entry = _entries.find(x => x.id === btn.dataset.id);
      if (entry) openEditModal(entry);
    });
  });
  body.querySelectorAll('.entry-chip-del').forEach(btn => {
    btn.addEventListener('click', () => openDeleteModal(btn.dataset.id));
  });
}

// ── ED: counselor tabs ────────────────────────────────────────────────────────
async function loadEdCounselors() {
  try {
    const snap = await getDocs(query(collection(db, 'counselors'), orderBy('name')));
    _edCounselors = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(c => c.active !== false && c.id !== _myId);
  } catch (_) { _edCounselors = []; }
}

function renderCounselorTabs() {
  const tabBar   = document.querySelector('.hud-tabs');
  const lastPanel = document.getElementById('tabEntries');

  _edCounselors.forEach(c => {
    const btn = document.createElement('button');
    btn.className    = 'hud-tab';
    btn.dataset.tab  = `counselor-${c.id}`;
    btn.textContent  = c.name || c.id;
    tabBar.appendChild(btn);
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));

    const panel = document.createElement('div');
    panel.id        = `tab-counselor-${c.id}`;
    panel.className = 'counselor-panel hidden';
    panel.innerHTML = `
      <div class="card" style="padding:0;max-width:960px;">
        <div style="padding:0.6rem 1rem;border-bottom:1px solid var(--border);font-size:0.8125rem;font-weight:600;display:flex;align-items:center;gap:0.75rem;">
          <span>${esc(c.name)}</span>
          <span id="counselorStatus-${esc(c.id)}" style="font-weight:400;color:var(--text-muted);"></span>
        </div>
        <div style="overflow-x:auto;">
          <table style="font-size:0.85rem;width:100%;">
            <thead>
              <tr>
                <th>Date</th><th>Section</th><th>PAR Row</th><th>Description</th>
                <th style="text-align:right;">Hours</th>
              </tr>
            </thead>
            <tbody id="counselorBody-${esc(c.id)}">
              <tr><td colspan="5" style="text-align:center;padding:2rem;color:var(--text-muted);">Select this tab to load.</td></tr>
            </tbody>
          </table>
        </div>
      </div>`;
    lastPanel.insertAdjacentElement('afterend', panel);
  });
}

async function loadCounselorTab(counselorId) {
  const cacheKey = `${counselorId}-${_month}`;
  if (_counselorDataCache[cacheKey]) {
    renderCounselorEntries(counselorId, _counselorDataCache[cacheKey]);
    return;
  }

  const statusEl = document.getElementById(`counselorStatus-${counselorId}`);
  const bodyEl   = document.getElementById(`counselorBody-${counselorId}`);
  if (statusEl) statusEl.textContent = 'Loading…';
  if (bodyEl) bodyEl.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:2rem;color:var(--text-muted);">Loading…</td></tr>';

  try {
    const snap = await getDocs(query(
      collection(db, 'hudTimeEntries'),
      where('counselorId', '==', counselorId),
      where('month', '==', _month),
    ));
    const entries = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    _counselorDataCache[cacheKey] = entries;
    renderCounselorEntries(counselorId, entries);
  } catch (err) {
    if (statusEl) statusEl.textContent = 'Error loading.';
    if (bodyEl) bodyEl.innerHTML = `<tr><td colspan="5" style="color:var(--danger);padding:1rem;">${esc(err.message)}</td></tr>`;
  }
}

function renderCounselorEntries(counselorId, entries) {
  const statusEl = document.getElementById(`counselorStatus-${counselorId}`);
  const bodyEl   = document.getElementById(`counselorBody-${counselorId}`);
  if (!bodyEl) return;

  const total = entries.reduce((s, e) => s + (e.hours || 0), 0);
  if (statusEl) statusEl.textContent = entries.length
    ? `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} · ${total}h`
    : 'No entries this month';

  if (!entries.length) {
    bodyEl.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:2rem;color:var(--text-muted);">No entries for this month.</td></tr>';
    return;
  }

  bodyEl.innerHTML = entries.map(e => {
    const dateObj  = new Date(e.date + 'T12:00:00');
    const dateDisp = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', weekday: 'short', timeZone: 'UTC' });
    const isAuto   = !!e.autoCreated;
    const autoBadge = isAuto ? `<span class="derived-badge" style="margin-left:4px;">NOFA</span>` : '';
    return `<tr>
      <td style="white-space:nowrap;">${dateDisp}</td>
      <td>${esc(SECTION_LABELS[e.section] || e.section || '')}${autoBadge}</td>
      <td>${esc(e.parRow || '—')}</td>
      <td style="max-width:320px;">${esc(e.activityDescription || '')}</td>
      <td style="text-align:right;">${e.hours || 0}h</td>
    </tr>`;
  }).join('');
}

// ── Utility ───────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
