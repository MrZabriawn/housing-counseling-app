import { db } from './firebase-config.js';
import {
  collection, addDoc, getDocs, query, orderBy, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

let _allCounselors    = [];
let _allClients       = [];
let _selectedClientId   = null;
let _selectedClientName = null;
let _callType = 'client';

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function toTitle(s) {
  return s.replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
}

function injectHtml() {
  const modal = document.createElement('div');
  modal.id = 'globalCallModal';
  modal.className = 'modal-overlay hidden';
  modal.innerHTML = `
    <div class="modal-box modal-box-wide">
      <h3>Log a Call</h3>
      <div class="form-grid" style="margin-top:1rem;">
        <div class="form-group">
          <label for="gcDate">Date *</label>
          <input type="date" id="gcDate">
        </div>
        <div class="form-group">
          <label for="gcCounselor">Counselor</label>
          <select id="gcCounselor"><option value="">— Select —</option></select>
        </div>
        <div class="form-group full-width">
          <label>Contact Type</label>
          <div class="call-type-toggle">
            <button class="call-type-btn active" data-type="client">Existing Client</button>
            <button class="call-type-btn" data-type="prospect">Prospect</button>
            <button class="call-type-btn" data-type="organizational">Organization</button>
          </div>
        </div>
        <div id="gcClientSection" class="form-group full-width">
          <label for="gcClientSearch">Search Client</label>
          <input type="text" id="gcClientSearch" placeholder="Name, counselor, or Rx…" autocomplete="off">
          <div id="gcClientResults" class="client-search-results">
            <div style="padding:1rem;color:var(--text-muted);font-size:0.875rem;">Start typing to find a client.</div>
          </div>
          <input type="hidden" id="gcClientId">
          <div id="gcClientChip" class="hidden" style="margin-top:0.5rem;font-size:0.875rem;background:var(--primary-light,#e8f0fe);border-radius:var(--radius);padding:0.4rem 0.75rem;display:flex;justify-content:space-between;align-items:center;">
            <span id="gcClientChipName"></span>
            <button type="button" id="gcClientClear" style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:1rem;">×</button>
          </div>
        </div>
        <div id="gcProspectSection" style="display:none;" class="form-group full-width">
          <div class="form-grid">
            <div class="form-group">
              <label for="gcProspectName">Prospect Name *</label>
              <input type="text" id="gcProspectName" placeholder="Full name">
            </div>
            <div class="form-group">
              <label for="gcProspectPhone">Phone Number</label>
              <input type="text" id="gcProspectPhone" placeholder="555-555-5555">
            </div>
          </div>
        </div>
        <div id="gcOrgSection" style="display:none;" class="form-group full-width">
          <div class="form-grid">
            <div class="form-group">
              <label for="gcOrgName">Organization Name *</label>
              <input type="text" id="gcOrgName" placeholder="e.g. Habitat for Humanity">
            </div>
            <div class="form-group">
              <label for="gcOrgContact">Contact Person</label>
              <input type="text" id="gcOrgContact" placeholder="Name of contact">
            </div>
          </div>
        </div>
        <div class="form-group">
          <label for="gcOutcome">Outcome</label>
          <input type="text" id="gcOutcome" placeholder="e.g. Left voicemail, Intake scheduled…">
        </div>
        <div class="form-group full-width">
          <label for="gcNotes">Notes</label>
          <textarea id="gcNotes" rows="3" placeholder="Brief summary of the call…"></textarea>
        </div>
      </div>
      <p id="gcError" class="error-msg hidden"></p>
      <div class="form-actions">
        <button id="gcSave" class="btn btn-primary">Save Call</button>
        <button id="gcCancel" class="btn btn-secondary">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

function setType(type) {
  _callType = type;
  document.querySelectorAll('#globalCallModal .call-type-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.type === type);
  });
  document.getElementById('gcClientSection').style.display   = type === 'client'       ? '' : 'none';
  document.getElementById('gcProspectSection').style.display = type === 'prospect'     ? '' : 'none';
  document.getElementById('gcOrgSection').style.display      = type === 'organizational' ? '' : 'none';
}

function openModal() {
  _selectedClientId   = null;
  _selectedClientName = null;
  document.getElementById('gcDate').value           = new Date().toISOString().split('T')[0];
  document.getElementById('gcOutcome').value        = '';
  document.getElementById('gcNotes').value          = '';
  document.getElementById('gcClientSearch').value   = '';
  document.getElementById('gcClientId').value       = '';
  document.getElementById('gcClientResults').innerHTML =
    '<div style="padding:1rem;color:var(--text-muted);font-size:0.875rem;">Start typing to find a client.</div>';
  document.getElementById('gcClientChip').classList.add('hidden');
  document.getElementById('gcError').classList.add('hidden');
  document.getElementById('gcProspectName').value   = '';
  document.getElementById('gcProspectPhone').value  = '';
  document.getElementById('gcOrgName').value        = '';
  document.getElementById('gcOrgContact').value     = '';
  setType('client');
  if (window._currentCounselor) document.getElementById('gcCounselor').value = window._currentCounselor;
  document.getElementById('globalCallModal').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('globalCallModal').classList.add('hidden');
}

async function loadCounselors() {
  if (_allCounselors.length) return;
  try {
    const snap = await getDocs(query(collection(db, 'counselors'), orderBy('name')));
    _allCounselors = snap.docs
      .filter(d => d.data().active !== false)
      .map(d => d.data().name);
    const sel = document.getElementById('gcCounselor');
    _allCounselors.forEach(name => {
      const o = document.createElement('option');
      o.value = name; o.textContent = name;
      sel.appendChild(o);
    });
    if (window._currentCounselor) sel.value = window._currentCounselor;
  } catch (_) {}
}

async function renderSearch() {
  const search    = document.getElementById('gcClientSearch').value.toLowerCase().trim();
  const resultsEl = document.getElementById('gcClientResults');
  if (!search) {
    resultsEl.innerHTML = '<div style="padding:1rem;color:var(--text-muted);font-size:0.875rem;">Start typing to find a client.</div>';
    return;
  }
  if (!_allClients.length) {
    resultsEl.innerHTML = '<div style="padding:1rem;color:var(--text-muted);font-size:0.875rem;">Loading…</div>';
    try {
      const snap = await getDocs(query(collection(db, 'clients'), orderBy('clientName')));
      _allClients = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (_) { _allClients = []; }
  }
  const matches = _allClients.filter(c =>
    (c.clientName || '').toLowerCase().includes(search) ||
    (c.counselor  || '').toLowerCase().includes(search) ||
    (c.rxNumbers  || []).some(rx => rx.toLowerCase().includes(search))
  ).slice(0, 30);
  if (!matches.length) {
    resultsEl.innerHTML = '<div style="padding:1rem;color:var(--text-muted);font-size:0.875rem;">No clients found.</div>';
    return;
  }
  resultsEl.innerHTML = matches.map(c =>
    `<div class="csr-item" data-id="${esc(c.id)}" data-name="${esc(c.clientName || '')}">
       <div class="csr-name">${esc(toTitle(c.clientName || ''))}</div>
       <div class="csr-meta">${esc(c.counselor || '')} · ${esc(c.counselingType || '')}</div>
     </div>`
  ).join('');
  resultsEl.querySelectorAll('.csr-item').forEach(item => {
    item.addEventListener('click', () => {
      _selectedClientId   = item.dataset.id;
      _selectedClientName = item.dataset.name;
      document.getElementById('gcClientId').value = _selectedClientId;
      document.getElementById('gcClientChipName').textContent = toTitle(_selectedClientName);
      document.getElementById('gcClientChip').classList.remove('hidden');
      document.getElementById('gcClientSearch').value = '';
      resultsEl.innerHTML = '<div style="padding:1rem;color:var(--text-muted);font-size:0.875rem;">Start typing to find a client.</div>';
    });
  });
}

async function saveCall() {
  const errorEl = document.getElementById('gcError');
  const saveBtn = document.getElementById('gcSave');
  errorEl.classList.add('hidden');

  const dateVal   = document.getElementById('gcDate').value;
  const counselor = document.getElementById('gcCounselor').value;
  const outcome   = document.getElementById('gcOutcome').value.trim();
  const notes     = document.getElementById('gcNotes').value.trim();

  if (!dateVal) {
    errorEl.textContent = 'Please select a date.';
    errorEl.classList.remove('hidden');
    return;
  }

  let contactName = '', linkedClientId = null, phone = '', orgName = '', orgContact = '';

  if (_callType === 'client') {
    if (!_selectedClientId) {
      errorEl.textContent = 'Please select a client or switch to Prospect.';
      errorEl.classList.remove('hidden');
      return;
    }
    linkedClientId = _selectedClientId;
    contactName    = _selectedClientName || '';
  } else if (_callType === 'prospect') {
    contactName = document.getElementById('gcProspectName').value.trim();
    phone       = document.getElementById('gcProspectPhone').value.trim();
    if (!contactName) {
      errorEl.textContent = 'Please enter a prospect name.';
      errorEl.classList.remove('hidden');
      return;
    }
  } else {
    orgName    = document.getElementById('gcOrgName').value.trim();
    orgContact = document.getElementById('gcOrgContact').value.trim();
    if (!orgName) {
      errorEl.textContent = 'Please enter an organization name.';
      errorEl.classList.remove('hidden');
      return;
    }
    contactName = orgName;
  }

  saveBtn.disabled    = true;
  saveBtn.textContent = 'Saving…';

  try {
    await addDoc(collection(db, 'outreachCalls'), {
      date:                  new Date(dateVal + 'T12:00:00'),
      counselor,
      type:                  _callType,
      linkedClientId,
      contactName,
      phone:                 phone      || null,
      orgName:               orgName    || null,
      orgContact:            orgContact || null,
      outcome,
      notes,
      assignedToCounselorId: null,
      assignedToName:        null,
      createdAt:             serverTimestamp(),
      updatedAt:             serverTimestamp(),
    });
    closeModal();
  } catch (_) {
    errorEl.textContent = 'Error saving. Please try again.';
    errorEl.classList.remove('hidden');
  } finally {
    saveBtn.disabled    = false;
    saveBtn.textContent = 'Save Call';
  }
}

export function initLogCallModal() {
  injectHtml();

  document.getElementById('navLogCallBtn').addEventListener('click', () => {
    loadCounselors();
    openModal();
  });
  document.getElementById('gcCancel').addEventListener('click', closeModal);
  document.getElementById('globalCallModal').addEventListener('click', e => {
    if (e.target.id === 'globalCallModal') closeModal();
  });
  document.querySelectorAll('#globalCallModal .call-type-btn').forEach(b => {
    b.addEventListener('click', () => setType(b.dataset.type));
  });
  document.getElementById('gcClientSearch').addEventListener('input', renderSearch);
  document.getElementById('gcClientClear').addEventListener('click', () => {
    _selectedClientId   = null;
    _selectedClientName = null;
    document.getElementById('gcClientId').value = '';
    document.getElementById('gcClientChip').classList.add('hidden');
  });
  document.getElementById('gcSave').addEventListener('click', saveCall);
}
