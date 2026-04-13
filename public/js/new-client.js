import { db } from './firebase-config.js';
import { requireAuth, setupNav } from './auth.js';
import { COUNSELING_TYPES, AMI_LEVELS, RE_CODES, AWARD_TYPES } from './data.js';
import {
  collection, addDoc, getDocs, query, orderBy, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

function toTitleCase(str) {
  if (!str) return str;
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

requireAuth(async (user, profile) => {
  setupNav(profile, 'clients');

  // Populate selects
  appendOptions('counselingType', COUNSELING_TYPES);
  appendOptions('amiPercent',     AMI_LEVELS);
  appendOptions('reCode',         RE_CODES);
  appendOptions('awardType',      AWARD_TYPES);
  await loadCounselorOptions('counselor', profile.name);

  // Default session date to today
  document.getElementById('sessionDate').value = new Date().toISOString().split('T')[0];

  document.getElementById('newClientForm').addEventListener('submit', handleSubmit);
});

function appendOptions(id, list) {
  const sel = document.getElementById(id);
  if (!sel) return;
  list.forEach(v => {
    const o = document.createElement('option');
    o.value = v; o.textContent = v;
    sel.appendChild(o);
  });
}

async function loadCounselorOptions(selectId, currentUserName) {
  try {
    const snap = await getDocs(query(collection(db, 'counselors'), orderBy('name')));
    const sel  = document.getElementById(selectId);
    snap.docs
      .filter(d => d.data().active !== false)
      .forEach(d => {
        const o = document.createElement('option');
        o.value = d.data().name;
        o.textContent = d.data().name;
        sel.appendChild(o);
      });
    // Pre-select current user's name if it matches a counselor
    if (currentUserName) {
      for (const opt of sel.options) {
        if (opt.value.toLowerCase() === currentUserName.toLowerCase()) {
          sel.value = opt.value;
          break;
        }
      }
    }
  } catch (_) {
    // counselors collection may not exist yet
  }
}

async function handleSubmit(e) {
  e.preventDefault();
  const errorEl  = document.getElementById('formError');
  const submitBtn = document.getElementById('submitBtn');
  errorEl.classList.add('hidden');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Creating…';

  try {
    const dateVal = document.getElementById('sessionDate').value;
    const now = serverTimestamp();

    // Build session
    const hours          = parseFloat(document.getElementById('hours').value)          || 0;
    const dollarsAwarded = parseFloat(document.getElementById('dollarsAwarded').value) || 0;

    const sessionData = {
      date:          dateVal ? new Date(dateVal + 'T12:00:00') : null,
      counselor:     document.getElementById('counselor').value,
      rxNumber:      document.getElementById('rxNumber').value.trim(),
      hours,
      dollarsAwarded,
      awardType:     document.getElementById('awardType').value,
      caseStatus:    document.getElementById('caseStatus').value.trim(),
      outcome:       document.getElementById('outcome').value.trim(),
      notes:         document.getElementById('notes').value.trim(),
      dollarsFor:    '',
      createdAt:     now,
      updatedAt:     now,
    };

    // Build client doc
    const rxRaw = document.getElementById('rxNumber').value.trim();
    const rxNumbers = rxRaw ? [rxRaw] : [];

    const clientData = {
      clientName:        toTitleCase(document.getElementById('clientName').value.trim()),
      counselingType:    document.getElementById('counselingType').value,
      counselor:         document.getElementById('counselor').value,
      guarantor:         document.getElementById('guarantor').value.trim(),
      zipCode:           document.getElementById('zipCode').value.trim(),
      rxNumbers,
      amiPercent:        document.getElementById('amiPercent').value,
      reCode:            document.getElementById('reCode').value,
      hispanic:          document.getElementById('hispanic').checked,
      femaleHeaded:      document.getElementById('femaleHeaded').checked,
      areasOfInterest:   [],
      driveFolderId:     '',
      driveFolderName:   '',
      driveFolderUrl:    '',
      totalDownPayment:  0,
      ccaAmountProvided: 0,
      status:            'active',
      sessionCount:      1,
      totalOutcomeValue: dollarsAwarded,
      firstSessionDate:  dateVal ? new Date(dateVal + 'T12:00:00') : null,
      lastSessionDate:   dateVal ? new Date(dateVal + 'T12:00:00') : null,
      createdAt:         now,
      updatedAt:         now,
    };

    const clientRef = await addDoc(collection(db, 'clients'), clientData);
    await addDoc(collection(db, 'clients', clientRef.id, 'sessions'), sessionData);

    window.location.href = `client.html?id=${clientRef.id}`;
  } catch (err) {
    errorEl.textContent = 'Save failed: ' + err.message;
    errorEl.classList.remove('hidden');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create Client';
  }
}
