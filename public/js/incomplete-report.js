import { db } from './firebase-config.js';
import { RE_CODES, amiDisplayLabel } from './data.js';
import {
  collection, getDocs, doc, updateDoc, serverTimestamp, query, orderBy,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

let _isED   = false;
let _myName = '';

export async function initIncompleteReport(user, profile) {
  _isED   = profile.role === 'executive_director';
  _myName = profile.name || profile.email || '';

  try {
    const snap = await getDocs(query(collection(db, 'counselors'), orderBy('name')));
    const sel  = document.getElementById('incompleteCounselor');
    snap.docs.filter(d => d.data().active !== false).forEach(d => {
      const o = document.createElement('option');
      o.value = d.data().name; o.textContent = d.data().name;
      sel.appendChild(o);
    });
    if (!_isED) sel.value = _myName;
  } catch (_) {}

  document.getElementById('incompleteSaveBar').style.display = 'none';
  document.getElementById('loadIncompleteBtn').addEventListener('click', loadIncomplete);
}

async function loadIncomplete() {
  const btn      = document.getElementById('loadIncompleteBtn');
  const resultEl = document.getElementById('incompleteResult');
  const counsel  = document.getElementById('incompleteCounselor').value;

  btn.disabled    = true;
  btn.textContent = 'Loading…';
  resultEl.innerHTML = '<p style="color:var(--text-muted);font-size:0.875rem;">Loading clients…</p>';

  try {
    const snap = await getDocs(collection(db, 'clients'));
    let rows = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(c => c.status !== 'closed');
    if (counsel) rows = rows.filter(c => c.counselor === counsel);

    const incomplete = rows
      .filter(c => !c.amiPercent || !c.reCode || !c.rxNumbers?.length)
      .sort((a, b) => (a.clientName || '').localeCompare(b.clientName || ''));

    if (!incomplete.length) {
      resultEl.innerHTML = '<p style="color:var(--accent);font-weight:600;">No incomplete files found.</p>';
      return;
    }

    const reOpts = RE_CODES.map(r =>
      `<option value="${escAttr(r)}">${escHtml(r)}</option>`
    ).join('');

    const TH = 'style="text-align:left;padding:0.4rem 0.6rem;border-bottom:2px solid var(--border);font-size:0.68rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);white-space:nowrap;"';
    const TD = 'style="padding:0.35rem 0.5rem;border-bottom:1px solid #f0f1f3;vertical-align:middle;"';

    resultEl.innerHTML = `
      <p style="font-size:0.8125rem;color:var(--text-muted);margin-bottom:0.75rem;">
        ${incomplete.length} incomplete file${incomplete.length !== 1 ? 's' : ''} found.
        Fill what you have and hit Save — partial saves are fine. Use the profile link for Rx/Guarantor.
      </p>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:0.8125rem;">
          <thead>
            <tr style="background:#f8f9fb;">
              <th ${TH}>Client Name</th>
              <th ${TH}>Counselor</th>
              <th ${TH}>Missing</th>
              <th ${TH}>AMI %</th>
              <th ${TH}>R/E Code</th>
              <th ${TH}>Rx / Guarantor</th>
              <th ${TH}></th>
            </tr>
          </thead>
          <tbody id="incompleteBody">
            ${incomplete.map(c => buildRow(c, reOpts, TD)).join('')}
          </tbody>
        </table>
      </div>`;

    wireRows(resultEl, reOpts);

  } catch (err) {
    resultEl.innerHTML = `<p class="error-msg">Failed to load: ${escHtml(err.message)}</p>`;
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Load';
  }
}

function buildRow(c, reOpts, TD = 'style="padding:0.35rem 0.5rem;border-bottom:1px solid #f0f1f3;vertical-align:middle;"') {
  const issues = [];
  if (!c.amiPercent)        issues.push('AMI');
  if (!c.reCode)            issues.push('R/E');
  if (!c.rxNumbers?.length) issues.push('Rx');

  const missingChips = issues.map(i =>
    `<span class="missing-chip" data-field="${escAttr(i)}" style="background:#fef3c7;color:#92400e;padding:0.1rem 0.4rem;border-radius:10px;font-size:0.68rem;font-weight:700;white-space:nowrap;">${escHtml(i)}</span>`
  ).join(' ');

  const amiVal = c.amiPercent ? String(c.amiPercent) : '';
  const amiInput = `
    <div style="display:flex;flex-direction:column;gap:0.1rem;">
      <input type="number" class="incomplete-ami" data-id="${escAttr(c.id)}"
        min="1" max="300" step="1" placeholder="e.g. 65"
        value="${escAttr(amiVal)}"
        style="width:80px;padding:0.22rem 0.35rem;border:1px solid var(--border);border-radius:var(--radius);font-size:0.8rem;">
      <span class="ami-live-label" style="font-size:0.68rem;color:var(--text-muted);">${amiVal ? escHtml(amiDisplayLabel(c.amiPercent)) : ''}</span>
    </div>`;

  const reSelect = `
    <select class="incomplete-re" data-id="${escAttr(c.id)}"
      style="padding:0.22rem 0.35rem;border:1px solid var(--border);border-radius:var(--radius);font-size:0.8rem;min-width:200px;">
      <option value="">— Select —</option>
      ${reOpts}
    </select>`;

  const rxStatus = c.rxNumbers?.length
    ? `<span style="color:var(--accent);font-weight:600;font-size:0.78rem;">${c.rxNumbers.length} Rx#</span>`
    : `<span style="color:#dc2626;font-weight:600;font-size:0.78rem;">None</span>`;

  return `<tr data-client-id="${escAttr(c.id)}" data-re-val="${escAttr(c.reCode || '')}" data-has-rx="${c.rxNumbers?.length ? '1' : '0'}">
    <td ${TD}><a href="client.html?id=${escAttr(c.id)}" target="_blank" style="font-weight:600;color:var(--primary);">${escHtml(c.clientName || '—')}</a></td>
    <td ${TD} style="color:var(--text-muted);">${escHtml(c.counselor || '—')}</td>
    <td ${TD}><div class="missing-chips" style="display:flex;gap:0.25rem;flex-wrap:wrap;">${missingChips}</div></td>
    <td ${TD}>${amiInput}</td>
    <td ${TD}>${reSelect}</td>
    <td ${TD}>
      ${rxStatus}
      <a href="client.html?id=${escAttr(c.id)}#tab-overview" target="_blank"
        style="font-size:0.72rem;color:var(--text-muted);margin-left:0.4rem;">Edit →</a>
    </td>
    <td ${TD}>
      <button class="btn btn-primary btn-sm row-save-btn" data-id="${escAttr(c.id)}" disabled
        style="white-space:nowrap;opacity:0.4;">Save</button>
      <div class="row-save-msg" style="font-size:0.72rem;margin-top:0.2rem;min-height:1em;"></div>
    </td>
  </tr>`;
}

function wireRows(container, reOpts) {
  container.querySelectorAll('tr[data-client-id]').forEach(row => {
    const clientId = row.dataset.clientId;

    // Pre-select existing R/E value
    const reVal = row.dataset.reVal;
    const sel   = row.querySelector('.incomplete-re');
    if (sel && reVal) sel.value = reVal;

    const amiInp  = row.querySelector('.incomplete-ami');
    const amiLbl  = row.querySelector('.ami-live-label');
    const saveBtn = row.querySelector('.row-save-btn');

    function markDirty() {
      saveBtn.disabled = false;
      saveBtn.style.opacity = '1';
    }

    if (amiInp && amiLbl) {
      amiInp.addEventListener('input', () => {
        const v = parseFloat(amiInp.value);
        amiLbl.textContent = isNaN(v) || v <= 0 ? '' : amiDisplayLabel(v);
        markDirty();
      });
    }
    if (sel) {
      sel.addEventListener('change', markDirty);
    }

    saveBtn.addEventListener('click', () => saveRow(clientId, row, reOpts));
  });
}

async function saveRow(clientId, row, reOpts) {
  const saveBtn = row.querySelector('.row-save-btn');
  const msgEl   = row.querySelector('.row-save-msg');
  const amiInp  = row.querySelector('.incomplete-ami');
  const reInp   = row.querySelector('.incomplete-re');

  const amiVal = amiInp ? parseFloat(amiInp.value) : NaN;
  const reVal  = reInp  ? reInp.value.trim() : '';

  // Build update — only include fields that now have a value
  const update = { updatedAt: serverTimestamp() };
  if (!isNaN(amiVal) && amiVal > 0) update.amiPercent = amiVal;
  if (reVal)                         update.reCode     = reVal;

  if (Object.keys(update).length === 1) {
    // Only updatedAt — nothing filled
    msgEl.textContent  = 'Nothing to save yet.';
    msgEl.style.color  = 'var(--text-muted)';
    return;
  }

  saveBtn.disabled    = true;
  saveBtn.textContent = 'Saving…';
  saveBtn.style.opacity = '0.6';
  msgEl.textContent   = '';

  try {
    await updateDoc(doc(db, 'clients', clientId), update);

    // Recalculate which fields are still missing
    const hasRx  = row.dataset.hasRx === '1';
    const nowAmi = update.amiPercent ?? (amiInp?.value ? parseFloat(amiInp.value) : null);
    const nowRe  = update.reCode     ?? reVal;

    const stillMissing = [];
    if (!nowAmi)  stillMissing.push('AMI');
    if (!nowRe)   stillMissing.push('R/E');
    if (!hasRx)   stillMissing.push('Rx');

    if (!stillMissing.length) {
      // Fully resolved — fade and remove row
      row.style.transition = 'opacity 0.4s';
      row.style.opacity    = '0';
      setTimeout(() => {
        row.remove();
        checkEmpty();
      }, 400);
      return;
    }

    // Update Missing chips to reflect current state
    const chipsEl = row.querySelector('.missing-chips');
    if (chipsEl) {
      chipsEl.innerHTML = stillMissing.map(i =>
        `<span class="missing-chip" style="background:#fef3c7;color:#92400e;padding:0.1rem 0.4rem;border-radius:10px;font-size:0.68rem;font-weight:700;white-space:nowrap;">${escHtml(i)}</span>`
      ).join(' ');
    }

    saveBtn.textContent   = 'Saved ✓';
    saveBtn.style.opacity = '1';
    msgEl.textContent     = stillMissing.length
      ? `Still missing: ${stillMissing.filter(f => f !== 'Rx').join(', ') || '—'}`
      : '';
    msgEl.style.color = 'var(--text-muted)';

    setTimeout(() => {
      saveBtn.textContent   = 'Save';
      saveBtn.disabled      = true;
      saveBtn.style.opacity = '0.4';
      msgEl.textContent     = '';
    }, 2000);

  } catch (err) {
    saveBtn.disabled    = false;
    saveBtn.textContent = 'Save';
    saveBtn.style.opacity = '1';
    msgEl.textContent  = 'Failed: ' + err.message;
    msgEl.style.color  = 'var(--danger)';
  }
}

function checkEmpty() {
  const tbody = document.getElementById('incompleteBody');
  if (tbody && !tbody.querySelector('tr')) {
    document.getElementById('incompleteResult').innerHTML =
      '<p style="color:var(--accent);font-weight:600;">All files resolved — great work!</p>';
  }
}

function escHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(str) {
  return (str || '').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
