import { db } from './firebase-config.js';
import { requireAuth, setupNav, isAdmin } from './auth.js';
import { COUNSELING_TYPES, AMI_LEVELS, RE_CODES, MONTHS, AWARD_TYPES, getDefaultRate } from './data.js';

// Inject a stored value as an option if it doesn't match any existing option
function setSelectValue(id, val) {
  const el = document.getElementById(id);
  if (!el || val == null || val === '') return;
  el.value = val;
  if (el.value !== String(val)) {
    // Value not found — add it so it's visible rather than silently blank
    const opt = document.createElement('option');
    opt.value = val; opt.textContent = val;
    el.insertBefore(opt, el.options[1]);
    el.value = val;
  }
}
import { openDrivePicker } from './picker.js';
import {
  doc, getDoc, addDoc, updateDoc, deleteDoc, collection, query, where, getDocs, orderBy, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const params = new URLSearchParams(window.location.search);
const recordId = params.get('id');

if (!recordId) window.location.href = 'log.html';

let _originalRecord = null; // preserved so selects that don't match options don't wipe data

requireAuth(async (user, profile) => {
  setupNav(profile, 'log'); // highlight "Counseling Log" as active

  buildSelects();
  setupAutoCalc();

  // Load record
  let record;
  try {
    const snap = await getDoc(doc(db, 'counselingLog', recordId));
    if (!snap.exists()) { alert('Record not found.'); window.location.href = 'log.html'; return; }
    record = { id: snap.id, ...snap.data() };
    _originalRecord = record;
  } catch (err) {
    alert('Failed to load record: ' + err.message);
    window.location.href = 'log.html';
    return;
  }

  populateForm(record);
  renderMeta(record);

  // Access control
  const isOwn      = (record.counselor || '').toLowerCase() === (profile.name || '').toLowerCase();
  const adminAccess = isAdmin(profile);

  if (!adminAccess && !isOwn) {
    document.querySelectorAll('#entryForm input, #entryForm select, #entryForm textarea').forEach(el => el.disabled = true);
    document.getElementById('submitBtn').classList.add('hidden');
  }

  if (adminAccess) {
    document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
    document.getElementById('deleteBtn').addEventListener('click', () => handleDelete(profile));
  }

  document.getElementById('entryForm').addEventListener('submit', (e) => handleUpdate(e, profile));

  // Drive folder
  setupFolderLink(record);

  // Enrollment buttons
  setupEnrollment(record, user, profile);
});

async function buildSelects() {
  appendOptions('counselingType', COUNSELING_TYPES);
  appendOptions('sourceMonth',    MONTHS);
  appendOptions('amiPercent',     AMI_LEVELS);
  appendOptions('reCode',         RE_CODES);
  appendOptions('awardType',      AWARD_TYPES);
  await loadCounselorOptions('counselor');
}

async function loadCounselorOptions(selectId) {
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
  } catch (_) {
    // counselors collection may not exist yet — leave select empty, field still works
  }
}

// Show/hide sourceMonth based on whether counselingDate has a value.
// When date is present, derive the month automatically.
function syncSourceMonth() {
  const dateVal = document.getElementById('counselingDate').value;
  const monthGroup = document.getElementById('sourceMonth').closest('.form-group');
  if (dateVal) {
    monthGroup.classList.add('hidden');
    // noon UTC avoids day-boundary timezone shifts
    const month = MONTHS[new Date(dateVal + 'T12:00:00').getMonth()];
    document.getElementById('sourceMonth').value = month;
  } else {
    monthGroup.classList.remove('hidden');
  }
}

function appendOptions(id, list) {
  const sel = document.getElementById(id);
  list.forEach(v => {
    const o = document.createElement('option');
    o.value = v; o.textContent = v;
    sel.appendChild(o);
  });
}

function setupAutoCalc() {
  const typeField    = document.getElementById('counselingType');
  const rateField    = document.getElementById('ratePerHour');
  const hoursField   = document.getElementById('hours');
  const awardedField = document.getElementById('dollarsAwarded');

  typeField.addEventListener('change', () => {
    // Only auto-set rate if user hasn't edited it already
    const currentRate = parseFloat(rateField.value) || 0;
    const defaultRate = getDefaultRate(typeField.value);
    const otherDefault = typeField.value === 'COURT' ? 48.5 : 2.0;
    if (currentRate === 0 || currentRate === defaultRate || currentRate === otherDefault) {
      rateField.value = defaultRate;
    }
    recalc();
  });
  rateField.addEventListener('input', recalc);
  hoursField.addEventListener('input', recalc);

  function recalc() {
    const h = parseFloat(hoursField.value) || 0;
    const r = parseFloat(rateField.value)  || 0;
    awardedField.value = (h * r).toFixed(2);
  }
}

function toDateInputValue(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toISOString().split('T')[0];
}

function populateForm(r) {
  setValue('rxNumber',         r.rxNumber);
  setValue('clientName',     r.clientName);
  setValue('counselingDate', toDateInputValue(r.counselingDate));
  setSelectValue('counselor', r.counselor);
  setValue('guarantor',      r.guarantor);
  setValue('zipCode',        r.zipCode);
  setSelectValue('counselingType', r.counselingType);
  setSelectValue('sourceMonth',    r.sourceMonth);
  setValue('caseStatus',     r.caseStatus);
  setValue('outcome',        r.outcome);
  setSelectValue('amiPercent', r.amiPercent);
  setSelectValue('reCode',     r.reCode);
  setValue('hours',          r.hours);
  setValue('ratePerHour',    r.ratePerHour);
  setValue('dollarsAwarded', r.dollarsAwarded != null ? Number(r.dollarsAwarded).toFixed(2) : '');
  setSelectValue('awardType', r.awardType);
  setValue('dollarsFor',     r.dollarsFor);
  setValue('notes',          r.notes);
  document.getElementById('hispanic').checked    = !!r.hispanic;
  document.getElementById('femaleHeaded').checked = !!r.femaleHeaded;

  // Hide source month when counseling date is present
  syncSourceMonth();
  document.getElementById('counselingDate').addEventListener('change', syncSourceMonth);
}

function setValue(id, val) {
  const el = document.getElementById(id);
  if (el && val != null) el.value = val;
}

function toTitleCase(str) {
  if (!str) return str;
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function renderMeta(r) {
  const fmt = (ts) => ts?.toDate ? ts.toDate().toLocaleString() : '—';
  document.getElementById('metaLine').textContent =
    `Created: ${fmt(r.createdAt)}  ·  Last updated: ${fmt(r.updatedAt)}`;
}

// ── Drive Folder ─────────────────────────────────────────────────────────────

let _driveFolder = null;

function setupFolderLink(record) {
  if (record.driveFolderId) {
    _driveFolder = { id: record.driveFolderId, name: record.driveFolderName, url: record.driveFolderUrl };
    renderFolderUI();
  }

  document.getElementById('linkFolderBtn').addEventListener('click', async () => {
    try {
      const folder = await openDrivePicker();
      if (folder) {
        _driveFolder = folder;
        renderFolderUI();
      }
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
  const folderName = document.getElementById('driveFolderName');
  const unlinkBtn  = document.getElementById('unlinkFolderBtn');

  if (_driveFolder) {
    folderLink.href        = _driveFolder.url;
    folderLink.textContent = _driveFolder.name;
    folderName.textContent = '';
    folderLink.classList.remove('hidden');
    unlinkBtn.classList.remove('hidden');
    linkBtn.textContent = 'Change Folder';
  } else {
    folderLink.classList.add('hidden');
    unlinkBtn.classList.add('hidden');
    linkBtn.textContent = 'Link Drive Folder';
  }
}

// ─────────────────────────────────────────────────────────────────────────────

// For select fields, if the form value is "" it means the stored value didn't
// match any option — fall back to the original record value to avoid wiping data.
function selectVal(id, originalKey) {
  const v = document.getElementById(id).value;
  if (v !== '') return v;
  return _originalRecord?.[originalKey] ?? '';
}

function readForm() {
  const dateVal = document.getElementById('counselingDate').value;
  // Derive sourceMonth from date when available; fallback to stored select value
  const sourceMonth = dateVal
    ? MONTHS[new Date(dateVal + 'T12:00:00').getMonth()]
    : selectVal('sourceMonth', 'sourceMonth');

  return {
    rxNumber:         document.getElementById('rxNumber').value.trim(),
    clientName:     toTitleCase(document.getElementById('clientName').value.trim()),
    counselingDate: dateVal ? new Date(dateVal + 'T12:00:00') : (_originalRecord?.counselingDate ?? null),
    counselor:      selectVal('counselor', 'counselor'),
    guarantor:      document.getElementById('guarantor').value.trim(),
    zipCode:        document.getElementById('zipCode').value.trim(),
    counselingType: selectVal('counselingType', 'counselingType'),
    sourceMonth,
    caseStatus:     document.getElementById('caseStatus').value.trim(),
    outcome:        document.getElementById('outcome').value.trim(),
    amiPercent:     selectVal('amiPercent', 'amiPercent'),
    reCode:         selectVal('reCode',     'reCode'),
    hispanic:       document.getElementById('hispanic').checked,
    femaleHeaded:   document.getElementById('femaleHeaded').checked,
    hours:          parseFloat(document.getElementById('hours').value)          || 0,
    ratePerHour:    parseFloat(document.getElementById('ratePerHour').value)    || 0,
    dollarsAwarded: parseFloat(document.getElementById('dollarsAwarded').value) || 0,
    awardType:       selectVal('awardType', 'awardType'),
    dollarsFor:      document.getElementById('dollarsFor').value.trim(),
    notes:           document.getElementById('notes').value.trim(),
    driveFolderId:   _driveFolder?.id   || '',
    driveFolderName: _driveFolder?.name || '',
    driveFolderUrl:  _driveFolder?.url  || '',
  };
}

async function handleUpdate(e) {
  e.preventDefault();
  const errorEl  = document.getElementById('formError');
  const submitBtn = document.getElementById('submitBtn');
  errorEl.classList.add('hidden');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving…';

  try {
    await updateDoc(doc(db, 'counselingLog', recordId), {
      ...readForm(),
      updatedAt: serverTimestamp(),
    });
    window.location.href = 'log.html';
  } catch (err) {
    errorEl.textContent = 'Save failed: ' + err.message;
    errorEl.classList.remove('hidden');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Save Changes';
  }
}

async function handleDelete() {
  if (!confirm('Permanently delete this record? This cannot be undone.')) return;
  const btn = document.getElementById('deleteBtn');
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  try {
    await deleteDoc(doc(db, 'counselingLog', recordId));
    window.location.href = 'log.html';
  } catch (err) {
    alert('Delete failed: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Delete Record';
  }
}

// ── Enrollment ────────────────────────────────────────────────────────────────

async function setupEnrollment(record, user, profile) {
  const type = record.counselingType;
  if (type !== 'PRE' && type !== 'POST') return;

  document.getElementById('enrollSection').classList.remove('hidden');

  // Check existing enrollments
  const [ccaSnap, higSnap] = await Promise.all([
    getDocs(query(collection(db, 'ccaList'),     where('counselingLogId', '==', recordId))),
    getDocs(query(collection(db, 'higWaitlist'), where('counselingLogId', '==', recordId))),
  ]);

  if (type === 'PRE') {
    if (ccaSnap.empty) {
      const btn = document.getElementById('enrollCcaBtn');
      btn.classList.remove('hidden');
      btn.addEventListener('click', () => openCcaModal(record, user, profile));
    } else {
      document.getElementById('enrolledCcaBadge').classList.remove('hidden');
    }
  }

  if (type === 'POST') {
    if (higSnap.empty) {
      const btn = document.getElementById('enrollHigBtn');
      btn.classList.remove('hidden');
      btn.addEventListener('click', () => openHigModal(record, user, profile));
    } else {
      document.getElementById('enrolledHigBadge').classList.remove('hidden');
    }
  }
}

function openCcaModal(record, user, profile) {
  document.getElementById('ccaModal').classList.remove('hidden');
  document.getElementById('ccaModalCancel').onclick = () =>
    document.getElementById('ccaModal').classList.add('hidden');
  document.getElementById('ccaModalSave').onclick = () =>
    saveCcaEnrollment(record, user, profile);
}

async function saveCcaEnrollment(record, user, profile) {
  const errorEl = document.getElementById('ccaModalError');
  const saveBtn = document.getElementById('ccaModalSave');
  errorEl.classList.add('hidden');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    const closingDateVal = document.getElementById('ccaClosingDate').value;
    await addDoc(collection(db, 'ccaList'), {
      counselingLogId: recordId,
      clientName:      record.clientName,
      counselor:       record.counselor,
      amiPercent:      record.amiPercent || '',
      closingDate:     closingDateVal ? new Date(closingDateVal) : null,
      ccaAmount:       parseFloat(document.getElementById('ccaAmount').value) || 0,
      notes:           document.getElementById('ccaNotes').value.trim(),
      status:          'eligible',
      driveFolderId:   _driveFolder?.id   || record.driveFolderId   || '',
      driveFolderName: _driveFolder?.name || record.driveFolderName || '',
      driveFolderUrl:  _driveFolder?.url  || record.driveFolderUrl  || '',
      enrolledAt:      serverTimestamp(),
      enrolledBy:      user.uid,
      updatedAt:       serverTimestamp(),
    });
    document.getElementById('ccaModal').classList.add('hidden');
    document.getElementById('enrollCcaBtn').classList.add('hidden');
    document.getElementById('enrolledCcaBadge').classList.remove('hidden');
  } catch (err) {
    errorEl.textContent = 'Failed to enroll: ' + err.message;
    errorEl.classList.remove('hidden');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Add to CCA List';
  }
}

// HIG drive file state
let _higDriveFile = null;

function openHigModal(record, user, profile) {
  _higDriveFile = null;
  document.getElementById('higFileName').textContent = 'No file selected';
  document.getElementById('higModal').classList.remove('hidden');
  document.getElementById('higModalCancel').onclick = () =>
    document.getElementById('higModal').classList.add('hidden');
  document.getElementById('higModalSave').onclick = () =>
    saveHigEnrollment(record, user, profile);
  document.getElementById('higPickFileBtn').onclick = async () => {
    try {
      const file = await openDrivePicker();
      if (file) {
        _higDriveFile = file;
        document.getElementById('higFileName').textContent = file.name;
      }
    } catch (err) {
      alert('Could not open Drive picker: ' + err.message);
    }
  };
}

async function saveHigEnrollment(record, user, profile) {
  const errorEl = document.getElementById('higModalError');
  const saveBtn = document.getElementById('higModalSave');
  errorEl.classList.add('hidden');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    const budget = parseFloat(document.getElementById('higBudget').value) || 0;
    const days   = parseInt(document.getElementById('higDays').value,   10) || 0;

    await addDoc(collection(db, 'higWaitlist'), {
      counselingLogId: recordId,
      clientName:      record.clientName,
      counselor:       record.counselor,
      amiPercent:      record.amiPercent || '',
      scopeOfWork:     document.getElementById('higScope').value.trim(),
      estimatedBudget: budget,
      estimatedDays:   days,
      driveFileId:     _higDriveFile?.id   || '',
      driveFileName:   _higDriveFile?.name || '',
      driveFileUrl:    _higDriveFile?.url  || '',
      driveFolderId:   _driveFolder?.id   || record.driveFolderId   || '',
      driveFolderName: _driveFolder?.name || record.driveFolderName || '',
      driveFolderUrl:  _driveFolder?.url  || record.driveFolderUrl  || '',
      notes:           document.getElementById('higNotes').value.trim(),
      status:          'waitlisted',
      priorityScore:   0,
      enrolledAt:      serverTimestamp(),
      enrolledBy:      user.uid,
      updatedAt:       serverTimestamp(),
    });
    document.getElementById('higModal').classList.add('hidden');
    document.getElementById('enrollHigBtn').classList.add('hidden');
    document.getElementById('enrolledHigBadge').classList.remove('hidden');
  } catch (err) {
    errorEl.textContent = 'Failed to enroll: ' + err.message;
    errorEl.classList.remove('hidden');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Add to HIG Waitlist';
  }
}
