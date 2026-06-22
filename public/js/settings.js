import { db } from './firebase-config.js';
import { requireED, setupNav } from './auth.js';
import { amiCategory, AMI_IMPORT_MAP } from './data.js';
import {
  findReasons, pairKey, confidenceColor, confidenceLabel, confRank,
} from './duplicate-scanner.js';
import {
  collection, collectionGroup, doc, getDoc, getDocs, setDoc, addDoc, deleteDoc, updateDoc, writeBatch,
  query, where, orderBy, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const DEFAULTS = { amiWeight: 50, budgetWeight: 15, timeWeight: 15, waitTimeWeight: 20 };
const _sessionMonthCache = new Map(); // "YYYY-MM" → Set<clientId>

requireED(async (user, profile) => {
  setupNav(profile, 'settings');

  await loadPendingUsers();
  await loadStaff();
  await loadRemapTable();
  await loadWeights();
  await loadRates();
  await loadDemoPasscode();

  // Add staff member
  document.getElementById('addCounselorBtn').addEventListener('click', addCounselor);
  document.getElementById('newCounselorName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addCounselor();
  });

  // Edit staff modal
  document.getElementById('editCounselorCancelBtn').addEventListener('click', closeStaffModal);
  document.getElementById('editCounselorModal').addEventListener('click', e => {
    if (e.target === document.getElementById('editCounselorModal')) closeStaffModal();
  });
  document.getElementById('editCounselorSaveBtn').addEventListener('click', saveEditCounselor);

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

  // AMI normalization
  document.getElementById('scanAmiBtn').addEventListener('click', scanAmiValues);
  document.getElementById('applyAmiBtn').addEventListener('click', applyAmiNormalization);

  // Duplicate scanner
  document.getElementById('scanDuplicatesBtn').addEventListener('click', scanDuplicates);
  document.getElementById('mergeCancelBtn').addEventListener('click', () => {
    document.getElementById('mergeModal').classList.add('hidden');
  });

  // CMC link tool
  document.getElementById('loadCmcLinkBtn').addEventListener('click', loadCmcLinkTool);

  // Auto-link list records to client profiles
  document.getElementById('scanUnlinkedBtn').addEventListener('click', scanUnlinkedListRecords);
  document.getElementById('applyAutoLinkBtn').addEventListener('click', applyAutoLinks);

  // Demo passcode
  document.getElementById('saveDemoPasscodeBtn').addEventListener('click', saveDemoPasscode);
  document.getElementById('migrateCounselingTypeBtn').addEventListener('click', migrateCounselingTypes);
  document.getElementById('repairHudCounselorIdsBtn').addEventListener('click', repairHudCounselorIds);
  document.getElementById('backfillNofaHudBtn').addEventListener('click', backfillNofaHudEvents);

  // Legacy counseling log
  document.getElementById('loadLegacyLogBtn').addEventListener('click', loadLegacyCounselingLog);
  document.getElementById('legacyLogSearch').addEventListener('input', filterLegacyLog);
});

// ── Staff & Roles ─────────────────────────────────────────────────────────────

const TH = 'style="text-align:left;padding:0.45rem 0.75rem;border-bottom:2px solid var(--border);font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);"';
const TD = 'style="padding:0.5rem 0.75rem;border-bottom:1px solid var(--border);"';

const ROLE_OPTIONS = [
  { value: 'counselor',          label: 'Counselor' },
  { value: 'admin',              label: 'Admin' },
  { value: 'executive_director', label: 'Executive Director' },
];


async function loadStaff() {
  const container = document.getElementById('staffList');
  try {
    const [userSnap, counselorSnap] = await Promise.all([
      getDocs(query(collection(db, 'users'), orderBy('name'))),
      getDocs(query(collection(db, 'counselors'), orderBy('name'))),
    ]);

    const users      = userSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const counselors = counselorSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Join by name (case-insensitive)
    const matchedCounselorIds = new Set();
    const rows = users.map(u => {
      const c = counselors.find(c => (c.name || '').toLowerCase() === (u.name || '').toLowerCase());
      if (c) matchedCounselorIds.add(c.id);
      return { user: u, counselor: c || null };
    });
    // Counselors with no user account
    counselors.filter(c => !matchedCounselorIds.has(c.id)).forEach(c => {
      rows.push({ user: null, counselor: c });
    });
    // Sort by name
    rows.sort((a, b) => {
      const na = (a.user?.name || a.counselor?.name || '').toLowerCase();
      const nb = (b.user?.name || b.counselor?.name || '').toLowerCase();
      return na.localeCompare(nb);
    });

    const ROLE_LABELS = { counselor: 'Counselor', admin: 'Admin', executive_director: 'ED', pending: 'Pending' };

    const bodyRows = rows.map(({ user: u, counselor: c }) => {
      const name        = u?.name || c?.name || '—';
      const isActive    = c ? c.active !== false : true;
      const isCounselor = c ? c.isCounselor !== false : false;
      const hasStaff    = !!c;

      const missingHud = hasStaff && isActive && isCounselor && (c.staffNumber == null || !c.staffTitle);
      const warn = missingHud
        ? `<span title="Staff # or Title missing — HUD reports won't generate" style="color:#e65100;margin-left:0.3rem;">⚠</span>`
        : '';

      const roleLabel = u?.role
        ? `<span style="font-size:0.75rem;font-weight:700;background:#f0f4ff;color:var(--primary);padding:0.15rem 0.45rem;border-radius:10px;">${escHtml(ROLE_LABELS[u.role] || u.role)}</span>`
        : `<span style="font-size:0.75rem;color:var(--text-muted);">No account</span>`;

      const staffNum = hasStaff && c.staffNumber != null
        ? `<strong>${escHtml(String(c.staffNumber))}</strong>`
        : '<span style="color:var(--text-muted);">—</span>';

      // Inline counselor toggle button
      const counselorToggle = hasStaff
        ? `<button class="staff-counselor-toggle btn btn-sm ${isCounselor ? 'btn-primary' : 'btn-secondary'}"
              data-cid="${escAttr(c.id)}" data-is-counselor="${isCounselor}"
              style="min-width:42px;font-size:0.75rem;">${isCounselor ? 'Yes' : 'No'}</button>`
        : '<span style="color:var(--text-muted);font-size:0.75rem;">—</span>';

      const editData = `data-cid="${escAttr(c?.id || '')}" data-uid="${escAttr(u?.id || '')}"
        data-name="${escAttr(name)}"
        data-staff-num="${escAttr(c?.staffNumber != null ? String(c.staffNumber) : '')}"
        data-staff-title="${escAttr(c?.staffTitle || '')}"
        data-is-counselor="${isCounselor}"
        data-base-salary="${escAttr(c?.baseSalary != null ? String(c.baseSalary) : '')}"
        data-fringe="${escAttr(c?.fringe != null ? String(c.fringe) : '')}"
        data-role="${escAttr(u?.role || '')}"`;

      const title = hasStaff && c.staffTitle ? escHtml(c.staffTitle) : '<span style="color:var(--text-muted);">—</span>';

      const statusBtn = hasStaff
        ? isActive
          ? `<button class="btn btn-sm btn-secondary staff-toggle-btn" data-cid="${escAttr(c.id)}" data-active="true" style="margin-left:4px;">Deactivate</button>`
          : `<button class="btn btn-sm btn-danger staff-remove-btn" data-cid="${escAttr(c.id)}" style="margin-left:4px;">Remove</button>`
        : '';

      const actionBtns = `
        <button class="btn btn-sm btn-secondary staff-edit-btn" ${editData}>Edit</button>
        ${statusBtn}`;

      return `<tr style="opacity:${isActive ? '1' : '0.55'};">
        <td ${TD}>${escHtml(name)}${warn}</td>
        <td ${TD}>${roleLabel}</td>
        <td ${TD} style="text-align:center;">${staffNum}</td>
        <td ${TD} style="font-size:0.8125rem;">${title}</td>
        <td ${TD} style="text-align:center;">${counselorToggle}</td>
        <td style="padding:0.5rem 0.75rem;border-bottom:1px solid var(--border);white-space:nowrap;text-align:right;">${actionBtns}</td>
      </tr>`;
    }).join('');

    container.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:0.875rem;">
        <thead><tr style="background:#f8f9fb;">
          <th ${TH}>Name</th>
          <th ${TH}>Role</th>
          <th ${TH} style="text-align:center;">Staff #</th>
          <th ${TH}>Title</th>
          <th ${TH} style="text-align:center;">Counselor</th>
          <th style="padding:0.45rem 0.75rem;border-bottom:2px solid var(--border);"></th>
        </tr></thead>
        <tbody>${bodyRows || '<tr><td colspan="6" style="padding:2rem;text-align:center;color:var(--text-muted);">No staff found.</td></tr>'}</tbody>
      </table>`;

    container.querySelectorAll('.staff-counselor-toggle').forEach(btn =>
      btn.addEventListener('click', () => toggleIsCounselor(btn.dataset.cid, btn.dataset.isCounselor === 'true', btn)));

    container.querySelectorAll('.staff-edit-btn').forEach(btn =>
      btn.addEventListener('click', () => openEditCounselor(
        btn.dataset.cid, btn.dataset.uid, btn.dataset.name, btn.dataset.staffNum,
        btn.dataset.staffTitle, btn.dataset.isCounselor === 'true',
        btn.dataset.baseSalary, btn.dataset.fringe, btn.dataset.role
      )));

    container.querySelectorAll('.staff-toggle-btn').forEach(btn =>
      btn.addEventListener('click', () => toggleCounselor(btn.dataset.cid, btn.dataset.active === 'true', btn)));

    container.querySelectorAll('.staff-remove-btn').forEach(btn =>
      btn.addEventListener('click', () => removeCounselor(btn.dataset.cid, btn)));

  } catch (err) {
    container.innerHTML = `<p class="error-msg">Failed to load: ${err.message}</p>`;
  }
}

// Keep loadCounselors as an alias so other internal callers still work
async function loadCounselors() { await loadStaff(); }

async function addCounselor() {
  const nameEl          = document.getElementById('newCounselorName');
  const staffNumEl      = document.getElementById('newCounselorStaffNum');
  const titleEl         = document.getElementById('newCounselorTitle');
  const isCounselorEl   = document.getElementById('newCounselorIsCounselor');
  const msgEl           = document.getElementById('counselorMsg');
  const btn             = document.getElementById('addCounselorBtn');

  const name = nameEl.value.trim();
  if (!name) { showMsg(msgEl, 'Enter a name.', false); return; }

  const staffNumRaw = staffNumEl.value.trim();
  const staffNum    = staffNumRaw !== '' ? parseInt(staffNumRaw, 10) : null;
  const staffTitle  = titleEl.value.trim();
  const isCounselor = isCounselorEl.checked;

  btn.disabled = true;
  btn.textContent = 'Adding…';
  msgEl.classList.add('hidden');

  try {
    const data = { name, active: true, isCounselor, createdAt: serverTimestamp() };
    if (staffNum != null) data.staffNumber = staffNum;
    if (staffTitle)       data.staffTitle  = staffTitle;

    await addDoc(collection(db, 'counselors'), data);
    nameEl.value            = '';
    staffNumEl.value        = '';
    titleEl.value           = '';
    isCounselorEl.checked   = true;
    await loadStaff();
    showMsg(msgEl, `${name} added.`, true);
  } catch (err) {
    showMsg(msgEl, 'Failed: ' + err.message, false);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add';
  }
}

async function toggleIsCounselor(id, currentlyIs, btn) {
  btn.disabled = true; btn.textContent = '…';
  try {
    await updateDoc(doc(db, 'counselors', id), { isCounselor: !currentlyIs });
    await loadStaff();
  } catch (err) {
    alert('Failed: ' + err.message);
    btn.disabled = false;
    btn.textContent = currentlyIs ? 'Yes' : 'No';
  }
}

async function toggleCounselor(id, currentlyActive, btn) {
  btn.disabled = true; btn.textContent = '…';
  try {
    await updateDoc(doc(db, 'counselors', id), { active: !currentlyActive });
    await loadStaff();
  } catch (err) {
    alert('Failed: ' + err.message);
    btn.disabled = false;
    btn.textContent = currentlyActive ? 'Deactivate' : 'Activate';
  }
}

async function removeCounselor(id, btn) {
  if (!confirm('Remove this staff member? This only removes their staff record — existing session records are not changed.')) return;
  btn.disabled = true; btn.textContent = '…';
  try {
    await deleteDoc(doc(db, 'counselors', id));
    await loadStaff();
  } catch (err) {
    alert('Failed: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Remove';
  }
}

function closeStaffModal() {
  document.getElementById('editCounselorModal').classList.add('hidden');
}

function openEditCounselor(cid, uid, name, staffNum, staffTitle, isCounselor, baseSalary, fringe, role) {
  document.getElementById('editCounselorId').value         = cid || '';
  document.getElementById('editStaffUserId').value         = uid || '';
  document.getElementById('editCounselorName').value       = name || '';
  document.getElementById('editCounselorStaffNum').value   = staffNum || '';
  document.getElementById('editCounselorTitle').value      = staffTitle || '';
  document.getElementById('editCounselorIsCounselor').checked = isCounselor !== false && isCounselor !== 'false';
  document.getElementById('editCounselorBaseSalary').value = baseSalary || '';
  document.getElementById('editCounselorFringe').value     = fringe || '';
  document.getElementById('editCounselorError').classList.add('hidden');
  document.getElementById('editCounselorSaveBtn').disabled    = false;
  document.getElementById('editCounselorSaveBtn').textContent = 'Save';
  document.getElementById('editStaffModalTitle').textContent  = cid ? 'Edit Staff Member' : 'Edit User';

  // Role row — only show if there's a user account
  const roleRow = document.getElementById('editStaffRoleRow');
  const roleSel = document.getElementById('editStaffRole');
  if (uid) {
    roleRow.classList.remove('hidden');
    roleSel.innerHTML = '<option value="">— pending —</option>' +
      ROLE_OPTIONS.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
    if (role) roleSel.value = role;
  } else {
    roleRow.classList.add('hidden');
  }

  document.getElementById('editCounselorModal').classList.remove('hidden');
  document.getElementById('editCounselorName').focus();
}

async function saveEditCounselor() {
  const cid         = document.getElementById('editCounselorId').value;
  const uid         = document.getElementById('editStaffUserId').value;
  const name        = document.getElementById('editCounselorName').value.trim();
  const staffNumRaw = document.getElementById('editCounselorStaffNum').value.trim();
  const staffTitle  = document.getElementById('editCounselorTitle').value.trim();
  const isCounselor = document.getElementById('editCounselorIsCounselor').checked;
  const errorEl     = document.getElementById('editCounselorError');
  const saveBtn     = document.getElementById('editCounselorSaveBtn');

  if (!name) {
    errorEl.textContent = 'Name is required.';
    errorEl.classList.remove('hidden');
    return;
  }

  const staffNum      = staffNumRaw !== '' ? parseInt(staffNumRaw, 10) : null;
  const baseSalaryRaw = document.getElementById('editCounselorBaseSalary').value.trim();
  const fringeRaw     = document.getElementById('editCounselorFringe').value.trim();

  saveBtn.disabled    = true;
  saveBtn.textContent = 'Saving…';
  errorEl.classList.add('hidden');

  try {
    const ops = [];

    // Save counselor/staff fields if they have a counselors doc
    if (cid) {
      const update = {
        name, staffTitle: staffTitle || '', isCounselor, updatedAt: serverTimestamp(),
        staffNumber: staffNum !== null ? staffNum : null,
        baseSalary:  baseSalaryRaw !== '' ? parseFloat(baseSalaryRaw) : null,
        fringe:      fringeRaw     !== '' ? parseFloat(fringeRaw)     : null,
      };
      ops.push(updateDoc(doc(db, 'counselors', cid), update));
    }

    // Save role if user account exists and role field is visible
    const roleRow = document.getElementById('editStaffRoleRow');
    if (uid && !roleRow.classList.contains('hidden')) {
      const role = document.getElementById('editStaffRole').value;
      if (role) ops.push(updateDoc(doc(db, 'users', uid), { role, updatedAt: serverTimestamp() }));
    }

    await Promise.all(ops);
    closeStaffModal();
    await loadStaff();
    await loadPendingUsers();
    showMsg(document.getElementById('staffMsg'), `${name} updated.`, true);
  } catch (err) {
    errorEl.textContent = 'Save failed: ' + err.message;
    errorEl.classList.remove('hidden');
  } finally {
    saveBtn.disabled    = false;
    saveBtn.textContent = 'Save';
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

// ── AMI Normalization ─────────────────────────────────────────────────────────

const CANONICAL_AMI = new Set(['Extremely Low', 'Very Low', 'Low', 'Moderate', 'Non Low-Moderate']);

function resolveAmi(val) {
  if (val == null || val === '') return null;
  if (CANONICAL_AMI.has(val)) return null; // already correct
  // Try numeric / amiCategory first
  const cat = amiCategory(val);
  if (CANONICAL_AMI.has(cat)) return cat;
  // Try the import map (handles ranges like "51-80%")
  const mapped = AMI_IMPORT_MAP[String(val).toLowerCase().trim()];
  if (mapped && CANONICAL_AMI.has(mapped)) return mapped;
  return null; // unknown format — skip
}

let _amiNormDocs = [];

async function scanAmiValues() {
  const btn       = document.getElementById('scanAmiBtn');
  const previewEl = document.getElementById('amiNormPreview');
  btn.disabled    = true;
  btn.textContent = 'Scanning…';
  previewEl.textContent = 'Loading…';

  try {
    const snap = await getDocs(collection(db, 'clients'));
    _amiNormDocs = snap.docs
      .map(d => ({ id: d.id, amiPercent: d.data().amiPercent, clientName: d.data().clientName }))
      .filter(d => resolveAmi(d.amiPercent) !== null)
      .map(d => ({ ...d, normalized: resolveAmi(d.amiPercent) }));

    if (!_amiNormDocs.length) {
      previewEl.innerHTML = '<span style="color:var(--accent);">All AMI values are already using the standard labels.</span>';
      document.getElementById('applyAmiBtn').classList.add('hidden');
    } else {
      const sample = _amiNormDocs.slice(0, 10).map(d =>
        `<li><strong>${escHtml(toTitleCase(d.clientName || ''))}</strong>: <code>${escHtml(String(d.amiPercent))}</code> → <strong>${escHtml(d.normalized)}</strong></li>`
      ).join('');
      previewEl.innerHTML = `
        <p style="margin-bottom:0.5rem;font-weight:600;">${_amiNormDocs.length} client${_amiNormDocs.length !== 1 ? 's' : ''} to update${_amiNormDocs.length > 10 ? ' (showing first 10)' : ''}:</p>
        <ul style="margin:0;padding-left:1.25rem;line-height:1.9;">${sample}</ul>
        ${_amiNormDocs.length > 10 ? `<p style="color:var(--text-muted);margin-top:0.4rem;">…and ${_amiNormDocs.length - 10} more</p>` : ''}`;
      document.getElementById('applyAmiBtn').classList.remove('hidden');
    }
  } catch (err) {
    previewEl.innerHTML = `<span class="error-msg">Scan failed: ${err.message}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Scan Records';
  }
}

async function applyAmiNormalization() {
  if (!_amiNormDocs.length) return;
  if (!confirm(`Normalize AMI values for ${_amiNormDocs.length} client${_amiNormDocs.length !== 1 ? 's' : ''}?`)) return;

  const btn   = document.getElementById('applyAmiBtn');
  const msgEl = document.getElementById('amiNormMsg');
  btn.disabled = true;
  btn.textContent = 'Applying…';
  msgEl.classList.add('hidden');

  try {
    const now = serverTimestamp();
    for (let i = 0; i < _amiNormDocs.length; i += 499) {
      const batch = writeBatch(db);
      _amiNormDocs.slice(i, i + 499).forEach(d => {
        batch.update(doc(db, 'clients', d.id), { amiPercent: d.normalized, updatedAt: now });
      });
      await batch.commit();
    }
    showMsg(msgEl, `Done — ${_amiNormDocs.length} AMI value${_amiNormDocs.length !== 1 ? 's' : ''} normalized.`, true);
    _amiNormDocs = [];
    document.getElementById('amiNormPreview').innerHTML = '<span style="color:var(--accent);">All done. No non-standard AMI values remaining.</span>';
    document.getElementById('applyAmiBtn').classList.add('hidden');
  } catch (err) {
    showMsg(msgEl, 'Failed: ' + err.message, false);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Apply Normalization';
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

    if (!pairs.length) {
      container.innerHTML = '<p style="color:var(--accent);">No potential duplicates found.</p>';
      return;
    }

    const rank = confRank;

    function fmtLastSession(ts) {
      if (!ts) return '—';
      const d = ts.toDate ? ts.toDate() : new Date(ts);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    }

    // Collect unique counselors and types for filter dropdowns
    const allCounselors = [...new Set(
      pairs.flatMap(p => [p.a.counselor, p.b.counselor].filter(Boolean))
    )].sort();
    const allTypes = [...new Set(
      pairs.flatMap(p => [p.a.counselingType, p.b.counselingType].filter(Boolean))
    )].sort();

    const counselorOpts = allCounselors.map(c => `<option value="${escAttr(c)}">${escHtml(c)}</option>`).join('');
    const typeOpts      = allTypes.map(t => `<option value="${escAttr(t)}">${escHtml(t)}</option>`).join('');

    container.innerHTML = `
      <div style="display:flex;gap:0.6rem;flex-wrap:wrap;align-items:flex-end;margin-bottom:0.75rem;padding:0.75rem;background:#f8f9fb;border:1px solid var(--border);border-radius:var(--radius);">
        <div class="form-group" style="margin:0;flex:2;min-width:160px;">
          <label style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-muted);">Search name</label>
          <input type="text" id="dupFilterSearch" placeholder="Type a name…" style="font-size:0.8125rem;">
        </div>
        <div class="form-group" style="margin:0;min-width:140px;">
          <label style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-muted);">Confidence</label>
          <select id="dupFilterConf" style="font-size:0.8125rem;">
            <option value="">All</option>
            <option value="high">Strong match</option>
            <option value="medium">Possible match</option>
            <option value="low">Weak signal</option>
          </select>
        </div>
        <div class="form-group" style="margin:0;min-width:150px;">
          <label style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-muted);">Counselor</label>
          <select id="dupFilterCounselor" style="font-size:0.8125rem;">
            <option value="">All Counselors</option>
            ${counselorOpts}
          </select>
        </div>
        <div class="form-group" style="margin:0;min-width:130px;">
          <label style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-muted);">Type</label>
          <select id="dupFilterType" style="font-size:0.8125rem;">
            <option value="">All Types</option>
            ${typeOpts}
          </select>
        </div>
        <div class="form-group" style="margin:0;min-width:155px;">
          <label style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-muted);">Session Month</label>
          <input type="month" id="dupFilterMonth" style="font-size:0.8125rem;" title="Show only pairs where at least one client has a session in this month">
        </div>
        <div class="form-group" style="margin:0;align-self:flex-end;">
          <button id="dupApplyBtn" class="btn btn-primary btn-sm" style="white-space:nowrap;">Apply Filters</button>
        </div>
        <div class="form-group" style="margin:0;min-width:160px;">
          <label style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-muted);">Sort by</label>
          <select id="dupSort" style="font-size:0.8125rem;">
            <option value="confidence">Confidence (default)</option>
            <option value="sessions">Most sessions first</option>
            <option value="alpha">Alphabetical</option>
          </select>
        </div>
      </div>
      <p id="dupCount" style="margin-bottom:0.75rem;font-weight:600;">${pairs.length} potential duplicate pair${pairs.length !== 1 ? 's' : ''} found:</p>
      <div id="dupPairList" style="display:flex;flex-direction:column;gap:0.75rem;">
        ${pairs.map(({ a, b, reasons, key }) => {
          const topConf = reasons.reduce((best, r) => rank(r) < rank(best) ? r : best, reasons[0]);
          const aName = toTitleCase(a.clientName);
          const bName = toTitleCase(b.clientName);
          const aSessions = a.sessionCount || 0;
          const bSessions = b.sessionCount || 0;
          const totalSessions = aSessions + bSessions;
          // Smart merge: keep whichever has more sessions (or A on tie)
          const smartKeep = bSessions > aSessions ? b : a;
          const smartDrop = bSessions > aSessions ? a : b;
          const smartKeepName = toTitleCase(smartKeep.clientName);
          const smartDropName = toTitleCase(smartDrop.clientName);
          const aCounselors = (a.counselor || '').toLowerCase();
          const bCounselors = (b.counselor || '').toLowerCase();
          return `
          <div class="dup-pair"
            data-key="${escAttr(key)}"
            data-conf="${topConf.confidence}"
            data-names="${escAttr((aName + ' ' + bName).toLowerCase())}"
            data-counselors="${escAttr(aCounselors + ' ' + bCounselors)}"
            data-types="${escAttr(((a.counselingType || '') + ' ' + (b.counselingType || '')).toLowerCase())}"
            data-total-sessions="${totalSessions}"
            data-client-a="${escAttr(a.id)}"
            data-client-b="${escAttr(b.id)}"
            style="border:1px solid var(--border);border-radius:var(--radius);padding:0.9rem 1rem;background:#fff;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap;">
              <div style="flex:1;min-width:200px;">
                <div style="font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-bottom:0.15rem;">A</div>
                <div style="font-weight:600;font-size:0.9rem;">${escHtml(aName)}</div>
                <div style="font-size:0.775rem;color:var(--text-muted);">${escHtml(a.counselingType || '—')} · ${escHtml(a.counselor || '—')}</div>
                <div style="font-size:0.75rem;color:var(--text-muted);margin-top:0.15rem;">${aSessions} session${aSessions !== 1 ? 's' : ''} · Last: ${fmtLastSession(a.lastSessionDate)}</div>
              </div>
              <div style="font-size:0.8rem;color:var(--text-muted);padding:0 0.25rem;align-self:center;">↔</div>
              <div style="flex:1;min-width:200px;">
                <div style="font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-bottom:0.15rem;">B</div>
                <div style="font-weight:600;font-size:0.9rem;">${escHtml(bName)}</div>
                <div style="font-size:0.775rem;color:var(--text-muted);">${escHtml(b.counselingType || '—')} · ${escHtml(b.counselor || '—')}</div>
                <div style="font-size:0.75rem;color:var(--text-muted);margin-top:0.15rem;">${bSessions} session${bSessions !== 1 ? 's' : ''} · Last: ${fmtLastSession(b.lastSessionDate)}</div>
              </div>
              <div style="display:flex;flex-direction:column;gap:0.4rem;align-items:flex-end;flex-shrink:0;">
                <span style="font-size:0.72rem;font-weight:700;color:${confidenceColor[topConf.confidence]};">
                  ${confidenceLabel[topConf.confidence]}
                </span>
                <div style="display:flex;gap:0.4rem;flex-wrap:wrap;justify-content:flex-end;">
                  <a href="client.html?id=${a.id}" target="_blank" class="btn btn-sm btn-secondary" style="font-size:0.75rem;">Open A</a>
                  <a href="client.html?id=${b.id}" target="_blank" class="btn btn-sm btn-secondary" style="font-size:0.75rem;">Open B</a>
                  <button class="btn btn-sm btn-secondary dismiss-pair" data-key="${escAttr(key)}" style="font-size:0.75rem;">Dismiss</button>
                  <button class="btn btn-sm btn-secondary smart-merge-btn"
                    data-keep="${smartKeep.id}" data-drop="${smartDrop.id}"
                    data-keep-name="${escAttr(smartKeepName)}"
                    data-drop-name="${escAttr(smartDropName)}"
                    style="font-size:0.75rem;background:#f0f4ff;border-color:var(--primary);color:var(--primary);"
                    title="Keep the side with more sessions (${escAttr(smartKeepName)})">
                    Smart Merge
                  </button>
                  <button class="btn btn-sm btn-primary merge-btn"
                    data-keep="${a.id}" data-drop="${b.id}"
                    data-keep-name="${escAttr(aName)}"
                    data-drop-name="${escAttr(bName)}"
                    style="font-size:0.75rem;">Keep A</button>
                  <button class="btn btn-sm btn-primary merge-btn"
                    data-keep="${b.id}" data-drop="${a.id}"
                    data-keep-name="${escAttr(bName)}"
                    data-drop-name="${escAttr(aName)}"
                    style="font-size:0.75rem;">Keep B</button>
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

    function updateDupCount() {
      const visible = [...container.querySelectorAll('.dup-pair')].filter(p => p.style.display !== 'none').length;
      const total   = container.querySelectorAll('.dup-pair').length;
      const countEl = document.getElementById('dupCount');
      if (countEl) countEl.textContent = visible === total
        ? `${total} potential duplicate pair${total !== 1 ? 's' : ''} found:`
        : `Showing ${visible} of ${total} pairs:`;
    }

    function sortPairs() {
      const sortVal = document.getElementById('dupSort')?.value || 'confidence';
      const list    = document.getElementById('dupPairList');
      if (!list) return;
      const items = [...list.querySelectorAll('.dup-pair')];
      items.sort((a, b) => {
        if (sortVal === 'sessions') {
          return Number(b.dataset.totalSessions) - Number(a.dataset.totalSessions);
        }
        if (sortVal === 'alpha') {
          return (a.dataset.names || '').localeCompare(b.dataset.names || '');
        }
        // confidence: high=0, medium=1, low=2
        const rankMap = { high: 0, medium: 1, low: 2 };
        return (rankMap[a.dataset.conf] ?? 3) - (rankMap[b.dataset.conf] ?? 3);
      });
      items.forEach(el => list.appendChild(el));
    }

    async function applyDupFilter() {
      const search    = (document.getElementById('dupFilterSearch')?.value || '').toLowerCase();
      const conf      = document.getElementById('dupFilterConf')?.value || '';
      const counselor = (document.getElementById('dupFilterCounselor')?.value || '').toLowerCase();
      const type      = (document.getElementById('dupFilterType')?.value || '').toLowerCase();
      const monthVal  = document.getElementById('dupFilterMonth')?.value || ''; // "YYYY-MM"

      let sessionIds = null; // null = no month filter active
      if (monthVal) {
        if (_sessionMonthCache.has(monthVal)) {
          sessionIds = _sessionMonthCache.get(monthVal);
        } else {
          const [yr, mo] = monthVal.split('-').map(Number);
          try {
            const snap = await getDocs(collectionGroup(db, 'sessions'));
            sessionIds = new Set(
              snap.docs
                .filter(d => {
                  const raw = d.data().date;
                  if (!raw) return false;
                  const dt = raw.toDate ? raw.toDate() : new Date(raw);
                  return dt.getFullYear() === yr && dt.getMonth() === mo - 1;
                })
                .map(d => d.ref.parent.parent.id)
            );
            _sessionMonthCache.set(monthVal, sessionIds);
          } catch (_) {
            sessionIds = null;
          }
        }
      }

      container.querySelectorAll('.dup-pair').forEach(pair => {
        const nameMatch     = !search    || pair.dataset.names.includes(search);
        const confMatch     = !conf      || pair.dataset.conf === conf;
        const counselorMatch = !counselor || pair.dataset.counselors.includes(counselor);
        const typeMatch     = !type      || pair.dataset.types.includes(type);
        const clientA = pair.dataset.clientA || '';
        const clientB = pair.dataset.clientB || '';
        const monthMatch = !sessionIds || !monthVal ||
          (clientA && sessionIds.has(clientA)) || (clientB && sessionIds.has(clientB));
        pair.style.display  = (nameMatch && confMatch && counselorMatch && typeMatch && monthMatch) ? '' : 'none';
      });
      updateDupCount();
    }

    // Sort is instant (no query involved)
    document.getElementById('dupSort').addEventListener('change', () => { sortPairs(); updateDupCount(); });

    // All other filters go through the Apply button
    const applyBtn = document.getElementById('dupApplyBtn');
    applyBtn.addEventListener('click', async () => {
      applyBtn.disabled = true;
      applyBtn.textContent = 'Loading…';
      try {
        await applyDupFilter();
      } finally {
        applyBtn.disabled = false;
        applyBtn.textContent = 'Apply Filters';
      }
    });

    // Initial sort (confidence)
    sortPairs();

    // Wire dismiss buttons
    container.querySelectorAll('.dismiss-pair').forEach(btn => {
      btn.addEventListener('click', () => {
        _dismissedPairs.add(btn.dataset.key);
        btn.closest('.dup-pair').remove();
        updateDupCount();
        const remaining = container.querySelectorAll('.dup-pair').length;
        if (!remaining) {
          document.getElementById('dupPairList').innerHTML = '';
          document.getElementById('dupCount').textContent = 'All pairs dismissed.';
        }
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
        const keptLabel = btn.textContent.trim() === 'Keep A' ? 'A' : 'B';
        const dropLabel = keptLabel === 'A' ? 'B' : 'A';
        document.getElementById('mergeModalDesc').innerHTML =
          `<strong>${escHtml(_pendingMerge.dropName)}</strong> (${dropLabel}) will be merged into <strong>${escHtml(_pendingMerge.keepName)}</strong> (${keptLabel}).<br>
           All sessions from ${dropLabel} will be moved to ${keptLabel}. ${dropLabel} will be permanently deleted.`;
        document.getElementById('mergeModalError').classList.add('hidden');
        document.getElementById('mergeConfirmBtn').disabled = false;
        document.getElementById('mergeConfirmBtn').textContent = 'Merge';
        document.getElementById('mergeModal').classList.remove('hidden');
      });
    });

    // Wire smart-merge buttons
    container.querySelectorAll('.smart-merge-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _pendingMerge = {
          keepId:   btn.dataset.keep,
          dropId:   btn.dataset.drop,
          keepName: btn.dataset.keepName,
          dropName: btn.dataset.dropName,
          pairKey:  btn.closest('.dup-pair').dataset.key,
        };
        document.getElementById('mergeModalDesc').innerHTML =
          `<strong>${escHtml(_pendingMerge.dropName)}</strong> will be merged into <strong>${escHtml(_pendingMerge.keepName)}</strong> (has more sessions).<br>
           All sessions will be moved to the kept record. The other record will be permanently deleted.`;
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
    if (!keepSnap.exists()) throw new Error(`Client "${keepName}" no longer exists — it may have already been merged or deleted. Refresh the page and scan again.`);
    if (!dropSnap.exists()) throw new Error(`Client "${dropName}" no longer exists — it may have already been merged or deleted. Refresh the page and scan again.`);
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

    // Clean up higWaitlist: re-point or remove the dropped client's entry
    const [dropHigSnap, keepHigSnap] = await Promise.all([
      getDocs(query(collection(db, 'higWaitlist'), where('clientId', '==', dropId))),
      getDocs(query(collection(db, 'higWaitlist'), where('clientId', '==', keepId))),
    ]);
    for (const higDoc of dropHigSnap.docs) {
      if (keepHigSnap.size > 0) {
        // keep already has a waitlist entry — just delete the orphaned one
        await deleteDoc(doc(db, 'higWaitlist', higDoc.id));
      } else {
        // keep has no entry — salvage this one by re-pointing it
        await updateDoc(doc(db, 'higWaitlist', higDoc.id), { clientId: keepId, updatedAt: now });
      }
    }

    // Close modal and remove pair from results
    document.getElementById('mergeModal').classList.add('hidden');
    _dismissedPairs.add(pk);
    const pairEl = document.querySelector(`.dup-pair[data-key="${CSS.escape(pk)}"]`);
    if (pairEl) {
      pairEl.remove();
      const countEl = document.getElementById('dupCount');
      if (countEl) {
        const remaining = document.querySelectorAll('.dup-pair').length;
        countEl.textContent = remaining
          ? `${remaining} potential duplicate pair${remaining !== 1 ? 's' : ''} found:`
          : 'All pairs dismissed.';
      }
    }

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

// ── Auto-Link List Records to Client Profiles ────────────────────────────────

// Pending auto-link assignments: [{ collection, docId, clientDocId }]
let _autoLinkPending = [];

function normName(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function scanUnlinkedListRecords() {
  const btn       = document.getElementById('scanUnlinkedBtn');
  const resultEl  = document.getElementById('autoLinkResult');
  const applyBtn  = document.getElementById('applyAutoLinkBtn');
  _autoLinkPending = [];
  applyBtn.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  resultEl.innerHTML = '<p style="color:var(--text-muted);">Loading records…</p>';

  try {
    // Load all clients once for matching
    const clientsSnap = await getDocs(collection(db, 'clients'));
    const clients = clientsSnap.docs.map(d => ({
      id: d.id,
      name: d.data().clientName || '',
      counselor: d.data().counselor || '',
      ami: d.data().ami || '',
      driveFolder: d.data().driveFolder || '',
      driveFolderName: d.data().driveFolderName || '',
    }));

    // Load unlinked ccaList and higWaitlist records
    const [ccaSnap, higSnap] = await Promise.all([
      getDocs(query(collection(db, 'ccaList'), where('clientId', '==', ''))),
      getDocs(query(collection(db, 'higWaitlist'), where('clientId', '==', ''))),
    ]);

    // Also catch docs where clientId field is absent entirely
    const [ccaAllSnap, higAllSnap] = await Promise.all([
      getDocs(collection(db, 'ccaList')),
      getDocs(collection(db, 'higWaitlist')),
    ]);

    const ccaDocs  = ccaAllSnap.docs.filter(d => !d.data().clientId).map(d => ({ col: 'ccaList',     id: d.id, name: d.data().clientName || d.data().name || '', counselor: d.data().counselor || '' }));
    const higDocs  = higAllSnap.docs.filter(d => !d.data().clientId).map(d => ({ col: 'higWaitlist', id: d.id, name: d.data().clientName || d.data().name || '', counselor: d.data().counselor || '' }));
    const unlinked = [...ccaDocs, ...higDocs];

    if (!unlinked.length) {
      resultEl.innerHTML = '<p style="color:var(--accent);font-weight:600;">All records are already linked.</p>';
      return;
    }

    // Match each unlinked record to client(s) by normalized name
    const rows = unlinked.map(rec => {
      const norm   = normName(rec.name);
      const matches = clients.filter(c => normName(c.name) === norm);
      return { rec, matches };
    });

    const autoRows     = rows.filter(r => r.matches.length === 1);
    const multiRows    = rows.filter(r => r.matches.length > 1);
    const noMatchRows  = rows.filter(r => r.matches.length === 0);

    // Pre-fill _autoLinkPending with single-match results
    _autoLinkPending = autoRows.map(r => ({
      collection: r.rec.col,
      docId: r.rec.id,
      clientDocId: r.matches[0].id,
    }));

    // Build preview table
    const listLabel = col => col === 'ccaList' ? 'Buyer Ready' : 'Repair Ready';

    let html = `<p style="margin-bottom:0.75rem;font-size:0.8125rem;">
      Found <strong>${unlinked.length}</strong> unlinked record(s):
      <strong>${autoRows.length}</strong> auto-matched,
      <strong>${multiRows.length}</strong> need manual selection,
      <strong>${noMatchRows.length}</strong> no match found.
    </p>
    <table class="data-table" style="font-size:0.8125rem;">
      <thead><tr>
        <th>List</th><th>Record Name</th><th>Counselor</th><th>Match</th>
      </tr></thead><tbody>`;

    // Auto-matched rows
    autoRows.forEach(({ rec, matches }) => {
      const c = matches[0];
      html += `<tr style="background:#f0faf0;">
        <td>${escHtml(listLabel(rec.col))}</td>
        <td>${escHtml(rec.name)}</td>
        <td style="color:var(--text-muted);">${escHtml(rec.counselor)}</td>
        <td>
          <span style="color:var(--accent);font-weight:600;">Auto → ${escHtml(c.name)}</span>
          <input type="hidden" class="auto-link-row" data-col="${escAttr(rec.col)}" data-doc="${escAttr(rec.id)}" data-client="${escAttr(c.id)}">
        </td>
      </tr>`;
    });

    // Multiple-match rows — show select dropdown
    multiRows.forEach(({ rec, matches }) => {
      const opts = matches.map(c => `<option value="${escAttr(c.id)}">${escHtml(c.name)} (${escHtml(c.counselor)})</option>`).join('');
      html += `<tr>
        <td>${escHtml(listLabel(rec.col))}</td>
        <td>${escHtml(rec.name)}</td>
        <td style="color:var(--text-muted);">${escHtml(rec.counselor)}</td>
        <td>
          <select class="multi-match-select" data-col="${escAttr(rec.col)}" data-doc="${escAttr(rec.id)}" style="font-size:0.8125rem;width:100%;">
            <option value="">— choose —</option>
            ${opts}
          </select>
        </td>
      </tr>`;
    });

    // No-match rows
    noMatchRows.forEach(({ rec }) => {
      html += `<tr style="opacity:0.55;">
        <td>${escHtml(listLabel(rec.col))}</td>
        <td>${escHtml(rec.name)}</td>
        <td style="color:var(--text-muted);">${escHtml(rec.counselor)}</td>
        <td style="color:var(--text-muted);font-style:italic;">No matching client found</td>
      </tr>`;
    });

    html += '</tbody></table>';
    resultEl.innerHTML = html;

    // Wire up multi-match selects to add/update pending
    resultEl.querySelectorAll('.multi-match-select').forEach(sel => {
      sel.addEventListener('change', () => {
        const col    = sel.dataset.col;
        const docId  = sel.dataset.doc;
        const existing = _autoLinkPending.findIndex(p => p.collection === col && p.docId === docId);
        if (sel.value) {
          const entry = { collection: col, docId, clientDocId: sel.value };
          if (existing >= 0) _autoLinkPending[existing] = entry;
          else _autoLinkPending.push(entry);
        } else {
          if (existing >= 0) _autoLinkPending.splice(existing, 1);
        }
      });
    });

    if (_autoLinkPending.length || multiRows.length) {
      applyBtn.classList.remove('hidden');
    }

  } catch (err) {
    resultEl.innerHTML = `<p class="error-msg">Scan failed: ${escHtml(err.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Scan Unlinked Records';
  }
}

async function applyAutoLinks() {
  const btn    = document.getElementById('applyAutoLinkBtn');
  const msgEl  = document.getElementById('autoLinkMsg');
  msgEl.classList.add('hidden');

  if (!_autoLinkPending.length) {
    showMsg(msgEl, 'No confirmed matches to apply.', false);
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Applying…';

  try {
    // Load all client docs we need (deduplicate)
    const clientIds = [...new Set(_autoLinkPending.map(p => p.clientDocId))];
    const clientMap = {};
    await Promise.all(clientIds.map(async id => {
      const snap = await getDoc(doc(db, 'clients', id));
      if (snap.exists()) clientMap[id] = snap.data();
    }));

    const batch = writeBatch(db);
    let count = 0;

    for (const { collection: col, docId, clientDocId } of _autoLinkPending) {
      const c = clientMap[clientDocId];
      if (!c) continue;
      const ref = doc(db, col, docId);
      const update = {
        clientId: clientDocId,
        counselor: c.counselor || '',
        updatedAt: serverTimestamp(),
      };
      // Sync AMI for both lists; sync folder links if present
      if (c.ami)             update.ami             = c.ami;
      if (c.driveFolder)     update.driveFolder     = c.driveFolder;
      if (c.driveFolderName) update.driveFolderName = c.driveFolderName;
      batch.update(ref, update);
      count++;
    }

    await batch.commit();
    _autoLinkPending = [];
    document.getElementById('applyAutoLinkBtn').classList.add('hidden');
    showMsg(msgEl, `Linked ${count} record(s) successfully.`, true);
    // Refresh the scan view to confirm all resolved
    await scanUnlinkedListRecords();

  } catch (err) {
    showMsg(msgEl, 'Apply failed: ' + err.message, false);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Apply Links';
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

// ── Pending Users ─────────────────────────────────────────────────────────────

async function changeUserRole(uid, btn) {
  const sel  = document.querySelector(`.staff-role-sel[data-uid="${uid}"]`);
  const role = sel?.value;
  if (!role) return;

  const msgEl = document.getElementById('staffMsg');
  btn.disabled    = true;
  btn.textContent = 'Saving…';

  try {
    await updateDoc(doc(db, 'users', uid), { role, updatedAt: serverTimestamp() });
    await loadStaff();
    await loadPendingUsers();
    showMsg(msgEl, 'Role updated.', true);
    setTimeout(() => msgEl.classList.add('hidden'), 3000);
  } catch (err) {
    showMsg(msgEl, 'Failed: ' + err.message, false);
    btn.disabled    = false;
    btn.textContent = 'Save';
  }
}

async function loadPendingUsers() {
  const container = document.getElementById('pendingUsersList');
  try {
    const snap = await getDocs(query(collection(db, 'users'), where('role', '==', 'pending')));
    if (snap.empty) {
      container.innerHTML = '<p style="color:var(--text-muted);font-size:0.875rem;">No pending accounts.</p>';
      return;
    }

    const pendingDocs = snap.docs.slice().sort((a, b) => {
      const ta = a.data().createdAt?.toMillis?.() ?? 0;
      const tb = b.data().createdAt?.toMillis?.() ?? 0;
      return ta - tb;
    });

    const rows = pendingDocs.map(d => {
      const u = { id: d.id, ...d.data() };
      const roleOpts = ROLE_OPTIONS.map(o =>
        `<option value="${o.value}">${o.label}</option>`
      ).join('');
      return `<tr>
        <td ${TD}>${escHtml(u.name || u.email || u.id)}</td>
        <td ${TD} style="color:var(--text-muted);font-size:0.8rem;">${escHtml(u.email || '')}</td>
        <td ${TD}>
          <select class="pending-role-sel" data-uid="${escAttr(u.id)}" style="font-size:0.875rem;padding:0.25rem 0.4rem;">
            ${roleOpts}
          </select>
        </td>
        <td ${TD}>
          <button class="btn btn-sm btn-primary promote-btn" data-uid="${escAttr(u.id)}">Approve</button>
        </td>
      </tr>`;
    }).join('');

    container.innerHTML = `
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr>
          <th ${TH}>Name</th><th ${TH}>Email</th><th ${TH}>Assign Role</th><th ${TH}></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;

    container.querySelectorAll('.promote-btn').forEach(btn => {
      btn.addEventListener('click', () => promoteUser(btn.dataset.uid, btn));
    });
  } catch (err) {
    container.innerHTML = `<p style="color:var(--danger);font-size:0.875rem;">Failed to load: ${escHtml(err.message)}</p>`;
  }
}

async function promoteUser(uid, btn) {
  const sel  = document.querySelector(`.pending-role-sel[data-uid="${uid}"]`);
  const role = sel?.value;
  if (!role) return;

  const msgEl = document.getElementById('pendingUsersMsg');
  btn.disabled    = true;
  btn.textContent = 'Saving…';

  try {
    await updateDoc(doc(db, 'users', uid), { role, updatedAt: serverTimestamp() });
    msgEl.textContent = 'User approved.';
    msgEl.style.color = 'var(--accent)';
    msgEl.classList.remove('hidden');
    await loadPendingUsers();
  } catch (err) {
    msgEl.textContent = 'Failed: ' + err.message;
    msgEl.style.color = 'var(--danger)';
    msgEl.classList.remove('hidden');
    btn.disabled    = false;
    btn.textContent = 'Approve';
  }
}

// ── Demo Mode Passcode ────────────────────────────────────────────────────────

async function loadDemoPasscode() {
  try {
    const snap = await getDoc(doc(db, 'config', 'demo'));
    if (snap.exists() && snap.data().passcode) {
      document.getElementById('demoPasscodeField').value = snap.data().passcode;
    }
  } catch (_) {}
}

async function saveDemoPasscode() {
  const btn    = document.getElementById('saveDemoPasscodeBtn');
  const msgEl  = document.getElementById('demoPasscodeMsg');
  const val    = document.getElementById('demoPasscodeField').value.trim();

  msgEl.classList.add('hidden');

  if (!val) {
    showMsg(msgEl, 'Please enter a passcode.', false);
    return;
  }

  btn.disabled    = true;
  btn.textContent = 'Saving…';

  try {
    await setDoc(doc(db, 'config', 'demo'), { passcode: val }, { merge: true });
    showMsg(msgEl, 'Passcode saved.', true);
  } catch (err) {
    showMsg(msgEl, 'Failed: ' + err.message, false);
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Save Passcode';
  }
}

// ── Migrate counselingType from client docs to sessions ───────────────────────

async function backfillNofaHudEvents() {
  const btn   = document.getElementById('backfillNofaHudBtn');
  const msgEl = document.getElementById('backfillNofaHudMsg');
  btn.disabled = true;
  btn.textContent = 'Running…';
  msgEl.textContent = '';

  try {
    // Build counselor name → doc ID map
    const counselorSnap = await getDocs(collection(db, 'counselors'));
    const nameToId = new Map(
      counselorSnap.docs.map(d => [(d.data().name || '').trim().toLowerCase(), d.id])
    );

    // Find all NOFA rxNumbers across all clients (filter in JS to avoid index requirement)
    const rxSnap = await getDocs(collectionGroup(db, 'rxNumbers'));

    // Group active NOFA rx by clientId (keep first active one per client)
    const nofaByClient = new Map();
    rxSnap.docs.forEach(d => {
      const data = d.data();
      if (data.guarantor !== 'NOFA') return;
      if (data.active === false) return;
      const clientId = d.ref.parent.parent.id;
      if (!nofaByClient.has(clientId)) nofaByClient.set(clientId, data);
    });

    let created = 0, skipped = 0;
    let batch = writeBatch(db);
    let batchCount = 0;

    const commit = async () => {
      if (batchCount > 0) { await batch.commit(); batch = writeBatch(db); batchCount = 0; }
    };

    for (const [clientId, rxData] of nofaByClient) {
      const sessSnap = await getDocs(
        query(collection(db, 'clients', clientId, 'sessions'), orderBy('date', 'asc'))
      );

      // Also load client name
      const clientDoc  = await getDoc(doc(db, 'clients', clientId));
      const clientName = clientDoc.exists() ? (clientDoc.data().clientName || '') : '';

      for (const sessDoc of sessSnap.docs) {
        const s = sessDoc.data();
        // Skip if already linked
        if (s.hudEventId) { skipped++; continue; }
        // Skip if no date (can't determine month)
        if (!s.date) { skipped++; continue; }

        // date may be a Firestore Timestamp or a 'YYYY-MM-DD' string
        const dateStr = s.date.toDate
          ? s.date.toDate().toISOString().split('T')[0]
          : String(s.date);

        const counselorDocId = nameToId.get((s.counselor || '').trim().toLowerCase()) || '';
        const month          = dateStr.substring(0, 7);

        // Create hudEvent doc ref manually so we can cross-reference
        const hudRef = doc(collection(db, 'hudEvents'));
        batch.set(hudRef, {
          source:          'session',
          sessionId:       sessDoc.id,
          clientId,
          clientName,
          rxCaseNo:        rxData.rxNumber   || '',
          guarantor:       'NOFA',
          counselorId:     counselorDocId,
          counselorName:   s.counselor       || '',
          date:            dateStr,
          month,
          durationMinutes: Math.round((Number(s.hours) || 0) * 60),
          type:            'counseling_session',
          parSection:      'S1',
          parRow:          'Counseling',
          createdAt:       serverTimestamp(),
        });
        // Store back-reference on session
        batch.update(sessDoc.ref, { hudEventId: hudRef.id });
        created++;
        batchCount += 2;
        if (batchCount >= 400) await commit();
      }
    }
    await commit();

    showMsg(msgEl, `Done — ${created} HUD entr${created !== 1 ? 'ies' : 'y'} created, ${skipped} skipped.`, true);
  } catch (err) {
    showMsg(msgEl, 'Failed: ' + err.message, false);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run Backfill';
  }
}

async function repairHudCounselorIds() {
  const btn   = document.getElementById('repairHudCounselorIdsBtn');
  const msgEl = document.getElementById('repairHudCounselorIdsMsg');
  btn.disabled = true;
  btn.textContent = 'Repairing…';
  msgEl.textContent = '';

  try {
    // Build name → counselor doc ID map
    const counselorSnap = await getDocs(collection(db, 'counselors'));
    const nameToId = new Map(
      counselorSnap.docs
        .filter(d => d.data().active !== false)
        .map(d => [( d.data().name || '').trim().toLowerCase(), d.id])
    );

    if (!nameToId.size) {
      showMsg(msgEl, 'No active counselors found.', false);
      return;
    }

    let fixed = 0, skipped = 0;
    let batch = writeBatch(db);
    let batchCount = 0;

    const commit = async () => {
      if (batchCount > 0) { await batch.commit(); batch = writeBatch(db); batchCount = 0; }
    };

    for (const colName of ['hudTimeEntries', 'hudEvents']) {
      const snap = await getDocs(collection(db, colName));
      for (const d of snap.docs) {
        const data         = d.data();
        const name         = (data.counselorName || '').trim().toLowerCase();
        const correctId    = nameToId.get(name);
        if (!correctId || data.counselorId === correctId) { skipped++; continue; }
        batch.update(d.ref, { counselorId: correctId });
        fixed++;
        batchCount++;
        if (batchCount >= 400) await commit();
      }
    }
    await commit();

    showMsg(msgEl, `Done — ${fixed} entr${fixed !== 1 ? 'ies' : 'y'} repaired, ${skipped} already correct or unmatched.`, true);
  } catch (err) {
    showMsg(msgEl, 'Failed: ' + err.message, false);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run Repair';
  }
}

async function migrateCounselingTypes() {
  const btn   = document.getElementById('migrateCounselingTypeBtn');
  const msgEl = document.getElementById('migrateCounselingTypeMsg');
  btn.disabled = true;
  btn.textContent = 'Migrating…';

  try {
    const clientSnap = await getDocs(collection(db, 'clients'));
    const clients = clientSnap.docs.filter(d => d.data().counselingType);

    let updated = 0;
    let skipped = 0;
    let batch = writeBatch(db);
    let batchCount = 0;

    for (const clientDoc of clients) {
      const type = clientDoc.data().counselingType;
      const sessSnap = await getDocs(collection(db, 'clients', clientDoc.id, 'sessions'));
      for (const sessDoc of sessSnap.docs) {
        if (!sessDoc.data().counselingType) {
          batch.update(sessDoc.ref, { counselingType: type });
          updated++;
          batchCount++;
          if (batchCount >= 400) {
            await batch.commit();
            batch = writeBatch(db);
            batchCount = 0;
          }
        } else {
          skipped++;
        }
      }
    }
    if (batchCount > 0) await batch.commit();

    showMsg(msgEl, `Done — ${updated} session${updated !== 1 ? 's' : ''} updated, ${skipped} already had a type.`, true);
  } catch (err) {
    showMsg(msgEl, 'Failed: ' + err.message, false);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run Migration';
  }
}

// ── Legacy Counseling Log ──────────────────────────────────────────────────────

let _legacyLogRows = [];

async function loadLegacyCounselingLog() {
  const resultEl = document.getElementById('legacyLogResult');
  const btn = document.getElementById('loadLegacyLogBtn');
  btn.disabled = true;
  resultEl.innerHTML = '<p style="color:var(--text-muted);">Loading…</p>';
  try {
    const snap = await getDocs(query(collection(db, 'counselingLog'), orderBy('date', 'desc')));
    if (snap.empty) {
      resultEl.innerHTML = '<p style="color:var(--text-muted);">No legacy records found.</p>';
      _legacyLogRows = [];
      return;
    }
    _legacyLogRows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderLegacyLog(_legacyLogRows);
  } catch (err) {
    resultEl.innerHTML = `<p style="color:#c62828;">Failed to load: ${escHtml(err.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
}

function filterLegacyLog() {
  if (!_legacyLogRows.length) return;
  const q = (document.getElementById('legacyLogSearch').value || '').toLowerCase().trim();
  const filtered = q
    ? _legacyLogRows.filter(r =>
        (r.clientName || '').toLowerCase().includes(q) ||
        (r.rxCaseNo || r.rxNumber || '').toLowerCase().includes(q) ||
        (r.counselor || '').toLowerCase().includes(q)
      )
    : _legacyLogRows;
  renderLegacyLog(filtered);
}

function renderLegacyLog(rows) {
  const resultEl = document.getElementById('legacyLogResult');
  const fmtDate = ts => {
    if (!ts) return '—';
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };
  resultEl.innerHTML = `
    <p style="color:var(--text-muted);margin-bottom:0.5rem;">${rows.length} record${rows.length !== 1 ? 's' : ''}</p>
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:0.8125rem;">
        <thead>
          <tr style="background:#f8f9fb;">
            <th ${TH}>Date</th>
            <th ${TH}>Client Name</th>
            <th ${TH}>Rx / Case No.</th>
            <th ${TH}>Counselor</th>
            <th ${TH}>Type</th>
            <th ${TH}>Notes</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr style="border-bottom:1px solid var(--border);">
              <td ${TD}>${fmtDate(r.date)}</td>
              <td ${TD}>${escHtml(r.clientName || '—')}</td>
              <td ${TD}>${escHtml(r.rxCaseNo || r.rxNumber || '—')}</td>
              <td ${TD}>${escHtml(r.counselor || '—')}</td>
              <td ${TD}>${escHtml(r.counselingType || r.type || '—')}</td>
              <td ${TD} style="max-width:260px;white-space:pre-wrap;">${escHtml(r.notes || r.description || '—')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}
