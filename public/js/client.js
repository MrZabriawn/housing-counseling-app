import { db } from './firebase-config.js';
import { requireAuth, setupNav, isAdmin } from './auth.js';
import { isDemoMode, demoClientName } from './demo-mode.js';
import { COUNSELING_TYPES, RE_CODES, AWARD_TYPES, BILLING_TYPES, RX_GUARANTORS, amiDisplayLabel } from './data.js';
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
let _user             = null;
let _isED             = false;
let _allUsers         = [];   // { uid, name } from users/{uid}
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
  _user    = user;
  _profile = profile;
  _isED    = profile.role === 'executive_director';
  setupNav(profile, 'clients');

  buildSelects();
  await Promise.all([
    loadCounselorOptions('counselor'),
    loadCounselorOptions('sCounselor'),
    loadAllUsers(),
  ]);

  await loadClient();
  await Promise.all([loadSessions(), loadRxNumbers(), loadCmcLink(), loadListMembership(), loadOutreachHistory()]);

  wireClientForm();
  wireSessionModal();
  wireCloseFileModal();
  wireDriveFolder();
  wireLogCallModal();
});

// ── Data loading ──────────────────────────────────────────────────────────────

function canViewClient(c) {
  const tier = c.confidentialityTier || 'standard';
  if (tier === 'standard') return true;
  if (_isED) return true;
  return (_user != null) && (c.careTeam || []).includes(_user.uid);
}

function canViewSSN() {
  if (_isED) return true;
  return _profile?.name && _client?.counselor &&
    _profile.name.toLowerCase() === _client.counselor.toLowerCase();
}

function maskSSN(ssn) {
  if (!ssn) return '';
  const d = ssn.replace(/\D/g, '');
  return d.length >= 4 ? `***-**-${d.slice(-4)}` : '***-**-****';
}

function initSsnField(inputId, btnId, realValue) {
  const input = document.getElementById(inputId);
  const btn   = document.getElementById(btnId);
  if (!input) return;

  if (!canViewSSN()) {
    const group = input.closest('.form-group');
    if (group) {
      group.innerHTML = `<label>Social Security Number</label><p style="margin:0.25rem 0 0;font-family:monospace;color:var(--text-muted);">${realValue ? maskSSN(realValue) : '—'}</p>`;
    }
    return;
  }

  input.dataset.realValue = realValue || '';
  input.value   = realValue ? maskSSN(realValue) : '';
  input.readOnly = true;
  input.dataset.revealed = 'false';
  if (!btn) return;

  btn.addEventListener('click', () => {
    if (input.dataset.revealed === 'false') {
      input.value = input.dataset.realValue;
      input.readOnly = false;
      input.dataset.revealed = 'true';
      btn.title = 'Hide SSN';
      btn.textContent = 'Hide';
    } else {
      input.dataset.realValue = input.value.trim();
      input.value    = input.dataset.realValue ? maskSSN(input.dataset.realValue) : '';
      input.readOnly = true;
      input.dataset.revealed = 'false';
      btn.title = 'Show SSN';
      btn.innerHTML = '&#128065;';
    }
  });
}

function readSsnField(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return '';
  if (input.dataset.revealed === 'true') return input.value.trim();
  return input.dataset.realValue || '';
}

function writeAccessLog(event, extra = {}) {
  addDoc(collection(db, 'accessLog'), {
    clientId,
    event,
    accessedBy:     _user.uid,
    accessedByName: _profile.name || '',
    tier:           _client.confidentialityTier || 'standard',
    accessedAt:     serverTimestamp(),
    ...extra,
  }).catch(() => {});
}

async function loadAllUsers() {
  try {
    const snap = await getDocs(collection(db, 'users'));
    _allUsers = snap.docs.map(d => ({
      uid:  d.id,
      name: d.data().name || d.data().email || d.id,
    }));
  } catch (_) { _allUsers = []; }
}

async function loadClient() {
  const snap = await getDoc(doc(db, 'clients', clientId));
  if (!snap.exists()) {
    alert('Client not found.');
    window.location.href = 'clients.html';
    return;
  }
  _client = { id: snap.id, ...snap.data() };

  if (!canViewClient(_client)) {
    alert('Access denied. You do not have permission to view this client.');
    window.location.href = 'clients.html';
    return;
  }

  const tier = _client.confidentialityTier || 'standard';
  if (tier !== 'standard') {
    writeAccessLog('view');
  }

  populateClientForm(_client);
  if (isDemoMode()) applyDemoRedactions();
  renderHeader(_client);
  renderConfidentialitySection();
}

async function loadSessions() {
  const snap = await getDocs(
    query(collection(db, 'clients', clientId, 'sessions'), orderBy('date', 'desc'))
  );
  _sessions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderSessionsTable(_sessions);
}

// Check cmcLog for any letter linked to this client and show the banner.
// If none is linked, show a button letting the counselor link one.
async function loadCmcLink() {
  const banner = document.getElementById('cmcBanner');
  try {
    const snap = await getDocs(
      query(collection(db, 'cmcLog'), where('linkedClientId', '==', clientId))
    );

    if (!snap.empty) {
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
    } else {
      banner.innerHTML =
        '<span style="color:var(--text-muted);">No CMC letter linked.</span>' +
        '<button id="openCmcLinkBtn" class="btn btn-sm btn-secondary" style="margin-left:0.75rem;font-size:0.78rem;">Link CMC Letter</button>';
      banner.classList.remove('hidden');
      document.getElementById('openCmcLinkBtn').addEventListener('click', openCmcLinkPanel);
    }
  } catch (_) {
    // cmcLog collection may not exist yet — silently ignore
  }
}

async function openCmcLinkPanel() {
  const panel = document.getElementById('cmcLinkPanel');
  panel.innerHTML = '<p style="color:var(--text-muted);font-size:0.875rem;padding:0.5rem 0;">Loading letters…</p>';
  panel.classList.remove('hidden');

  try {
    const snap = await getDocs(query(collection(db, 'cmcLog'), orderBy('dateSent', 'desc')));
    const unlinked = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => !r.linkedClientId);

    if (!unlinked.length) {
      panel.innerHTML = '<p style="color:var(--text-muted);font-size:0.875rem;padding:0.5rem 0;">No unlinked CMC letters found.</p>';
      return;
    }

    function rowHtml(r) {
      const dateStr = r.dateSent
        ? (r.dateSent.toDate ? r.dateSent.toDate() : new Date(r.dateSent))
            .toLocaleDateString('en-US', { timeZone: 'UTC' })
        : '—';
      return `<div class="cmc-link-row" data-id="${escAttr(r.id)}"
        style="padding:0.5rem 0.75rem;cursor:pointer;border-bottom:1px solid #f0f1f3;font-size:0.875rem;">
        <strong>${escHtml(r.recipientName || '—')}</strong>
        <span style="color:var(--text-muted);font-size:0.8rem;margin-left:0.5rem;">${escHtml(dateStr)}${r.counselor ? ' · ' + escHtml(r.counselor) : ''}</span>
      </div>`;
    }

    panel.innerHTML = `
      <div style="border:1px solid var(--primary);border-radius:var(--radius);padding:1rem;background:#f0f4ff;">
        <div style="font-weight:600;margin-bottom:0.5rem;font-size:0.875rem;">Select CMC Letter to Link</div>
        <input type="text" id="cmcLinkSearch" placeholder="Search by name…"
          style="width:100%;margin-bottom:0.5rem;padding:0.35rem 0.5rem;border:1px solid var(--border);border-radius:var(--radius);font-size:0.875rem;">
        <div id="cmcLinkList" style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius);background:#fff;">
          ${unlinked.map(rowHtml).join('')}
        </div>
        <div id="cmcLinkSelected" style="margin-top:0.5rem;font-size:0.8rem;color:var(--text-muted);">No letter selected.</div>
        <div style="display:flex;gap:0.5rem;margin-top:0.5rem;">
          <button id="cmcLinkConfirmBtn" class="btn btn-primary btn-sm" disabled>Link &amp; Add to Sessions</button>
          <button id="cmcLinkCancelBtn" class="btn btn-secondary btn-sm">Cancel</button>
        </div>
        <p id="cmcLinkError" class="hidden" style="color:var(--danger);font-size:0.8rem;margin-top:0.4rem;"></p>
      </div>`;

    let _selectedCmc = null;

    document.getElementById('cmcLinkSearch').addEventListener('input', e => {
      const q = e.target.value.toLowerCase();
      panel.querySelectorAll('.cmc-link-row').forEach(row => {
        row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });

    panel.querySelectorAll('.cmc-link-row').forEach(row => {
      row.addEventListener('mouseenter', () => { if (row.style.background !== 'var(--primary-light)') row.style.background = '#f8f9fb'; });
      row.addEventListener('mouseleave', () => { if (row.style.background !== 'var(--primary-light)') row.style.background = ''; });
      row.addEventListener('click', () => {
        panel.querySelectorAll('.cmc-link-row').forEach(r => { r.style.background = ''; });
        row.style.background = 'var(--primary-light)';
        _selectedCmc = unlinked.find(r => r.id === row.dataset.id);
        const dateStr = _selectedCmc.dateSent
          ? ((_selectedCmc.dateSent.toDate ? _selectedCmc.dateSent.toDate() : new Date(_selectedCmc.dateSent))
              .toLocaleDateString('en-US', { timeZone: 'UTC' }))
          : '—';
        document.getElementById('cmcLinkSelected').textContent =
          `Selected: ${_selectedCmc.recipientName || '—'} — ${dateStr}`;
        document.getElementById('cmcLinkSelected').style.color = 'var(--primary)';
        document.getElementById('cmcLinkConfirmBtn').disabled = false;
      });
    });

    document.getElementById('cmcLinkCancelBtn').addEventListener('click', () => {
      panel.classList.add('hidden');
      panel.innerHTML = '';
    });

    document.getElementById('cmcLinkConfirmBtn').addEventListener('click', async () => {
      if (!_selectedCmc) return;
      const btn   = document.getElementById('cmcLinkConfirmBtn');
      const errEl = document.getElementById('cmcLinkError');
      btn.disabled    = true;
      btn.textContent = 'Linking…';
      errEl.classList.add('hidden');
      try {
        await performCmcLink(_selectedCmc);
        panel.classList.add('hidden');
        panel.innerHTML = '';
      } catch (err) {
        errEl.textContent = 'Failed: ' + err.message;
        errEl.classList.remove('hidden');
        btn.disabled    = false;
        btn.textContent = 'Link & Add to Sessions';
      }
    });

  } catch (err) {
    panel.innerHTML = `<p class="error-msg" style="padding:0.5rem 0;">Failed to load: ${escHtml(err.message)}</p>`;
  }
}

async function performCmcLink(cmcRecord) {
  // 1. Mark the CMC log record as linked to this client
  await updateDoc(doc(db, 'cmcLog', cmcRecord.id), {
    linkedClientId:   clientId,
    linkedClientName: _client?.clientName || '',
    updatedAt:        serverTimestamp(),
  });

  // 2. Add a session entry so the outreach contact appears in session history
  const letterDate = cmcRecord.dateSent
    ? (cmcRecord.dateSent.toDate ? cmcRecord.dateSent.toDate() : new Date(cmcRecord.dateSent))
    : new Date();

  await addDoc(collection(db, 'clients', clientId, 'sessions'), {
    date:           letterDate,
    counselor:      cmcRecord.counselor || _profile?.name || '',
    caseStatus:     'CMC Outreach',
    notes:          `CMC letter sent to ${cmcRecord.recipientName || 'client'}`,
    source:         'cmc',
    cmcLogId:       cmcRecord.id,
    hours:          0,
    createdAt:      serverTimestamp(),
    clientSnapshot: buildClientSnapshot(),
  });

  // 3. Refresh denormalized counts, sessions table, and banner
  await refreshClientDenormalized();
  await loadSessions();
  await loadCmcLink();
}

// ── Build selects ─────────────────────────────────────────────────────────────

function buildSelects() {
  appendOptions('counselingType',   COUNSELING_TYPES);
  appendOptions('billingType',      BILLING_TYPES);
  appendOptions('reCode',           RE_CODES);
  appendOptions('closureAwardType', AWARD_TYPES);
  wireAmiLabel('amiPercent', 'amiLabel');
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

function wireAmiLabel(inputId, labelId) {
  const inp = document.getElementById(inputId);
  const lbl = document.getElementById(labelId);
  if (!inp || !lbl) return;
  inp.addEventListener('input', () => {
    const v = parseFloat(inp.value);
    lbl.textContent = isNaN(v) ? '' : amiDisplayLabel(v);
  });
}

function setAmiField(val) {
  const inp = document.getElementById('amiPercent');
  const lbl = document.getElementById('amiLabel');
  if (!inp) return;
  const n = Number(val);
  if (val != null && val !== '' && !isNaN(n) && n > 0) {
    inp.value = n;
    if (lbl) lbl.textContent = amiDisplayLabel(n);
  } else if (val) {
    if (lbl) lbl.textContent = `Legacy: ${val}`;
  }
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
  setValue('zipCode',       c.zipCode);
  setSelectValue('counselingType', c.counselingType);
  setSelectValue('billingType',    c.billingType);
  setAmiField(c.amiPercent);
  setSelectValue('reCode',         c.reCode);

  setSelectValue('counselor', c.counselor);

  document.getElementById('hispanic').checked     = !!c.hispanic;
  document.getElementById('femaleHeaded').checked = !!c.femaleHeaded;

  // PRE-specific: home search notes
  const isPre = c.counselingType === 'PRE';
  document.getElementById('areasSection').classList.toggle('hidden', !isPre);
  const notesEl = document.getElementById('homeSearchNotes');
  if (notesEl) notesEl.value = c.homeSearchNotes || '';

  // Intake — Contact
  setValue('streetAddress', c.streetAddress);
  setValue('city',          c.city);
  setValue('county',        c.county);
  setValue('dateOfBirth',   c.dateOfBirth);
  initSsnField('ssn', 'ssnRevealBtn', c.ssn);
  setValue('email',         c.email);
  setValue('homePhone',     c.homePhone);
  setValue('workPhone',     c.workPhone);
  setValue('cellPhone',     c.cellPhone);

  // Intake — Co-Applicant
  setValue('coApplicantName',      c.coApplicantName);
  setValue('coApplicantDob',       c.coApplicantDob);
  initSsnField('coApplicantSsn', 'coApplicantSsnRevealBtn', c.coApplicantSsn);
  setValue('coApplicantEmail',     c.coApplicantEmail);
  setValue('coApplicantHomePhone', c.coApplicantHomePhone);
  setValue('coApplicantWorkPhone', c.coApplicantWorkPhone);
  setValue('coApplicantCellPhone', c.coApplicantCellPhone);

  // Intake — Household
  setSelectValue('maritalStatus',   c.maritalStatus);
  setValue('adultsInHousehold',     c.adultsInHousehold);
  setValue('childrenInHousehold',   c.childrenInHousehold);
  renderHouseholdTable(c.householdMembers || []);

  // Intake — Property & Mortgage
  setSelectValue('propertyType', c.propertyType);
  setSelectValue('mortgageType', c.mortgageType);
  document.getElementById('primaryResidence').checked = !!c.primaryResidence;
  setValue('mortgage1Company', c.mortgage1Company);
  setValue('mortgage2Company', c.mortgage2Company);
  setValue('mortgage3Company', c.mortgage3Company);
  document.getElementById('bankruptcyFiled').checked = !!c.bankruptcyFiled;
  setValue('bankruptcyAccount',     c.bankruptcyAccount);
  setValue('conciliationStampDate', c.conciliationStampDate);

  // Intake Notes
  setValue('intakeDate', c.intakeDate);
  const intakeNotesEl = document.getElementById('intakeNotes');
  if (intakeNotesEl) intakeNotesEl.value = c.intakeNotes || '';

  updateIntakeSections(c.counselingType);
  updateBankruptcyAccountState();

  // Drive folder
  if (c.driveFolderId) {
    _driveFolder = { id: c.driveFolderId, name: c.driveFolderName, url: c.driveFolderUrl };
  }
  renderFolderUI();

  // Financials
  loadFinancials(c);
}

function applyDemoRedactions() {
  const redact = (id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = '';
    el.placeholder = 'Redacted';
    el.readOnly = true;
  };

  // Replace name with demo alias
  const nameEl = document.getElementById('clientName');
  if (nameEl) {
    nameEl.value    = demoClientName(clientId);
    nameEl.readOnly = true;
  }

  // Contact PII
  ['streetAddress','city','dateOfBirth','email','homePhone','workPhone','cellPhone'].forEach(redact);

  // SSN — replace the entire group with a placeholder
  const ssnGroup = document.getElementById('ssn')?.closest('.form-group');
  if (ssnGroup) ssnGroup.innerHTML = '<label>Social Security Number</label><p style="margin:0.25rem 0 0;color:var(--text-muted);font-style:italic;">Redacted</p>';
  const coSsnGroup = document.getElementById('coApplicantSsn')?.closest('.form-group');
  if (coSsnGroup) coSsnGroup.innerHTML = '<label>SSN</label><p style="margin:0.25rem 0 0;color:var(--text-muted);font-style:italic;">Redacted</p>';

  // Co-applicant
  ['coApplicantName','coApplicantDob','coApplicantEmail','coApplicantHomePhone','coApplicantWorkPhone','coApplicantCellPhone'].forEach(redact);

  // Block the save button
  const saveBtn = document.getElementById('saveClientBtn');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.title = 'Editing is disabled in Demo Mode';
  }
}

function updateIntakeSections(counselingType) {
  const mortgageEnabled = counselingType === 'OUTSTANDING' || counselingType === 'COURT';
  document.getElementById('mortgageSection').classList.toggle('intake-disabled', !mortgageEnabled);
  document.getElementById('mortgageNote').classList.toggle('hidden', mortgageEnabled);
  document.getElementById('conciliationGroup').classList.toggle('hidden', counselingType !== 'COURT');
}

function updateBankruptcyAccountState() {
  const filed = document.getElementById('bankruptcyFiled')?.checked;
  document.getElementById('bankruptcyAccountGroup')?.classList.toggle('intake-disabled', !filed);
}

function setValue(id, val) {
  const el = document.getElementById(id);
  if (el && val != null) el.value = val;
}

// ── Header / banner ───────────────────────────────────────────────────────────

function renderHeader(c) {
  document.getElementById('pageTitle').textContent = isDemoMode() ? demoClientName(clientId) : (c.clientName || 'Client Profile');

  const coAppEl = document.getElementById('coApplicantSubtitle');
  if (coAppEl) {
    if (c.coApplicantName) {
      coAppEl.textContent = `& ${c.coApplicantName}`;
      coAppEl.classList.remove('hidden');
    } else {
      coAppEl.classList.add('hidden');
    }
  }

  const status = c.status || 'active';
  const badge  = status === 'closed'
    ? `<span class="badge badge-outstanding" style="font-size:0.75rem;">Closed</span>`
    : `<span class="badge badge-pre" style="font-size:0.75rem;">Active</span>`;
  const tier = c.confidentialityTier || 'standard';
  const tierBadge = tier === 'sealed'
    ? `<span style="font-size:0.7rem;font-weight:700;background:#7c3aed15;color:#7c3aed;border:1px solid #7c3aed40;border-radius:20px;padding:0.15rem 0.65rem;margin-left:0.4rem;">Protected</span>`
    : tier === 'restricted'
    ? `<span style="font-size:0.7rem;font-weight:700;background:#b4590915;color:#b45309;border:1px solid #b4590940;border-radius:20px;padding:0.15rem 0.65rem;margin-left:0.4rem;">Confidential</span>`
    : '';
  document.getElementById('metaLine').innerHTML = `${badge} &nbsp; ${c.counselingType || ''} &nbsp; ${c.counselor || ''}${tierBadge}`;

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
  // Tab switching
  document.querySelectorAll('.client-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.client-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.client-tab-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    });
  });

  // Counseling type change — update reactive sections
  document.getElementById('counselingType').addEventListener('change', () => {
    const type = document.getElementById('counselingType').value;
    document.getElementById('areasSection').classList.toggle('hidden', type !== 'PRE');
    updateIntakeSections(type);
  });

  // Primary save button (Overview tab)
  document.getElementById('saveClientBtn').addEventListener('click', () => saveClient());

  // Secondary save button (Intake tab) — same action, different msg element
  document.getElementById('saveClientBtn2').addEventListener('click', () => saveClient('clientSaveMsg2'));

  // Print intake — both tabs
  document.getElementById('printIntakeBtn').addEventListener('click', printIntakeForm);
  document.getElementById('printIntakeBtn2').addEventListener('click', printIntakeForm);

  // Financials save
  document.getElementById('saveFinancialsBtn').addEventListener('click', saveFinancials);

  // Household members dynamic rows
  document.getElementById('addHouseholdRowBtn').addEventListener('click', () => {
    document.getElementById('householdBody').appendChild(makeHouseholdRow());
  });

  // Financials dynamic rows
  document.getElementById('addEmpRowBtn').addEventListener('click', addEmpRow);
  document.getElementById('addIncomeRowBtn').addEventListener('click', addIncomeRow);
  document.getElementById('addLiabilityRowBtn').addEventListener('click', addLiabilityRow);

  // Expense sheet auto-totals + ratio updates
  document.getElementById('tab-financials').addEventListener('input', e => {
    if (e.target.classList.contains('housing-exp')) updateHousingTotal();
    if (e.target.classList.contains('living-exp'))  updateLivingTotal();
    if (e.target.classList.contains('liability-payment') ||
        e.target.classList.contains('liability-balance')  ||
        e.target.classList.contains('liability-limit'))   updateLiabilityTotals();
    if (e.target.classList.contains('emp-gross') || e.target.classList.contains('inc-amount')) {
      updateRatioSummary(); updateLiquidityCalcs();
    }
    if (e.target.id === 'finLiquidAssets' || e.target.id === 'finMonthlySavings') updateLiquidityCalcs();
    if (e.target.classList.contains('credit-score-input')) updateMiddleScore();
    if (e.target.id === 'finDerogatoryCount') updateDerogatoryDisplay();
    if (e.target.id === 'finMonthsSinceLate') updateLastLateDisplay();
  });

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
  document.getElementById('reopenFileBtn').addEventListener('click', async (e) => {
    if (!confirm('Reopen this file?')) return;
    const reopenBtn = e.currentTarget;
    reopenBtn.disabled = true;
    reopenBtn.textContent = 'Reopening…';
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
    } finally {
      reopenBtn.disabled = false;
      reopenBtn.textContent = 'Reopen File';
    }
  });

  // Add Session
  document.getElementById('addSessionBtn').addEventListener('click', openAddSession);

  // Bankruptcy account field enabled only when bankruptcy is checked
  document.getElementById('bankruptcyFiled').addEventListener('change', updateBankruptcyAccountState);

  // Print intake form
  document.getElementById('printIntakeBtn').addEventListener('click', printIntakeForm);

  // Export PDF
  document.getElementById('exportPdfBtn').addEventListener('click', () => {
    document.getElementById('exportModal').classList.remove('hidden');
  });
  document.getElementById('exportCancelBtn').addEventListener('click', () => {
    document.getElementById('exportModal').classList.add('hidden');
  });
  document.getElementById('exportConfirmBtn').addEventListener('click', generateExportPdf);
  document.getElementById('exportModal').addEventListener('click', e => {
    if (e.target === document.getElementById('exportModal'))
      document.getElementById('exportModal').classList.add('hidden');
  });
}

async function saveClient(msgId = 'clientSaveMsg') {
  const saveBtn = msgId === 'clientSaveMsg2'
    ? document.getElementById('saveClientBtn2')
    : document.getElementById('saveClientBtn');
  const msgEl   = document.getElementById(msgId);
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
      zipCode:           document.getElementById('zipCode').value.trim(),
      amiPercent:        (() => { const v = document.getElementById('amiPercent').value; return v ? Number(v) : (_client?.amiPercent ?? null); })(),
      reCode:            document.getElementById('reCode').value,
      hispanic:          document.getElementById('hispanic').checked,
      femaleHeaded:      document.getElementById('femaleHeaded').checked,
      homeSearchNotes:   (document.getElementById('homeSearchNotes')?.value || '').trim(),
      driveFolderId:     _driveFolder?.id   || '',
      driveFolderName:   _driveFolder?.name || '',
      driveFolderUrl:    _driveFolder?.url  || '',
      // Intake — Contact
      streetAddress:     document.getElementById('streetAddress').value.trim(),
      city:              document.getElementById('city').value.trim(),
      county:            document.getElementById('county').value.trim(),
      dateOfBirth:       document.getElementById('dateOfBirth').value,
      ssn:               canViewSSN() ? readSsnField('ssn') : (_client.ssn || ''),
      email:             document.getElementById('email').value.trim(),
      homePhone:         document.getElementById('homePhone').value.trim(),
      workPhone:         document.getElementById('workPhone').value.trim(),
      cellPhone:         document.getElementById('cellPhone').value.trim(),
      // Intake — Co-Applicant
      coApplicantName:      document.getElementById('coApplicantName').value.trim(),
      coApplicantDob:       document.getElementById('coApplicantDob').value,
      coApplicantSsn:       canViewSSN() ? readSsnField('coApplicantSsn') : (_client.coApplicantSsn || ''),
      coApplicantEmail:     document.getElementById('coApplicantEmail').value.trim(),
      coApplicantHomePhone: document.getElementById('coApplicantHomePhone').value.trim(),
      coApplicantWorkPhone: document.getElementById('coApplicantWorkPhone').value.trim(),
      coApplicantCellPhone: document.getElementById('coApplicantCellPhone').value.trim(),
      // Intake — Household
      maritalStatus:        document.getElementById('maritalStatus').value,
      adultsInHousehold:    parseInt(document.getElementById('adultsInHousehold').value) || null,
      childrenInHousehold:  parseInt(document.getElementById('childrenInHousehold').value) || null,
      householdMembers:     readHouseholdRows(),
      // Intake — Property & Mortgage
      propertyType:         document.getElementById('propertyType').value,
      mortgageType:         document.getElementById('mortgageType').value,
      primaryResidence:     document.getElementById('primaryResidence').checked,
      mortgage1Company:     document.getElementById('mortgage1Company').value.trim(),
      mortgage2Company:     document.getElementById('mortgage2Company').value.trim(),
      mortgage3Company:     document.getElementById('mortgage3Company').value.trim(),
      bankruptcyFiled:      document.getElementById('bankruptcyFiled').checked,
      bankruptcyAccount:    document.getElementById('bankruptcyAccount').value.trim(),
      conciliationStampDate: document.getElementById('conciliationStampDate').value,
      // Intake Notes
      intakeDate:           document.getElementById('intakeDate').value,
      intakeNotes:          (document.getElementById('intakeNotes')?.value || '').trim(),
      // Preserve confidentiality fields — only ED can change these via saveTierChange()
      confidentialityTier:   _client.confidentialityTier || 'standard',
      careTeam:              _client.careTeam || [],
      updatedAt:             serverTimestamp(),
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
      <td>${s.source === 'cmc' ? '' : `<button class="btn btn-sm btn-secondary" data-session-id="${s.id}">Edit</button>`}</td>
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
  document.getElementById('sessionSnapshotBtn').addEventListener('click', () => {
    const session = _sessions.find(s => s.id === _editingSessionId);
    if (session?.clientSnapshot) openSnapshotView(session.clientSnapshot);
  });

  // Close on overlay click
  document.getElementById('sessionModal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('sessionModal')) closeSessionModal();
  });

  // Snapshot modal close
  document.getElementById('snapshotCloseBtn').addEventListener('click', () => {
    document.getElementById('snapshotModal').classList.add('hidden');
  });
  document.getElementById('snapshotModal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('snapshotModal'))
      document.getElementById('snapshotModal').classList.add('hidden');
  });
}

function openAddSession() {
  _editingSessionId = null;
  document.getElementById('sessionModalTitle').textContent = 'Add Session';
  document.getElementById('sessionModalDelete').classList.add('hidden');
  document.getElementById('sessionSnapshotBtn').classList.add('hidden');
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
  document.getElementById('sessionSnapshotBtn').classList.toggle('hidden', !session.clientSnapshot);

  // Populate
  document.getElementById('sDate').value         = toDateInputValue(session.date);
  document.getElementById('sCounselor').value    = session.counselor || '';
  document.getElementById('sRxNumber').value     = session.rxNumber  || '';
  document.getElementById('sHudType').value      = session.hudType   || 'counseling';
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
  document.getElementById('sHudType').value = 'counseling';
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
    date:       dateVal ? new Date(dateVal + 'T12:00:00') : null,
    counselor:  document.getElementById('sCounselor').value,
    rxNumber:   document.getElementById('sRxNumber').value.trim(),
    hudType:    document.getElementById('sHudType').value,
    hours:      parseFloat(document.getElementById('sHours').value) || 0,
    dollarsFor: document.getElementById('sDollarsFor').value.trim(),
    caseStatus: document.getElementById('sCaseStatus').value.trim(),
    outcome:    document.getElementById('sOutcome').value.trim(),
    notes:      document.getElementById('sNotes').value.trim(),
    updatedAt:  serverTimestamp(),
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
      // Update existing — snapshot stays frozen from original session creation
      await updateDoc(
        doc(db, 'clients', clientId, 'sessions', _editingSessionId),
        data
      );
    } else {
      // New session — embed point-in-time client snapshot (includes financials)
      data.createdAt      = serverTimestamp();
      data.clientSnapshot = buildClientSnapshot();
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
  } finally {
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
    renderListSlot('buyerReadySlot',  ccaSnap.empty  ? null : ccaSnap.docs[0].id,  'Buyer Ready',  'buyer-ready');
    renderListSlot('homeRepairsSlot', higSnap.empty  ? null : higSnap.docs[0].id,  'Home Repairs', 'repair-ready');
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
      clientId:            clientId,
      clientName:          _client.clientName          || '',
      amiPercent:          _client.amiPercent          || '',
      driveFolderId:       _client.driveFolderId        || '',
      driveFolderName:     _client.driveFolderName      || '',
      driveFolderUrl:      _client.driveFolderUrl       || '',
      confidentialityTier: _client.confidentialityTier  || 'standard',
      careTeam:            _client.careTeam             || [],
      enrolledAt:          serverTimestamp(),
      updatedAt:           serverTimestamp(),
      notes:               '',
      status:              page === 'buyer-ready' ? 'eligible' : 'waitlisted',
    };
    if (page === 'buyer-ready') {
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
      clientName:          data.clientName          || '',
      counselor:           data.counselor           || '',
      amiPercent:          data.amiPercent          || '',
      driveFolderId:       data.driveFolderId        || '',
      driveFolderName:     data.driveFolderName      || '',
      driveFolderUrl:      data.driveFolderUrl       || '',
      confidentialityTier: data.confidentialityTier  || 'standard',
      careTeam:            data.careTeam             || [],
      updatedAt:           serverTimestamp(),
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

// ── Confidentiality section ───────────────────────────────────────────────────

function renderConfidentialitySection() {
  const tier = _client.confidentialityTier || 'standard';
  const card = document.getElementById('confidentialityCard');
  if (!card) return;

  // Show the card only if the tier is non-standard OR the ED is viewing
  if (tier === 'standard' && !_isED) return;
  card.classList.remove('hidden');

  const tierLabel = tier === 'sealed' ? 'Protected' : tier === 'restricted' ? 'Confidential' : 'Standard';
  const tierColor = tier === 'sealed' ? '#7c3aed' : tier === 'restricted' ? '#b45309' : '#16a34a';

  const careTeam      = _client.careTeam || [];
  const careTeamItems = careTeam.map((uid, i) => {
    const u    = _allUsers.find(u => u.uid === uid);
    const name = u ? u.name : uid;
    return { uid, name, i };
  });

  let html = `
    <div style="display:flex;align-items:center;gap:1rem;margin-bottom:1rem;flex-wrap:wrap;">
      <span style="display:inline-block;background:${tierColor}18;color:${tierColor};border:1px solid ${tierColor}50;border-radius:20px;padding:0.25rem 0.9rem;font-size:0.8rem;font-weight:700;">
        ${tierLabel}
      </span>
      <span style="font-size:0.8125rem;color:var(--text-muted);">
        ${tier === 'standard' ? 'No access restrictions' : tier === 'restricted' ? 'Visible to care team and Executive Director only' : 'Fully protected — excluded from all program lists'}
      </span>
    </div>`;

  if (tier !== 'standard') {
    html += `
    <div style="margin-bottom:1rem;">
      <div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-bottom:0.5rem;">Care Team</div>
      <div id="careTeamList" style="display:flex;flex-wrap:wrap;gap:0.4rem;margin-bottom:0.5rem;">
        ${careTeamItems.length
          ? careTeamItems.map(m => `
            <span class="chip" style="background:#f5f0ff;color:#7c3aed;">
              ${escHtml(m.name)}
              ${_isED ? `<button type="button" class="chip-remove care-team-remove" data-uid="${escAttr(m.uid)}" aria-label="Remove">&times;</button>` : ''}
            </span>`).join('')
          : '<span style="font-size:0.8125rem;color:var(--text-muted);">No care team members assigned.</span>'}
      </div>
      ${_isED ? `
        <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;">
          <select id="careTeamAddSelect" style="font-size:0.8125rem;padding:0.3rem 0.5rem;border:1px solid var(--border);border-radius:var(--radius);">
            <option value="">Add care team member…</option>
            ${_allUsers.filter(u => !careTeam.includes(u.uid))
              .map(u => `<option value="${escAttr(u.uid)}">${escHtml(u.name)}</option>`)
              .join('')}
          </select>
          <button id="careTeamAddBtn" class="btn btn-secondary btn-sm">Add</button>
        </div>` : ''}
    </div>`;
  }

  if (_isED) {
    html += `
    <div style="border-top:1px solid var(--border);padding-top:1rem;">
      <div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-bottom:0.5rem;">Change Tier (ED Only)</div>
      <div style="display:flex;gap:0.5rem;align-items:flex-end;flex-wrap:wrap;">
        <div class="form-group" style="margin:0;">
          <label style="font-size:0.75rem;">New Tier</label>
          <select id="tierChangeSelect" style="font-size:0.8125rem;padding:0.3rem 0.5rem;border:1px solid var(--border);border-radius:var(--radius);">
            <option value="standard"   ${tier === 'standard'   ? 'selected' : ''}>Standard</option>
            <option value="restricted" ${tier === 'restricted' ? 'selected' : ''}>Confidential (Restricted)</option>
            <option value="sealed"     ${tier === 'sealed'     ? 'selected' : ''}>Protected (Sealed)</option>
          </select>
        </div>
        <div class="form-group" style="margin:0;flex:1;min-width:200px;">
          <label style="font-size:0.75rem;">Reason</label>
          <input type="text" id="tierChangeReason" placeholder="Required for audit log"
            style="font-size:0.8125rem;padding:0.3rem 0.5rem;border:1px solid var(--border);border-radius:var(--radius);width:100%;">
        </div>
        <button id="tierSaveBtn" class="btn btn-primary btn-sm">Save Tier</button>
      </div>
      <p id="tierSaveMsg" class="hidden" style="font-size:0.8rem;margin-top:0.5rem;"></p>
    </div>`;
  }

  document.getElementById('confidentialityContent').innerHTML = html;

  if (_isED) {
    document.querySelectorAll('.care-team-remove').forEach(btn => {
      btn.addEventListener('click', () => removeCareTeamMember(btn.dataset.uid));
    });
    const addBtn = document.getElementById('careTeamAddBtn');
    if (addBtn) addBtn.addEventListener('click', addCareTeamMember);
    const saveTierBtn = document.getElementById('tierSaveBtn');
    if (saveTierBtn) saveTierBtn.addEventListener('click', saveTierChange);
  }
}

async function addCareTeamMember() {
  const sel = document.getElementById('careTeamAddSelect');
  const uid = sel?.value;
  if (!uid) return;
  const careTeam = [...(_client.careTeam || []), uid];
  try {
    await updateDoc(doc(db, 'clients', clientId), { careTeam, updatedAt: serverTimestamp() });
    _client.careTeam = careTeam;
    syncClientToLists({ ..._client, careTeam });
    renderConfidentialitySection();
  } catch (err) {
    alert('Failed to add member: ' + err.message);
  }
}

async function removeCareTeamMember(uid) {
  const careTeam = (_client.careTeam || []).filter(u => u !== uid);
  try {
    await updateDoc(doc(db, 'clients', clientId), { careTeam, updatedAt: serverTimestamp() });
    _client.careTeam = careTeam;
    syncClientToLists({ ..._client, careTeam });
    renderConfidentialitySection();
  } catch (err) {
    alert('Failed to remove member: ' + err.message);
  }
}

async function saveTierChange() {
  const newTier = document.getElementById('tierChangeSelect')?.value;
  const reason  = document.getElementById('tierChangeReason')?.value.trim();
  const msgEl   = document.getElementById('tierSaveMsg');
  const saveBtn = document.getElementById('tierSaveBtn');

  if (!reason) {
    msgEl.textContent = 'Reason is required for audit log.';
    msgEl.style.color = 'var(--danger)';
    msgEl.classList.remove('hidden');
    return;
  }

  saveBtn.disabled = true;
  const prevTier = _client.confidentialityTier || 'standard';
  const careTeam = newTier === 'standard' ? [] : (_client.careTeam || []);

  try {
    await updateDoc(doc(db, 'clients', clientId), {
      confidentialityTier: newTier,
      careTeam,
      updatedAt: serverTimestamp(),
    });
    await addDoc(collection(db, 'accessLog'), {
      clientId,
      event:         'tier_change',
      changedBy:     _user.uid,
      changedByName: _profile.name || '',
      fromTier:      prevTier,
      toTier:        newTier,
      reason,
      changedAt:     serverTimestamp(),
    });
    _client.confidentialityTier = newTier;
    _client.careTeam = careTeam;
    syncClientToLists({ ..._client, confidentialityTier: newTier, careTeam });
    renderHeader(_client);
    renderConfidentialitySection();
    msgEl.textContent = 'Tier updated.';
    msgEl.style.color = 'var(--success, green)';
    msgEl.classList.remove('hidden');
    setTimeout(() => msgEl.classList.add('hidden'), 2500);
  } catch (err) {
    msgEl.textContent = 'Save failed: ' + err.message;
    msgEl.style.color = 'var(--danger)';
    msgEl.classList.remove('hidden');
  } finally {
    saveBtn.disabled = false;
  }
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

  // Surface Rx numbers found in session history that aren't in the subcollection
  const knownRxNums = new Set([..._rxDocs.map(r => r.rxNumber), legacyRx].filter(Boolean));
  const sessionRxNums = [...new Set(_sessions.map(s => (s.rxNumber || '').trim()).filter(Boolean))]
    .filter(rx => !knownRxNums.has(rx));
  if (sessionRxNums.length) {
    html += `<div style="font-size:0.8rem;margin-bottom:0.75rem;padding:0.5rem 0.75rem;background:#f0f4ff;border-left:3px solid var(--primary);border-radius:var(--radius);">
      <span style="font-weight:600;display:block;margin-bottom:0.45rem;">Found in session history — not yet on file:</span>
      <div style="display:flex;flex-wrap:wrap;gap:0.4rem;">
        ${sessionRxNums.map(rx =>
          `<button type="button" class="btn btn-sm btn-secondary rx-autofill-btn" data-rx="${escAttr(rx)}" style="font-size:0.75rem;">
            ${escHtml(rx)} &rarr; Add
          </button>`
        ).join('')}
      </div>
    </div>`;
  }

  if (_rxDocs.length) {
    html += `<table style="width:100%;border-collapse:collapse;font-size:0.875rem;margin-bottom:0.75rem;">
      <thead>
        <tr style="background:#f8f9fb;">
          <th ${TH}>Rx #</th>
          <th ${TH}>Guarantor</th>
          <th ${TH}>NOFA Initiative</th>
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
            <td ${TD}>
              <input type="text" class="rx-nofa-init" data-rx-id="${escAttr(r.id)}"
                value="${escAttr(r.nofaInitiative || '')}"
                placeholder="${r.guarantor === 'NOFA' ? 'e.g. NOFA 2025-1 COMP' : '—'}"
                style="font-size:0.8125rem;padding:0.25rem 0.4rem;border:1px solid var(--border);border-radius:var(--radius);width:160px;${r.guarantor !== 'NOFA' ? 'color:var(--text-muted);' : ''}">
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
      <div class="form-group" style="margin:0;flex:1;min-width:160px;">
        <label style="font-size:0.75rem;">NOFA Initiative</label>
        <input type="text" id="rxNewNofaInit" placeholder="e.g. NOFA 2025-1 COMP">
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

  // Auto-fill buttons — open add form pre-filled with Rx from session history
  panel.querySelectorAll('.rx-autofill-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const addForm   = document.getElementById('rxAddForm');
      const showBtn   = document.getElementById('rxShowAddBtn');
      const numInput  = document.getElementById('rxNewNumber');
      const guarSel   = document.getElementById('rxNewGuarantor');
      addForm.classList.remove('hidden');
      addForm.style.display = 'flex';
      showBtn.classList.add('hidden');
      numInput.value  = btn.dataset.rx;
      guarSel.value   = '';
      guarSel.focus();
    });
  });
}

function resetRxAddForm() {
  const form = document.getElementById('rxAddForm');
  if (!form) return;
  form.classList.add('hidden');
  document.getElementById('rxShowAddBtn').classList.remove('hidden');
  document.getElementById('rxNewNumber').value    = '';
  document.getElementById('rxNewGuarantor').value  = '';
  document.getElementById('rxNewNofaInit').value   = '';
  document.getElementById('rxNewActive').checked   = true;
}

async function saveRxRow(rxId) {
  const guarEl  = document.querySelector(`.rx-guarantor[data-rx-id="${rxId}"]`);
  const actEl   = document.querySelector(`.rx-active[data-rx-id="${rxId}"]`);
  const initEl  = document.querySelector(`.rx-nofa-init[data-rx-id="${rxId}"]`);
  const saveBtn = document.querySelector(`.rx-save-btn[data-rx-id="${rxId}"]`);
  if (!guarEl || !actEl) return;

  saveBtn.disabled    = true;
  saveBtn.textContent = '…';

  try {
    const nofaInitiative = initEl ? initEl.value.trim() : '';
    await updateDoc(doc(db, 'clients', clientId, 'rxNumbers', rxId), {
      guarantor: guarEl.value,
      active:    actEl.checked,
      nofaInitiative,
    });
    const rxDoc = _rxDocs.find(r => r.id === rxId);
    if (rxDoc) { rxDoc.guarantor = guarEl.value; rxDoc.active = actEl.checked; rxDoc.nofaInitiative = nofaInitiative; }
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

  const rxNumber      = numEl.value.trim();
  const guarantor     = guarEl.value;
  const nofaInitiative = (document.getElementById('rxNewNofaInit')?.value || '').trim();
  if (!rxNumber)  { alert('Enter an Rx number.'); numEl.focus(); return; }
  if (!guarantor) { alert('Select a guarantor.'); guarEl.focus(); return; }

  addBtn.disabled    = true;
  addBtn.textContent = 'Adding…';

  try {
    const ref = await addDoc(collection(db, 'clients', clientId, 'rxNumbers'), {
      rxNumber,
      guarantor,
      nofaInitiative,
      active:    actEl.checked,
      createdAt: serverTimestamp(),
    });
    _rxDocs.push({ id: ref.id, rxNumber, guarantor, nofaInitiative, active: actEl.checked });
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

// ── Print Intake Form ──────────────────────────────────────────────────────────

function printIntakeForm() {
  if (isDemoMode()) return;
  const c = _client;
  const logoUrl = new URL('img/logo.png', window.location.href).href;

  const chk  = (val) => val ? '&#9745;' : '&#9744;';
  const v    = (val) => escHtml(String(val ?? ''));
  const fmtD = (iso) => {
    if (!iso) return '';
    const d = new Date(iso + 'T12:00:00');
    return isNaN(d) ? iso : d.toLocaleDateString('en-US');
  };

  const typeLabel = {
    OUTSTANDING: 'Default &amp; Delinquency',
    PRE:         'First Time Homebuyers',
    POST:        'Post-Purchase',
    COURT:       'BC Conciliation Program',
  };

  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<title>Intake Form — ${v(c.clientName)}</title>
<style>
  @page { margin: 0.65in; size: letter portrait; }
  * { box-sizing: border-box; }
  body {
    font-family: Arial, Helvetica, sans-serif;
    font-size: 9.5pt; color: #000;
    margin: 0; padding: 0;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .header {
    display: flex; align-items: center; gap: 14px;
    border-bottom: 3px solid #1a3a8f; padding-bottom: 10px; margin-bottom: 12px;
  }
  .logo { height: 56px; width: auto; }
  .header-text h1 {
    font-size: 13pt; font-weight: bold; margin: 0 0 2px;
    color: #1a3a8f; letter-spacing: 0.02em;
  }
  .header-text p { margin: 0; font-size: 8.5pt; color: #444; }
  .row { display: flex; gap: 8px; margin-bottom: 5px; align-items: baseline; }
  .lbl { font-weight: bold; font-size: 8.5pt; white-space: nowrap; flex-shrink: 0; }
  .val { border-bottom: 1px solid #555; flex: 1; min-height: 14px; font-size: 9.5pt; padding-bottom: 1px; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 0 20px; }
  .sec { font-weight: bold; text-decoration: underline; margin: 10px 0 5px; font-size: 9.5pt; }
  .chk-row { display: flex; align-items: center; gap: 5px; margin-bottom: 3px; font-size: 9.5pt; }
  .chk { font-size: 11pt; line-height: 1; }
  hr { border: none; border-top: 1px solid #aaa; margin: 8px 0; }
  .inline { display: inline-flex; align-items: baseline; gap: 5px; }
  .notes-line { border-bottom: 1px solid #000; min-height: 16px; margin-bottom: 5px; }
  @media print { body { padding: 0; } }
</style>
</head><body>

<div class="header">
  <img src="${logoUrl}" class="logo" alt="Housing Opportunities Inc." onerror="this.style.display='none'">
  <div class="header-text">
    <h1>Housing Counseling Intake Form</h1>
    <p>Housing Opportunities Inc. &nbsp;&#8226;&nbsp; 293 Pinney Street, Rochester, PA 15074 &nbsp;&#8226;&nbsp; Phone: (724) 728-7511 &nbsp;&#8226;&nbsp; Fax: (724) 728-7202</p>
  </div>
</div>

<div class="row">
  <span class="lbl">DATE:</span>
  <span class="val">${new Date().toLocaleDateString('en-US')}</span>
  <span class="lbl" style="margin-left:24px;">COUNSELOR:</span>
  <span class="val">${v(c.counselor)}</span>
</div>

<hr>

<div class="two">
  <div class="row"><span class="lbl">APPLICANT&rsquo;S NAME:</span> <span class="val">${v(c.clientName)}</span></div>
  <div class="row"><span class="lbl">CO-APPLICANT&rsquo;S NAME:</span> <span class="val">${v(c.coApplicantName)}</span></div>
</div>

<div class="row"><span class="lbl">ADDRESS:</span> <span class="val">${v(c.streetAddress)}</span></div>

<div class="two">
  <div class="row"><span class="lbl">CITY / STATE / ZIP:</span> <span class="val">${v([c.city, 'PA', c.zipCode].filter(Boolean).join('  '))}</span></div>
  <div class="row"><span class="lbl">COUNTY:</span> <span class="val">${v(c.county)}</span></div>
</div>

<div class="two">
  <div class="row"><span class="lbl">Date of Birth:</span> <span class="val">${fmtD(c.dateOfBirth)}</span></div>
  <div class="row"><span class="lbl">Date of Birth:</span> <span class="val">${fmtD(c.coApplicantDob)}</span></div>
</div>
<div class="two">
  <div class="row"><span class="lbl">HOME PHONE:</span> <span class="val">${v(c.homePhone)}</span></div>
  <div class="row"><span class="lbl">HOME PHONE:</span> <span class="val">${v(c.coApplicantHomePhone)}</span></div>
</div>
<div class="two">
  <div class="row"><span class="lbl">WORK PHONE:</span> <span class="val">${v(c.workPhone)}</span></div>
  <div class="row"><span class="lbl">WORK PHONE:</span> <span class="val">${v(c.coApplicantWorkPhone)}</span></div>
</div>
<div class="two">
  <div class="row"><span class="lbl">CELL PHONE:</span> <span class="val">${v(c.cellPhone)}</span></div>
  <div class="row"><span class="lbl">CELL PHONE:</span> <span class="val">${v(c.coApplicantCellPhone)}</span></div>
</div>
<div class="two">
  <div class="row"><span class="lbl"># Adults in Household:</span> <span class="val">${v(c.adultsInHousehold)}</span></div>
  <div class="row"><span class="lbl"># Children in Household:</span> <span class="val">${v(c.childrenInHousehold)}</span></div>
</div>
<div class="two">
  <div class="row"><span class="lbl">Email Address:</span> <span class="val">${v(c.email)}</span></div>
  <div class="row"><span class="lbl">Email Address:</span> <span class="val">${v(c.coApplicantEmail)}</span></div>
</div>
<div class="two">
  <div class="row"><span class="lbl">Marital Status:</span> <span class="val">${v(c.maritalStatus)}</span></div>
  <div class="row"><span class="lbl">Race &amp; Ethnicity:</span> <span class="val">${v(c.reCode)}</span></div>
</div>

<hr>

<div class="sec">TYPE OF APPT:</div>
<div class="two">
  <div>
    <div class="chk-row"><span class="chk">${chk(c.counselingType === 'OUTSTANDING')}</span> Default &amp; Delinquency</div>
    <div class="chk-row"><span class="chk">${chk(c.counselingType === 'PRE')}</span> First Time Homebuyers</div>
    <div class="chk-row"><span class="chk">${chk(c.counselingType === 'POST')}</span> Post-Purchase</div>
  </div>
  <div>
    <div class="chk-row"><span class="chk">${chk(c.counselingType === 'COURT')}</span> BC Conciliation Program</div>
    <div class="row" style="margin-top:4px;"><span class="lbl">Conciliation Stamp Date:</span> <span class="val">${fmtD(c.conciliationStampDate)}</span></div>
  </div>
</div>

<hr>

<div class="sec">PRELIMINARY INFORMATION:</div>
<div class="two">
  <div>
    <div class="chk-row"><span class="chk">${chk(true)}</span> Living in secured property</div>
    <div class="chk-row"><span class="chk">${chk(c.primaryResidence)}</span> Primary Residence</div>
    <div class="chk-row"><span class="chk">${chk(true)}</span> Located in Pennsylvania</div>
  </div>
  <div>
    <div class="chk-row"><span class="chk">${chk(c.propertyType === 'Detached/Condo')}</span> Detached home or condominium</div>
    <div class="chk-row"><span class="chk">${chk(c.propertyType === 'Mobile Home')}</span> Mobile home secured by mortgage</div>
    <div class="row" style="margin-top:3px;">
      <span class="lbl">Bankruptcy:</span>
      <span class="chk">${chk(c.bankruptcyFiled)}</span> <span style="font-size:9pt;">YES</span>
      &nbsp;
      <span class="chk">${chk(!c.bankruptcyFiled)}</span> <span style="font-size:9pt;">NO</span>
      &nbsp;&nbsp;
      <span class="lbl">Account #</span> <span class="val" style="max-width:120px;">${v(c.bankruptcyAccount)}</span>
    </div>
  </div>
</div>

<div class="row" style="margin-top:6px;"><span class="lbl">1st Mortgage - Mortgage Company:</span> <span class="val">${v(c.mortgage1Company)}</span></div>
<div class="row"><span class="lbl">2nd Mortgage - Mortgage Company:</span> <span class="val">${v(c.mortgage2Company)}</span></div>
<div class="row"><span class="lbl">3rd Mortgage - Mortgage Company:</span> <span class="val">${v(c.mortgage3Company)}</span></div>

<div style="display:flex;flex-wrap:wrap;gap:4px 20px;margin:6px 0;">
  <div class="chk-row"><span class="chk">${chk(c.mortgageType === 'Conventional')}</span> Conventional Mortgage</div>
  <div class="chk-row"><span class="chk">${chk(c.mortgageType === 'VA')}</span> VA Mortgage</div>
  <div class="chk-row"><span class="chk">${chk(c.mortgageType === 'FHA')}</span> FHA Mortgage</div>
  <div class="chk-row"><span class="chk">${chk(c.mortgageType === 'FmHA/USDA')}</span> FmHA Loan (USDA / Rural Housing / Farmer&rsquo;s Home Loan)</div>
</div>

<hr>

<div class="two" style="margin-top:4px;">
  <div class="row"><span class="lbl">FACE TO FACE MEETING — DATE:</span> <span class="val">${fmtD(c.firstSessionDate || c.intakeDate)}</span></div>
  <div class="row"><span class="lbl">TIME:</span> <span class="val"></span></div>
</div>
<div style="margin-bottom:5px;"><span class="lbl">PHONE CALL NOTES:</span></div>
${c.intakeNotes
  ? `<div style="border:1px solid #aaa;padding:5px 7px;min-height:40px;font-size:9pt;white-space:pre-wrap;line-height:1.5;">${v(c.intakeNotes)}</div>`
  : '<div class="notes-line"></div><div class="notes-line"></div><div class="notes-line"></div>'}

<script>window.addEventListener('load', () => window.print());<\/script>
</body></html>`;

  const win = window.open('', '_blank');
  if (!win) { alert('Please allow pop-ups to print the intake form.'); return; }
  win.document.write(html);
  win.document.close();
}

// ── Financials ────────────────────────────────────────────────────────────────

const HOUSING_EXP_IDS = [
  'expMortgage1','expMortgage2','expMortgage3','expPropertyTax','expHazardIns',
  'expCondoFees','expAssocDues','expOtherHousing','expElectric','expGas',
  'expOil','expWater','expSewer','expTrash',
];
const LIVING_EXP_IDS = [
  'expGroceries','expLunches','expPetCare','expPetFood','expTobacco','expHairCuts',
  'expLaundry','expClothing','expCellPhone','expHomePhone','expCableTV','expInternet',
  'expHomeMaint','expAutoIns','expGasoline','expCarRepair','expBusParking',
  'expPrescriptions','expCopays','expDayCare','expChurch','expEntertainment',
  'expNewspaper','expClubs','expOtherLiving1','expOtherLiving2','expOtherLiving3',
];
const HOUSING_EXP_LABELS = {
  expMortgage1:'Mortgage (1st) / Rent', expMortgage2:'Mortgage (2nd)', expMortgage3:'Mortgage (3rd)',
  expPropertyTax:'Real Estate / Property Taxes', expHazardIns:'Hazard Insurance',
  expCondoFees:'Condo Fees', expAssocDues:'Assoc. Dues', expOtherHousing:'Other',
  expElectric:'Electric', expGas:'Gas', expOil:'Oil', expWater:'Water', expSewer:'Sewer', expTrash:'Trash',
};
const LIVING_EXP_LABELS = {
  expGroceries:'Groceries / Toiletries', expLunches:'Lunches', expPetCare:'Pet Care',
  expPetFood:'Pet Food', expTobacco:'Tobacco / Alcohol', expHairCuts:'Hair Cuts',
  expLaundry:'Laundry / Dry Cleaning', expClothing:'Clothing', expCellPhone:'Cell Phone',
  expHomePhone:'Home Phone', expCableTV:'Cable / Dish / TV', expInternet:'Internet Service',
  expHomeMaint:'Home Maint / Alarm', expAutoIns:'Auto Insurance', expGasoline:'Gasoline',
  expCarRepair:'Car Repair / Insp / Registration', expBusParking:'Bus / Parking / Tolls',
  expPrescriptions:'Prescriptions / Med Supplies', expCopays:'Co-Pays', expDayCare:'Day Care',
  expChurch:'Church / Donations', expEntertainment:'Entertainment',
  expNewspaper:'Newspaper / Subscriptions', expClubs:'Clubs / Gifts',
  expOtherLiving1:'Other (1)', expOtherLiving2:'Other (2)', expOtherLiving3:'Other (3)',
};

function numVal(id) {
  return parseFloat(document.getElementById(id)?.value || '0') || 0;
}

function fmtMoney2(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function updateHousingTotal() {
  const total = HOUSING_EXP_IDS.reduce((s, id) => s + numVal(id), 0);
  document.getElementById('housingTotal').textContent = fmtMoney2(total);
  updateGrandExpTotal();
  updateRatioSummary();
  updateLiquidityCalcs();
}

function updateLivingTotal() {
  const total = LIVING_EXP_IDS.reduce((s, id) => s + numVal(id), 0);
  document.getElementById('livingTotal').textContent = fmtMoney2(total);
  updateGrandExpTotal();
  updateLiquidityCalcs();
}

function updateGrandExpTotal() {
  const h = HOUSING_EXP_IDS.reduce((s, id) => s + numVal(id), 0);
  const l = LIVING_EXP_IDS.reduce((s, id) => s + numVal(id), 0);
  document.getElementById('grandExpTotal').textContent = fmtMoney2(h + l);
}

function updateLiabilityTotals() {
  let payments = 0, balances = 0, limits = 0;
  document.querySelectorAll('#liabilityBody tr').forEach(row => {
    payments += parseFloat(row.querySelector('.liability-payment')?.value || '0') || 0;
    balances += parseFloat(row.querySelector('.liability-balance')?.value  || '0') || 0;
    limits   += parseFloat(row.querySelector('.liability-limit')?.value    || '0') || 0;
  });
  document.getElementById('liabilityPaymentTotal').textContent = fmtMoney2(payments);
  document.getElementById('liabilityBalanceTotal').textContent  = fmtMoney2(balances);
  const limitTotalEl = document.getElementById('liabilityCreditLimitTotal');
  if (limitTotalEl) limitTotalEl.textContent = fmtMoney2(limits);
  updateRatioSummary();
  updateLiquidityCalcs();
  updateCreditUtilization();
}

// ── Financial ratio calculations ──────────────────────────────────────────────

function setRatioEl(id, text, status) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = el.className.replace(/ratio-(ok|warn|bad|neutral)/g, '').trim() + ' ratio-' + status;
}

function updateRatioSummary() {
  const empGross  = [...document.querySelectorAll('.emp-gross')]
    .reduce((s, el) => s + (parseFloat(el.value) || 0), 0);
  const otherInc  = [...document.querySelectorAll('.inc-amount')]
    .reduce((s, el) => s + (parseFloat(el.value) || 0), 0);
  const gross     = empGross + otherInc;
  const housing   = HOUSING_EXP_IDS.reduce((s, id) => s + numVal(id), 0);
  const liabPay   = [...document.querySelectorAll('.liability-payment')]
    .reduce((s, el) => s + (parseFloat(el.value) || 0), 0);

  const grossEl = document.getElementById('rGrossIncome');
  if (grossEl) {
    grossEl.textContent = gross > 0 ? fmtMoney2(gross) : '—';
    grossEl.className   = grossEl.className.replace(/ratio-(ok|warn|bad|neutral)/g, '').trim() + ' ratio-neutral';
  }

  if (gross <= 0) {
    ['rFrontEnd','rBackEnd','rNonHousing','rDiscretionary'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.textContent = '—'; el.className = el.className.replace(/ratio-(ok|warn|bad|neutral)/g, '').trim() + ' ratio-neutral'; }
    });
    return;
  }

  const fe = housing / gross;
  setRatioEl('rFrontEnd', (fe * 100).toFixed(1) + '%', fe <= 0.28 ? 'ok' : fe <= 0.35 ? 'warn' : 'bad');

  const be = (housing + liabPay) / gross;
  setRatioEl('rBackEnd', (be * 100).toFixed(1) + '%', be <= 0.36 ? 'ok' : be <= 0.43 ? 'warn' : 'bad');

  const nh = liabPay / gross;
  setRatioEl('rNonHousing', (nh * 100).toFixed(1) + '%', nh <= 0.15 ? 'ok' : nh <= 0.25 ? 'warn' : 'bad');

  const disc = gross - housing - liabPay;
  setRatioEl('rDiscretionary', fmtMoney2(disc), disc >= 500 ? 'ok' : disc >= 0 ? 'warn' : 'bad');
}

function updateLiquidityCalcs() {
  const liquid   = parseFloat(document.getElementById('finLiquidAssets')?.value  || '0') || 0;
  const savings  = parseFloat(document.getElementById('finMonthlySavings')?.value || '0') || 0;
  const housing  = HOUSING_EXP_IDS.reduce((s, id) => s + numVal(id), 0);
  const living   = LIVING_EXP_IDS.reduce((s, id) => s + numVal(id), 0);
  const liabPay  = [...document.querySelectorAll('.liability-payment')]
    .reduce((s, el) => s + (parseFloat(el.value) || 0), 0);
  const totalExp = housing + living + liabPay;
  const empGross = [...document.querySelectorAll('.emp-gross')]
    .reduce((s, el) => s + (parseFloat(el.value) || 0), 0);
  const otherInc = [...document.querySelectorAll('.inc-amount')]
    .reduce((s, el) => s + (parseFloat(el.value) || 0), 0);
  const gross = empGross + otherInc;

  if (totalExp > 0) {
    const mo = liquid / totalExp;
    setRatioEl('rMonthsReserves', mo.toFixed(1) + ' mo', mo >= 3 ? 'ok' : mo >= 1 ? 'warn' : 'bad');
  } else {
    const el = document.getElementById('rMonthsReserves');
    if (el) { el.textContent = '—'; el.className = el.className.replace(/ratio-(ok|warn|bad|neutral)/g, '').trim() + ' ratio-neutral'; }
  }

  if (gross > 0) {
    const ef = liquid / gross;
    setRatioEl('rEmergencyFund', ef.toFixed(1) + ' mo', ef >= 3 ? 'ok' : ef >= 1 ? 'warn' : 'bad');
    const sr = savings / gross;
    setRatioEl('rSavingsRate', (sr * 100).toFixed(1) + '%', sr >= 0.10 ? 'ok' : sr >= 0.05 ? 'warn' : 'bad');
  } else {
    ['rEmergencyFund','rSavingsRate'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.textContent = '—'; el.className = el.className.replace(/ratio-(ok|warn|bad|neutral)/g, '').trim() + ' ratio-neutral'; }
    });
  }
}

function updateCreditUtilization() {
  let totalBalance = 0, totalLimit = 0;
  document.querySelectorAll('#liabilityBody tr').forEach(row => {
    const limit = parseFloat(row.querySelector('.liability-limit')?.value || '0') || 0;
    if (limit > 0) {
      totalBalance += parseFloat(row.querySelector('.liability-balance')?.value || '0') || 0;
      totalLimit   += limit;
    }
  });
  const el = document.getElementById('rCreditUtil');
  if (!el) return;
  if (totalLimit <= 0) {
    el.textContent = '—';
    el.className   = el.className.replace(/ratio-(ok|warn|bad|neutral)/g, '').trim() + ' ratio-neutral';
    return;
  }
  const util = totalBalance / totalLimit;
  setRatioEl('rCreditUtil', (util * 100).toFixed(1) + '%', util <= 0.30 ? 'ok' : util <= 0.50 ? 'warn' : 'bad');
}

function updateMiddleScore() {
  const scores = ['finScoreEq','finScoreEx','finScoreTu']
    .map(id => { const v = parseFloat(document.getElementById(id)?.value || ''); return isNaN(v) ? null : v; })
    .filter(v => v !== null && v > 0);

  const midEl  = document.getElementById('rMiddleScore');
  const noteEl = document.getElementById('rMiddleScoreNote');
  if (!midEl) return;

  if (scores.length === 0) {
    midEl.textContent  = '—';
    midEl.className    = 'credit-middle-val ratio-neutral';
    if (noteEl) noteEl.textContent = 'Enter at least one bureau score';
    return;
  }

  scores.sort((a, b) => a - b);
  const mid = scores.length === 1 ? scores[0] : scores.length === 2 ? scores[0] : scores[1];
  const status = mid >= 680 ? 'ok' : mid >= 620 ? 'warn' : 'bad';
  midEl.textContent = String(mid);
  midEl.className   = 'credit-middle-val ratio-' + status;
  if (noteEl) noteEl.textContent = scores.length === 1 ? 'Only score' : scores.length === 2 ? 'Lower of 2 scores' : 'Middle of 3 scores';
}

function updateDerogatoryDisplay() {
  const input = document.getElementById('finDerogatoryCount');
  const el    = document.getElementById('rDerogatory');
  if (!el) return;
  if (!input?.value && input?.value !== '0') {
    el.textContent = '—'; el.className = el.className.replace(/ratio-(ok|warn|bad|neutral)/g, '').trim() + ' ratio-neutral'; return;
  }
  const count = parseInt(input.value) || 0;
  el.textContent = count;
  setRatioEl('rDerogatory', String(count), count === 0 ? 'ok' : count <= 2 ? 'warn' : 'bad');
}

function updateLastLateDisplay() {
  const input = document.getElementById('finMonthsSinceLate');
  const el    = document.getElementById('rLastLate');
  if (!el) return;
  if (!input?.value && input?.value !== '0') {
    el.textContent = '—'; el.className = el.className.replace(/ratio-(ok|warn|bad|neutral)/g, '').trim() + ' ratio-neutral'; return;
  }
  const mo = parseInt(input.value) || 0;
  setRatioEl('rLastLate', mo + ' mo', mo >= 24 ? 'ok' : mo >= 12 ? 'warn' : 'bad');
}

// ── Household members table ───────────────────────────────────────────────────

const RELATIONSHIPS = ['Spouse', 'Partner', 'Co-Borrower', 'Dependent', 'Other Adult'];

function renderHouseholdTable(rows) {
  const tbody = document.getElementById('householdBody');
  if (!tbody) return;
  tbody.innerHTML = '';
  rows.forEach(r => tbody.appendChild(makeHouseholdRow(r)));
}

function makeHouseholdRow(r = {}) {
  const tr = document.createElement('tr');
  const relOpts = RELATIONSHIPS.map(v =>
    `<option value="${escAttr(v)}" ${v === (r.relationship || '') ? 'selected' : ''}>${v}</option>`
  ).join('');
  const ssnMasked = r.ssn ? maskSSN(r.ssn) : '';

  tr.innerHTML = `
    <td><input type="text" class="hh-name" value="${escAttr(r.name || '')}"></td>
    <td><select class="hh-rel"><option value="">— Select —</option>${relOpts}</select></td>
    <td><input type="date" class="hh-dob" value="${escAttr(r.dateOfBirth || '')}"></td>
    <td>
      <div style="display:flex;gap:0.3rem;align-items:center;">
        <input type="text" class="hh-ssn" autocomplete="off" maxlength="11"
          value="${escAttr(ssnMasked)}"
          data-real-value="${escAttr(r.ssn || '')}"
          data-revealed="false"
          ${canViewSSN() ? '' : 'readonly style="color:var(--text-muted);background:#f8f9fb;"'}
          placeholder="XXX-XX-XXXX" style="flex:1;width:100px;">
        ${canViewSSN() ? `<button type="button" class="hh-ssn-btn btn btn-secondary btn-sm" title="Show SSN" style="padding:0.2rem 0.4rem;flex-shrink:0;">&#128065;</button>` : ''}
      </div>
    </td>
    <td><input type="number" class="hh-income" value="${r.monthlyIncome || ''}" min="0" step="0.01"></td>
    <td><input type="text" class="hh-source" value="${escAttr(r.incomeSource || '')}"></td>
    <td><button type="button" class="del-btn" title="Remove">&times;</button></td>`;

  tr.querySelector('.del-btn').addEventListener('click', () => tr.remove());

  if (canViewSSN()) {
    const ssnInput = tr.querySelector('.hh-ssn');
    const ssnBtn   = tr.querySelector('.hh-ssn-btn');
    ssnBtn.addEventListener('click', () => {
      if (ssnInput.dataset.revealed === 'false') {
        ssnInput.value = ssnInput.dataset.realValue;
        ssnInput.readOnly = false;
        ssnInput.dataset.revealed = 'true';
        ssnBtn.textContent = 'Hide';
      } else {
        ssnInput.dataset.realValue = ssnInput.value.trim();
        ssnInput.value = ssnInput.dataset.realValue ? maskSSN(ssnInput.dataset.realValue) : '';
        ssnInput.readOnly = true;
        ssnInput.dataset.revealed = 'false';
        ssnBtn.innerHTML = '&#128065;';
      }
    });
  }

  return tr;
}

function readHouseholdRows() {
  return [...document.querySelectorAll('#householdBody tr')].map(row => {
    const ssnInput = row.querySelector('.hh-ssn');
    const ssn = ssnInput
      ? (ssnInput.dataset.revealed === 'true' ? ssnInput.value.trim() : ssnInput.dataset.realValue || '')
      : '';
    return {
      name:         row.querySelector('.hh-name')?.value.trim()   || '',
      relationship: row.querySelector('.hh-rel')?.value           || '',
      dateOfBirth:  row.querySelector('.hh-dob')?.value           || '',
      ssn,
      monthlyIncome: parseFloat(row.querySelector('.hh-income')?.value || '0') || 0,
      incomeSource:  row.querySelector('.hh-source')?.value.trim() || '',
    };
  }).filter(r => r.name || r.monthlyIncome);
}

// ── Employment rows ───────────────────────────────────────────────────────────

function renderEmpTable(rows) {
  const tbody = document.getElementById('empBody');
  tbody.innerHTML = '';
  (rows || [{}]).forEach(r => tbody.appendChild(makeEmpRow(r)));
}

function makeEmpRow(r = {}) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="emp-who" value="${escAttr(r.who || '')}"></td>
    <td><input type="text" class="emp-employer" value="${escAttr(r.employer || '')}"></td>
    <td><input type="text" class="emp-start" value="${escAttr(r.startDate || '')}" placeholder="MM/YY"></td>
    <td><input type="text" class="emp-end" value="${escAttr(r.endDate || '')}" placeholder="MM/YY or Current"></td>
    <td><input type="text" class="emp-position" value="${escAttr(r.position || '')}"></td>
    <td><input type="text" class="emp-reason" value="${escAttr(r.reasonForLeaving || '')}"></td>
    <td><input type="number" class="emp-gross" value="${r.grossMonthly || ''}" min="0" step="0.01"></td>
    <td><input type="number" class="emp-net" value="${r.netMonthly || ''}" min="0" step="0.01"></td>
    <td><button type="button" class="del-btn" title="Remove row">&times;</button></td>`;
  tr.querySelector('.del-btn').addEventListener('click', () => { tr.remove(); updateRatioSummary(); updateLiquidityCalcs(); });
  return tr;
}

function addEmpRow() {
  document.getElementById('empBody').appendChild(makeEmpRow());
}

function readEmpRows() {
  return [...document.querySelectorAll('#empBody tr')].map(row => ({
    who:              row.querySelector('.emp-who')?.value.trim()       || '',
    employer:         row.querySelector('.emp-employer')?.value.trim()  || '',
    startDate:        row.querySelector('.emp-start')?.value.trim()     || '',
    endDate:          row.querySelector('.emp-end')?.value.trim()       || '',
    position:         row.querySelector('.emp-position')?.value.trim()  || '',
    reasonForLeaving: row.querySelector('.emp-reason')?.value.trim()    || '',
    grossMonthly:     parseFloat(row.querySelector('.emp-gross')?.value || '0') || 0,
    netMonthly:       parseFloat(row.querySelector('.emp-net')?.value   || '0') || 0,
  })).filter(r => r.who || r.employer || r.position);
}

// ── Other income rows ─────────────────────────────────────────────────────────

function renderIncomeTable(rows) {
  const tbody = document.getElementById('incomeBody');
  tbody.innerHTML = '';
  (rows || [{}]).forEach(r => tbody.appendChild(makeIncomeRow(r)));
}

function makeIncomeRow(r = {}) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="inc-who" value="${escAttr(r.who || '')}"></td>
    <td><input type="text" class="inc-source" value="${escAttr(r.source || '')}"></td>
    <td><input type="number" class="inc-amount" value="${r.monthlyAmount || ''}" min="0" step="0.01"></td>
    <td><input type="text" class="inc-desc" value="${escAttr(r.description || '')}"></td>
    <td><button type="button" class="del-btn" title="Remove row">&times;</button></td>`;
  tr.querySelector('.del-btn').addEventListener('click', () => { tr.remove(); updateRatioSummary(); updateLiquidityCalcs(); });
  return tr;
}

function addIncomeRow() {
  document.getElementById('incomeBody').appendChild(makeIncomeRow());
}

function readIncomeRows() {
  return [...document.querySelectorAll('#incomeBody tr')].map(row => ({
    who:           row.querySelector('.inc-who')?.value.trim()    || '',
    source:        row.querySelector('.inc-source')?.value.trim() || '',
    monthlyAmount: parseFloat(row.querySelector('.inc-amount')?.value || '0') || 0,
    description:   row.querySelector('.inc-desc')?.value.trim()   || '',
  })).filter(r => r.who || r.source || r.monthlyAmount);
}

// ── Liability rows ────────────────────────────────────────────────────────────

function renderLiabilityTable(rows) {
  const tbody = document.getElementById('liabilityBody');
  tbody.innerHTML = '';
  (rows || [{}]).forEach(r => tbody.appendChild(makeLiabilityRow(r)));
  updateLiabilityTotals();
}

function makeLiabilityRow(r = {}) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="liab-name" value="${escAttr(r.accountName || '')}"></td>
    <td><input type="number" class="liability-payment" value="${r.monthlyPayment || ''}" min="0" step="0.01"></td>
    <td><input type="number" class="liability-balance" value="${r.balance || ''}" min="0" step="0.01"></td>
    <td><input type="number" class="liability-limit" value="${r.creditLimit || ''}" min="0" step="0.01" placeholder="Revolving only"></td>
    <td><button type="button" class="del-btn" title="Remove row">&times;</button></td>`;
  tr.querySelector('.del-btn').addEventListener('click', () => { tr.remove(); updateLiabilityTotals(); });
  tr.querySelector('.liability-payment').addEventListener('input', updateLiabilityTotals);
  tr.querySelector('.liability-balance').addEventListener('input', updateLiabilityTotals);
  tr.querySelector('.liability-limit').addEventListener('input', updateLiabilityTotals);
  return tr;
}

function addLiabilityRow() {
  const tbody = document.getElementById('liabilityBody');
  const row = makeLiabilityRow();
  tbody.appendChild(row);
  updateLiabilityTotals();
}

function readLiabilityRows() {
  return [...document.querySelectorAll('#liabilityBody tr')].map(row => ({
    accountName:    row.querySelector('.liab-name')?.value.trim()           || '',
    monthlyPayment: parseFloat(row.querySelector('.liability-payment')?.value || '0') || 0,
    balance:        parseFloat(row.querySelector('.liability-balance')?.value  || '0') || 0,
    creditLimit:    parseFloat(row.querySelector('.liability-limit')?.value    || '0') || 0,
  })).filter(r => r.accountName || r.monthlyPayment || r.balance);
}

// ── Load / save financials ────────────────────────────────────────────────────

function loadFinancials(c) {
  renderEmpTable(c.employmentHistory);
  renderIncomeTable(c.otherIncome);
  renderLiabilityTable(c.monthlyLiabilities);

  HOUSING_EXP_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el && c[id] != null) el.value = c[id];
  });
  LIVING_EXP_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el && c[id] != null) el.value = c[id];
  });

  // Liquidity & credit health fields (null-safe — null values leave inputs blank)
  ['finLiquidAssets','finMonthlySavings',
   'finScoreEq','finScoreEqDate','finScoreEx','finScoreExDate','finScoreTu','finScoreTuDate',
   'finDerogatoryCount','finMonthsSinceLate'].forEach(id => {
    const el = document.getElementById(id);
    if (el && c[id] != null) el.value = c[id];
  });

  updateHousingTotal();
  updateLivingTotal();
  updateLiabilityTotals();
  updateLiquidityCalcs();
  updateCreditUtilization();
  updateMiddleScore();
  updateDerogatoryDisplay();
  updateLastLateDisplay();
}

function readExpFields() {
  const out = {};
  HOUSING_EXP_IDS.forEach(id => { out[id] = numVal(id); });
  LIVING_EXP_IDS.forEach(id => { out[id] = numVal(id); });
  return out;
}

async function saveFinancials() {
  const btn   = document.getElementById('saveFinancialsBtn');
  const msgEl = document.getElementById('finSaveMsg');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  msgEl.classList.add('hidden');

  try {
    const data = {
      employmentHistory:  readEmpRows(),
      otherIncome:        readIncomeRows(),
      monthlyLiabilities: readLiabilityRows(),
      ...readExpFields(),
      finLiquidAssets:    parseFloat(document.getElementById('finLiquidAssets')?.value)   || 0,
      finMonthlySavings:  parseFloat(document.getElementById('finMonthlySavings')?.value) || 0,
      finScoreEq:         parseFloat(document.getElementById('finScoreEq')?.value)   || null,
      finScoreEqDate:     document.getElementById('finScoreEqDate')?.value            || '',
      finScoreEx:         parseFloat(document.getElementById('finScoreEx')?.value)   || null,
      finScoreExDate:     document.getElementById('finScoreExDate')?.value            || '',
      finScoreTu:         parseFloat(document.getElementById('finScoreTu')?.value)   || null,
      finScoreTuDate:     document.getElementById('finScoreTuDate')?.value            || '',
      finDerogatoryCount: document.getElementById('finDerogatoryCount')?.value !== '' ? (parseInt(document.getElementById('finDerogatoryCount')?.value) || 0) : null,
      finMonthsSinceLate: document.getElementById('finMonthsSinceLate')?.value !== '' ? (parseInt(document.getElementById('finMonthsSinceLate')?.value) || 0) : null,
      updatedAt: serverTimestamp(),
    };
    await updateDoc(doc(db, 'clients', clientId), data);
    Object.assign(_client, data);
    msgEl.textContent = 'Saved.';
    msgEl.style.color = 'var(--success, green)';
    msgEl.classList.remove('hidden');
    setTimeout(() => msgEl.classList.add('hidden'), 2500);
  } catch (err) {
    msgEl.textContent = 'Save failed: ' + err.message;
    msgEl.style.color = 'var(--danger, red)';
    msgEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Financials';
  }
}

// ── Session snapshot ──────────────────────────────────────────────────────────

// Fields excluded from snapshots — operational / computed / storage metadata
const SNAPSHOT_EXCLUDE = new Set([
  'id', 'updatedAt', 'createdAt', 'sessionCount', 'totalOutcomeValue',
  'firstSessionDate', 'lastSessionDate', 'status', 'closureDate',
  'closureOutcome', 'closureOutcomeValue', 'closureAwardType',
  'totalDownPayment', 'ccaAmountProvided',
  'driveFolderId', 'driveFolderName', 'driveFolderUrl',
  'rxNumber',  // legacy field — subcollection is authoritative
]);

function buildClientSnapshot() {
  const snapshot = { snapshotAt: new Date().toISOString() };
  for (const [k, v] of Object.entries(_client)) {
    if (!SNAPSHOT_EXCLUDE.has(k)) snapshot[k] = v;
  }
  return snapshot;
}

function openSnapshotView(snap) {
  const fmtD = iso => {
    if (!iso) return '—';
    const d = new Date(iso + (iso.length === 10 ? 'T12:00:00' : ''));
    return isNaN(d) ? iso : d.toLocaleDateString('en-US');
  };
  const fmtN = (n, prefix = '$') => n > 0
    ? prefix + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2 })
    : '—';
  const v  = val => escHtml(String(val ?? '—'));
  const row = (label, val) => val && val !== '—'
    ? `<div style="display:flex;gap:0.5rem;padding:0.2rem 0;font-size:0.825rem;border-bottom:1px solid #f0f1f3;">
        <span style="min-width:180px;font-weight:600;flex-shrink:0;color:var(--text-muted);">${label}</span>
        <span>${val}</span>
       </div>`
    : '';

  const sectionHdr = label =>
    `<p style="font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted);margin:1rem 0 0.3rem;">${label}</p>`;

  // Expense totals
  const housingTotal = HOUSING_EXP_IDS.reduce((s, id) => s + (Number(snap[id]) || 0), 0);
  const livingTotal  = LIVING_EXP_IDS.reduce((s, id) => s + (Number(snap[id]) || 0), 0);

  // Employment rows
  const empRows = (snap.employmentHistory || []).map(e =>
    `<tr style="font-size:0.8rem;border-bottom:1px solid #f0f1f3;">
      <td style="padding:0.25rem 0.4rem;">${escHtml(e.who || '')}</td>
      <td style="padding:0.25rem 0.4rem;">${escHtml(e.employer || '')}</td>
      <td style="padding:0.25rem 0.4rem;">${escHtml(e.position || '')}</td>
      <td style="padding:0.25rem 0.4rem;text-align:right;">${fmtN(e.grossMonthly)}</td>
      <td style="padding:0.25rem 0.4rem;text-align:right;">${fmtN(e.netMonthly)}</td>
    </tr>`
  ).join('');

  const empTable = empRows
    ? `<table style="width:100%;border-collapse:collapse;font-size:0.8rem;margin-bottom:0.5rem;">
        <thead><tr style="background:#f8f9fb;">
          <th style="padding:0.25rem 0.4rem;text-align:left;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-muted);">Who</th>
          <th style="padding:0.25rem 0.4rem;text-align:left;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-muted);">Employer</th>
          <th style="padding:0.25rem 0.4rem;text-align:left;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-muted);">Position</th>
          <th style="padding:0.25rem 0.4rem;text-align:right;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-muted);">Gross/Mo</th>
          <th style="padding:0.25rem 0.4rem;text-align:right;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-muted);">Net/Mo</th>
        </tr></thead>
        <tbody>${empRows}</tbody>
      </table>`
    : '<p style="font-size:0.8rem;color:var(--text-muted);">No employment history recorded.</p>';

  // Other income rows
  const incRows = (snap.otherIncome || []).map(i =>
    `<tr style="font-size:0.8rem;border-bottom:1px solid #f0f1f3;">
      <td style="padding:0.25rem 0.4rem;">${escHtml(i.who || '')}</td>
      <td style="padding:0.25rem 0.4rem;">${escHtml(i.source || '')}</td>
      <td style="padding:0.25rem 0.4rem;text-align:right;">${fmtN(i.monthlyAmount)}</td>
      <td style="padding:0.25rem 0.4rem;">${escHtml(i.description || '')}</td>
    </tr>`
  ).join('');

  // Liability rows
  const liabRows = (snap.monthlyLiabilities || []).map(l =>
    `<tr style="font-size:0.8rem;border-bottom:1px solid #f0f1f3;">
      <td style="padding:0.25rem 0.4rem;">${escHtml(l.accountName || '')}</td>
      <td style="padding:0.25rem 0.4rem;text-align:right;">${fmtN(l.monthlyPayment)}</td>
      <td style="padding:0.25rem 0.4rem;text-align:right;">${fmtN(l.balance)}</td>
    </tr>`
  ).join('');
  const liabPayTotal = (snap.monthlyLiabilities || []).reduce((s, l) => s + (Number(l.monthlyPayment) || 0), 0);
  const liabBalTotal = (snap.monthlyLiabilities || []).reduce((s, l) => s + (Number(l.balance) || 0), 0);

  const html = `
    ${sectionHdr('Profile')}
    ${row('Client Name',      v(snap.clientName))}
    ${row('Counseling Type',  v(snap.counselingType))}
    ${row('Billing Type',     v(snap.billingType))}
    ${row('Counselor',        v(snap.counselor))}
    ${row('AMI Level',        v(amiDisplayLabel(snap.amiPercent)))}
    ${row('Race & Ethnicity', v(snap.reCode))}

    ${sectionHdr('Contact')}
    ${row('Address', [snap.streetAddress, snap.city, snap.county, snap.zipCode].filter(Boolean).map(escHtml).join(', '))}
    ${row('Date of Birth',    fmtD(snap.dateOfBirth))}
    ${row('Email',            v(snap.email))}
    ${row('Home Phone',       v(snap.homePhone))}
    ${row('Cell Phone',       v(snap.cellPhone))}
    ${snap.coApplicantName ? sectionHdr('Co-Applicant') + row('Name', v(snap.coApplicantName)) + row('DOB', fmtD(snap.coApplicantDob)) : ''}

    ${sectionHdr('Household')}
    ${row('Marital Status',   v(snap.maritalStatus))}
    ${row('Adults',           v(snap.adultsInHousehold))}
    ${row('Children',         v(snap.childrenInHousehold))}

    ${snap.mortgage1Company || snap.propertyType ? sectionHdr('Property & Mortgage') +
      row('Property Type',    v(snap.propertyType)) +
      row('Mortgage Type',    v(snap.mortgageType)) +
      row('1st Mortgage',     v(snap.mortgage1Company)) +
      row('2nd Mortgage',     v(snap.mortgage2Company)) +
      row('3rd Mortgage',     v(snap.mortgage3Company))
    : ''}

    ${sectionHdr('Employment History')}
    ${empTable}

    ${incRows ? sectionHdr('Other Income') + `<table style="width:100%;border-collapse:collapse;margin-bottom:0.5rem;">
      <thead><tr style="background:#f8f9fb;">
        <th style="padding:0.25rem 0.4rem;text-align:left;font-size:0.7rem;text-transform:uppercase;color:var(--text-muted);">Who</th>
        <th style="padding:0.25rem 0.4rem;text-align:left;font-size:0.7rem;text-transform:uppercase;color:var(--text-muted);">Source</th>
        <th style="padding:0.25rem 0.4rem;text-align:right;font-size:0.7rem;text-transform:uppercase;color:var(--text-muted);">Monthly</th>
        <th style="padding:0.25rem 0.4rem;text-align:left;font-size:0.7rem;text-transform:uppercase;color:var(--text-muted);">Description</th>
      </tr></thead><tbody>${incRows}</tbody>
    </table>` : ''}

    ${sectionHdr('Monthly Expenses')}
    <div style="display:flex;gap:2rem;font-size:0.825rem;margin-bottom:0.5rem;">
      <div>${row('Housing Total', fmtN(housingTotal))}</div>
      <div>${row('Living Total',  fmtN(livingTotal))}</div>
      <div>${row('Grand Total',   fmtN(housingTotal + livingTotal))}</div>
    </div>

    ${liabRows ? sectionHdr('Monthly Liabilities') + `<table style="width:100%;border-collapse:collapse;margin-bottom:0.5rem;">
      <thead><tr style="background:#f8f9fb;">
        <th style="padding:0.25rem 0.4rem;text-align:left;font-size:0.7rem;text-transform:uppercase;color:var(--text-muted);">Account</th>
        <th style="padding:0.25rem 0.4rem;text-align:right;font-size:0.7rem;text-transform:uppercase;color:var(--text-muted);">Monthly Pmt</th>
        <th style="padding:0.25rem 0.4rem;text-align:right;font-size:0.7rem;text-transform:uppercase;color:var(--text-muted);">Balance</th>
      </tr></thead>
      <tbody>${liabRows}</tbody>
      <tfoot><tr style="background:#f8f9fb;font-weight:700;font-size:0.8rem;">
        <td style="padding:0.3rem 0.4rem;">Totals</td>
        <td style="padding:0.3rem 0.4rem;text-align:right;">${fmtN(liabPayTotal)}</td>
        <td style="padding:0.3rem 0.4rem;text-align:right;">${fmtN(liabBalTotal)}</td>
      </tr></tfoot>
    </table>` : ''}
  `;

  const takenAt = snap.snapshotAt
    ? new Date(snap.snapshotAt).toLocaleString('en-US')
    : 'unknown date';
  document.getElementById('snapshotDateLine').textContent =
    `Captured at time of session — ${takenAt}`;
  document.getElementById('snapshotContent').innerHTML = html;
  document.getElementById('snapshotModal').classList.remove('hidden');
}

// ── Export PDF ────────────────────────────────────────────────────────────────

function generateExportPdf() {
  if (isDemoMode()) return;
  const include = {
    overview:   document.getElementById('exportOverview').checked,
    intake:     document.getElementById('exportIntake').checked,
    financials: document.getElementById('exportFinancials').checked,
    sessions:   document.getElementById('exportSessions').checked,
  };
  if (!Object.values(include).some(Boolean)) {
    alert('Select at least one section.');
    return;
  }

  const c       = _client;
  const logoUrl = new URL('img/logo.png', window.location.href).href;
  const chk     = val => val ? '&#9745;' : '&#9744;';
  const v       = val => escHtml(String(val ?? ''));
  const fmtMon  = n => { const num = Number(n) || 0; return num > 0 ? '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2 }) : ''; };
  const pdfRow  = (label, val) =>
    `<div class="prow"><span class="plbl">${label}</span><span class="pval">${val ?? ''}</span></div>`;
  const secHdr  = title => `<h2>${title}</h2>`;

  let body = '';

  // ── Overview ──────────────────────────────────────────────────────────────
  if (include.overview) {
    body += secHdr('Identity');
    body += `<div class="two-col">
      <div>
        ${pdfRow('Client Name',     v(c.clientName))}
        ${pdfRow('Counseling Type', v(c.counselingType))}
        ${pdfRow('Billing Type',    v(c.billingType))}
        ${pdfRow('Counselor',       v(c.counselor))}
      </div>
      <div>
        ${pdfRow('AMI Level',        v(amiDisplayLabel(c.amiPercent)))}
        ${pdfRow('Race &amp; Ethnicity', v(c.reCode))}
        <div class="prow"><span class="plbl">Hispanic / Latino</span><span class="pval"><span class="chk">${chk(c.hispanic)}</span></span></div>
        <div class="prow"><span class="plbl">Female-Headed HH</span><span class="pval"><span class="chk">${chk(c.femaleHeaded)}</span></span></div>
      </div>
    </div>`;

    if (_rxDocs.length) {
      body += secHdr('Rx Numbers');
      body += `<table>
        <thead><tr><th>Rx #</th><th>Guarantor</th><th>Active</th></tr></thead>
        <tbody>${_rxDocs.map(r => `<tr>
          <td>${escHtml(r.rxNumber)}</td>
          <td>${escHtml(r.guarantor || '—')}</td>
          <td>${r.active !== false ? 'Yes' : 'No'}</td>
        </tr>`).join('')}</tbody>
      </table>`;
    }
  }

  // ── Intake ────────────────────────────────────────────────────────────────
  if (include.intake) {
    body += secHdr('Contact Information');
    body += `<div class="two-col">
      <div>
        ${pdfRow('Street Address',   v(c.streetAddress))}
        ${pdfRow('City',             v(c.city))}
        ${pdfRow('County',           v(c.county))}
        ${pdfRow('Zip Code',         v(c.zipCode))}
        ${pdfRow('Date of Birth',    fmtDate(c.dateOfBirth))}
        ${pdfRow('Email',            v(c.email))}
      </div>
      <div>
        ${pdfRow('Home Phone',       v(c.homePhone))}
        ${pdfRow('Work Phone',       v(c.workPhone))}
        ${pdfRow('Cell Phone',       v(c.cellPhone))}
        ${pdfRow('Marital Status',   v(c.maritalStatus))}
        ${pdfRow('Adults in HH',     v(c.adultsInHousehold))}
        ${pdfRow('Children in HH',   v(c.childrenInHousehold))}
      </div>
    </div>`;

    if (c.coApplicantName) {
      body += secHdr('Co-Applicant');
      body += `<div class="two-col">
        <div>
          ${pdfRow('Name',        v(c.coApplicantName))}
          ${pdfRow('DOB',         fmtDate(c.coApplicantDob))}
          ${pdfRow('Email',       v(c.coApplicantEmail))}
        </div>
        <div>
          ${pdfRow('Home Phone',  v(c.coApplicantHomePhone))}
          ${pdfRow('Work Phone',  v(c.coApplicantWorkPhone))}
          ${pdfRow('Cell Phone',  v(c.coApplicantCellPhone))}
        </div>
      </div>`;
    }

    if (c.counselingType === 'OUTSTANDING' || c.counselingType === 'COURT') {
      body += secHdr('Property &amp; Mortgage');
      body += `<div class="two-col">
        <div>
          ${pdfRow('Property Type',    v(c.propertyType))}
          ${pdfRow('Mortgage Type',    v(c.mortgageType))}
          <div class="prow"><span class="plbl">Primary Residence</span><span class="pval"><span class="chk">${chk(c.primaryResidence)}</span></span></div>
          ${pdfRow('1st Mortgage Co.', v(c.mortgage1Company))}
          ${pdfRow('2nd Mortgage Co.', v(c.mortgage2Company))}
          ${pdfRow('3rd Mortgage Co.', v(c.mortgage3Company))}
        </div>
        <div>
          <div class="prow"><span class="plbl">Bankruptcy Filed</span><span class="pval"><span class="chk">${chk(c.bankruptcyFiled)}</span></span></div>
          ${c.bankruptcyFiled ? pdfRow('Bankruptcy Acct #', v(c.bankruptcyAccount)) : ''}
          ${c.counselingType === 'COURT' ? pdfRow('Conciliation Stamp', fmtDate(c.conciliationStampDate)) : ''}
        </div>
      </div>`;
    }

    if (c.counselingType === 'PRE' && c.homeSearchNotes) {
      body += secHdr('Home Search Notes');
      body += `<p style="font-size:8.5pt;border:1px solid #ccc;padding:6px;border-radius:3px;margin:0;">${v(c.homeSearchNotes)}</p>`;
    }
  }

  // ── Financials ────────────────────────────────────────────────────────────
  if (include.financials) {
    const empRows  = c.employmentHistory  || [];
    const incRows  = c.otherIncome        || [];
    const liabRows = c.monthlyLiabilities || [];

    body += secHdr('Employment History');
    if (empRows.length) {
      body += `<table>
        <thead><tr><th>Applicant</th><th>Employer</th><th>Start</th><th>End</th><th>Position</th><th>Reason Left</th><th>Gross/Mo</th><th>Net/Mo</th></tr></thead>
        <tbody>${empRows.map(e => `<tr>
          <td>${escHtml(e.who || '')}</td>
          <td>${escHtml(e.employer || '')}</td>
          <td>${escHtml(e.startDate || '')}</td>
          <td>${escHtml(e.endDate || '')}</td>
          <td>${escHtml(e.position || '')}</td>
          <td>${escHtml(e.reasonForLeaving || '')}</td>
          <td>${fmtMon(e.grossMonthly)}</td>
          <td>${fmtMon(e.netMonthly)}</td>
        </tr>`).join('')}</tbody>
      </table>`;
    } else {
      body += `<p class="empty">No employment history recorded.</p>`;
    }

    if (incRows.length) {
      body += secHdr('Other Income Sources');
      body += `<table>
        <thead><tr><th>Applicant</th><th>Source</th><th>Monthly</th><th>Description</th></tr></thead>
        <tbody>${incRows.map(i => `<tr>
          <td>${escHtml(i.who || '')}</td>
          <td>${escHtml(i.source || '')}</td>
          <td>${fmtMon(i.monthlyAmount)}</td>
          <td>${escHtml(i.description || '')}</td>
        </tr>`).join('')}</tbody>
      </table>`;
    }

    const hTotal = HOUSING_EXP_IDS.reduce((s, id) => s + (Number(c[id]) || 0), 0);
    const lTotal = LIVING_EXP_IDS.reduce((s,  id) => s + (Number(c[id]) || 0), 0);

    body += secHdr('Monthly Expense Sheet');
    body += `<div class="two-col">
      <div>
        <p class="col-hdr">Housing Expenses</p>
        ${HOUSING_EXP_IDS.map(id => `<div class="erow">
          <span>${HOUSING_EXP_LABELS[id]}</span>
          <span>${fmtMon(c[id]) || '—'}</span>
        </div>`).join('')}
        <div class="erow etotal"><span>Total Housing</span><span>$${hTotal.toLocaleString('en-US',{minimumFractionDigits:2})}</span></div>
      </div>
      <div>
        <p class="col-hdr">Living Expenses</p>
        ${LIVING_EXP_IDS.map(id => `<div class="erow">
          <span>${LIVING_EXP_LABELS[id]}</span>
          <span>${fmtMon(c[id]) || '—'}</span>
        </div>`).join('')}
        <div class="erow etotal"><span>Total Living</span><span>$${lTotal.toLocaleString('en-US',{minimumFractionDigits:2})}</span></div>
      </div>
    </div>
    <div class="grand-total">
      <span>Total Monthly Expenses</span>
      <span>$${(hTotal + lTotal).toLocaleString('en-US',{minimumFractionDigits:2})}</span>
    </div>`;

    if (liabRows.length) {
      const lpTotal = liabRows.reduce((s, l) => s + (Number(l.monthlyPayment) || 0), 0);
      const lbTotal = liabRows.reduce((s, l) => s + (Number(l.balance)        || 0), 0);
      body += secHdr('Monthly Liabilities');
      body += `<table>
        <thead><tr><th>Account Name</th><th>Monthly Payment</th><th>Balance</th></tr></thead>
        <tbody>${liabRows.map(l => `<tr>
          <td>${escHtml(l.accountName || '')}</td>
          <td>${fmtMon(l.monthlyPayment)}</td>
          <td>${fmtMon(l.balance)}</td>
        </tr>`).join('')}
        <tr class="total-row">
          <td><strong>Totals</strong></td>
          <td><strong>$${lpTotal.toLocaleString('en-US',{minimumFractionDigits:2})}</strong></td>
          <td><strong>$${lbTotal.toLocaleString('en-US',{minimumFractionDigits:2})}</strong></td>
        </tr></tbody>
      </table>`;
    }
  }

  // ── Sessions ──────────────────────────────────────────────────────────────
  if (include.sessions) {
    body += secHdr('Session History');
    if (_sessions.length) {
      body += `<table>
        <thead><tr><th>Date</th><th>Counselor</th><th>Rx #</th><th>Hrs</th><th>Status</th><th>Outcome</th><th>Notes</th></tr></thead>
        <tbody>${_sessions.map(s => `<tr>
          <td style="white-space:nowrap;">${fmtDate(s.date)}</td>
          <td>${escHtml(s.counselor  || '')}</td>
          <td>${escHtml(s.rxNumber   || '')}</td>
          <td>${s.hours || ''}</td>
          <td>${escHtml(s.caseStatus || '')}</td>
          <td>${escHtml(s.outcome    || '')}</td>
          <td>${escHtml(s.notes      || '')}</td>
        </tr>`).join('')}</tbody>
      </table>`;
    } else {
      body += `<p class="empty">No sessions on file.</p>`;
    }
  }

  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<title>Client Record — ${v(c.clientName)}</title>
<style>
  @page { margin:0.65in; size:letter portrait; }
  *  { box-sizing:border-box; }
  body { font-family:Arial,Helvetica,sans-serif; font-size:9pt; color:#000; margin:0;
         -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .header { display:flex; align-items:center; gap:12px;
            border-bottom:3px solid #1a3a8f; padding-bottom:8px; margin-bottom:14px; }
  .logo { height:50px; width:auto; }
  .header-text h1 { font-size:12pt; font-weight:bold; margin:0 0 2px; color:#1a3a8f; }
  .header-text p  { margin:0; font-size:8pt; color:#444; }
  h2 { font-size:8.5pt; font-weight:bold; text-transform:uppercase; letter-spacing:0.06em;
       color:#1a3a8f; border-bottom:1.5px solid #1a3a8f; padding-bottom:3px; margin:14px 0 6px; }
  .two-col { display:grid; grid-template-columns:1fr 1fr; gap:0 22px; }
  .prow { display:flex; gap:5px; margin-bottom:3px; align-items:baseline; }
  .plbl { font-weight:bold; font-size:8pt; white-space:nowrap; flex-shrink:0; min-width:130px; }
  .pval { flex:1; border-bottom:1px solid #bbb; min-height:13px; font-size:9pt; padding-bottom:1px; }
  .chk  { font-size:10pt; }
  table { width:100%; border-collapse:collapse; font-size:8pt; margin-bottom:10px; }
  th { background:#e8edf5; text-align:left; padding:4px 5px; border-bottom:2px solid #aaa;
       font-size:7pt; text-transform:uppercase; letter-spacing:0.04em; }
  td { padding:3px 5px; border-bottom:1px solid #eee; vertical-align:top; }
  .total-row td { background:#f0f0f0; }
  .col-hdr { font-weight:bold; font-size:8pt; text-transform:uppercase;
             letter-spacing:0.04em; margin:0 0 4px; color:#555; }
  .erow { display:flex; justify-content:space-between; padding:1.5px 0;
          border-bottom:1px solid #f0f0f0; font-size:8.5pt; }
  .etotal { font-weight:bold; border-top:2px solid #999; border-bottom:none;
            padding-top:3px; margin-top:3px; }
  .grand-total { display:flex; justify-content:space-between; font-weight:bold;
                 font-size:9.5pt; border-top:2px solid #333; padding-top:5px;
                 margin-top:6px; margin-bottom:4px; }
  .empty { font-size:8.5pt; color:#666; margin:0; }
  @media print { body { padding:0; } }
</style>
</head><body>
<div class="header">
  <img src="${logoUrl}" class="logo" alt="" onerror="this.style.display='none'">
  <div class="header-text">
    <h1>${v(c.clientName)} — Client Record</h1>
    <p>Housing Opportunities Inc. &nbsp;&#8226;&nbsp; 293 Pinney Street, Rochester, PA 15074 &nbsp;&#8226;&nbsp; Exported ${new Date().toLocaleDateString('en-US')}</p>
  </div>
</div>
${body}
<script>window.addEventListener('load', () => window.print());<\/script>
</body></html>`;

  const win = window.open('', '_blank');
  if (!win) { alert('Please allow pop-ups to export.'); return; }
  win.document.write(html);
  win.document.close();
  document.getElementById('exportModal').classList.add('hidden');
}

// ── Outreach History ──────────────────────────────────────────────────────────

async function loadOutreachHistory() {
  const panel = document.getElementById('outreachHistoryPanel');
  const list  = document.getElementById('outreachHistoryList');
  try {
    const snap = await getDocs(
      query(collection(db, 'outreachCalls'), where('linkedClientId', '==', clientId))
    );
    if (snap.empty) return;

    const calls = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const ta = a.date ? (a.date.toDate ? a.date.toDate() : new Date(a.date)).getTime() : 0;
        const tb = b.date ? (b.date.toDate ? b.date.toDate() : new Date(b.date)).getTime() : 0;
        return tb - ta;
      });
    list.innerHTML = calls.map(c => {
      const dateStr = c.date
        ? (c.date.toDate ? c.date.toDate() : new Date(c.date)).toLocaleDateString('en-US', { timeZone: 'UTC' })
        : '—';
      return `<div style="display:flex;gap:0.75rem;padding:0.35rem 0;border-bottom:1px solid var(--border,#dee2e6);align-items:baseline;">
        <span style="white-space:nowrap;color:var(--text-muted);font-size:0.8rem;">${dateStr}</span>
        <span style="flex:1;">${escHtml(c.outcome || c.notes || '—')}</span>
        ${c.counselor ? `<span style="font-size:0.8rem;color:var(--text-muted);">${escHtml(c.counselor)}</span>` : ''}
      </div>`;
    }).join('');
    panel.classList.remove('hidden');
  } catch (_) {}
}

function wireLogCallModal() {
  const modal   = document.getElementById('logCallFromClientModal');
  const saveBtn = document.getElementById('lcSaveBtn');
  const cancelBtn = document.getElementById('lcCancelBtn');

  document.getElementById('logCallFromClientBtn').addEventListener('click', () => {
    document.getElementById('lcDate').value     = new Date().toISOString().split('T')[0];
    document.getElementById('lcOutcome').value  = '';
    document.getElementById('lcNotes').value    = '';
    document.getElementById('lcError').classList.add('hidden');
    // Pre-select current counselor
    const sel = document.getElementById('lcCounselor');
    if (sel && _profile) sel.value = _profile.name || '';
    modal.classList.remove('hidden');
  });

  cancelBtn.addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });

  // Populate counselor dropdown
  loadCounselorOptions('lcCounselor');

  saveBtn.addEventListener('click', async () => {
    const errEl   = document.getElementById('lcError');
    const dateVal = document.getElementById('lcDate').value;
    const outcome = document.getElementById('lcOutcome').value.trim();
    const notes   = document.getElementById('lcNotes').value.trim();
    const counselor = document.getElementById('lcCounselor').value;

    errEl.classList.add('hidden');
    if (!dateVal) { errEl.textContent = 'Date is required.'; errEl.classList.remove('hidden'); return; }

    saveBtn.disabled    = true;
    saveBtn.textContent = 'Saving…';
    try {
      await addDoc(collection(db, 'outreachCalls'), {
        date:           new Date(dateVal + 'T12:00:00'),
        counselor,
        type:           'client',
        linkedClientId: clientId,
        linkedClientName: _client?.clientName || '',
        contactName:    _client?.clientName || '',
        phone:          _client?.phone || '',
        outcome,
        notes,
        createdAt:      serverTimestamp(),
        updatedAt:      serverTimestamp(),
      });
      modal.classList.add('hidden');
      await loadOutreachHistory();
    } catch (err) {
      errEl.textContent = 'Save failed: ' + err.message;
      errEl.classList.remove('hidden');
    } finally {
      saveBtn.disabled    = false;
      saveBtn.textContent = 'Save Call';
    }
  });
}

