import { db } from './firebase-config.js';
import { requireAuth, setupNav } from './auth.js';
import { COUNSELING_TYPES, AMI_LEVELS, RE_CODES, MONTHS, AWARD_TYPES, getDefaultRate } from './data.js';
import {
  collection, addDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

requireAuth((user, profile) => {
  setupNav(profile, 'new-entry');
  buildSelects();
  prefillCounselor(profile);
  setupAutoCalc();

  document.getElementById('entryForm').addEventListener('submit', (e) => handleSubmit(e, profile));
});

function buildSelects() {
  appendOptions('counselingType', COUNSELING_TYPES);
  appendOptions('sourceMonth',    MONTHS);
  appendOptions('amiPercent',     AMI_LEVELS);
  appendOptions('reCode',         RE_CODES);
  appendOptions('awardType',      AWARD_TYPES);
}

function appendOptions(id, list) {
  const sel = document.getElementById(id);
  list.forEach(v => {
    const o = document.createElement('option');
    o.value = v; o.textContent = v;
    sel.appendChild(o);
  });
}

function prefillCounselor(profile) {
  const field = document.getElementById('counselor');
  field.value = profile.name || '';
}

function setupAutoCalc() {
  const typeField = document.getElementById('counselingType');
  const rateField = document.getElementById('ratePerHour');
  const hoursField = document.getElementById('hours');
  const awardedField = document.getElementById('dollarsAwarded');

  // Default rate when type changes
  typeField.addEventListener('change', () => {
    rateField.value = getDefaultRate(typeField.value);
    recalc();
  });

  rateField.addEventListener('input', recalc);
  hoursField.addEventListener('input', recalc);

  function recalc() {
    const h = parseFloat(hoursField.value) || 0;
    const r = parseFloat(rateField.value)  || 0;
    awardedField.value = (h * r).toFixed(2);
  }

  // Set initial default rate
  rateField.value = getDefaultRate('');
}

async function handleSubmit(e, profile) {
  e.preventDefault();
  const errorEl  = document.getElementById('formError');
  const submitBtn = document.getElementById('submitBtn');
  errorEl.classList.add('hidden');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving…';

  try {
    const data = readForm(profile);
    await addDoc(collection(db, 'counselingLog'), {
      ...data,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    window.location.href = 'log.html';
  } catch (err) {
    errorEl.textContent = 'Save failed: ' + err.message;
    errorEl.classList.remove('hidden');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Save Entry';
  }
}

function readForm() {
  const dateVal = document.getElementById('counselingDate').value;
  const sourceMonth = dateVal
    ? MONTHS[new Date(dateVal + 'T12:00:00').getMonth()]
    : document.getElementById('sourceMonth').value;
  return {
    caseNo:          document.getElementById('caseNo').value.trim(),
    clientName:      document.getElementById('clientName').value.trim(),
    counselingDate:  dateVal ? new Date(dateVal + 'T12:00:00') : null,
    counselor:       document.getElementById('counselor').value.trim(),
    guarantor:       document.getElementById('guarantor').value.trim(),
    zipCode:         document.getElementById('zipCode').value.trim(),
    counselingType:  document.getElementById('counselingType').value,
    sourceMonth,
    caseStatus:      document.getElementById('caseStatus').value.trim(),
    outcome:         document.getElementById('outcome').value.trim(),
    amiPercent:      document.getElementById('amiPercent').value,
    reCode:          document.getElementById('reCode').value,
    hispanic:        document.getElementById('hispanic').checked,
    femaleHeaded:    document.getElementById('femaleHeaded').checked,
    hours:           parseFloat(document.getElementById('hours').value) || 0,
    ratePerHour:     parseFloat(document.getElementById('ratePerHour').value) || 0,
    dollarsAwarded:  parseFloat(document.getElementById('dollarsAwarded').value) || 0,
    awardType:       document.getElementById('awardType').value,
    dollarsFor:      document.getElementById('dollarsFor').value.trim(),
    notes:           document.getElementById('notes').value.trim(),
  };
}
