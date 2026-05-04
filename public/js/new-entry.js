import { db } from './firebase-config.js';
import { requireAuth, setupNav } from './auth.js';
import { COUNSELING_TYPES, RE_CODES, MONTHS, AWARD_TYPES, getDefaultRate, amiDisplayLabel } from './data.js';
import {
  collection, addDoc, getDocs, query, orderBy, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

requireAuth(async (user, profile) => {
  setupNav(profile, 'new-entry');
  await buildSelects(profile);
  setupAutoCalc();

  document.getElementById('entryForm').addEventListener('submit', (e) => handleSubmit(e, profile));
});

async function buildSelects(profile) {
  appendOptions('counselingType', COUNSELING_TYPES);
  appendOptions('sourceMonth',    MONTHS);
  appendOptions('reCode',         RE_CODES);
  appendOptions('awardType',      AWARD_TYPES);
  wireAmiLabel('amiPercent', 'amiLabel');

  // Load counselors from Firestore and pre-select current user
  const sel = document.getElementById('counselor');
  try {
    const snap = await getDocs(query(collection(db, 'counselors'), orderBy('name')));
    snap.docs
      .filter(d => d.data().active !== false)
      .forEach(d => {
        const o = document.createElement('option');
        o.value = d.data().name;
        o.textContent = d.data().name;
        sel.appendChild(o);
      });
    // Pre-select if the logged-in user's name matches a counselor
    if (profile.name) sel.value = profile.name;
  } catch (_) {
    // counselors collection may not exist yet
  }
}

function toTitleCase(str) {
  if (!str) return str;
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function appendOptions(id, list) {
  const sel = document.getElementById(id);
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
    rxNumber:          document.getElementById('rxNumber').value.trim(),
    clientName:      toTitleCase(document.getElementById('clientName').value.trim()),
    counselingDate:  dateVal ? new Date(dateVal + 'T12:00:00') : null,
    counselor:       document.getElementById('counselor').value.trim(),
    guarantor:       document.getElementById('guarantor').value.trim(),
    zipCode:         document.getElementById('zipCode').value.trim(),
    counselingType:  document.getElementById('counselingType').value,
    sourceMonth,
    caseStatus:      document.getElementById('caseStatus').value.trim(),
    outcome:         document.getElementById('outcome').value.trim(),
    amiPercent:      Number(document.getElementById('amiPercent').value) || null,
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
