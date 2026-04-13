import { db } from './firebase-config.js';
import { requireAuth, setupNav } from './auth.js';
import {
  collection, addDoc, getDocs, query, orderBy, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// All CMC records, loaded fresh on each page load
let _allRecords = [];

// ── Entry point ───────────────────────────────────────────────────────────────

requireAuth(async (user, profile) => {
  setupNav(profile, 'cmc-log');

  // Store the logged-in counselor's name for new records
  window._currentCounselor = profile.name || profile.email || '';

  await loadRecords();

  // Modal open/close
  document.getElementById('logLetterBtn').addEventListener('click', openModal);
  document.getElementById('logModalSave').addEventListener('click', saveRecord);
  document.getElementById('logModalCancel').addEventListener('click', closeModal);
  document.getElementById('logModal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('logModal')) closeModal();
  });

  // Show/hide the Lender field based on which template is selected.
  // Dan's (Beaver County) letter requires the plaintiff/lender name.
  // Andrusa's letter does not include a lender reference.
  document.getElementById('lTemplate').addEventListener('change', toggleLenderField);

  // Select-all checkbox
  document.getElementById('selectAll').addEventListener('change', (e) => {
    document.querySelectorAll('.row-cb').forEach(cb => { cb.checked = e.target.checked; });
    updateGenerateBar();
  });

  // Generate button — builds a print window with one letter per selected row
  document.getElementById('generateBtn').addEventListener('click', generateLetters);
  document.getElementById('clearSelBtn').addEventListener('click', () => {
    document.querySelectorAll('.row-cb').forEach(cb => { cb.checked = false; });
    document.getElementById('selectAll').checked = false;
    updateGenerateBar();
  });
});

// ── Load & render ─────────────────────────────────────────────────────────────

async function loadRecords() {
  const tbody = document.getElementById('cmcTableBody');
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:2rem;color:var(--text-muted)">Loading…</td></tr>';

  // Newest letters first
  const snap = await getDocs(query(collection(db, 'cmcLog'), orderBy('dateSent', 'desc')));
  _allRecords = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  renderTable(_allRecords);
  renderStats(_allRecords);
}

function renderTable(records) {
  const tbody = document.getElementById('cmcTableBody');
  if (!records.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:2rem;color:var(--text-muted)">No letters logged yet.</td></tr>';
    return;
  }

  tbody.innerHTML = records.map(r => {
    const linkedCell = r.linkedClientId
      ? `<a href="client.html?id=${r.linkedClientId}" style="font-weight:600;">${escHtml(r.linkedClientName || 'View Client')}</a>`
      : '<span style="color:var(--text-muted);">—</span>';

    const templateLabel = r.counselorTemplate === 'andrusa'
      ? 'Andrusa — Lawrence'
      : 'Dan — Beaver';

    // Combine both mailing address lines for display
    const mailingDisplay = [r.mailingAddress, r.mailingAddress2].filter(Boolean).join(', ');

    return `<tr>
      <td class="cb-col">
        <input type="checkbox" class="row-cb" data-id="${escAttr(r.id)}">
      </td>
      <td style="white-space:nowrap">${fmtDate(r.dateSent)}</td>
      <td>${escHtml(r.recipientName || '—')}</td>
      <td style="font-size:0.8rem;">${escHtml(mailingDisplay || '—')}</td>
      <td style="font-size:0.8rem;">${escHtml(r.propertyAddress || '—')}</td>
      <td style="font-size:0.8rem;white-space:nowrap;">${escHtml(templateLabel)}</td>
      <td>${linkedCell}</td>
    </tr>`;
  }).join('');

  // Update generate bar whenever a checkbox changes
  tbody.querySelectorAll('.row-cb').forEach(cb => {
    cb.addEventListener('change', updateGenerateBar);
  });
}

function renderStats(records) {
  const total  = records.length;
  const linked = records.filter(r => r.linkedClientId).length;
  const rate   = total > 0 ? Math.round((linked / total) * 100) + '%' : '—';

  document.getElementById('statTotal').textContent  = total;
  document.getElementById('statLinked').textContent = linked;
  document.getElementById('statRate').textContent   = rate;
}

// ── Generate bar ──────────────────────────────────────────────────────────────

function updateGenerateBar() {
  const checked = document.querySelectorAll('.row-cb:checked').length;
  const bar     = document.getElementById('generateBar');
  document.getElementById('selectedCount').textContent = `${checked} selected`;
  bar.style.display = checked > 0 ? 'flex' : 'none';
}

// ── Letter generation ─────────────────────────────────────────────────────────

function generateLetters() {
  // Collect the record IDs for all checked rows, preserving display order
  const checkedIds = new Set(
    [...document.querySelectorAll('.row-cb:checked')].map(cb => cb.dataset.id)
  );
  const selected = _allRecords.filter(r => checkedIds.has(r.id));
  if (!selected.length) return;

  const today = new Date().toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric'
  });

  // Build one letter page per selected record
  const pages = selected.map(r => buildLetterHTML(r, today)).join('');

  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>CMC Letters</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: "Times New Roman", Times, serif; font-size: 12pt; color: #000; }

    /* Each letter occupies exactly one printed page */
    .letter-page {
      width: 8.5in;
      min-height: 11in;
      padding: 1in 1.1in 1in 1.1in;
      page-break-after: always;
      position: relative;
    }
    .letter-page:last-child { page-break-after: auto; }

    /* Address block and salutation */
    .date-line   { margin-bottom: 1.5em; }
    .addr-block  { margin-bottom: 1.5em; line-height: 1.4; }
    .salutation  { margin-bottom: 1em; }
    .body-para   { margin-bottom: 1em; line-height: 1.6; text-align: justify; }
    .closing     { margin-top: 2.5em; }
    .sig-block   { margin-top: 3.5em; line-height: 1.5; }

    @media print {
      @page { size: letter; margin: 0; }
      body  { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
    }
  </style>
</head>
<body>
${pages}
<script>window.onload = () => { window.print(); }<\/script>
</body>
</html>`);
  win.document.close();
}

// Returns the HTML for a single letter, choosing the correct template
function buildLetterHTML(r, fallbackDate) {
  const dateLine    = r.dateSent
    ? fmtDateLong(r.dateSent)
    : fallbackDate;
  const name        = escHtml(r.recipientName   || '');
  const addr1       = escHtml(r.mailingAddress  || '');
  const addr2       = escHtml(r.mailingAddress2 || '');
  const propAddr    = escHtml(r.propertyAddress || '');
  const lender      = escHtml(r.lender          || '');

  if (r.counselorTemplate === 'andrusa') {
    return andrusaletter(dateLine, name, addr1, addr2, propAddr);
  }
  // Default to Dan's Beaver County template
  return danLetter(dateLine, name, addr1, addr2, propAddr, lender);
}

// Dan Bernabie — Beaver County template
function danLetter(date, name, addr1, addr2, propAddr, lender) {
  return `<div class="letter-page">
  <p class="date-line">${date}</p>

  <div class="addr-block">
    <p>${name}</p>
    <p>${addr1}</p>
    ${addr2 ? `<p>${addr2}</p>` : ''}
  </div>

  <p class="salutation">Dear ${name},</p>

  <p class="body-para">Our agency has received notification that a Complaint in Mortgage Foreclosure has been filed against you by Plaintiff, ${lender || '[LENDER]'}, in the Court of Common Pleas of Beaver County, PA. This Complaint regards your mortgaged property on ${propAddr || '[PROPERTY ADDRESS]'}.</p>

  <p class="body-para">Housing Opportunities Inc. (HOI) is a HUD Approved Housing Counseling Agency located in Rochester, PA. We provide free services and advice for homeowners facing foreclosure enabling them to make an informed decision. Also, we can represent your case in Beaver County Mortgage Conciliation Court at no charge. If you choose to utilize our services, we require your written authorization during an in-office appointment at our location in Beaver to gather pertinent documents and information.</p>

  <p class="body-para">Please call HOBC at 724.728.7511 to discuss your situation. We will be glad to assist your effort to navigate through the foreclosure process with a goal to retain your home.</p>

  <p class="closing">Sincerely,</p>

  <div class="sig-block">
    <p>Daniel Bernabie</p>
    <p>HUD Certified Housing Counselor</p>
  </div>
</div>`;
}

// Andrusa Lawson — Lawrence County template
function andrusaletter(date, name, addr1, addr2, propAddr) {
  return `<div class="letter-page">
  <p class="date-line">${date}</p>

  <div class="addr-block">
    <p>${name}</p>
    <p>${addr1}</p>
    ${addr2 ? `<p>${addr2}</p>` : ''}
  </div>

  <p class="salutation">Dear ${name},</p>

  <p class="body-para">Our agency has received notification that a Complaint in Foreclosure has been filed against you in the Court of Common Pleas. This Complaint regards your mortgaged property on ${propAddr || '[PROPERTY ADDRESS]'}.</p>

  <p class="body-para">Housing Opportunities Inc is a HUD Approved Housing Counseling Agency located in New Castle, PA. We provide free services and advice for homeowners facing foreclosure enabling them to make an informed decision. Also, we can represent your case in Mortgage Conciliation Court at no charge. If you choose to utilize our services, we require your written authorization during an in-office appointment at our location in New Castle to gather pertinent documents, information and advocate on your behalf.</p>

  <p class="body-para">Please call us at 724.728.7511 to discuss your situation. We are here to help you navigate through the foreclosure process and find the best available solution.</p>

  <p class="closing">Sincerely,</p>

  <div class="sig-block">
    <p>Andrusa Lawson</p>
    <p>HUD Certified Housing Counselor</p>
    <p>724-513-1385</p>
  </div>
</div>`;
}

// ── Modal ─────────────────────────────────────────────────────────────────────

function toggleLenderField() {
  const template   = document.getElementById('lTemplate').value;
  const lenderGroup = document.getElementById('lenderGroup');
  // Lender field is only relevant for Dan's Beaver County template
  lenderGroup.style.opacity  = template === 'dan' ? '1' : '0.35';
  lenderGroup.style.pointerEvents = template === 'dan' ? '' : 'none';
  document.getElementById('lLender').required = template === 'dan';
}

function openModal() {
  document.getElementById('lDate').value     = new Date().toISOString().split('T')[0];
  document.getElementById('lTemplate').value = 'dan';
  document.getElementById('lName').value     = '';
  document.getElementById('lLender').value   = '';
  document.getElementById('lMailAddr').value  = '';
  document.getElementById('lMailAddr2').value = '';
  document.getElementById('lPropAddr').value  = '';
  document.getElementById('logModalError').classList.add('hidden');
  toggleLenderField(); // reset lender field visibility
  document.getElementById('logModal').classList.remove('hidden');
  document.getElementById('lName').focus();
}

function closeModal() {
  document.getElementById('logModal').classList.add('hidden');
}

async function saveRecord() {
  const errorEl = document.getElementById('logModalError');
  const saveBtn = document.getElementById('logModalSave');
  errorEl.classList.add('hidden');

  const template  = document.getElementById('lTemplate').value;
  const dateVal   = document.getElementById('lDate').value;
  const name      = document.getElementById('lName').value.trim();
  const lender    = document.getElementById('lLender').value.trim();
  const mailAddr  = document.getElementById('lMailAddr').value.trim();
  const mailAddr2 = document.getElementById('lMailAddr2').value.trim();
  const propAddr  = document.getElementById('lPropAddr').value.trim();

  // Validate required fields
  if (!name) {
    errorEl.textContent = 'Recipient name is required.';
    errorEl.classList.remove('hidden');
    return;
  }
  if (template === 'dan' && !lender) {
    errorEl.textContent = 'Lender / Plaintiff is required for the Beaver County letter.';
    errorEl.classList.remove('hidden');
    return;
  }
  if (!mailAddr || !propAddr) {
    errorEl.textContent = 'Mailing address and property address are required.';
    errorEl.classList.remove('hidden');
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    await addDoc(collection(db, 'cmcLog'), {
      recipientName:    name,
      mailingAddress:   mailAddr,
      mailingAddress2:  mailAddr2,
      propertyAddress:  propAddr,
      lender:           lender,
      counselorTemplate: template,
      // Save date at noon UTC to prevent timezone off-by-one errors
      dateSent:         dateVal ? new Date(dateVal + 'T12:00:00') : null,
      counselor:        window._currentCounselor,
      linkedClientId:   null,   // filled later by ED in Settings
      linkedClientName: null,
      createdAt:        serverTimestamp(),
      updatedAt:        serverTimestamp(),
    });

    closeModal();
    await loadRecords();
  } catch (err) {
    errorEl.textContent = 'Save failed: ' + err.message;
    errorEl.classList.remove('hidden');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-US', { timeZone: 'UTC' });
}

// Long date format for the letter header — e.g. "January 27, 2026"
function fmtDateLong(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-US', {
    timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric'
  });
}

function escHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(str) {
  return (str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
