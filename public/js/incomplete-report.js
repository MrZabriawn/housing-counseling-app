import { db } from './firebase-config.js';
import { RE_CODES, amiDisplayLabel } from './data.js';
import {
  collection, getDocs, doc, writeBatch, serverTimestamp, query, orderBy,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

let _allClients   = [];
let _isED         = false;
let _myName       = '';
let _pendingEdits = {}; // clientId → { amiPercent?, reCode? }

export async function initIncompleteReport(user, profile) {
  _isED   = profile.role === 'executive_director';
  _myName = profile.name || profile.email || '';

  // Populate counselor filter
  try {
    const snap = await getDocs(query(collection(db, 'counselors'), orderBy('name')));
    const sel  = document.getElementById('incompleteCounselor');
    snap.docs.filter(d => d.data().active !== false).forEach(d => {
      const o = document.createElement('option');
      o.value = d.data().name; o.textContent = d.data().name;
      sel.appendChild(o);
    });
    // Pre-select own name for non-ED users
    if (!_isED) sel.value = _myName;
  } catch (_) {}

  document.getElementById('incompleteSaveBar').style.display = 'none';
  document.getElementById('loadIncompleteBtn').addEventListener('click', loadIncomplete);
  document.getElementById('incompletesSaveBtn').addEventListener('click', saveIncompleteEdits);
}

async function loadIncomplete() {
  const btn      = document.getElementById('loadIncompleteBtn');
  const resultEl = document.getElementById('incompleteResult');
  const saveBar  = document.getElementById('incompleteSaveBar');
  const counsel  = document.getElementById('incompleteCounselor').value;

  btn.disabled    = true;
  btn.textContent = 'Loading…';
  resultEl.innerHTML = '<p style="color:var(--text-muted);font-size:0.875rem;">Loading clients…</p>';
  saveBar.style.display = 'none';
  _pendingEdits = {};

  try {
    const snap = await getDocs(collection(db, 'clients'));
    _allClients = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    let rows = _allClients.filter(c => c.status !== 'closed');
    if (counsel) rows = rows.filter(c => c.counselor === counsel);

    const incomplete = rows.filter(c =>
      !c.amiPercent || !c.reCode || !c.rxNumbers?.length
    );

    if (!incomplete.length) {
      resultEl.innerHTML = '<p style="color:var(--accent);font-weight:600;">No incomplete files found for this counselor.</p>';
      return;
    }

    incomplete.sort((a, b) => (a.clientName || '').localeCompare(b.clientName || ''));

    const reOpts = RE_CODES.map(r =>
      `<option value="${escAttr(r)}">${escHtml(r)}</option>`
    ).join('');

    const TH = 'style="text-align:left;padding:0.4rem 0.6rem;border-bottom:2px solid var(--border);font-size:0.68rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);white-space:nowrap;"';
    const TD = 'style="padding:0.35rem 0.5rem;border-bottom:1px solid #f0f1f3;vertical-align:middle;"';

    resultEl.innerHTML = `
      <p style="font-size:0.8125rem;color:var(--text-muted);margin-bottom:0.75rem;">
        ${incomplete.length} incomplete file${incomplete.length !== 1 ? 's' : ''} found.
        Edit AMI and R/E inline, then click Save. Use the profile link to add Rx/Guarantor.
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
            </tr>
          </thead>
          <tbody>
            ${incomplete.map(c => {
              const issues = [];
              if (!c.amiPercent)        issues.push('AMI');
              if (!c.reCode)            issues.push('R/E');
              if (!c.rxNumbers?.length) issues.push('Rx');

              const missingChips = issues.map(i =>
                `<span style="background:#fef3c7;color:#92400e;padding:0.1rem 0.4rem;border-radius:10px;font-size:0.68rem;font-weight:700;white-space:nowrap;">${escHtml(i)}</span>`
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
              // Pre-select existing value
              const reVal = c.reCode || '';

              const rxStatus = c.rxNumbers?.length
                ? `<span style="color:var(--accent);font-weight:600;font-size:0.78rem;">${c.rxNumbers.length} Rx#</span>`
                : `<span style="color:#dc2626;font-weight:600;font-size:0.78rem;">None</span>`;

              return `<tr data-client-id="${escAttr(c.id)}" data-re-val="${escAttr(reVal)}">
                <td ${TD}><a href="client.html?id=${escAttr(c.id)}" target="_blank" style="font-weight:600;color:var(--primary);">${escHtml(c.clientName || '—')}</a></td>
                <td ${TD} style="color:var(--text-muted);">${escHtml(c.counselor || '—')}</td>
                <td ${TD}><div style="display:flex;gap:0.25rem;flex-wrap:wrap;">${missingChips}</div></td>
                <td ${TD}>${amiInput}</td>
                <td ${TD}>${reSelect}</td>
                <td ${TD}>
                  ${rxStatus}
                  <a href="client.html?id=${escAttr(c.id)}#tab-overview" target="_blank"
                    style="font-size:0.72rem;color:var(--text-muted);margin-left:0.4rem;">Edit →</a>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;

    // Pre-select existing R/E values and wire AMI live labels
    resultEl.querySelectorAll('tr[data-client-id]').forEach(row => {
      const reVal = row.dataset.reVal;
      const sel   = row.querySelector('.incomplete-re');
      if (sel && reVal) sel.value = reVal;

      const amiInp = row.querySelector('.incomplete-ami');
      const amiLbl = row.querySelector('.ami-live-label');
      if (amiInp && amiLbl) {
        amiInp.addEventListener('input', () => {
          const v = parseFloat(amiInp.value);
          amiLbl.textContent = isNaN(v) || v <= 0 ? '' : amiDisplayLabel(v);
          trackEdit(amiInp.dataset.id, 'amiPercent', v > 0 ? v : null);
        });
      }
      if (sel) {
        sel.addEventListener('change', () => {
          trackEdit(sel.dataset.id, 'reCode', sel.value || null);
        });
      }
    });

    saveBar.style.display = 'flex';

  } catch (err) {
    resultEl.innerHTML = `<p class="error-msg">Failed to load: ${escHtml(err.message)}</p>`;
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Load';
  }
}

function trackEdit(clientId, field, value) {
  if (!_pendingEdits[clientId]) _pendingEdits[clientId] = {};
  _pendingEdits[clientId][field] = value;
}

async function saveIncompleteEdits() {
  const btn   = document.getElementById('incompletesSaveBtn');
  const msgEl = document.getElementById('incompleteSaveMsg');

  const changes = Object.entries(_pendingEdits).filter(([, fields]) =>
    Object.values(fields).some(v => v !== undefined)
  );

  if (!changes.length) {
    showMsg(msgEl, 'No changes to save.', false);
    return;
  }

  btn.disabled    = true;
  btn.textContent = 'Saving…';
  msgEl.classList.add('hidden');

  try {
    const now = serverTimestamp();
    for (let i = 0; i < changes.length; i += 490) {
      const batch = writeBatch(db);
      changes.slice(i, i + 490).forEach(([clientId, fields]) => {
        const update = { updatedAt: now };
        if (fields.amiPercent !== undefined) update.amiPercent = fields.amiPercent;
        if (fields.reCode     !== undefined) update.reCode     = fields.reCode;
        batch.update(doc(db, 'clients', clientId), update);
      });
      await batch.commit();
    }
    _pendingEdits = {};
    showMsg(msgEl, `Saved ${changes.length} record${changes.length !== 1 ? 's' : ''}.`, true);
    // Reload to reflect updated state
    await loadIncomplete();
  } catch (err) {
    showMsg(msgEl, 'Save failed: ' + err.message, false);
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Save AMI & R/E Changes';
  }
}

function escHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(str) {
  return (str || '').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function showMsg(el, text, success) {
  el.textContent = text;
  el.style.color = success ? 'var(--accent)' : 'var(--danger)';
  el.classList.remove('hidden');
  if (success) setTimeout(() => el.classList.add('hidden'), 3000);
}
