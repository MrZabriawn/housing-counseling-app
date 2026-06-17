import { db } from './firebase-config.js';
import {
  collection, collectionGroup, addDoc, deleteDoc, updateDoc, setDoc,
  getDocs, getDoc, doc, query, where, orderBy, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ── PAR section → row options ──────────────────────────────────────────────
const PAR_ROWS = {
  'PAR-S1': ['Processing-Intake', 'Processing-Billing', 'Supervision', 'Management', 'Counseling', 'Group Education'],
  'PAR-S2': ['Training'],
  'PAR-S3': ['Marketing'],
  'CML':    ['Case Management'],
};

const SECTION_LABELS = {
  'PAR-S1': 'Section 1 – Direct Service',
  'PAR-S2': 'Section 2 – Training',
  'PAR-S3': 'Section 3 – Marketing',
  'CML':    'CML',
};

// ── Module state ────────────────────────────────────────────────────────────
let _user     = null;
let _myId     = '';
let _myName   = '';

let _month           = '';
let _entries         = [];         // legacy hudTimeEntries for this counselor + month
let _hudEvents       = [];         // new hudEvents for this counselor + month
let _scheduledHours  = new Map();  // dateStr → scheduled hours (default 8)

let _activeTab  = 'par';
let _openAddDay = null;
let _openDays   = new Set();

let _pendingDeleteId   = null;
let _pendingDeleteSrc  = 'legacy'; // 'legacy' | 'event'
let _editingEntry    = null;

// ED-only state
let _isED               = false;
let _edCounselors       = [];
let _counselorDataCache = {}; // `${counselorId}-${month}` → entries array

// ── Entry point ─────────────────────────────────────────────────────────────
export async function initHudTime(user, profile) {
  _user   = user;
  _myName = profile.name || profile.email || '';

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
    // Hide personal PAR/Entries tabs — ED uses per-counselor tabs for everyone including themselves
    document.querySelectorAll('.hud-tab[data-tab="par"], .hud-tab[data-tab="entries"]').forEach(b => b.classList.add('hidden'));
    if (_edCounselors.length) switchTab(`counselor-${_edCounselors[0].id}`);
  }
}

// ── Data loading ─────────────────────────────────────────────────────────────
async function loadData() {
  await Promise.all([loadEntries(), loadHudEvents(), loadScheduledHours()]);
}

async function loadHudEvents() {
  try {
    const snap = await getDocs(
      query(
        collection(db, 'hudEvents'),
        where('counselorId', '==', _myId),
        where('month', '==', _month),
      )
    );
    _hudEvents = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  } catch (_) {
    _hudEvents = [];
  }
}

async function loadScheduledHours() {
  _scheduledHours = new Map();
  try {
    const snap = await getDoc(doc(db, 'hudScheduledHours', _myId));
    if (snap.exists()) {
      const data = snap.data();
      Object.entries(data).forEach(([key, hrs]) => {
        if (key.startsWith(_month)) _scheduledHours.set(key, hrs);
      });
    }
  } catch (_) {}
}

async function saveScheduledHours(dateStr, hours) {
  _scheduledHours.set(dateStr, hours);
  try {
    await setDoc(doc(db, 'hudScheduledHours', _myId), { [dateStr]: hours }, { merge: true });
  } catch (_) {}
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

  const dayEntries  = _entries.filter(e => e.date === dateStr);
  const dayEvents   = _hudEvents.filter(e => e.date === dateStr);
  const legacyHrs   = dayEntries.reduce((s, e) => s + (e.hours || 0), 0);
  const eventMins   = dayEvents.reduce((s, e) => s + (e.durationMinutes || 0), 0);
  const totalHrs    = legacyHrs + eventMins / 60;
  const isOpen      = _openDays.has(dateStr);
  const hasAddForm  = _openAddDay === dateStr;

  const SECTION_COLORS = { S1: '#1a73e8', S2: '#0d9488', S3: '#7c3aed', S4: '#6b7280' };

  const chips = [
    ...dayEntries.map(e => {
      const isAuto    = !!e.autoCreated;
      const autoBadge = isAuto ? `<span class="derived-badge">NOFA</span>` : '';
      return `
        <div class="entry-chip">
          <div class="entry-chip-info">
            <div class="entry-chip-row">${esc(e.parRow || e.section)} ${autoBadge}</div>
            ${e.activityDescription ? `<div class="entry-chip-desc">${esc(e.activityDescription)}</div>` : ''}
          </div>
          <div class="entry-chip-hrs">${e.hours}h</div>
          <button class="entry-chip-edit" data-id="${esc(e.id)}" data-src="legacy" title="Edit">✎</button>
          ${isAuto ? '' : `<button class="entry-chip-del" data-id="${esc(e.id)}" data-src="legacy" title="Delete">×</button>`}
        </div>`;
    }),
    ...dayEvents.map(e => {
      const sColor  = SECTION_COLORS[e.parSection] || '#6b7280';
      const secBadge = `<span style="font-size:0.68rem;font-weight:700;padding:0.1rem 0.4rem;border-radius:20px;background:${sColor};color:#fff;margin-left:0.4rem;vertical-align:middle;">${esc(e.parSection)}</span>`;
      const typeLabel = e.type === 'counseling_session' ? 'Session'
                      : e.type === 'case_management'    ? 'Case Mgmt'
                      : e.costType === 'T'              ? 'Training'
                      : 'Marketing';
      const detail = e.clientName
        ? `${esc(e.clientName)} · ${esc(e.rxCaseNo || '')}${e.nofaInitiative ? ' · ' + esc(e.nofaInitiative) : ''}`
        : esc(e.description || e.activityNote || '');
      const mins = e.durationMinutes || 0;
      const hrsDisplay = mins % 60 === 0 ? `${mins/60}h` : `${Math.floor(mins/60)}h ${mins%60}m`;
      return `
        <div class="entry-chip">
          <div class="entry-chip-info">
            <div class="entry-chip-row">${typeLabel}${secBadge}</div>
            ${detail ? `<div class="entry-chip-desc">${detail}</div>` : ''}
          </div>
          <div class="entry-chip-hrs">${hrsDisplay}</div>
          <button class="entry-chip-del" data-id="${esc(e.id)}" data-src="event" title="Delete">×</button>
        </div>`;
    }),
  ].join('');

  const addFormHtml = hasAddForm ? buildAddForm(dateStr) : `
    <div style="margin-top:${dayEntries.length > 0 ? '0.5rem' : '0'};">
      <button class="btn btn-secondary btn-sm add-day-btn" data-date="${dateStr}">+ Add Entry</button>
    </div>`;

  const scheduled  = _scheduledHours.get(dateStr) ?? (isWeekend ? 0 : 8);
  const grantMins  = dayEvents.filter(e => e.parSection === 'S1' || e.parSection === 'S2' || e.parSection === 'S3')
                               .reduce((s, e) => s + (e.durationMinutes || 0), 0);
  const grantHrs   = grantMins / 60;
  const s4Fill     = Math.max(0, scheduled - grantHrs - legacyHrs);
  const s4Display  = s4Fill > 0 ? `<span style="font-size:0.75rem;color:#6b7280;margin-left:0.75rem;">S4 fill: ${s4Fill % 1 === 0 ? s4Fill : s4Fill.toFixed(2)}h</span>` : '';

  return `
    <div class="day-row ${isOpen ? 'open' : ''}" id="day-${dateStr}">
      <div class="day-header ${isWeekend ? 'weekend' : ''}" data-date="${dateStr}">
        <span class="day-arrow">▶</span>
        <span class="day-label">${dayLabel}</span>
        <span class="day-hours">${totalHrs > 0 ? (totalHrs % 1 === 0 ? totalHrs : totalHrs.toFixed(2)) + 'h' : ''}</span>
        ${s4Display}
        <span style="margin-left:auto;display:flex;align-items:center;gap:0.3rem;font-size:0.75rem;color:var(--text-muted);" onclick="event.stopPropagation()">
          Sched:
          <input type="number" class="sched-hrs-input" data-date="${dateStr}"
            value="${scheduled}" min="0" max="24" step="0.5"
            style="width:48px;font-size:0.75rem;padding:0.15rem 0.3rem;border:1px solid var(--border);border-radius:3px;text-align:right;">h
        </span>
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
      if (btn.dataset.src === 'event') {
        openDeleteModal(btn.dataset.id, 'event');
      } else {
        openDeleteModal(btn.dataset.id, 'legacy');
      }
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

  container.querySelectorAll('.sched-hrs-input').forEach(inp => {
    inp.addEventListener('change', (e) => {
      e.stopPropagation();
      const hrs = parseFloat(inp.value) || 0;
      saveScheduledHours(inp.dataset.date, hrs);
      renderParLog();
    });
  });

  container.querySelectorAll('.ev-type-radio').forEach(radio => {
    radio.addEventListener('change', () => updateAddFormType(radio.closest('.add-entry-form')));
  });

  container.querySelectorAll('.ev-rx-lookup').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); performRxLookup(btn.closest('.add-entry-form')); });
  });

  container.querySelectorAll('.ev-rx-input').forEach(inp => {
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.stopPropagation(); performRxLookup(inp.closest('.add-entry-form')); }
    });
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
      <div class="section-radios" style="margin-bottom:0.75rem;">
        <label><input type="radio" name="evType_${dateStr}" class="ev-type-radio" value="counseling_session" checked> Counseling Session</label>
        <label><input type="radio" name="evType_${dateStr}" class="ev-type-radio" value="case_management"> Case Management</label>
        <label><input type="radio" name="evType_${dateStr}" class="ev-type-radio" value="training_marketing"> Training / Marketing</label>
      </div>

      <!-- Rx lookup (session + case_management) -->
      <div class="ev-rx-section">
        <div class="add-form-row" style="align-items:flex-end;margin-bottom:0.5rem;">
          <div class="form-group" style="margin:0;flex:0 0 160px;">
            <label style="font-size:0.75rem;">Rx Case # *</label>
            <input type="text" class="ev-rx-input" placeholder="Enter Rx #" autocomplete="off">
          </div>
          <button type="button" class="btn btn-secondary btn-sm ev-rx-lookup" style="margin-bottom:2px;">Look up</button>
          <div class="ev-rx-result" style="flex:1;font-size:0.8125rem;padding:0.3rem 0.5rem;border-radius:var(--radius);min-height:2rem;"></div>
        </div>
        <!-- delivery (session only) -->
        <div class="ev-delivery-row section-radios" style="margin-bottom:0.6rem;">
          <label><input type="radio" name="evDel_${dateStr}" class="ev-delivery-radio" value="face-to-face" checked> Face-to-face</label>
          <label><input type="radio" name="evDel_${dateStr}" class="ev-delivery-radio" value="phone"> Phone</label>
          <label><input type="radio" name="evDel_${dateStr}" class="ev-delivery-radio" value="virtual"> Virtual</label>
        </div>
        <div class="form-group" style="margin:0 0 0.5rem;">
          <label style="font-size:0.75rem;">Activity Note</label>
          <input type="text" class="ev-note" placeholder="Brief description…">
        </div>
      </div>

      <!-- Training / Marketing fields -->
      <div class="ev-tm-section" style="display:none;">
        <div class="add-form-row" style="margin-bottom:0.5rem;">
          <div class="form-group" style="margin:0;flex:0 0 200px;">
            <label style="font-size:0.75rem;">Type *</label>
            <select class="ev-cost-type">
              <option value="T">Training / Cert / Cont-Ed (T → S2)</option>
              <option value="M">Marketing / Outreach (M → S3)</option>
            </select>
          </div>
          <div class="form-group" style="margin:0;flex:0 0 120px;">
            <label style="font-size:0.75rem;">Start Time</label>
            <input type="time" class="ev-start-time">
          </div>
        </div>
        <div class="form-group" style="margin:0 0 0.5rem;">
          <label style="font-size:0.75rem;">Description *</label>
          <input type="text" class="ev-tm-desc" placeholder="Activity description…">
        </div>
      </div>

      <div class="add-form-row">
        <div class="form-group" style="margin:0;flex:0 0 120px;">
          <label style="font-size:0.75rem;">Duration (min) *</label>
          <input type="number" class="ev-duration" min="15" max="960" step="15" value="60" placeholder="60">
        </div>
      </div>

      <p class="par-error error-msg hidden" style="font-size:0.8rem;margin:0.35rem 0;"></p>
      <div class="add-form-actions">
        <button class="btn btn-primary btn-sm add-form-save" data-date="${dateStr}">Save</button>
        <button class="btn btn-secondary btn-sm add-form-cancel" data-date="${dateStr}">Cancel</button>
      </div>
    </div>`;
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

// ── Add form: type toggle ─────────────────────────────────────────────────────
function updateAddFormType(form) {
  const type = form.querySelector('.ev-type-radio:checked')?.value || 'counseling_session';
  const isTM = type === 'training_marketing';
  form.querySelector('.ev-rx-section').style.display  = isTM ? 'none'  : '';
  form.querySelector('.ev-tm-section').style.display  = isTM ? ''      : 'none';
  const deliveryRow = form.querySelector('.ev-delivery-row');
  if (deliveryRow) deliveryRow.style.display = type === 'counseling_session' ? '' : 'none';
}

// ── Rx lookup ─────────────────────────────────────────────────────────────────
async function performRxLookup(form) {
  const rxInput  = form.querySelector('.ev-rx-input');
  const resultEl = form.querySelector('.ev-rx-result');
  const rxNum    = (rxInput?.value || '').trim();
  if (!rxNum) { resultEl.textContent = 'Enter an Rx number first.'; resultEl.style.color = 'var(--danger)'; return; }

  resultEl.textContent = 'Looking up…';
  resultEl.style.color = 'var(--text-muted)';
  resultEl.removeAttribute('data-client-id');
  resultEl.removeAttribute('data-client-name');
  resultEl.removeAttribute('data-guarantor');
  resultEl.removeAttribute('data-nofa-initiative');
  resultEl.removeAttribute('data-par-section');
  resultEl.removeAttribute('data-par-row');

  try {
    const snap = await getDocs(
      query(collectionGroup(db, 'rxNumbers'), where('rxNumber', '==', rxNum))
    );
    const match = snap.docs.find(d => d.data().active !== false);
    if (!match) {
      resultEl.textContent = `Rx "${rxNum}" not found.`;
      resultEl.style.color = 'var(--danger)';
      return;
    }
    const rxData    = match.data();
    const clientId  = match.ref.parent.parent.id;
    const clientDoc = await getDoc(doc(db, 'clients', clientId));
    const clientName = clientDoc.exists() ? (clientDoc.data().clientName || clientId) : clientId;
    const guarantor  = rxData.guarantor || '';
    const nofaInit   = rxData.nofaInitiative || '';

    const { parSection, parRow } = deriveParSectionRow('counseling_session', guarantor, '');
    const sColor = parSection === 'S1' ? '#1a73e8' : '#6b7280';
    const badge  = `<span style="font-size:0.7rem;font-weight:700;padding:0.1rem 0.4rem;border-radius:20px;background:${sColor};color:#fff;margin-left:0.4rem;">${parSection}</span>`;
    resultEl.innerHTML = `<strong>${esc(clientName)}</strong> · ${esc(guarantor)}${nofaInit ? ' · ' + esc(nofaInit) : ''} ${badge}`;
    resultEl.style.color = '';

    resultEl.dataset.clientId      = clientId;
    resultEl.dataset.clientName    = clientName;
    resultEl.dataset.guarantor     = guarantor;
    resultEl.dataset.nofaInitiative = nofaInit;
    resultEl.dataset.parSection    = parSection;
    resultEl.dataset.parRow        = parRow;
  } catch (err) {
    resultEl.textContent = 'Lookup failed: ' + err.message;
    resultEl.style.color = 'var(--danger)';
  }
}

function deriveParSectionRow(type, guarantor, costType) {
  if (type === 'training_marketing') {
    return costType === 'M'
      ? { parSection: 'S3', parRow: 'Marketing' }
      : { parSection: 'S2', parRow: 'Training' };
  }
  if (guarantor === 'NOFA') {
    return type === 'case_management'
      ? { parSection: 'S1', parRow: 'Processing-Intake' }
      : { parSection: 'S1', parRow: 'Counseling' };
  }
  return type === 'case_management'
    ? { parSection: 'S4', parRow: 'Case Management' }
    : { parSection: 'S4', parRow: 'Individual Counseling' };
}

// ── Save new hudEvent ─────────────────────────────────────────────────────────
async function saveEntry(dateStr) {
  const container = document.getElementById(`day-${dateStr}`);
  const form      = container.querySelector('.add-entry-form');
  const errEl     = form.querySelector('.par-error');
  errEl.classList.add('hidden');

  const type     = form.querySelector('.ev-type-radio:checked')?.value || 'counseling_session';
  const durRaw   = parseInt(form.querySelector('.ev-duration')?.value, 10) || 0;
  const duration = Math.round(durRaw / 15) * 15;

  if (duration <= 0) { showFormErr(errEl, 'Duration must be at least 15 minutes.'); return; }

  let payload = {
    counselorId: _myId, counselorName: _myName,
    month: _month, date: dateStr, type,
    durationMinutes: duration,
    enteredBy: _user.uid, createdAt: serverTimestamp(),
  };

  if (type === 'training_marketing') {
    const costType  = form.querySelector('.ev-cost-type')?.value || 'T';
    const tmDesc    = form.querySelector('.ev-tm-desc')?.value.trim() || '';
    const startTime = form.querySelector('.ev-start-time')?.value || '';
    if (!tmDesc) { showFormErr(errEl, 'Description is required.'); return; }
    const { parSection, parRow } = deriveParSectionRow(type, '', costType);
    Object.assign(payload, { costType, description: tmDesc, startTime, parSection, parRow });
  } else {
    const resultEl   = form.querySelector('.ev-rx-result');
    const clientId   = resultEl?.dataset.clientId;
    const clientName = resultEl?.dataset.clientName;
    const guarantor  = resultEl?.dataset.guarantor;
    if (!clientId) { showFormErr(errEl, 'Look up an Rx number first.'); return; }
    const nofaInitiative = resultEl?.dataset.nofaInitiative || '';
    const rxCaseNo   = form.querySelector('.ev-rx-input')?.value.trim() || '';
    const activityNote = form.querySelector('.ev-note')?.value.trim() || '';
    const { parSection, parRow } = deriveParSectionRow(type, guarantor, '');
    let extra = { clientId, clientName, rxCaseNo, guarantor, nofaInitiative, activityNote, parSection, parRow };
    if (type === 'counseling_session') {
      extra.delivery = form.querySelector('.ev-delivery-radio:checked')?.value || 'face-to-face';
    }
    Object.assign(payload, extra);
  }

  const saveBtn = form.querySelector('.add-form-save');
  saveBtn.disabled = true; saveBtn.textContent = 'Saving…';

  try {
    await addDoc(collection(db, 'hudEvents'), payload);
    _openAddDay = null;
    await loadHudEvents();
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
function openDeleteModal(docId, src = 'legacy') {
  _pendingDeleteId  = docId;
  _pendingDeleteSrc = src;
  document.getElementById('deleteModalError').classList.add('hidden');
  document.getElementById('deleteModal').classList.remove('hidden');
}

async function confirmDelete() {
  if (!_pendingDeleteId) return;
  const btn        = document.getElementById('deleteConfirmBtn');
  const collection = _pendingDeleteSrc === 'event' ? 'hudEvents' : 'hudTimeEntries';
  btn.disabled = true; btn.textContent = 'Deleting…';
  try {
    await deleteDoc(doc(db, collection, _pendingDeleteId));
    document.getElementById('deleteModal').classList.add('hidden');
    _pendingDeleteId = null;
    if (_pendingDeleteSrc === 'event') { await loadHudEvents(); } else { await loadEntries(); }
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
    const all = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(c => c.active !== false);
    // Put the ED's own entry first so their tab is the default
    _edCounselors = [
      ...all.filter(c => c.id === _myId),
      ...all.filter(c => c.id !== _myId),
    ];
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
