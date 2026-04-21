import { db } from './firebase-config.js';
import { requireAuth, setupNav, isAdmin } from './auth.js';
import { COUNSELING_TYPES, AMI_LEVELS, RE_CODES, AWARD_TYPES, BILLING_TYPES, RX_GUARANTORS } from './data.js';
import { openDrivePicker } from './picker.js';
import {
  doc, getDoc, updateDoc, collection, getDocs, addDoc, deleteDoc,
  query, orderBy, where, serverTimestamp, limit
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const params   = new URLSearchParams(window.location.search);
const clientId = params.get('id');
if (!clientId) window.location.href = 'clients.html';

let _client           = null;
let _sessions         = [];
let _rxDocs           = [];   // clients/{id}/rxNumbers subcollection
let _profile          = null;
let _driveFolder      = null;
let _editingSessionId = null; // null = new session, else existing id

// ── Billing Type → report routing ─────────────────────────────────────────────
// billingType is stored on the client document (not per-session) and determines
// which activity log a client's sessions are routed to in HUD report generation.
//
//   "In-Person"                → sessions appear on CAL (Counseling Activity Log)
//   "Case Management Activity" → sessions appear on CML (Case Management Log)
//   "Court"                    → sessions appear on CML (Case Management Log)
//
// billingType is referenced starting in Prompt 6 when report output logic is built.
// Sessions inherit the client's billingType. No per-session override exists yet.
// ──────────────────────────────────────────────────────────────────────────────

// ── Entry point ───────────────────────────────────────────────────────────────

requireAuth(async (user, profile) => {
  _profile = profile;
  setupNav(profile, 'clients');

  buildSelects();
  await Promise.all([
    loadCounselorOptions('counselor'),
    loadCounselorOptions('sCounselor'),
  ]);

  await loadClient();
  await Promise.all([loadSessions(), loadRxNumbers(), loadCmcLink(), loadListMembership()]);

  wireClientForm();
  wireSessionModal();
  wireCloseFileModal();
  wireDriveFolder();
});

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadClient() {
  const snap = await getDoc(doc(db, 'clients', clientId));
  if (!snap.exists()) {
    alert('Client not found.');
    window.location.href = 'clients.html';
    return;
  }
  _client = { id: snap.id, ...snap.data() };
  populateClientForm(_client);
  renderHeader(_client);
}

async function loadSessions() {
  const snap = await getDocs(
    query(collection(db, 'clients', clientId, 'sessions'), orderBy('date', 'desc'))
  );
  _sessions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderSessionsTable(_sessions);
}

// Check cmcLog for any letter linked to this client and show the banner
async function loadCmcLink() {
  try {
    const snap = await getDocs(
      query(collection(db, 'cmcLog'), where('linkedClientId', '==', clientId))
    );
    const banner = document.getElementById('cmcBanner');
    if (snap.empty) return;

    // Build one line per linked CMC letter (usually just one, but handle multiples)
    const lines = snap.docs.map(d => {
      const r = d.data();
      const dateStr = r.dateSent
        ? (r.dateSent.toDate ? r.dateSent.toDate() : new Date(r.dateSent))
            .toLocaleDateString('en-US', { timeZone: 'UTC' })
        : '';
      return `CMC letter sent${dateStr ? ' ' + dateStr : ''}${r.counselor ? ' by ' + r.counselor : ''}`;
    });

    banner.innerHTML = '&#9993; ' + lines.join(' &nbsp;·&nbsp; ');
    banner.classList.remove('hidden');
  } catch (_) {
    // cmcLog collection may not exist yet — silently ignore
  }
}

// ── Build selects ─────────────────────────────────────────────────────────────

function buildSelects() {
  appendOptions('counselingType',   COUNSELING_TYPES);
  appendOptions('billingType',      BILLING_TYPES);
  appendOptions('amiPercent',       AMI_LEVELS);
  appendOptions('reCode',           RE_CODES);
  appendOptions('closureAwardType', AWARD_TYPES);
}

function appendOptions(id, list) {
  const sel = document.getElementById(id);
  if (!sel) return;
  list.forEach(v => {
    const o = document.createElement('option');
    o.value = v; o.textContent = v;
    sel.appendChild(o);
  });
}

async function loadCounselorOptions(selectId) {
  try {
    const snap = await getDocs(query(collection(db, 'counselors'), orderBy('name')));
    const sel  = document.getElementById(selectId);
    if (!sel) return;
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

// ── Populate client form ──────────────────────────────────────────────────────

function setSelectValue(id, val) {
  const el = document.getElementById(id);
  if (!el || val == null || val === '') return;
  el.value = val;
  if (el.value !== String(val)) {
    const opt = document.createElement('option');
    opt.value = val; opt.textContent = val;
    el.insertBefore(opt, el.options[1]);
    el.value = val;
  }
}

function populateClientForm(c) {
  setValue('clientName',    c.clientName);
  setValue('guarantor',     c.guarantor);
  setValue('zipCode',       c.zipCode);
  setSelectValue('counselingType', c.counselingType);
  setSelectValue('billingType',    c.billingType);
  setSelectValue('amiPercent',     c.amiPercent);
  setSelectValue('reCode',         c.reCode);

  // Counselor — inject custom option if not in list
  setSelectValue('counselor', c.counselor);

  document.getElementById('hispanic').checked     = !!c.hispanic;
  document.getElementById('femaleHeaded').checked = !!c.femaleHeaded;

  // rxPanel is populated by loadRxNumbers() after subcollection loads

  // PRE-specific: home search notes
  const isPre = c.counselingType === 'PRE';
  document.getElementById('areasSection').classList.toggle('hidden', !isPre);
  const notesEl = document.getElementById('homeSearchNotes');
  if (notesEl) notesEl.value = c.homeSearchNotes || '';

  // Drive folder
  if (c.driveFolderId) {
    _driveFolder = { id: c.driveFolderId, name: c.driveFolderName, url: c.driveFolderUrl };
  }
  renderFolderUI();

  // Show/hide home search notes section when type changes
  document.getElementById('counselingType').addEventListener('change', () => {
    const pre = document.getElementById('counselingType').value === 'PRE';
    document.getElementById('areasSection').classList.toggle('hidden', !pre);
  });
}

function setValue(id, val) {
  const el = document.getElementById(id);
  if (el && val != null) el.value = val;
}

// ── Header / banner ───────────────────────────────────────────────────────────

function renderHeader(c) {
  document.getElementById('pageTitle').textContent = c.clientName || 'Client Profile';

  const status = c.status || 'active';
  const badge  = status === 'closed'
    ? `<span class="badge badge-outstanding" style="font-size:0.75rem;">Closed</span>`
    : `<span class="badge badge-pre" style="font-size:0.75rem;">Active</span>`;
  document.getElementById('metaLine').innerHTML = `${badge} &nbsp; ${c.counselingType || ''} &nbsp; ${c.counselor || ''}`;

  const closedBanner  = document.getElementById('closedBanner');
  const closeFileBtn  = document.getElementById('closeFileBtn');
  const reopenFileBtn = document.getElementById('reopenFileBtn');

  // Determine if current user can close/reopen this file
  const canClose = isAdmin(_profile) ||
    (_client.counselor || '').toLowerCase() === (_profile?.name || '').toLowerCase();

  if (status === 'closed') {
    const dateStr    = c.closureDate ? toDate(c.closureDate).toLocaleDateString('en-US', { timeZone: 'UTC' }) : '';
    const valueStr   = c.closureOutcomeValue > 0
      ? ' · Outcome Value: $' + Number(c.closureOutcomeValue).toLocaleString('en-US', { minimumFractionDigits: 2 })
      : '';
    const typeStr    = c.closureAwardType ? ` (${c.closureAwardType})` : '';
    const notesStr   = c.closureOutcome ? ' — ' + c.closureOutcome : '';
    closedBanner.textContent = `File closed${dateStr ? ' on ' + dateStr : ''}${valueStr}${typeStr}${notesStr}`;
    closedBanner.classList.remove('hidden');
    closeFileBtn.classList.add('hidden');
    reopenFileBtn.classList.toggle('hidden', !canClose);
  } else {
    closedBanner.classList.add('hidden');
    closeFileBtn.classList.toggle('hidden', !canClose);
    reopenFileBtn.classList.add('hidden');
  }
}

function escHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function escAttr(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Tag input (Areas of Interest) ────────────────────────────────────────────

function renderAreaTags(items) {
  const box   = document.getElementById('areaTagBox');
  const input = document.getElementById('areaInput');
  if (!box || !input) return;

  // Remove existing chips (keep the input)
  box.querySelectorAll('.chip').forEach(c => c.remove());

  items.forEach((item, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `${escHtml(item)}<button type="button" class="chip-remove" aria-label="Remove">×</button>`;
    chip.querySelector('.chip-remove').addEventListener('click', () => {
      _client.areasOfInterest.splice(i, 1);
      renderAreaTags(_client.areasOfInterest);
    });
    box.insertBefore(chip, input);
  });
}

function addAreaTag(raw) {
  const val = raw.trim().replace(/,+$/, '').trim();
  if (!val) return;
  if (!_client.areasOfInterest) _client.areasOfInterest = [];
  if (_client.areasOfInterest.includes(val)) return; // no dupes
  _client.areasOfInterest.push(val);
  renderAreaTags(_client.areasOfInterest);
}

// ── CCA percentage (closure modal) ───────────────────────────────────────────

function updateClosureCcaPercent() {
  const dp  = parseFloat(document.getElementById('closureTotalDownPayment').value) || 0;
  const cca = parseFloat(document.getElementById('closureCcaAmount').value)        || 0;
  const pct = dp > 0 ? ((cca / dp) * 100).toFixed(1) + '%' : '—';
  document.getElementById('closureCcaPercent').value = pct;
}

// ── Wire client form ──────────────────────────────────────────────────────────

function wireClientForm() {
  // Save client
  document.getElementById('saveClientBtn').addEventListener('click', saveClient);

  // Close File button
  document.getElementById('closeFileBtn').addEventListener('click', () => {
    document.getElementById('closureDate').value         = new Date().toISOString().split('T')[0];
    document.getElementById('closureOutcome').value      = '';
    document.getElementById('closureOutcomeValue').value = '';
    document.getElementById('closureAwardType').value    = '';
    document.getElementById('closeFileError').classList.add('hidden');

    // CCA section — only for PRE clients
    const isPre = (_client.counselingType === 'PRE');
    const ccaSec = document.getElementById('closureCcaSection');
    if (isPre) {
      ccaSec.classList.remove('hidden');
      ccaSec.style.display = 'contents';
      document.getElementById('closureTotalDownPayment').value = _client.totalDownPayment || '';
      document.getElementById('closureCcaAmount').value        = _client.ccaAmountProvided || '';
      updateClosureCcaPercent();
    } else {
      ccaSec.classList.add('hidden');
      ccaSec.style.display = 'none';
    }

    document.getElementById('closeFileModal').classList.remove('hidden');
  });

  // CCA live calc in modal
  ['closureTotalDownPayment','closureCcaAmount'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateClosureCcaPercent);
  });

  // Reopen File button
  document.getElementById('reopenFileBtn').addEventListener('click', async () => {
    if (!confirm('Reopen this file?')) return;
    try {
      await updateDoc(doc(db, 'clients', clientId), {
        status: 'active',
        closureDate: null,
        closureOutcome: '',
        updatedAt: serverTimestamp(),
      });
      _client.status = 'active';
      _client.closureDate = null;
      _client.closureOutcome = '';
      renderHeader(_client);
    } catch (err) {
      alert('Failed to reopen: ' + err.message);
    }
  });

  // Add Session
  document.getElementById('addSessionBtn').addEventListener('click', openAddSession);
}

async function saveClient() {
  const saveBtn = document.getElementById('saveClientBtn');
  const msgEl   = document.getElementById('clientSaveMsg');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';
  msgEl.classList.add('hidden');

  try {
    const counselingType = document.getElementById('counselingType').value;
    const isPre = counselingType === 'PRE';

    const data = {
      clientName:        toTitleCase(document.getElementById('clientName').value.trim()),
      counselingType,
      billingType:       document.getElementById('billingType').value,
      counselor:         document.getElementById('counselor').value,
      guarantor:         document.getElementById('guarantor').value.trim(),
      zipCode:           document.getElementById('zipCode').value.trim(),
      amiPercent:        document.getElementById('amiPercent').value,
      reCode:            document.getElementById('reCode').value,
      hispanic:          document.getElementById('hispanic').checked,
      femaleHeaded:      document.getElementById('femaleHeaded').checked,
      homeSearchNotes:   (document.getElementById('homeSearchNotes')?.value || '').trim(),
      driveFolderId:     _driveFolder?.id   || '',
      driveFolderName:   _driveFolder?.name || '',
      driveFolderUrl:    _driveFolder?.url  || '',
      updatedAt:         serverTimestamp(),
    };

    await updateDoc(doc(db, 'clients', clientId), data);
    Object.assign(_client, data);
    renderHeader(_client);
    syncClientToLists(data); // fire-and-forget; non-blocking
    msgEl.textContent = 'Saved.';
    msgEl.style.color = 'var(--success, green)';
    msgEl.classList.remove('hidden');
    setTimeout(() => msgEl.classList.add('hidden'), 2500);
  } catch (err) {
    msgEl.textContent = 'Save failed: ' + err.message;
    msgEl.style.color = 'var(--danger, red)';
    msgEl.classList.remove('hidden');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Changes';
  }
}

function toTitleCase(str) {
  if (!str) return str;
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

// ── Session table ─────────────────────────────────────────────────────────────

function toDate(ts) {
  if (!ts) return new Date(0);
  return ts.toDate ? ts.toDate() : new Date(ts);
}

function fmtDate(ts) {
  if (!ts) return '—';
  return toDate(ts).toLocaleDateString('en-US', { timeZone: 'UTC' });
}

function fmtMoney(val) {
  const n = Number(val) || 0;
  return n > 0 ? '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2 }) : '—';
}

function renderSessionsTable(sessions) {
  const tbody = document.getElementById('sessionsBody');
  if (!sessions.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:2rem;color:var(--text-muted)">No sessions yet.</td></tr>';
    return;
  }

  tbody.innerHTML = sessions.map(s => `
    <tr>
      <td style="white-space:nowrap">${fmtDate(s.date)}</td>
      <td>${escHtml(s.counselor || '—')}</td>
      <td>${escHtml(s.rxNumber || '—')}</td>
      <td style="text-align:right">${s.hours || '—'}</td>
      <td>${escHtml(s.caseStatus || '—')}</td>
      <td class="session-notes" title="${escHtml(s.notes || '')}">${escHtml(s.notes || '—')}</td>
      <td><button class="btn btn-sm btn-secondary" data-session-id="${s.id}">Edit</button></td>
    </tr>`).join('');

  tbody.querySelectorAll('button[data-session-id]').forEach(btn => {
    btn.addEventListener('click', () => openEditSession(btn.dataset.sessionId));
  });
}

// ── Session modal ─────────────────────────────────────────────────────────────

function wireSessionModal() {
  document.getElementById('sessionModalCancel').addEventListener('click', closeSessionModal);
  document.getElementById('sessionModalSave').addEventListener('click', saveSession);
  document.getElementById('sessionModalDelete').addEventListener('click', deleteSession);

  // Close on overlay click
  document.getElementById('sessionModal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('sessionModal')) closeSessionModal();
  });
}

function openAddSession() {
  _editingSessionId = null;
  document.getElementById('sessionModalTitle').textContent = 'Add Session';
  document.getElementById('sessionModalDelete').classList.add('hidden');
  clearSessionModal();

  // Defaults
  document.getElementById('sDate').value      = new Date().toISOString().split('T')[0];
  document.getElementById('sCounselor').value = _client.counselor || '';
  // Pre-fill with the first HUD-billable Rx (NOFA + active), else first active, else first
  const defaultRx = (
    _rxDocs.find(r => r.active !== false && r.guarantor === 'NOFA') ||
    _rxDocs.find(r => r.active !== false) ||
    _rxDocs[0]
  )?.rxNumber || '';
  document.getElementById('sRxNumber').value = defaultRx;

  document.getElementById('sessionModalError').classList.add('hidden');
  document.getElementById('sessionModal').classList.remove('hidden');
}

function openEditSession(sessionId) {
  const session = _sessions.find(s => s.id === sessionId);
  if (!session) return;

  _editingSessionId = sessionId;
  document.getElementById('sessionModalTitle').textContent = 'Edit Session';
  document.getElementById('sessionModalDelete').classList.remove('hidden');

  // Populate
  document.getElementById('sDate').value         = toDateInputValue(session.date);
  document.getElementById('sCounselor').value    = session.counselor || '';
  document.getElementById('sRxNumber').value     = session.rxNumber  || '';
  document.getElementById('sHours').value        = session.hours     || '';
  document.getElementById('sDollarsFor').value   = session.dollarsFor  || '';
  document.getElementById('sCaseStatus').value   = session.caseStatus  || '';
  document.getElementById('sOutcome').value      = session.outcome     || '';
  document.getElementById('sNotes').value        = session.notes       || '';

  document.getElementById('sessionModalError').classList.add('hidden');
  document.getElementById('sessionModal').classList.remove('hidden');
}

function clearSessionModal() {
  ['sDate','sCounselor','sRxNumber','sHours',
   'sDollarsFor','sCaseStatus','sOutcome','sNotes'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
}

function closeSessionModal() {
  document.getElementById('sessionModal').classList.add('hidden');
  _editingSessionId = null;
}

function toDateInputValue(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toISOString().split('T')[0];
}

function readSessionForm() {
  const dateVal = document.getElementById('sDate').value;
  return {
    date:          dateVal ? new Date(dateVal + 'T12:00:00') : null,
    counselor:     document.getElementById('sCounselor').value,
    rxNumber:      document.getElementById('sRxNumber').value.trim(),
    hours:         parseFloat(document.getElementById('sHours').value) || 0,
    dollarsFor:    document.getElementById('sDollarsFor').value.trim(),
    caseStatus:    document.getElementById('sCaseStatus').value.trim(),
    outcome:       document.getElementById('sOutcome').value.trim(),
    notes:         document.getElementById('sNotes').value.trim(),
    updatedAt:     serverTimestamp(),
    // billingType: "In-Person" | "Case Management Activity" | "Court"
    // Not yet collected by the UI; treat as null when absent on historical sessions.
  };
}

async function saveSession() {
  const errorEl = document.getElementById('sessionModalError');
  const saveBtn = document.getElementById('sessionModalSave');
  errorEl.classList.add('hidden');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    const data = readSessionForm();

    if (_editingSessionId) {
      // Update existing
      await updateDoc(
        doc(db, 'clients', clientId, 'sessions', _editingSessionId),
        data
      );
    } else {
      // New session
      data.createdAt = serverTimestamp();
      await addDoc(collection(db, 'clients', clientId, 'sessions'), data);
    }

    // Refresh denormalized fields on client doc
    await refreshClientDenormalized();

    closeSessionModal();
    await loadSessions();
  } catch (err) {
    errorEl.textContent = 'Save failed: ' + err.message;
    errorEl.classList.remove('hidden');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Session';
  }
}

async function deleteSession() {
  if (!_editingSessionId) return;
  if (!confirm('Delete this session? This cannot be undone.')) return;

  const delBtn = document.getElementById('sessionModalDelete');
  delBtn.disabled = true;
  delBtn.textContent = 'Deleting…';

  try {
    await deleteDoc(doc(db, 'clients', clientId, 'sessions', _editingSessionId));
    await refreshClientDenormalized();
    closeSessionModal();
    await loadSessions();
  } catch (err) {
    alert('Delete failed: ' + err.message);
    delBtn.disabled = false;
    delBtn.textContent = 'Delete Session';
  }
}

// Re-compute denormalized fields (sessionCount, totalOutcomeValue, lastSessionDate, firstSessionDate)
async function refreshClientDenormalized() {
  const snap = await getDocs(
    query(collection(db, 'clients', clientId, 'sessions'), orderBy('date', 'asc'))
  );
  const sessions = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  const sessionCount      = sessions.length;
  const totalOutcomeValue = sessions.reduce((s, r) => s + (Number(r.dollarsAwarded) || 0), 0);
  const dated             = sessions.filter(s => s.date);
  const firstSessionDate  = dated.length ? dated[0].date : null;
  const lastSessionDate   = dated.length ? dated[dated.length - 1].date : null;

  await updateDoc(doc(db, 'clients', clientId), {
    sessionCount,
    totalOutcomeValue,
    firstSessionDate,
    lastSessionDate,
    updatedAt: serverTimestamp(),
  });

  _client.sessionCount      = sessionCount;
  _client.totalOutcomeValue = totalOutcomeValue;
}

// ── Program Lists (Buyer Ready / Repair Ready) ───────────────────────────────
//
// The "Program Lists" card at the bottom of the profile shows whether this
// client is enrolled on the Buyer Ready (ccaList) or Repair Ready (higWaitlist)
// list. Each slot shows either a "View on {List}" link or an "+ Add to {List}"
// button, depending on whether a linked record exists.
//
// The link is established by storing clientId as a foreign key on the list doc.
// limit(1) is used because each client should appear on each list at most once.

async function loadListMembership() {
  try {
    const [ccaSnap, higSnap] = await Promise.all([
      getDocs(query(collection(db, 'ccaList'),    where('clientId', '==', clientId), limit(1))),
      getDocs(query(collection(db, 'higWaitlist'), where('clientId', '==', clientId), limit(1))),
    ]);
    renderListSlot('buyerReadySlot',  ccaSnap.empty  ? null : ccaSnap.docs[0].id,  'Buyer Ready',  'cca-list');
    renderListSlot('homeRepairsSlot', higSnap.empty  ? null : higSnap.docs[0].id,  'Home Repairs', 'hig-waitlist');
  } catch (_) {}
}

function renderListSlot(slotId, linkedId, label, page) {
  const slot = document.getElementById(slotId);
  if (!slot) return;
  if (linkedId) {
    slot.innerHTML = `<a href="${page}.html" class="btn btn-secondary btn-sm">View on ${label}</a>`;
  } else {
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary btn-sm';
    btn.textContent = `+ Add to ${label}`;
    btn.addEventListener('click', () => addToList(slotId, label, page));
    slot.innerHTML = '';
    slot.appendChild(btn);
  }
}

async function addToList(slotId, label, page) {
  const btn = document.querySelector(`#${slotId} button`);
  if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
  try {
    const base = {
      clientId:        clientId,
      clientName:      _client.clientName  || '',
      amiPercent:      _client.amiPercent  || '',
      driveFolderId:   _client.driveFolderId  || '',
      driveFolderName: _client.driveFolderName || '',
      driveFolderUrl:  _client.driveFolderUrl  || '',
      enrolledAt:      serverTimestamp(),
      updatedAt:       serverTimestamp(),
      notes:           '',
      status:          page === 'cca-list' ? 'eligible' : 'waitlisted',
    };
    if (page === 'cca-list') {
      Object.assign(base, { counselor: _client.counselor || '', closingDate: null, ccaAmount: 0 });
      await addDoc(collection(db, 'ccaList'), base);
    } else {
      Object.assign(base, { scopeOfWork: '', estimatedBudget: 0, estimatedDays: 0 });
      await addDoc(collection(db, 'higWaitlist'), base);
    }
    await loadListMembership();
  } catch (err) {
    alert('Failed to add to list: ' + err.message);
    if (btn) { btn.disabled = false; btn.textContent = `+ Add to ${label}`; }
  }
}

// Called (fire-and-forget, without await) after every client profile save.
// Finds any ccaList / higWaitlist records linked to this client and pushes
// the updated name, counselor, AMI, and Drive folder to them, so the list
// pages always reflect the latest client data without the counselor having
// to update two places. Errors are silently swallowed — a sync failure
// should never block the profile save from completing.
async function syncClientToLists(data) {
  try {
    const ccaBase = {
      clientName:      data.clientName      || '',
      counselor:       data.counselor       || '',
      amiPercent:      data.amiPercent      || '',
      driveFolderId:   data.driveFolderId   || '',
      driveFolderName: data.driveFolderName || '',
      driveFolderUrl:  data.driveFolderUrl  || '',
      updatedAt:       serverTimestamp(),
    };
    const higBase = { ...ccaBase };
    delete higBase.counselor; // hig records don't track counselor

    const [ccaSnap, higSnap] = await Promise.all([
      getDocs(query(collection(db, 'ccaList'),    where('clientId', '==', clientId))),
      getDocs(query(collection(db, 'higWaitlist'), where('clientId', '==', clientId))),
    ]);
    await Promise.all([
      ...ccaSnap.docs.map(d => updateDoc(doc(db, 'ccaList',    d.id), ccaBase)),
      ...higSnap.docs.map(d => updateDoc(doc(db, 'higWaitlist', d.id), higBase)),
    ]);
  } catch (_) {}
}

// ── Rx Numbers subcollection panel ───────────────────────────────────────────

async function loadRxNumbers() {
  try {
    const snap = await getDocs(
      query(collection(db, 'clients', clientId, 'rxNumbers'), orderBy('createdAt', 'asc'))
    );
    _rxDocs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (_) {
    _rxDocs = [];
  }
  renderRxPanel();
}

function renderRxPanel() {
  const panel = document.getElementById('rxPanel');
  if (!panel) return;

  const legacyRx     = (_client.rxNumber || '').trim();
  const legacyInSub  = legacyRx && _rxDocs.some(r => r.rxNumber === legacyRx);

  const TH = 'style="text-align:left;padding:0.4rem 0.6rem;border-bottom:2px solid var(--border);font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);"';
  const TD = 'style="padding:0.4rem 0.6rem;border-bottom:1px solid var(--border);"';

  let html = '';

  if (legacyRx && !legacyInSub) {
    html += `<p style="font-size:0.8rem;color:var(--text-muted);margin-bottom:0.75rem;padding:0.45rem 0.75rem;background:#fff8e1;border-left:3px solid #f59e0b;border-radius:var(--radius);">
      Legacy Rx on file: <strong>${escHtml(legacyRx)}</strong> — migrated, assign guarantor above
    </p>`;
  }

  if (_rxDocs.length) {
    html += `<table style="width:100%;border-collapse:collapse;font-size:0.875rem;margin-bottom:0.75rem;">
      <thead>
        <tr style="background:#f8f9fb;">
          <th ${TH}>Rx #</th>
          <th ${TH}>Guarantor</th>
          <th ${TH} style="text-align:center;">Active</th>
          <th style="padding:0.4rem 0.6rem;border-bottom:2px solid var(--border);"></th>
        </tr>
      </thead>
      <tbody>
        ${_rxDocs.map(r => {
          const isHud = r.active !== false && r.guarantor === 'NOFA';
          const hudBadge = isHud
            ? `<span style="font-size:0.68rem;font-weight:700;padding:0.1rem 0.45rem;border-radius:20px;background:#1a73e8;color:#fff;margin-left:0.4rem;vertical-align:middle;">HUD</span>`
            : '';
          const guarantorOpts = ['', ...RX_GUARANTORS].map(v =>
            `<option value="${escAttr(v)}" ${v === (r.guarantor || '') ? 'selected' : ''}>${v || '— none —'}</option>`
          ).join('');
          return `<tr>
            <td ${TD}>${escHtml(r.rxNumber)}${hudBadge}</td>
            <td ${TD}>
              <select class="rx-guarantor" data-rx-id="${escAttr(r.id)}"
                style="font-size:0.8125rem;padding:0.25rem 0.4rem;border:1px solid var(--border);border-radius:var(--radius);">
                ${guarantorOpts}
              </select>
            </td>
            <td ${TD} style="text-align:center;">
              <input type="checkbox" class="rx-active" data-rx-id="${escAttr(r.id)}" ${r.active !== false ? 'checked' : ''}>
            </td>
            <td ${TD} style="white-space:nowrap;">
              <button class="btn btn-sm btn-secondary rx-save-btn" data-rx-id="${escAttr(r.id)}" style="font-size:0.75rem;">Save</button>
              <button class="btn btn-sm btn-danger rx-remove-btn" data-rx-id="${escAttr(r.id)}" style="font-size:0.75rem;margin-left:4px;">×</button>
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
  } else {
    html += `<p style="font-size:0.875rem;color:var(--text-muted);margin-bottom:0.75rem;">No Rx numbers on file.</p>`;
  }

  html += `
    <div id="rxAddForm" class="hidden" style="display:flex;gap:0.5rem;align-items:flex-end;flex-wrap:wrap;padding:0.75rem;background:#f8f9fb;border:1px solid var(--border);border-radius:var(--radius);margin-bottom:0.5rem;">
      <div class="form-group" style="margin:0;flex:1;min-width:140px;">
        <label style="font-size:0.75rem;">Rx Number *</label>
        <input type="text" id="rxNewNumber" placeholder="Enter Rx #">
      </div>
      <div class="form-group" style="margin:0;flex:0 0 150px;">
        <label style="font-size:0.75rem;">Guarantor *</label>
        <select id="rxNewGuarantor">
          <option value="">— required —</option>
          ${RX_GUARANTORS.map(v => `<option value="${escAttr(v)}">${escHtml(v)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group" style="margin:0;">
        <label style="font-size:0.75rem;">Active</label>
        <div style="padding-top:0.5rem;"><input type="checkbox" id="rxNewActive" checked></div>
      </div>
      <div style="display:flex;gap:0.4rem;align-self:flex-end;padding-bottom:2px;">
        <button type="button" id="rxAddConfirmBtn" class="btn btn-primary btn-sm">Add</button>
        <button type="button" id="rxAddCancelBtn" class="btn btn-secondary btn-sm">Cancel</button>
      </div>
    </div>
    <button type="button" id="rxShowAddBtn" class="btn btn-secondary btn-sm">+ Add Rx #</button>
    <p id="rxPanelMsg" class="hidden" style="font-size:0.8125rem;margin-top:0.5rem;"></p>`;

  panel.innerHTML = html;

  document.getElementById('rxShowAddBtn').addEventListener('click', () => {
    document.getElementById('rxAddForm').classList.remove('hidden');
    document.getElementById('rxAddForm').style.display = 'flex';
    document.getElementById('rxShowAddBtn').classList.add('hidden');
    document.getElementById('rxNewNumber').focus();
  });
  document.getElementById('rxAddCancelBtn').addEventListener('click', resetRxAddForm);
  document.getElementById('rxAddConfirmBtn').addEventListener('click', addRxNumber);

  panel.querySelectorAll('.rx-save-btn').forEach(btn =>
    btn.addEventListener('click', () => saveRxRow(btn.dataset.rxId))
  );
  panel.querySelectorAll('.rx-remove-btn').forEach(btn =>
    btn.addEventListener('click', () => deleteRxRow(btn.dataset.rxId))
  );
}

function resetRxAddForm() {
  const form = document.getElementById('rxAddForm');
  if (!form) return;
  form.classList.add('hidden');
  document.getElementById('rxShowAddBtn').classList.remove('hidden');
  document.getElementById('rxNewNumber').value   = '';
  document.getElementById('rxNewGuarantor').value = '';
  document.getElementById('rxNewActive').checked = true;
}

async function saveRxRow(rxId) {
  const guarEl  = document.querySelector(`.rx-guarantor[data-rx-id="${rxId}"]`);
  const actEl   = document.querySelector(`.rx-active[data-rx-id="${rxId}"]`);
  const saveBtn = document.querySelector(`.rx-save-btn[data-rx-id="${rxId}"]`);
  if (!guarEl || !actEl) return;

  saveBtn.disabled    = true;
  saveBtn.textContent = '…';

  try {
    await updateDoc(doc(db, 'clients', clientId, 'rxNumbers', rxId), {
      guarantor: guarEl.value,
      active:    actEl.checked,
    });
    const rxDoc = _rxDocs.find(r => r.id === rxId);
    if (rxDoc) { rxDoc.guarantor = guarEl.value; rxDoc.active = actEl.checked; }
    renderRxPanel();
  } catch (err) {
    alert('Save failed: ' + err.message);
    saveBtn.disabled    = false;
    saveBtn.textContent = 'Save';
  }
}

async function deleteRxRow(rxId) {
  if (!confirm('Remove this Rx number? This cannot be undone.')) return;
  try {
    await deleteDoc(doc(db, 'clients', clientId, 'rxNumbers', rxId));
    _rxDocs = _rxDocs.filter(r => r.id !== rxId);
    renderRxPanel();
  } catch (err) {
    alert('Remove failed: ' + err.message);
  }
}

async function addRxNumber() {
  const numEl  = document.getElementById('rxNewNumber');
  const guarEl = document.getElementById('rxNewGuarantor');
  const actEl  = document.getElementById('rxNewActive');
  const addBtn = document.getElementById('rxAddConfirmBtn');

  const rxNumber  = numEl.value.trim();
  const guarantor = guarEl.value;
  if (!rxNumber)  { alert('Enter an Rx number.'); numEl.focus(); return; }
  if (!guarantor) { alert('Select a guarantor.'); guarEl.focus(); return; }

  addBtn.disabled    = true;
  addBtn.textContent = 'Adding…';

  try {
    const ref = await addDoc(collection(db, 'clients', clientId, 'rxNumbers'), {
      rxNumber,
      guarantor,
      active:    actEl.checked,
      createdAt: serverTimestamp(),
    });
    _rxDocs.push({ id: ref.id, rxNumber, guarantor, active: actEl.checked });
    renderRxPanel();
  } catch (err) {
    alert('Add failed: ' + err.message);
    addBtn.disabled    = false;
    addBtn.textContent = 'Add';
  }
}

// ── Close File modal ──────────────────────────────────────────────────────────

function wireCloseFileModal() {
  document.getElementById('closeFileCancel').addEventListener('click', () => {
    document.getElementById('closeFileModal').classList.add('hidden');
  });
  document.getElementById('closeFileConfirm').addEventListener('click', closeFile);

  document.getElementById('closeFileModal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('closeFileModal')) {
      document.getElementById('closeFileModal').classList.add('hidden');
    }
  });
}

async function closeFile() {
  const errorEl  = document.getElementById('closeFileError');
  const confirmBtn = document.getElementById('closeFileConfirm');
  errorEl.classList.add('hidden');
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Closing…';

  try {
    const dateVal             = document.getElementById('closureDate').value;
    const outcome             = document.getElementById('closureOutcome').value.trim();
    const closureOutcomeValue = parseFloat(document.getElementById('closureOutcomeValue').value) || 0;
    const closureAwardType    = document.getElementById('closureAwardType').value;
    const isPre               = _client.counselingType === 'PRE';
    const totalDownPayment    = isPre ? (parseFloat(document.getElementById('closureTotalDownPayment').value) || 0) : 0;
    const ccaAmountProvided   = isPre ? (parseFloat(document.getElementById('closureCcaAmount').value)        || 0) : 0;

    await updateDoc(doc(db, 'clients', clientId), {
      status:               'closed',
      closureDate:          dateVal ? new Date(dateVal + 'T12:00:00') : null,
      closureOutcome:       outcome,
      closureOutcomeValue,
      closureAwardType,
      totalDownPayment,
      ccaAmountProvided,
      updatedAt:            serverTimestamp(),
    });

    _client.status               = 'closed';
    _client.closureDate          = dateVal ? new Date(dateVal + 'T12:00:00') : null;
    _client.closureOutcome       = outcome;
    _client.closureOutcomeValue  = closureOutcomeValue;
    _client.closureAwardType     = closureAwardType;
    _client.totalDownPayment     = totalDownPayment;
    _client.ccaAmountProvided    = ccaAmountProvided;

    document.getElementById('closeFileModal').classList.add('hidden');
    renderHeader(_client);
  } catch (err) {
    errorEl.textContent = 'Failed to close file: ' + err.message;
    errorEl.classList.remove('hidden');
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Close File';
  }
}

// ── Drive Folder ──────────────────────────────────────────────────────────────

function wireDriveFolder() {
  document.getElementById('linkFolderBtn').addEventListener('click', async () => {
    try {
      const folder = await openDrivePicker();
      if (folder) { _driveFolder = folder; renderFolderUI(); }
    } catch (err) {
      alert('Could not open Drive picker: ' + err.message);
    }
  });

  document.getElementById('unlinkFolderBtn').addEventListener('click', () => {
    _driveFolder = null;
    renderFolderUI();
  });
}

function renderFolderUI() {
  const linkBtn    = document.getElementById('linkFolderBtn');
  const folderLink = document.getElementById('driveFolderLink');
  const unlinkBtn  = document.getElementById('unlinkFolderBtn');

  if (_driveFolder) {
    folderLink.href        = _driveFolder.url;
    folderLink.textContent = _driveFolder.name || 'Open folder';
    folderLink.classList.remove('hidden');
    unlinkBtn.classList.remove('hidden');
    linkBtn.textContent = 'Change Folder';
  } else {
    folderLink.classList.add('hidden');
    unlinkBtn.classList.add('hidden');
    linkBtn.textContent = 'Link Drive Folder';
  }
}
