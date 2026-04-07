import { db } from './firebase-config.js';
import { requireAdmin, setupNav } from './auth.js';
import { AMI_IMPORT_MAP, RE_CODES } from './data.js';
import {
  collection, getDocs, query, addDoc, updateDoc, doc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// window.Papa from PapaParse CDN script tag

// CSV column → app field (loose, case-insensitive)
const COLUMN_MAP = {
  'case number':     'caseNo',
  'case no':         'caseNo',
  'case no.':        'caseNo',
  'client name':     'clientName',
  'client':          'clientName',
  'ami':             'amiPercent',
  'ami / income level': 'amiPercent',
  'income level':    'amiPercent',
  'race/ethnicity':  'reCode',
  'race / ethnicity': 'reCode',
  'race':            'reCode',
  'ethnicity':       'reCode',
  'counselor':       'counselor',
  'counselor name':  'counselor',
  'counseling date': 'counselingDate',
  'date':            'counselingDate',
  'session date':    'counselingDate',
  'counseling type': 'counselingType',
  'type':            'counselingType',
  'session type':    'counselingType',
  'notes':           'notes',
  'note':            'notes',
  'comments':        'notes',
};

let parsedRows = [];
let existingCaseNos = new Set();

requireAdmin(async (user, profile) => {
  setupNav(profile, 'import');

  // Load existing caseNos for duplicate detection
  const snap = await getDocs(query(collection(db, 'counselingLog')));
  snap.docs.forEach(d => {
    const cn = (d.data().caseNo || '').trim();
    if (cn) existingCaseNos.set ? existingCaseNos.add(cn) : (existingCaseNos = new Set([...existingCaseNos, cn]));
  });

  const csvInput  = document.getElementById('csvInput');
  const dropZone  = document.getElementById('dropZone');

  csvInput.addEventListener('change', (e) => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
  });

  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  document.getElementById('confirmImport').addEventListener('click', runImport);
  document.getElementById('cancelImport').addEventListener('click',  resetUI);
  document.getElementById('importAgain').addEventListener('click',   resetUI);
});

function handleFile(file) {
  document.getElementById('fileNameLabel').textContent = file.name;
  window.Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    transformHeader: h => h.trim(),
    complete: (result) => processCSV(result.data, result.meta.fields),
    error: (err) => alert('Failed to parse CSV: ' + err.message),
  });
}

function normalizeHeader(h) {
  return (h || '').toLowerCase().trim();
}

function mapColumns(rawRow, rawHeaders) {
  const mapped = {};
  rawHeaders.forEach(rawHeader => {
    const norm = normalizeHeader(rawHeader);
    const field = COLUMN_MAP[norm];
    if (field) mapped[field] = (rawRow[rawHeader] || '').trim();
  });
  return mapped;
}

function normalizeAmi(val) {
  const norm = (val || '').toLowerCase().trim();
  return AMI_IMPORT_MAP[norm] || val || '';
}

function normalizeReCode(val) {
  if (!val) return '';
  const norm = val.toLowerCase().trim();
  // Try loose match against known codes
  const match = RE_CODES.find(code => code.toLowerCase().includes(norm) || norm.includes(code.toLowerCase().split('(')[0].trim()));
  return match || val;
}

function processCSV(rawData, rawHeaders) {
  parsedRows = rawData.map((raw, i) => {
    const m = mapColumns(raw, rawHeaders);
    return {
      _rowIndex:     i,
      caseNo:        m.caseNo        || '',
      clientName:    m.clientName    || '',
      counselingDate: m.counselingDate || '',
      counselor:     m.counselor     || '',
      counselingType: m.counselingType || '',
      amiPercent:    normalizeAmi(m.amiPercent),
      reCode:        normalizeReCode(m.reCode),
      notes:         m.notes         || '',
      _isDuplicate:  !!(m.caseNo && existingCaseNos.has(m.caseNo.trim())),
      _action:       (m.caseNo && existingCaseNos.has(m.caseNo.trim())) ? 'skip' : 'add',
    };
  });

  const dupCount = parsedRows.filter(r => r._isDuplicate).length;
  document.getElementById('previewTitle').textContent = 'Preview';
  document.getElementById('previewMeta').textContent  =
    `${parsedRows.length} rows parsed · ${dupCount} potential duplicates highlighted`;

  renderPreview();
  document.getElementById('uploadCard').classList.add('hidden');
  document.getElementById('previewSection').classList.remove('hidden');
  document.getElementById('summarySection').classList.add('hidden');
}

function renderPreview() {
  const tbody = document.getElementById('previewBody');
  tbody.innerHTML = parsedRows.map((r, i) => {
    const dupClass = r._isDuplicate ? 'row-duplicate' : '';
    const statusBadge = r._isDuplicate
      ? '<span style="color:var(--warning);font-weight:600;">Duplicate</span>'
      : '<span style="color:var(--accent);font-weight:600;">New</span>';

    const actionSel = r._isDuplicate
      ? `<select data-row="${i}" class="action-sel" style="font-size:0.8rem;padding:0.2rem;">
           <option value="skip" ${r._action==='skip'?'selected':''}>Skip</option>
           <option value="update" ${r._action==='update'?'selected':''}>Update</option>
         </select>`
      : '<span class="text-muted" style="font-size:0.8rem;">—</span>';

    return `<tr class="${dupClass}">
      <td>${r.caseNo || '—'}</td>
      <td>${r.clientName || '—'}</td>
      <td>${r.counselingDate || '—'}</td>
      <td>${r.counselor || '—'}</td>
      <td>${r.counselingType || '—'}</td>
      <td>${r.amiPercent || '—'}</td>
      <td style="font-size:0.8rem">${r.reCode || '—'}</td>
      <td style="font-size:0.8rem;max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${r.notes || ''}</td>
      <td>${statusBadge}</td>
      <td>${actionSel}</td>
    </tr>`;
  }).join('');

  // Sync action selects back to parsedRows
  tbody.querySelectorAll('.action-sel').forEach(sel => {
    sel.addEventListener('change', () => {
      parsedRows[parseInt(sel.dataset.row)]._action = sel.value;
    });
  });
}

async function runImport() {
  const btn = document.getElementById('confirmImport');
  btn.disabled = true;
  btn.textContent = 'Importing…';

  let added   = 0;
  let updated = 0;
  let skipped = 0;

  // Build a map of existing caseNo → doc ID for updates
  const snap = await getDocs(query(collection(db, 'counselingLog')));
  const caseNoToId = {};
  snap.docs.forEach(d => {
    const cn = (d.data().caseNo || '').trim();
    if (cn) caseNoToId[cn] = d.id;
  });

  for (const row of parsedRows) {
    if (row._isDuplicate && row._action === 'skip') {
      skipped++;
      continue;
    }

    const data = buildRecord(row);

    if (row._isDuplicate && row._action === 'update') {
      const docId = caseNoToId[row.caseNo.trim()];
      if (docId) {
        await updateDoc(doc(db, 'counselingLog', docId), { ...data, updatedAt: serverTimestamp() });
        updated++;
      } else {
        skipped++;
      }
    } else {
      await addDoc(collection(db, 'counselingLog'), { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      added++;
    }
  }

  document.getElementById('previewSection').classList.add('hidden');
  document.getElementById('summarySection').classList.remove('hidden');
  document.getElementById('summaryText').textContent =
    `${added} added · ${updated} updated · ${skipped} skipped`;

  btn.disabled = false;
  btn.textContent = 'Import Selected';
}

function buildRecord(r) {
  let counselingDate = null;
  if (r.counselingDate) {
    const parsed = new Date(r.counselingDate);
    if (!isNaN(parsed)) counselingDate = parsed;
  }
  return {
    caseNo:         r.caseNo,
    clientName:     r.clientName,
    counselingDate: counselingDate,
    counselor:      r.counselor,
    counselingType: r.counselingType,
    amiPercent:     r.amiPercent,
    reCode:         r.reCode,
    notes:          r.notes,
    hispanic:       false,
    femaleHeaded:   false,
    guarantor:      '',
    zipCode:        '',
    hours:          0,
    ratePerHour:    0,
    dollarsAwarded: 0,
    awardType:      '',
    caseStatus:     '',
    dollarsFor:     '',
    outcome:        '',
    sourceMonth:    '',
  };
}

function resetUI() {
  parsedRows = [];
  document.getElementById('csvInput').value = '';
  document.getElementById('fileNameLabel').textContent = '';
  document.getElementById('uploadCard').classList.remove('hidden');
  document.getElementById('previewSection').classList.add('hidden');
  document.getElementById('summarySection').classList.add('hidden');
}
