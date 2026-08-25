import { db } from './firebase-config.js';
import { requireAuth, setupNav } from './auth.js?v=2';
import {
  collection, doc, addDoc, getDoc, getDocs, updateDoc,
  query, orderBy, where, serverTimestamp, Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ── State ─────────────────────────────────────────────────────────────────────
let _workshops  = [];   // list of workshop docs {id, ...data}
let _registrants = [];  // all regs for current workshop
let _currentWs  = null; // current workshop data
let _currentId  = null; // current workshop id
let _user       = null;

// ── Boot ──────────────────────────────────────────────────────────────────────
requireAuth(async (user, profile) => {
  _user = user;
  setupNav(profile, 'workshops');
  initTabs();
  initNewWsForm();
  addDefaultLocation();
  await loadWorkshopList();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function qs(sel) { return document.querySelector(sel); }
function escHtml(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function formatDate(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatShort(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Tab system ────────────────────────────────────────────────────────────────
function initTabs() {
  document.addEventListener('click', e => {
    const tab = e.target.closest('.ws-tab');
    if (!tab) return;
    const tabId = tab.dataset.tab;
    document.querySelectorAll('.ws-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabId));
    document.querySelectorAll('.ws-panel').forEach(p => {
      const active = p.id === `panel${capitalize(tabId)}`;
      p.classList.toggle('active', active);
      p.style.display = active ? '' : 'none';
    });
  });
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function showTab(tabId) {
  document.querySelectorAll('.ws-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabId));
  document.querySelectorAll('.ws-panel').forEach(p => {
    const active = p.id === `panel${capitalize(tabId)}`;
    p.classList.toggle('active', active);
    p.style.display = active ? '' : 'none';
  });
}

// ── Workshop list ─────────────────────────────────────────────────────────────
async function loadWorkshopList() {
  const snap = await getDocs(query(collection(db, 'workshops'), orderBy('createdAt', 'desc')));
  _workshops = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderWorkshopSelect();

  // Show tabs area — at minimum for creating new workshop
  qs('#wsTabsNew').style.display = 'flex';
  showTab('new');
  qs('#panelNew').style.display = '';

  if (_workshops.length > 0) {
    qs('#wsTabs').style.display = 'flex';
    qs('#wsTabsNew').style.display = 'none';
    selectWorkshop(_workshops[0].id);
  }
}

function renderWorkshopSelect() {
  const sel = qs('#workshopSelect');
  const opts = _workshops.map(w =>
    `<option value="${w.id}">${escHtml(w.title || 'Untitled')} — ${formatShort(w.date)}</option>`
  ).join('');
  sel.innerHTML = `<option value="">— Select a workshop —</option>${opts}`;
  sel.addEventListener('change', () => {
    if (sel.value) selectWorkshop(sel.value);
  });
}

async function selectWorkshop(id) {
  _currentId = id;
  qs('#workshopSelect').value = id;

  const snap = await getDoc(doc(db, 'workshops', id));
  if (!snap.exists()) return;
  _currentWs = snap.data();

  renderSeatCards(_currentWs);
  renderShareLink(id);
  renderStatusChip(_currentWs);
  populateLocationFilters(_currentWs);
  await loadRegistrants(id);
  renderWorkshopChrome(_currentWs);

  qs('#wsTabs').style.display = 'flex';
  qs('#wsTabsNew').style.display = 'none';

  // Show/hide raffle tab
  qs('#raffleTabBtn').style.display = _currentWs.hasRaffle ? '' : 'none';
  qs('#raffleTh').style.display = _currentWs.hasRaffle ? '' : 'none';
  qs('#mortgageTh').style.display = _currentWs.askMortgage ? '' : 'none';
  qs('#raffleFilterWrap').style.display = _currentWs.hasRaffle ? '' : 'none';

  showTab('registrants');
  qs('#panelRegistrants').style.display = '';
  qs('#seatCards').style.display = '';
  qs('#shareLinkRow').style.display = '';
}

function renderWorkshopChrome(ws) {
  const toggleBtn = qs('#toggleActiveBtn');
  toggleBtn.style.display = '';
  toggleBtn.textContent = ws.active ? 'Close Registration' : 'Reopen Registration';
  toggleBtn.className = ws.active ? 'btn btn-sm btn-secondary' : 'btn btn-sm btn-primary';
  toggleBtn.onclick = () => toggleActive(ws.active);
}

async function toggleActive(currentlyActive) {
  await updateDoc(doc(db, 'workshops', _currentId), { active: !currentlyActive });
  await selectWorkshop(_currentId);
}

// ── Seat cards ────────────────────────────────────────────────────────────────
function renderSeatCards(ws) {
  const locs = ws.locations || [];
  const container = qs('#seatCards');
  if (!locs.length) { container.innerHTML = ''; return; }

  const totalCap = locs.reduce((s, l) => s + (l.cap || 0), 0);
  const totalFilled = locs.reduce((s, l) => s + (l.seatCount || 0), 0);

  container.innerHTML = locs.map(loc => {
    const filled = loc.seatCount || 0;
    const cap = loc.cap || 0;
    const pct = cap ? Math.round((filled / cap) * 100) : 0;
    const full = filled >= cap;
    return `<div class="seat-card${full ? ' full' : ''}">
      <div class="seat-card-name">${escHtml(loc.label)}</div>
      <div class="seat-card-count">${filled} / ${cap}</div>
      <div class="seat-card-sub">${pct}% full${full ? ' — FULL' : ''}</div>
    </div>`;
  }).join('') + `
    <div class="seat-card">
      <div class="seat-card-name">Total</div>
      <div class="seat-card-count">${totalFilled} / ${totalCap}</div>
      <div class="seat-card-sub">All locations</div>
    </div>`;
}

// ── Share link ────────────────────────────────────────────────────────────────
function renderShareLink(id) {
  const base = `${location.origin}${location.pathname.replace('workshop-admin.html', '')}`;
  const link = `${base}workshop-registration.html?w=${id}`;
  qs('#shareLinkInput').value = link;
  qs('#copyLinkBtn').onclick = () => {
    navigator.clipboard.writeText(link).then(() => {
      qs('#copyLinkBtn').textContent = 'Copied!';
      setTimeout(() => { qs('#copyLinkBtn').textContent = 'Copy link'; }, 1800);
    });
  };
}

// ── Status chip ───────────────────────────────────────────────────────────────
function renderStatusChip(ws) {
  const chip = qs('#wsStatusChip');
  chip.style.display = '';
  chip.textContent = ws.active ? 'Open' : 'Closed';
  chip.className = `ws-status ${ws.active ? 'open' : 'closed'}`;
}

// ── Location filters ──────────────────────────────────────────────────────────
function populateLocationFilters(ws) {
  const locs = ws.locations || [];
  const opts = locs.map(l => `<option value="${l.id}">${escHtml(l.label)}</option>`).join('');
  const allOpt = '<option value="">All locations</option>';
  qs('#filterLocation').innerHTML = allOpt + opts;
  qs('#raffleLocation').innerHTML = allOpt + opts;
}

// ── Registrants ───────────────────────────────────────────────────────────────
async function loadRegistrants(workshopId) {
  const snap = await getDocs(
    query(collection(db, 'workshopRegistrations'),
      where('workshopId', '==', workshopId),
      orderBy('createdAt', 'asc'))
  );
  _registrants = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderRegistrants();
  setupRegFilters();
}

function renderRegistrants() {
  const ws = _currentWs;
  const locFilter = qs('#filterLocation').value;
  const search = (qs('#searchReg').value || '').toLowerCase().trim();
  const raffleFilter = qs('#filterRaffle').value;

  let rows = _registrants;
  if (locFilter) rows = rows.filter(r => r.locationId === locFilter);
  if (search) rows = rows.filter(r => {
    const full = `${r.firstName} ${r.lastName} ${r.email} ${r.city}`.toLowerCase();
    return full.includes(search);
  });
  if (raffleFilter === '1') rows = rows.filter(r => r.raffleEntry);

  const locs = ws.locations || [];
  const locMap = Object.fromEntries(locs.map(l => [l.id, l.label]));

  const tbody = qs('#regTableBody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--text-muted);padding:2rem;">No registrants found.</td></tr>`;
    qs('#regCount').textContent = '';
    return;
  }

  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${escHtml(r.firstName)} ${escHtml(r.lastName)}</td>
      <td>${escHtml(r.email)}</td>
      <td>${escHtml(r.phone)}</td>
      <td>${escHtml(r.city)}</td>
      <td>${escHtml(locMap[r.locationId] || r.locationId)}</td>
      ${ws.askMortgage ? `<td>${r.hasMortgage ? `<span class="mortgage-chip">${escHtml(r.hasMortgage)}</span>` : '—'}</td>` : ''}
      ${ws.hasRaffle ? `<td>${r.raffleEntry ? '<span class="raffle-chip">Entered</span>' : '—'}</td>` : ''}
      <td>${formatShort(r.createdAt)}</td>
    </tr>`).join('');

  qs('#regCount').textContent = `Showing ${rows.length} of ${_registrants.length} registrant${_registrants.length === 1 ? '' : 's'}`;
}

function setupRegFilters() {
  ['filterLocation', 'filterRaffle'].forEach(id => {
    const el = qs(`#${id}`);
    if (el) el.addEventListener('change', renderRegistrants);
  });
  qs('#searchReg').addEventListener('input', renderRegistrants);
  qs('#exportCsvBtn').addEventListener('click', exportCsv);
}

// ── CSV export ────────────────────────────────────────────────────────────────
function exportCsv() {
  const ws = _currentWs;
  const locs = ws.locations || [];
  const locMap = Object.fromEntries(locs.map(l => [l.id, l.label]));

  const headers = ['First Name', 'Last Name', 'Email', 'Phone', 'City', 'Location', 'Registered'];
  if (ws.askMortgage) headers.push('Has Mortgage?');
  if (ws.hasRaffle) headers.push('Raffle Entry?');

  const rows = _registrants.map(r => {
    const row = [
      r.firstName, r.lastName, r.email, r.phone, r.city,
      locMap[r.locationId] || r.locationId,
      r.createdAt ? (r.createdAt.toDate ? r.createdAt.toDate().toISOString() : r.createdAt) : '',
    ];
    if (ws.askMortgage) row.push(r.hasMortgage || '');
    if (ws.hasRaffle) row.push(r.raffleEntry ? 'Yes' : 'No');
    return row;
  });

  const csv = [headers, ...rows].map(r =>
    r.map(cell => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')
  ).join('\r\n');

  // Build blob and trigger download via anchor click
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const safe = (ws.title || 'Workshop').replace(/[^a-z0-9]/gi, '_');
  a.download = `${safe}_Registrants.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Raffle ────────────────────────────────────────────────────────────────────
qs('#drawWinnerBtn')?.addEventListener('click', drawRaffleWinner);

function drawRaffleWinner() {
  const locFilter = qs('#raffleLocation').value;
  const ws = _currentWs;
  if (!ws) return;

  let pool = _registrants.filter(r => r.raffleEntry);
  if (locFilter) pool = pool.filter(r => r.locationId === locFilter);

  const result = qs('#raffleResult');
  if (!pool.length) {
    result.innerHTML = '<span class="raffle-empty">No raffle entries for the selected location.</span>';
    return;
  }

  // Shuffle and pick — use Math.random (acceptable here: display-only, not stored)
  const winner = pool[Math.floor(Math.random() * pool.length)];
  const locs = ws.locations || [];
  const locMap = Object.fromEntries(locs.map(l => [l.id, l.label]));

  result.innerHTML = `
    <div class="raffle-winner-name">🎉 ${escHtml(winner.firstName)} ${escHtml(winner.lastName)}</div>
    <div class="raffle-winner-meta">${escHtml(winner.city)} &bull; ${escHtml(locMap[winner.locationId] || winner.locationId)}</div>
    <div class="raffle-winner-meta" style="margin-top:0.3rem;">${escHtml(winner.email)} &bull; ${escHtml(winner.phone)}</div>`;
}

// ── New workshop form ─────────────────────────────────────────────────────────
let _locCount = 0;

function initNewWsForm() {
  qs('#addLocBtn').addEventListener('click', addLocationRow);
  qs('#newWsForm').addEventListener('submit', createWorkshop);
}

function addDefaultLocation() {
  addLocationRow('Mercer County', 60);
  addLocationRow('Lawrence County', 60);
  addLocationRow('Virtual', 999);
}

function addLocationRow(labelVal = '', capVal = 60) {
  const id = `locRow_${_locCount++}`;
  const div = document.createElement('div');
  div.className = 'loc-row';
  div.id = id;
  div.innerHTML = `
    <input type="text" class="loc-name-input" placeholder="Location name" value="${escHtml(labelVal)}" required>
    <input type="number" class="loc-cap-input" placeholder="Cap" min="1" value="${capVal}" required>
    <button type="button" class="btn-loc-del" title="Remove" onclick="this.closest('.loc-row').remove()">×</button>`;
  qs('#locBuilder').appendChild(div);
}

async function createWorkshop(e) {
  e.preventDefault();
  const title = qs('#nwTitle').value.trim();
  if (!title) { alert('Please enter a title.'); return; }
  const dateStr = qs('#nwDate').value;
  if (!dateStr) { alert('Please enter a date.'); return; }

  const locRows = document.querySelectorAll('.loc-row');
  const locations = [];
  let locError = false;
  locRows.forEach((row, i) => {
    const label = row.querySelector('.loc-name-input').value.trim();
    const cap   = parseInt(row.querySelector('.loc-cap-input').value, 10);
    if (!label || isNaN(cap)) { locError = true; return; }
    locations.push({ id: `loc${i}`, label, cap, seatCount: 0 });
  });
  if (locError || !locations.length) { alert('Please fill in all location fields.'); return; }

  const btn = qs('#createWsBtn');
  btn.disabled = true;
  qs('#nwStatus').textContent = 'Creating…';

  try {
    const ref = await addDoc(collection(db, 'workshops'), {
      title,
      subtitle: qs('#nwSubtitle').value.trim(),
      date: Timestamp.fromDate(new Date(dateStr)),
      locations,
      hasRaffle: qs('#nwHasRaffle').checked,
      askMortgage: qs('#nwAskMortgage').checked,
      active: true,
      createdAt: serverTimestamp(),
      createdBy: _user?.displayName || _user?.email || 'Unknown',
    });

    qs('#nwStatus').textContent = '✓ Workshop created!';
    qs('#newWsForm').reset();
    qs('#locBuilder').innerHTML = '';
    _locCount = 0;
    addDefaultLocation();
    btn.disabled = false;

    await loadWorkshopList();
    selectWorkshop(ref.id);
  } catch (err) {
    btn.disabled = false;
    qs('#nwStatus').textContent = 'Error: ' + err.message;
  }
}
