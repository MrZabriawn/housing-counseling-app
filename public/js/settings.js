import { db } from './firebase-config.js';
import { requireED, setupNav } from './auth.js';
import {
  collection, doc, getDoc, getDocs, setDoc, addDoc, deleteDoc, updateDoc, writeBatch,
  query, orderBy, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const DEFAULTS = { amiWeight: 50, budgetWeight: 15, timeWeight: 15, waitTimeWeight: 20 };

requireED(async (user, profile) => {
  setupNav(profile, 'settings');

  await loadCounselors();
  await loadRemapTable();
  await loadWeights();
  await loadRates();

  // Add counselor
  document.getElementById('addCounselorBtn').addEventListener('click', addCounselor);
  document.getElementById('newCounselorName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addCounselor();
  });

  // Weight sliders live update
  ['wAmi', 'wBudget', 'wTime', 'wWait'].forEach(id => {
    document.getElementById(id).addEventListener('input', (e) => {
      document.getElementById(id + 'Val').textContent = e.target.value;
    });
  });

  document.getElementById('saveWeights').addEventListener('click', saveWeights);
  document.getElementById('saveRatesBtn').addEventListener('click', saveRates);

  // Client name remap tool
  document.getElementById('scanClientNamesBtn').addEventListener('click', () => scanClientNames(false));
  document.getElementById('scanAllClientNamesBtn').addEventListener('click', () => scanClientNames(true));
  document.getElementById('applyClientRemapBtn').addEventListener('click', applyClientNameRemap);

  // All-caps title case tool — now scans clients collection
  document.getElementById('scanNamesBtn').addEventListener('click', scanAllCapsNames);
  document.getElementById('applyTitleCaseBtn').addEventListener('click', applyTitleCaseToClients);

  // Duplicate scanner
  document.getElementById('scanDuplicatesBtn').addEventListener('click', scanDuplicates);
  document.getElementById('mergeCancelBtn').addEventListener('click', () => {
    document.getElementById('mergeModal').classList.add('hidden');
  });

  // CMC link tool
  document.getElementById('loadCmcLinkBtn').addEventListener('click', loadCmcLinkTool);
});

// ── Counselors ────────────────────────────────────────────────────────────────

async function loadCounselors() {
  const container = document.getElementById('counselorsList');
  try {
    const snap = await getDocs(query(collection(db, 'counselors'), orderBy('name')));
    if (snap.empty) {
      container.innerHTML = '<p style="color:var(--text-muted);font-size:0.875rem;">No counselors added yet.</p>';
      return;
    }
    container.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:0.875rem;">
        <thead>
          <tr style="background:#f8f9fb;">
            <th style="text-align:left;padding:0.45rem 0.75rem;border-bottom:2px solid var(--border);font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);">Name</th>
            <th style="text-align:center;padding:0.45rem 0.75rem;border-bottom:2px solid var(--border);font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);">Status</th>
            <th style="padding:0.45rem 0.75rem;border-bottom:2px solid var(--border);"></th>
          </tr>
        </thead>
        <tbody>
          ${snap.docs.map(d => {
            const c = d.data();
            const isActive = c.active !== false;
            return `<tr style="opacity:${isActive ? '1' : '0.55'};">
              <td style="padding:0.5rem 0.75rem;border-bottom:1px solid var(--border);">${escHtml(c.name)}</td>
              <td style="padding:0.5rem 0.75rem;border-bottom:1px solid var(--border);text-align:center;">
                <span style="font-size:0.75rem;font-weight:600;color:${isActive ? 'var(--accent,green)' : 'var(--text-muted)'};">
                  ${isActive ? 'Active' : 'Inactive'}
                </span>
              </td>
              <td style="padding:0.5rem 0.75rem;border-bottom:1px solid var(--border);text-align:right;white-space:nowrap;">
                <button class="btn btn-sm btn-secondary" data-toggle="${d.id}" data-active="${isActive}">${isActive ? 'Mark Inactive' : 'Mark Active'}</button>
                <button class="btn btn-sm btn-danger" data-delete="${d.id}" style="margin-left:4px;">Remove</button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;

    container.querySelectorAll('button[data-toggle]').forEach(btn => {
      btn.addEventListener('click', () => toggleCounselor(btn.dataset.toggle, btn.dataset.active === 'true', btn));
    });
    container.querySelectorAll('button[data-delete]').forEach(btn => {
      btn.addEventListener('click', () => removeCounselor(btn.dataset.delete, btn));
    });
  } catch (err) {
    container.innerHTML = `<p class="error-msg">Failed to load: ${err.message}</p>`;
  }
}

async function addCounselor() {
  const nameEl = document.getElementById('newCounselorName');
  const msgEl  = document.getElementById('counselorMsg');
  const btn    = document.getElementById('addCounselorBtn');

  const name = nameEl.value.trim();
  if (!name) { showMsg(msgEl, 'Enter a name.', false); return; }

  btn.disabled = true;
  btn.textContent = 'Adding…';
  msgEl.classList.add('hidden');

  try {
    await addDoc(collection(db, 'counselors'), {
      name,
      active:    true,
      createdAt: serverTimestamp(),
    });
    nameEl.value = '';
    await loadCounselors();
    showMsg(msgEl, `${name} added.`, true);
  } catch (err) {
    showMsg(msgEl, 'Failed: ' + err.message, false);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add';
  }
}

async function toggleCounselor(id, currentlyActive, btn) {
  btn.disabled = true;
  btn.textContent = '…';
  try {
    await updateDoc(doc(db, 'counselors', id), { active: !currentlyActive });
    await loadCounselors();
  } catch (err) {
    alert('Failed: ' + err.message);
    btn.disabled = false;
    btn.textContent = currentlyActive ? 'Mark Inactive' : 'Mark Active';
  }
}

async function removeCounselor(id, btn) {
  if (!confirm('Remove this counselor? This only removes them from the dropdown — existing records are not changed.')) return;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    await deleteDoc(doc(db, 'counselors', id));
    await loadCounselors();
  } catch (err) {
    alert('Failed: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Remove';
  }
}

// ── Counselor Remap ───────────────────────────────────────────────────────────

let _counselorNames = [];   // canonical names from counselors collection
let _logDocs        = [];   // all counselingLog docs (id + counselor field)

async function loadRemapTable() {
  const container = document.getElementById('remapTable');
  try {
    // Load canonical counselor names
    const cSnap = await getDocs(query(collection(db, 'counselors'), orderBy('name')));
    _counselorNames = cSnap.docs.map(d => d.data().name);

    // Load all counseling log records (just id + counselor)
    const lSnap = await getDocs(collection(db, 'counselingLog'));
    _logDocs = lSnap.docs.map(d => ({ id: d.id, counselor: d.data().counselor || '' }));

    // Find unique stored values that don't exactly match a canonical name
    const canonical = new Set(_counselorNames);
    const unmapped  = new Map(); // stored value → count
    _logDocs.forEach(d => {
      const v = d.counselor.trim();
      if (v && !canonical.has(v)) {
        unmapped.set(v, (unmapped.get(v) || 0) + 1);
      }
    });

    if (unmapped.size === 0) {
      container.innerHTML = '<p style="color:var(--accent);font-size:0.875rem;">All records already use canonical counselor names.</p>';
      return;
    }

    const optionsHtml = ['<option value="">— Keep as-is —</option>',
      ..._counselorNames.map(n => `<option value="${n}">${n}</option>`)
    ].join('');

    container.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:0.875rem;">
        <thead>
          <tr style="background:#f8f9fb;">
            <th style="text-align:left;padding:0.45rem 0.75rem;border-bottom:2px solid var(--border);font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);">Stored Value</th>
            <th style="text-align:center;padding:0.45rem 0.75rem;border-bottom:2px solid var(--border);font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);">Records</th>
            <th style="text-align:left;padding:0.45rem 0.75rem;border-bottom:2px solid var(--border);font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);">Map To</th>
          </tr>
        </thead>
        <tbody>
          ${[...unmapped.entries()].sort((a,b) => b[1]-a[1]).map(([val, count]) => `
            <tr>
              <td style="padding:0.5rem 0.75rem;border-bottom:1px solid var(--border);font-family:monospace;">${val}</td>
              <td style="padding:0.5rem 0.75rem;border-bottom:1px solid var(--border);text-align:center;color:var(--text-muted);">${count}</td>
              <td style="padding:0.5rem 0.75rem;border-bottom:1px solid var(--border);">
                <select class="remap-select" data-from="${val}" style="font-size:0.875rem;padding:0.3rem 0.5rem;border:1px solid var(--border);border-radius:var(--radius);width:100%;">
                  ${optionsHtml}
                </select>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;

    document.getElementById('applyRemapBtn').classList.remove('hidden');
    document.getElementById('applyRemapBtn').addEventListener('click', applyRemap);
  } catch (err) {
    container.innerHTML = `<p class="error-msg">Failed to load: ${err.message}</p>`;
  }
}

async function applyRemap() {
  const btn   = document.getElementById('applyRemapBtn');
  const msgEl = document.getElementById('remapMsg');
  const selects = document.querySelectorAll('.remap-select');

  // Build mapping: oldValue → newValue (only where a target was chosen)
  const mapping = new Map();
  selects.forEach(sel => {
    if (sel.value) mapping.set(sel.dataset.from, sel.value);
  });

  if (mapping.size === 0) {
    showMsg(msgEl, 'No mappings selected.', false);
    return;
  }

  const total = [...mapping.values()].reduce((n, newVal) => {
    return n + _logDocs.filter(d => mapping.has(d.counselor.trim())).length;
  }, 0);

  if (!confirm(`This will update counselor names on ${_logDocs.filter(d => mapping.has(d.counselor.trim())).length} records. Continue?`)) return;

  btn.disabled = true;
  btn.textContent = 'Applying…';
  msgEl.classList.add('hidden');

  try {
    // Batch writes — Firestore max 500 per batch
    const toUpdate = _logDocs.filter(d => mapping.has(d.counselor.trim()));
    let updated = 0;

    for (let i = 0; i < toUpdate.length; i += 499) {
      const batch = writeBatch(db);
      toUpdate.slice(i, i + 499).forEach(d => {
        batch.update(doc(db, 'counselingLog', d.id), {
          counselor: mapping.get(d.counselor.trim()),
          updatedAt: serverTimestamp(),
        });
      });
      await batch.commit();
      updated += Math.min(499, toUpdate.length - i);
    }

    showMsg(msgEl, `Done — updated ${updated} records.`, true);
    await loadRemapTable(); // refresh
  } catch (err) {
    showMsg(msgEl, 'Failed: ' + err.message, false);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Apply Remapping';
  }
}

// ── Client Name Title Case (All-Caps → Title Case, clients collection) ────────

function toTitleCase(str) {
  if (!str) return str;
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function isAllCaps(str) {
  if (!str || str.trim().length < 2) return false;
  const letters = str.replace(/[^a-zA-Z]/g, '');
  return letters.length > 0 && letters === letters.toUpperCase();
}

let _allCapsDocs = [];

async function scanAllCapsNames() {
  const previewEl = document.getElementById('titleCasePreview');
  const btn       = document.getElementById('scanNamesBtn');
  btn.disabled = true;
  btn.textContent = 'Scanning…';

  try {
    const snap = await getDocs(collection(db, 'clients'));
    _allCapsDocs = snap.docs
      .map(d => ({ id: d.id, clientName: d.data().clientName || '' }))
      .filter(d => isAllCaps(d.clientName));

    if (_allCapsDocs.length === 0) {
      previewEl.innerHTML = '<span style="color:var(--accent);">No all-caps client names found.</span>';
      document.getElementById('applyTitleCaseBtn').classList.add('hidden');
    } else {
      const sample = _allCapsDocs.slice(0, 8).map(d =>
        `<li><span style="font-family:monospace;">${escHtml(d.clientName)}</span> → ${escHtml(toTitleCase(d.clientName))}</li>`
      ).join('');
      previewEl.innerHTML = `
        <p style="margin-bottom:0.5rem;font-weight:600;">${_allCapsDocs.length} clients to update${_allCapsDocs.length > 8 ? ' (showing first 8)' : ''}:</p>
        <ul style="margin:0;padding-left:1.25rem;line-height:1.8;">${sample}</ul>
        ${_allCapsDocs.length > 8 ? `<p style="color:var(--text-muted);margin-top:0.4rem;">…and ${_allCapsDocs.length - 8} more</p>` : ''}`;
      document.getElementById('applyTitleCaseBtn').classList.remove('hidden');
    }
  } catch (err) {
    previewEl.innerHTML = `<span class="error-msg">Scan failed: ${err.message}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Scan Records';
  }
}

async function applyTitleCaseToClients() {
  if (!_allCapsDocs.length) return;
  if (!confirm(`Apply title case to ${_allCapsDocs.length} clients?`)) return;

  const btn   = document.getElementById('applyTitleCaseBtn');
  const msgEl = document.getElementById('titleCaseMsg');
  btn.disabled = true;
  btn.textContent = 'Applying…';
  msgEl.classList.add('hidden');

  try {
    const now = serverTimestamp();
    for (let i = 0; i < _allCapsDocs.length; i += 499) {
      const batch = writeBatch(db);
      _allCapsDocs.slice(i, i + 499).forEach(d => {
        batch.update(doc(db, 'clients', d.id), {
          clientName: toTitleCase(d.clientName),
          updatedAt:  now,
        });
      });
      await batch.commit();
    }
    showMsg(msgEl, `Done — ${_allCapsDocs.length} client names updated.`, true);
    _allCapsDocs = [];
    document.getElementById('titleCasePreview').innerHTML = '<span style="color:var(--accent);">All done. No all-caps names remaining.</span>';
    document.getElementById('applyTitleCaseBtn').classList.add('hidden');
  } catch (err) {
    showMsg(msgEl, 'Failed: ' + err.message, false);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Apply Title Case';
  }
}

// ── Client Name Remapping (Last, First → First Last, etc.) ────────────────────

let _clientNameDocs = []; // { id, clientName }

async function scanClientNames(showAll) {
  const container = document.getElementById('clientNameRemapTable');
  const applyBtn  = document.getElementById('applyClientRemapBtn');
  container.innerHTML = '<p style="color:var(--text-muted);">Scanning…</p>';
  applyBtn.classList.add('hidden');

  try {
    const snap = await getDocs(collection(db, 'clients'));
    const all  = snap.docs.map(d => ({ id: d.id, clientName: d.data().clientName || '' }));

    // Comma pattern: "Lastname, Firstname" — has a comma in the name
    _clientNameDocs = showAll
      ? all.filter(d => d.clientName.trim())
      : all.filter(d => /,/.test(d.clientName));

    _clientNameDocs.sort((a, b) => a.clientName.localeCompare(b.clientName));

    if (_clientNameDocs.length === 0) {
      container.innerHTML = showAll
        ? '<p style="color:var(--text-muted);">No clients found.</p>'
        : '<p style="color:var(--accent);">No comma-style names found.</p>';
      return;
    }

    container.innerHTML = `
      <p style="font-size:0.8125rem;color:var(--text-muted);margin-bottom:0.75rem;">
        ${_clientNameDocs.length} clients shown. Edit names in the right column — leave blank to keep as-is.
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:0.875rem;">
        <thead>
          <tr style="background:#f8f9fb;">
            <th style="text-align:left;padding:0.45rem 0.75rem;border-bottom:2px solid var(--border);font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);">Current Name</th>
            <th style="text-align:left;padding:0.45rem 0.75rem;border-bottom:2px solid var(--border);font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);">Corrected Name</th>
          </tr>
        </thead>
        <tbody>
          ${_clientNameDocs.map((d, i) => {
            // Auto-suggest: "Akins, Malik" → "Malik Akins"
            const suggest = /^([^,]+),\s*(.+)$/.test(d.clientName)
              ? toTitleCase(d.clientName.replace(/^([^,]+),\s*(.+)$/, '$2 $1'))
              : '';
            return `<tr>
              <td style="padding:0.5rem 0.75rem;border-bottom:1px solid var(--border);font-family:monospace;">${escHtml(d.clientName)}</td>
              <td style="padding:0.4rem 0.5rem;border-bottom:1px solid var(--border);">
                <input type="text" class="client-name-input" data-index="${i}"
                  value="${escAttr(suggest)}"
                  placeholder="Leave blank to keep"
                  style="width:100%;padding:0.3rem 0.5rem;border:1px solid var(--border);border-radius:var(--radius);font-size:0.875rem;">
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;

    applyBtn.classList.remove('hidden');
  } catch (err) {
    container.innerHTML = `<p class="error-msg">Scan failed: ${err.message}</p>`;
  }
}

async function applyClientNameRemap() {
  const inputs = document.querySelectorAll('.client-name-input');
  const changes = [];
  inputs.forEach(input => {
    const i    = parseInt(input.dataset.index);
    const newName = input.value.trim();
    const orig    = _clientNameDocs[i];
    if (newName && newName !== orig.clientName) {
      changes.push({ id: orig.id, newName: toTitleCase(newName) });
    }
  });

  if (changes.length === 0) {
    showMsg(document.getElementById('clientRemapMsg'), 'No changes to apply.', false);
    return;
  }

  if (!confirm(`Update ${changes.length} client name(s)?`)) return;

  const btn   = document.getElementById('applyClientRemapBtn');
  const msgEl = document.getElementById('clientRemapMsg');
  btn.disabled = true;
  btn.textContent = 'Applying…';
  msgEl.classList.add('hidden');

  try {
    for (let i = 0; i < changes.length; i += 499) {
      const batch = writeBatch(db);
      changes.slice(i, i + 499).forEach(c => {
        batch.update(doc(db, 'clients', c.id), {
          clientName: c.newName,
          updatedAt:  serverTimestamp(),
        });
      });
      await batch.commit();
    }
    showMsg(msgEl, `Done — ${changes.length} client name(s) updated.`, true);
    document.getElementById('applyClientRemapBtn').classList.add('hidden');
    document.getElementById('clientNameRemapTable').innerHTML =
      `<p style="color:var(--accent);">${changes.length} names updated. Scan again to continue.</p>`;
    _clientNameDocs = [];
  } catch (err) {
    showMsg(msgEl, 'Failed: ' + err.message, false);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Apply Name Changes';
  }
}

// ── Billing Rates ─────────────────────────────────────────────────────────────

async function loadRates() {
  try {
    const snap = await getDoc(doc(db, 'config', 'billing'));
    if (snap.exists()) {
      const d = snap.data();
      document.getElementById('defaultRate').value = d.defaultRate ?? 48.5;
      document.getElementById('courtRate').value   = d.courtRate   ?? 2.0;
    } else {
      document.getElementById('defaultRate').value = 48.5;
      document.getElementById('courtRate').value   = 2.0;
    }
  } catch (_) {}
}

async function saveRates() {
  const btn   = document.getElementById('saveRatesBtn');
  const msgEl = document.getElementById('ratesMsg');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  msgEl.classList.add('hidden');
  try {
    await setDoc(doc(db, 'config', 'billing'), {
      defaultRate: parseFloat(document.getElementById('defaultRate').value) || 48.5,
      courtRate:   parseFloat(document.getElementById('courtRate').value)   || 2.0,
    });
    showMsg(msgEl, 'Rates saved.', true);
  } catch (err) {
    showMsg(msgEl, 'Save failed: ' + err.message, false);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Rates';
  }
}

// ── Possible Duplicate Scanner ────────────────────────────────────────────────

let _dismissedPairs = new Set(); // pairKey → true, dismissed for this session
let _pendingMerge   = null;      // { keepId, dropId, keepName, dropName }

function nameTokens(name) {
  return (name || '').toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean);
}

function tokenOverlapScore(a, b) {
  const ta = new Set(nameTokens(a));
  const tb = nameTokens(b);
  if (!ta.size || !tb.length) return 0;
  const shared = tb.filter(t => ta.has(t)).length;
  return shared / Math.max(ta.size, tb.length);
}

// Simple edit distance (Levenshtein) — used on short normalized strings
function editDistance(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function nameSimilarity(a, b) {
  const na = (a || '').toLowerCase().replace(/[^a-z]/g, '');
  const nb = (b || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!na || !nb) return 0;
  const maxLen = Math.max(na.length, nb.length);
  return 1 - editDistance(na, nb) / maxLen;
}

// Reverse "Last, First" → "First Last" for comparison
function reversedName(name) {
  const m = (name || '').match(/^([^,]+),\s*(.+)$/);
  return m ? `${m[2]} ${m[1]}` : name;
}

function rxOverlap(a, b) {
  const rxA = (a.rxNumbers || []).filter(r => r && r.trim());
  const rxB = new Set((b.rxNumbers || []).filter(r => r && r.trim()));
  return rxA.filter(r => rxB.has(r));
}

function findReasons(a, b) {
  const reasons = [];

  // Shared Rx numbers
  const shared = rxOverlap(a, b);
  if (shared.length) reasons.push({ text: `Shared Rx: ${shared.join(', ')}`, confidence: 'high' });

  // Name similarity signals
  const overlap      = tokenOverlapScore(a.clientName, b.clientName);
  const similarity   = nameSimilarity(a.clientName, b.clientName);
  const reversedA    = reversedName(a.clientName);
  const revSimilarity = nameSimilarity(reversedA, b.clientName);
  const revOverlap   = tokenOverlapScore(reversedA, b.clientName);

  if (overlap >= 0.99 || similarity >= 0.97) {
    reasons.push({ text: 'Near-identical names', confidence: 'high' });
  } else if (revSimilarity >= 0.85 || revOverlap >= 0.85) {
    reasons.push({ text: 'Possible name reversal (Last, First vs First Last)', confidence: 'high' });
  } else if (overlap >= 0.75 || similarity >= 0.80) {
    reasons.push({ text: `Similar names (${Math.round(Math.max(overlap, similarity) * 100)}% match)`, confidence: 'medium' });
  } else if (overlap >= 0.5 || similarity >= 0.65) {
    reasons.push({ text: `Possible name misspelling (${Math.round(Math.max(overlap, similarity) * 100)}% match)`, confidence: 'low' });
  }

  // Same zip + same counseling type + any name similarity
  if (!reasons.length && a.zipCode && a.zipCode === b.zipCode && a.counselingType === b.counselingType && overlap >= 0.3) {
    reasons.push({ text: `Same zip (${a.zipCode}) + same counseling type + partial name match`, confidence: 'low' });
  }

  return reasons;
}

function pairKey(a, b) {
  return [a.id, b.id].sort().join('|');
}

async function scanDuplicates() {
  const btn       = document.getElementById('scanDuplicatesBtn');
  const container = document.getElementById('duplicatesResult');
  btn.disabled    = true;
  btn.textContent = 'Scanning…';
  container.innerHTML = '<p style="color:var(--text-muted);">Loading clients…</p>';

  try {
    const snap    = await getDocs(collection(db, 'clients'));
    const clients = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    container.innerHTML = `<p style="color:var(--text-muted);">Comparing ${clients.length} clients…</p>`;

    const pairs = [];
    for (let i = 0; i < clients.length; i++) {
      for (let j = i + 1; j < clients.length; j++) {
        const a = clients[i], b = clients[j];
        const key = pairKey(a, b);
        if (_dismissedPairs.has(key)) continue;
        const reasons = findReasons(a, b);
        if (reasons.length) pairs.push({ a, b, reasons, key });
      }
    }

    // Sort: high confidence first
    const rank = r => r.confidence === 'high' ? 0 : r.confidence === 'medium' ? 1 : 2;
    pairs.sort((x, y) => Math.min(...x.reasons.map(r => rank(r))) - Math.min(...y.reasons.map(r => rank(r))));

    if (!pairs.length) {
      container.innerHTML = '<p style="color:var(--accent);">No potential duplicates found.</p>';
      return;
    }

    const confidenceColor = { high: 'var(--danger)', medium: '#e65100', low: 'var(--text-muted)' };
    const confidenceLabel = { high: 'Strong match', medium: 'Possible match', low: 'Weak signal' };

    container.innerHTML = `
      <p style="margin-bottom:0.75rem;font-weight:600;">${pairs.length} potential duplicate pair${pairs.length !== 1 ? 's' : ''} found:</p>
      <div style="display:flex;flex-direction:column;gap:0.75rem;">
        ${pairs.map(({ a, b, reasons, key }) => {
          const topConf = reasons.reduce((best, r) => rank(r) < rank(best) ? r : best, reasons[0]);
          return `
          <div class="dup-pair" data-key="${escAttr(key)}"
            style="border:1px solid var(--border);border-radius:var(--radius);padding:0.9rem 1rem;background:#fff;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap;">
              <div style="flex:1;min-width:200px;">
                <div style="font-weight:600;font-size:0.9rem;">${escHtml(toTitleCase(a.clientName))}</div>
                <div style="font-size:0.775rem;color:var(--text-muted);">${escHtml(a.counselingType || '')} · ${escHtml(a.counselor || '')} · ${a.sessionCount || 0} sessions</div>
              </div>
              <div style="font-size:0.8rem;color:var(--text-muted);padding:0 0.25rem;">↔</div>
              <div style="flex:1;min-width:200px;">
                <div style="font-weight:600;font-size:0.9rem;">${escHtml(toTitleCase(b.clientName))}</div>
                <div style="font-size:0.775rem;color:var(--text-muted);">${escHtml(b.counselingType || '')} · ${escHtml(b.counselor || '')} · ${b.sessionCount || 0} sessions</div>
              </div>
              <div style="display:flex;flex-direction:column;gap:0.4rem;align-items:flex-end;flex-shrink:0;">
                <span style="font-size:0.72rem;font-weight:700;color:${confidenceColor[topConf.confidence]};">
                  ${confidenceLabel[topConf.confidence]}
                </span>
                <div style="display:flex;gap:0.4rem;flex-wrap:wrap;justify-content:flex-end;">
                  <a href="client.html?id=${a.id}" target="_blank" class="btn btn-sm btn-secondary" style="font-size:0.75rem;">Open A</a>
                  <a href="client.html?id=${b.id}" target="_blank" class="btn btn-sm btn-secondary" style="font-size:0.75rem;">Open B</a>
                  <button class="btn btn-sm btn-secondary dismiss-pair" data-key="${escAttr(key)}" style="font-size:0.75rem;">Dismiss</button>
                  <button class="btn btn-sm btn-primary merge-btn"
                    data-keep="${a.id}" data-drop="${b.id}"
                    data-keep-name="${escAttr(toTitleCase(a.clientName))}"
                    data-drop-name="${escAttr(toTitleCase(b.clientName))}"
                    style="font-size:0.75rem;">Merge B→A</button>
                </div>
              </div>
            </div>
            <div style="margin-top:0.5rem;display:flex;gap:0.5rem;flex-wrap:wrap;">
              ${reasons.map(r => `
                <span style="font-size:0.72rem;padding:0.15rem 0.5rem;border-radius:20px;background:#f0f1f3;color:${confidenceColor[r.confidence]};">
                  ${escHtml(r.text)}
                </span>`).join('')}
            </div>
          </div>`;
        }).join('')}
      </div>`;

    // Wire dismiss buttons
    container.querySelectorAll('.dismiss-pair').forEach(btn => {
      btn.addEventListener('click', () => {
        _dismissedPairs.add(btn.dataset.key);
        btn.closest('.dup-pair').remove();
        const remaining = container.querySelectorAll('.dup-pair').length;
        if (!remaining) container.querySelector('p').textContent = 'All pairs dismissed.';
        else container.querySelector('p').textContent = `${remaining} potential duplicate pair${remaining !== 1 ? 's' : ''} found:`;
      });
    });

    // Wire merge buttons
    container.querySelectorAll('.merge-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _pendingMerge = {
          keepId:   btn.dataset.keep,
          dropId:   btn.dataset.drop,
          keepName: btn.dataset.keepName,
          dropName: btn.dataset.dropName,
          pairKey:  btn.closest('.dup-pair').dataset.key,
        };
        document.getElementById('mergeModalDesc').innerHTML =
          `<strong>${escHtml(_pendingMerge.dropName)}</strong> (B) will be merged into <strong>${escHtml(_pendingMerge.keepName)}</strong> (A).<br>
           All sessions from B will be moved to A. B will be permanently deleted.`;
        document.getElementById('mergeModalError').classList.add('hidden');
        document.getElementById('mergeConfirmBtn').disabled = false;
        document.getElementById('mergeConfirmBtn').textContent = 'Merge';
        document.getElementById('mergeModal').classList.remove('hidden');
      });
    });

    // Confirm merge
    document.getElementById('mergeConfirmBtn').onclick = () => performMerge();

  } catch (err) {
    container.innerHTML = `<p class="error-msg">Scan failed: ${err.message}</p>`;
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Scan Clients';
  }
}

async function performMerge() {
  if (!_pendingMerge) return;
  const { keepId, dropId, keepName, dropName, pairKey: pk } = _pendingMerge;
  const confirmBtn = document.getElementById('mergeConfirmBtn');
  const errorEl    = document.getElementById('mergeModalError');
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Merging…';
  errorEl.classList.add('hidden');

  try {
    // Load both client docs
    const [keepSnap, dropSnap] = await Promise.all([
      getDoc(doc(db, 'clients', keepId)),
      getDoc(doc(db, 'clients', dropId)),
    ]);
    const keep = keepSnap.data();
    const drop = dropSnap.data();

    // Load sessions from drop client
    const sessSnap = await getDocs(collection(db, 'clients', dropId, 'sessions'));
    const dropSessions = sessSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Move sessions to keep client in batches
    const now = serverTimestamp();
    for (let i = 0; i < dropSessions.length; i += 490) {
      const batch = writeBatch(db);
      dropSessions.slice(i, i + 490).forEach(s => {
        const { id, ...data } = s;
        batch.set(doc(collection(db, 'clients', keepId, 'sessions')), { ...data, mergedFrom: dropId });
        batch.delete(doc(db, 'clients', dropId, 'sessions', id));
      });
      await batch.commit();
    }

    // Merge arrays (union, deduplicate)
    const mergedRx    = [...new Set([...(keep.rxNumbers || []), ...(drop.rxNumbers || [])].filter(Boolean))];
    const mergedAreas = [...new Set([...(keep.areasOfInterest || []), ...(drop.areasOfInterest || [])].filter(Boolean))];

    // Recompute denormalized fields
    const allSessSnap = await getDocs(collection(db, 'clients', keepId, 'sessions'));
    const allSessions = allSessSnap.docs.map(d => d.data());
    const sessionCount     = allSessions.length;
    const totalOutcomeValue = allSessions.reduce((s, r) => s + (Number(r.dollarsAwarded) || 0), 0);

    function toDate(ts) { if (!ts) return null; return ts.toDate ? ts.toDate() : new Date(ts); }
    const dated = allSessions.map(s => toDate(s.date)).filter(Boolean).sort((a, b) => a - b);
    const firstSessionDate = dated.length ? dated[0] : (toDate(keep.firstSessionDate) || toDate(drop.firstSessionDate));
    const lastSessionDate  = dated.length ? dated[dated.length - 1] : (toDate(keep.lastSessionDate) || toDate(drop.lastSessionDate));

    // Use the counseling type from whichever record had the more recent activity.
    // null lastSessionDate becomes epoch (Jan 1 1970) so a record with sessions
    // always beats one without, and the more recent record wins on ties.
    const keepDate = keep.lastSessionDate ? toDate(keep.lastSessionDate).getTime() : 0;
    const dropDate = drop.lastSessionDate ? toDate(drop.lastSessionDate).getTime() : 0;
    const activeCounselingType = dropDate > keepDate
      ? (drop.counselingType || keep.counselingType)
      : (keep.counselingType || drop.counselingType);

    // Update keep doc
    await updateDoc(doc(db, 'clients', keepId), {
      rxNumbers:         mergedRx,
      areasOfInterest:   mergedAreas,
      sessionCount,
      totalOutcomeValue,
      firstSessionDate:  firstSessionDate || null,
      lastSessionDate:   lastSessionDate  || null,
      counselingType:    activeCounselingType,
      // Prefer non-empty fields from either record
      guarantor:         keep.guarantor  || drop.guarantor  || '',
      zipCode:           keep.zipCode    || drop.zipCode    || '',
      counselor:         keep.counselor  || drop.counselor  || '',
      updatedAt:         now,
    });

    // Delete drop client doc
    await deleteDoc(doc(db, 'clients', dropId));

    // Close modal and remove pair from results
    document.getElementById('mergeModal').classList.add('hidden');
    _dismissedPairs.add(pk);
    const pairEl = document.querySelector(`.dup-pair[data-key="${CSS.escape(pk)}"]`);
    if (pairEl) pairEl.remove();

    showMsg(document.getElementById('duplicatesMsg'),
      `Merged "${dropName}" into "${keepName}" — ${dropSessions.length} session(s) transferred.`, true);
    _pendingMerge = null;

  } catch (err) {
    errorEl.textContent = 'Merge failed: ' + err.message;
    errorEl.classList.remove('hidden');
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Merge';
  }
}

// ── CMC Letter Linking ────────────────────────────────────────────────────────

// Holds all clients for search — loaded once when the tool opens
let _cmcClients = [];

async function loadCmcLinkTool() {
  const container = document.getElementById('cmcLinkResult');
  const btn       = document.getElementById('loadCmcLinkBtn');
  btn.disabled    = true;
  btn.textContent = 'Loading…';
  container.innerHTML = '<p style="color:var(--text-muted);">Loading…</p>';

  try {
    // Load all unlinked CMC records (no linkedClientId set)
    const cmcSnap = await getDocs(query(collection(db, 'cmcLog'), orderBy('dateSent', 'desc')));
    const allCmc  = cmcSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const unlinked = allCmc.filter(r => !r.linkedClientId);

    // Load clients once for search — only need id + name
    const cliSnap = await getDocs(collection(db, 'clients'));
    _cmcClients = cliSnap.docs.map(d => ({ id: d.id, clientName: d.data().clientName || '' }))
      .sort((a, b) => a.clientName.localeCompare(b.clientName));

    if (!unlinked.length) {
      container.innerHTML = '<p style="color:var(--accent);">All CMC letters are already linked to clients.</p>';
      return;
    }

    container.innerHTML = `
      <p style="font-size:0.8125rem;color:var(--text-muted);margin-bottom:0.75rem;">
        ${unlinked.length} unlinked letter${unlinked.length !== 1 ? 's' : ''}. Search for a client to link each one.
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:0.875rem;">
        <thead>
          <tr style="background:#f8f9fb;">
            <th style="text-align:left;padding:0.45rem 0.75rem;border-bottom:2px solid var(--border);font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);">Date Sent</th>
            <th style="text-align:left;padding:0.45rem 0.75rem;border-bottom:2px solid var(--border);font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);">Recipient</th>
            <th style="text-align:left;padding:0.45rem 0.75rem;border-bottom:2px solid var(--border);font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);">Counselor</th>
            <th style="text-align:left;padding:0.45rem 0.75rem;border-bottom:2px solid var(--border);font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);">Link to Client</th>
            <th style="padding:0.45rem 0.75rem;border-bottom:2px solid var(--border);"></th>
          </tr>
        </thead>
        <tbody id="cmcLinkBody">
          ${unlinked.map(r => {
            const dateStr = r.dateSent
              ? (r.dateSent.toDate ? r.dateSent.toDate() : new Date(r.dateSent)).toLocaleDateString('en-US', { timeZone: 'UTC' })
              : '—';
            return `<tr data-cmc-id="${escAttr(r.id)}" data-cmc-name="${escAttr(r.recipientName || '')}">
              <td style="padding:0.5rem 0.75rem;border-bottom:1px solid var(--border);white-space:nowrap;">${escHtml(dateStr)}</td>
              <td style="padding:0.5rem 0.75rem;border-bottom:1px solid var(--border);">${escHtml(r.recipientName || '—')}</td>
              <td style="padding:0.5rem 0.75rem;border-bottom:1px solid var(--border);">${escHtml(r.counselor || '—')}</td>
              <td style="padding:0.4rem 0.5rem;border-bottom:1px solid var(--border);">
                <input type="text" class="cmc-search"
                  placeholder="Type client name…"
                  style="width:100%;padding:0.3rem 0.5rem;border:1px solid var(--border);border-radius:var(--radius);font-size:0.875rem;">
                <div class="cmc-suggestions" style="position:relative;"></div>
              </td>
              <td style="padding:0.4rem 0.5rem;border-bottom:1px solid var(--border);white-space:nowrap;">
                <button class="btn btn-sm btn-primary cmc-link-btn" disabled
                  style="font-size:0.75rem;">Link</button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;

    // Wire search inputs — filter _cmcClients on input, show dropdown suggestions
    container.querySelectorAll('tr[data-cmc-id]').forEach(row => {
      const input    = row.querySelector('.cmc-search');
      const dropdown = row.querySelector('.cmc-suggestions');
      const linkBtn  = row.querySelector('.cmc-link-btn');
      let _selectedClientId   = null;
      let _selectedClientName = null;

      input.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();
        _selectedClientId = null;
        _selectedClientName = null;
        linkBtn.disabled = true;

        if (!q) { dropdown.innerHTML = ''; return; }

        const matches = _cmcClients.filter(c => c.clientName.toLowerCase().includes(q)).slice(0, 8);
        if (!matches.length) {
          dropdown.innerHTML = '<div style="font-size:0.8rem;color:var(--text-muted);padding:0.35rem 0.5rem;">No clients found</div>';
          return;
        }
        dropdown.innerHTML = `<div style="border:1px solid var(--border);border-radius:var(--radius);background:#fff;position:absolute;z-index:100;width:100%;box-shadow:0 4px 12px rgba(0,0,0,0.08);">
          ${matches.map(c => `<div class="cmc-suggestion-item"
            data-id="${escAttr(c.id)}" data-name="${escAttr(c.clientName)}"
            style="padding:0.4rem 0.75rem;cursor:pointer;font-size:0.875rem;"
            onmouseover="this.style.background='#f0f4ff'" onmouseout="this.style.background=''">
            ${escHtml(c.clientName)}
          </div>`).join('')}
        </div>`;

        dropdown.querySelectorAll('.cmc-suggestion-item').forEach(item => {
          item.addEventListener('click', () => {
            _selectedClientId   = item.dataset.id;
            _selectedClientName = item.dataset.name;
            input.value         = item.dataset.name;
            dropdown.innerHTML  = '';
            linkBtn.disabled    = false;
          });
        });
      });

      linkBtn.addEventListener('click', async () => {
        if (!_selectedClientId) return;
        linkBtn.disabled = true;
        linkBtn.textContent = '…';
        try {
          await updateDoc(doc(db, 'cmcLog', row.dataset.cmcId), {
            linkedClientId:   _selectedClientId,
            linkedClientName: _selectedClientName,
            updatedAt:        serverTimestamp(),
          });
          // Fade the row out and show success
          row.style.opacity = '0.4';
          row.querySelector('td:last-child').innerHTML =
            `<span style="font-size:0.8rem;color:var(--accent);font-weight:600;">Linked ✓</span>`;
          showMsg(document.getElementById('cmcLinkMsg'),
            `Linked "${row.dataset.cmcName}" to "${_selectedClientName}".`, true);
        } catch (err) {
          alert('Link failed: ' + err.message);
          linkBtn.disabled = false;
          linkBtn.textContent = 'Link';
        }
      });
    });

  } catch (err) {
    container.innerHTML = `<p class="error-msg">Failed to load: ${err.message}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Load Unlinked Letters';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function escAttr(str) {
  return (str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── HIG Weights ───────────────────────────────────────────────────────────────

async function loadWeights() {
  const snap = await getDoc(doc(db, 'config', 'higWeights'));
  const saved = snap.exists() ? snap.data() : DEFAULTS;
  setSlider('wAmi',    'wAmiVal',    saved.amiWeight      ?? DEFAULTS.amiWeight);
  setSlider('wBudget', 'wBudgetVal', saved.budgetWeight   ?? DEFAULTS.budgetWeight);
  setSlider('wTime',   'wTimeVal',   saved.timeWeight     ?? DEFAULTS.timeWeight);
  setSlider('wWait',   'wWaitVal',   saved.waitTimeWeight ?? DEFAULTS.waitTimeWeight);
}

async function saveWeights() {
  const btn   = document.getElementById('saveWeights');
  const msgEl = document.getElementById('settingsMsg');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  msgEl.classList.add('hidden');
  try {
    await setDoc(doc(db, 'config', 'higWeights'), {
      amiWeight:      parseInt(document.getElementById('wAmi').value,    10),
      budgetWeight:   parseInt(document.getElementById('wBudget').value, 10),
      timeWeight:     parseInt(document.getElementById('wTime').value,   10),
      waitTimeWeight: parseInt(document.getElementById('wWait').value,   10),
    });
    showMsg(msgEl, 'Weights saved.', true);
  } catch (err) {
    showMsg(msgEl, 'Save failed: ' + err.message, false);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Weights';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function setSlider(sliderId, valId, value) {
  document.getElementById(sliderId).value    = value;
  document.getElementById(valId).textContent = value;
}

function showMsg(el, text, success) {
  el.textContent = text;
  el.style.color = success ? 'var(--accent)' : 'var(--danger)';
  el.classList.remove('hidden');
}
