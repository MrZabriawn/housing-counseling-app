import { db } from './firebase-config.js';
import {
  collection, addDoc, getDocs, query, where, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const PAR_ROWS = {
  'PAR-S1': ['Processing-Intake', 'Processing-Billing', 'Supervision', 'Management', 'Counseling', 'Group Education'],
  'PAR-S2': ['Training'],
  'PAR-S3': ['Marketing'],
  'CML':    ['Case Management'],
};

let _profile      = null;
let _counselorId  = null;

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function injectHtml() {
  const modal = document.createElement('div');
  modal.id        = 'globalParModal';
  modal.className = 'modal-overlay hidden';
  modal.innerHTML = `
    <div class="modal-box">
      <h3>Log PAR / CML Entry</h3>
      <div class="form-grid" style="margin-top:1rem;">
        <div class="form-group">
          <label for="gparDate">Date *</label>
          <input type="date" id="gparDate">
        </div>
        <div class="form-group">
          <label for="gparSection">Section *</label>
          <select id="gparSection">
            <option value="PAR-S1">Section 1 – Direct Service</option>
            <option value="PAR-S2">Section 2 – Training</option>
            <option value="PAR-S3">Section 3 – Marketing</option>
            <option value="CML">CML – Case Management</option>
          </select>
        </div>
        <div class="form-group">
          <label for="gparRow">PAR Row *</label>
          <select id="gparRow"></select>
        </div>
        <div class="form-group">
          <label for="gparHours">Hours *</label>
          <input type="number" id="gparHours" min="0.25" max="24" step="0.25" placeholder="e.g. 1.5">
        </div>
        <div class="form-group full-width">
          <label for="gparDesc">Description</label>
          <textarea id="gparDesc" rows="3" placeholder="Brief description of the activity…"></textarea>
        </div>
      </div>
      <p id="gparError" class="error-msg hidden"></p>
      <div class="form-actions">
        <button id="gparSave" class="btn btn-primary">Save Entry</button>
        <button id="gparCancel" class="btn btn-secondary">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

function updateRows(section) {
  const rows = PAR_ROWS[section] || [];
  const sel  = document.getElementById('gparRow');
  sel.innerHTML = rows.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join('');
}

async function lookupCounselorId() {
  if (_counselorId || !_profile?.email) return;
  try {
    const snap = await getDocs(query(collection(db, 'counselors'), where('email', '==', _profile.email)));
    if (!snap.empty) _counselorId = snap.docs[0].id;
  } catch (_) {}
}

function openModal() {
  lookupCounselorId();
  const section = 'PAR-S1';
  document.getElementById('gparDate').value    = new Date().toISOString().split('T')[0];
  document.getElementById('gparSection').value = section;
  updateRows(section);
  document.getElementById('gparHours').value   = '';
  document.getElementById('gparDesc').value    = '';
  document.getElementById('gparError').classList.add('hidden');
  document.getElementById('globalParModal').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('globalParModal').classList.add('hidden');
}

async function saveEntry() {
  const errorEl = document.getElementById('gparError');
  const saveBtn = document.getElementById('gparSave');
  errorEl.classList.add('hidden');

  const dateVal = document.getElementById('gparDate').value;
  const section = document.getElementById('gparSection').value;
  const row     = document.getElementById('gparRow').value;
  const hours   = parseFloat(document.getElementById('gparHours').value);
  const desc    = document.getElementById('gparDesc').value.trim();

  if (!dateVal) {
    errorEl.textContent = 'Please select a date.';
    errorEl.classList.remove('hidden');
    return;
  }
  if (!hours || hours <= 0) {
    errorEl.textContent = 'Please enter a valid duration.';
    errorEl.classList.remove('hidden');
    return;
  }

  const parSection = section === 'CML' ? 'S4' : section.replace('PAR-', '');
  const type       = section === 'CML'    ? 'admin_cml'
                   : section === 'PAR-S2' ? 'training_marketing'
                   : section === 'PAR-S3' ? 'training_marketing'
                   : 'admin_direct';
  const costType   = section === 'PAR-S2' ? 'T'
                   : section === 'PAR-S3' ? 'M'
                   : undefined;

  const payload = {
    counselorId:     _counselorId || '',
    counselorName:   _profile?.name || '',
    month:           dateVal.slice(0, 7),
    date:            dateVal,
    type,
    durationMinutes: Math.round(hours * 60),
    parSection,
    parRow:          row,
    description:     desc || null,
    enteredBy:       _profile?.email || '',
    createdAt:       serverTimestamp(),
  };
  if (costType) payload.costType = costType;

  saveBtn.disabled    = true;
  saveBtn.textContent = 'Saving…';

  try {
    await addDoc(collection(db, 'hudEvents'), payload);
    closeModal();
  } catch (_) {
    errorEl.textContent = 'Error saving entry. Please try again.';
    errorEl.classList.remove('hidden');
  } finally {
    saveBtn.disabled    = false;
    saveBtn.textContent = 'Save Entry';
  }
}

export function initLogParModal(profile) {
  _profile = profile;
  injectHtml();

  document.getElementById('navLogParBtn').addEventListener('click', openModal);
  document.getElementById('gparSection').addEventListener('change', () => {
    updateRows(document.getElementById('gparSection').value);
  });
  document.getElementById('gparCancel').addEventListener('click', closeModal);
  document.getElementById('globalParModal').addEventListener('click', e => {
    if (e.target.id === 'globalParModal') closeModal();
  });
  document.getElementById('gparSave').addEventListener('click', saveEntry);
}
