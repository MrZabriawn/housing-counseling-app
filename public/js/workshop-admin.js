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

// Sessions bridge state
let _clients            = [];    // { id, clientName, email } — loaded once on first Sessions tab open
let _clientsLoaded      = false;
let _sessionMatches     = [];    // { reg, status, clientId, clientName } per registrant
let _sessionCounselors  = [];    // counselor names for sessions dropdown
let _sessionCounsLoaded = false;

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
    if (tabId === 'sessions') loadSessionsTab();
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

  try {
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

    renderBannerSection(_currentWs);
    qs('#bannerCard').style.display = '';
  } catch (err) {
    console.error('selectWorkshop error:', err);
    alert('Could not load workshop: ' + err.message);
  }
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
  // No orderBy here — combining where + orderBy on different fields requires
  // a composite index. Sort client-side instead to avoid that dependency.
  const snap = await getDocs(
    query(collection(db, 'workshopRegistrations'),
      where('workshopId', '==', workshopId))
  );
  _registrants = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => {
      const at = a.createdAt?.toMillis?.() ?? 0;
      const bt = b.createdAt?.toMillis?.() ?? 0;
      return at - bt;
    });
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

// ── Banner image ──────────────────────────────────────────────────────────────

function renderBannerSection(ws) {
  const preview = qs('#bannerPreview');
  const status  = qs('#bannerStatus');

  if (ws.bannerImageUrl) {
    preview.src = ws.bannerImageUrl;
    preview.style.display = '';
    status.textContent = 'Image uploaded. Pick a new file to replace it.';
  } else {
    preview.style.display = 'none';
    preview.src = '';
    status.textContent = 'No banner image yet.';
  }

  // Pre-fill share image URL field
  qs('#shareImageUrl').value = ws.shareImageUrl || '';
  qs('#shareImageStatus').textContent = '';

  // Wire file input (re-wire each time a workshop is selected)
  const input = qs('#bannerUploadInput');
  const newInput = input.cloneNode(true);
  input.parentNode.replaceChild(newInput, input);
  newInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) handleBannerUpload(file);
  });

  // Wire share image save button (re-wire each time)
  const saveBtn = qs('#saveShareImageBtn');
  const newBtn = saveBtn.cloneNode(true);
  saveBtn.parentNode.replaceChild(newBtn, saveBtn);
  newBtn.addEventListener('click', saveShareImageUrl);
}

async function handleBannerUpload(file) {
  const status  = qs('#bannerStatus');
  const preview = qs('#bannerPreview');

  if (!file.type.startsWith('image/')) {
    status.textContent = 'Please choose an image file.';
    return;
  }

  // Compress client-side before uploading — canvas scales down and re-encodes
  // as JPEG regardless of the original format or file size.
  status.textContent = 'Compressing…';
  let blob;
  try {
    blob = await compressImage(file, 1400, 500, 0.85);
  } catch (_) {
    blob = file; // fall back to raw file if canvas fails (shouldn't happen)
  }

  const sizeMB = (blob.size / (1024 * 1024)).toFixed(1);
  status.textContent = `Uploading (${sizeMB} MB)…`;

  try {
    const { ref, uploadBytes, getDownloadURL } = await import(
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js'
    );
    const { storage } = await import('./firebase-config.js');

    // Always .jpg — canvas.toBlob outputs JPEG
    const storageRef = ref(storage, `workshop-banners/${_currentId}/banner.jpg`);
    await uploadBytes(storageRef, blob, { contentType: 'image/jpeg' });
    const downloadUrl = await getDownloadURL(storageRef);

    await updateDoc(doc(db, 'workshops', _currentId), { bannerImageUrl: downloadUrl });
    _currentWs.bannerImageUrl = downloadUrl;

    preview.src = downloadUrl;
    preview.style.display = '';
    status.textContent = '✓ Banner saved!';
  } catch (err) {
    status.textContent = 'Upload failed: ' + err.message;
  }
}

// Compress an image file to a JPEG blob, scaled to fit within maxW × maxH.
// Uses the browser Canvas API — no external libraries.
function compressImage(file, maxW, maxH, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.naturalWidth, h = img.naturalHeight;
      // Scale down proportionally to fit within the max dimensions
      if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
      if (h > maxH) { w = Math.round(w * maxH / h); h = maxH; }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob(
        b => (b ? resolve(b) : reject(new Error('Compression failed'))),
        'image/jpeg',
        quality
      );
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not load image')); };
    img.src = url;
  });
}

async function saveShareImageUrl() {
  const url = qs('#shareImageUrl').value.trim();
  const statusEl = qs('#shareImageStatus');
  statusEl.textContent = 'Saving…';
  try {
    await updateDoc(doc(db, 'workshops', _currentId), { shareImageUrl: url });
    _currentWs.shareImageUrl = url;
    statusEl.textContent = url ? '✓ Saved! Facebook/LinkedIn will use this image.' : '✓ Cleared.';
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
  }
}

// ── Sessions bridge ────────────────────────────────────────────────────────────
// Pulls registrants from workshopRegistrations, auto-matches by email to
// existing client profiles, and bulk-creates session records for the workshop.

async function loadSessionsTab() {
  const tableEl  = qs('#sessionMatchTable');
  const statusEl = qs('#sessionsStatus');
  statusEl.textContent = '';
  statusEl.style.color = '';
  tableEl.innerHTML = '<p style="font-size:0.875rem;color:var(--text-muted);">Loading…</p>';

  // Load counselors once into the dropdown
  if (!_sessionCounsLoaded) {
    try {
      const snap = await getDocs(query(collection(db, 'counselors'), orderBy('name')));
      const sel  = qs('#sessionsCounselor');
      snap.docs
        .filter(d => d.data().active !== false && d.data().isCounselor !== false)
        .forEach(d => {
          const name = d.data().name || '';
          _sessionCounselors.push(name);
          const o = document.createElement('option');
          o.value = o.textContent = name;
          sel.appendChild(o);
        });
      _sessionCounsLoaded = true;
    } catch (_) {}
  }

  // Pre-fill date from the workshop's own date field
  if (_currentWs?.date) {
    const d = _currentWs.date.toDate ? _currentWs.date.toDate() : new Date(_currentWs.date);
    qs('#sessionsDate').value = d.toISOString().split('T')[0];
  }

  // Load all clients once for email matching
  if (!_clientsLoaded) {
    try {
      const snap = await getDocs(collection(db, 'clients'));
      _clients = snap.docs.map(d => ({
        id:         d.id,
        clientName: d.data().clientName || '',
        email:      (d.data().email || '').toLowerCase().trim(),
      }));
      _clientsLoaded = true;
    } catch (_) {}
  }

  buildSessionMatches();
  renderSessionMatches();
  qs('#createSessionsBtn').onclick = createSessionRecords;
}

function buildSessionMatches() {
  // Build email → client map for fast lookup
  const emailMap = {};
  _clients.forEach(c => { if (c.email) emailMap[c.email] = c; });

  _sessionMatches = _registrants.map(r => {
    if (r.sessionCreated) {
      return { reg: r, status: 'created', clientId: r.sessionClientId || null, clientName: r.sessionClientName || '' };
    }
    const email = (r.email || '').toLowerCase().trim();
    const match = email ? emailMap[email] : null;
    if (match) {
      return { reg: r, status: 'matched', clientId: match.id, clientName: match.clientName };
    }
    return { reg: r, status: 'unmatched', clientId: null, clientName: null };
  });
}

function renderSessionMatches() {
  const locs   = _currentWs?.locations || [];
  const locMap = Object.fromEntries(locs.map(l => [l.id, l.label]));

  const total   = _sessionMatches.length;
  const created = _sessionMatches.filter(m => m.status === 'created').length;
  const pending = total - created;

  // Build client option list once (sorted by name)
  const sortedClients = _clients.slice().sort((a, b) => a.clientName.localeCompare(b.clientName));
  const clientOpts = sortedClients
    .map(c => `<option value="${escHtml(c.id)}">${escHtml(c.clientName)}</option>`)
    .join('');

  const TH = 'style="text-align:left;padding:0.45rem 0.75rem;border-bottom:2px solid var(--border);font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);white-space:nowrap;"';
  const TD = 'style="padding:0.5rem 0.75rem;border-bottom:1px solid var(--border);vertical-align:middle;"';

  const rows = _sessionMatches.map((m, i) => {
    const r    = m.reg;
    const name = `${r.firstName || ''} ${r.lastName || ''}`.trim();
    const loc  = escHtml(locMap[r.locationId] || r.locationId || '—');

    let matchCell;
    if (m.status === 'created') {
      matchCell = `<td ${TD} style="color:var(--text-muted);font-size:0.8rem;">
        ✓ Session created<br>
        <span style="font-size:0.75rem;">${escHtml(m.clientName)}</span>
      </td>`;
    } else if (m.clientId) {
      // Auto-matched or manually linked
      matchCell = `<td ${TD}>
        <div style="display:flex;align-items:center;gap:0.4rem;flex-wrap:wrap;">
          <span style="background:#dcfce7;color:#166534;font-size:0.75rem;font-weight:700;padding:0.15rem 0.5rem;border-radius:4px;">→ ${escHtml(m.clientName)}</span>
          <button class="btn btn-sm" style="font-size:0.72rem;padding:0.1rem 0.4rem;line-height:1.3;" data-unlink="${i}">✗ Unlink</button>
        </div>
      </td>`;
    } else {
      // Unmatched — show client select
      matchCell = `<td ${TD}>
        <select class="session-client-sel" data-idx="${i}" style="font-size:0.8rem;max-width:220px;">
          <option value="">— Create new client —</option>
          ${clientOpts}
        </select>
      </td>`;
    }

    const opacity = m.status === 'created' ? 'opacity:0.5;' : '';
    return `<tr style="${opacity}">
      <td ${TD}>
        ${escHtml(name)}<br>
        <span style="font-size:0.75rem;color:var(--text-muted);">${escHtml(r.email)}</span>
      </td>
      <td ${TD} style="padding:0.5rem 0.75rem;font-size:0.8rem;">${loc}</td>
      ${matchCell}
    </tr>`;
  }).join('');

  qs('#sessionMatchTable').innerHTML = `
    <p style="font-size:0.8125rem;color:var(--text-muted);margin-bottom:0.75rem;">
      <strong>${total}</strong> registrant${total !== 1 ? 's' : ''} —
      <strong>${created}</strong> already have sessions,
      <strong>${pending}</strong> pending.
    </p>
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:0.8125rem;">
        <thead>
          <tr>
            <th ${TH}>Registrant</th>
            <th ${TH}>Location</th>
            <th ${TH}>Client match</th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="3" style="padding:2rem;text-align:center;color:var(--text-muted);">No registrants.</td></tr>'}</tbody>
      </table>
    </div>`;

  // Wire client selects for unmatched rows
  qs('#sessionMatchTable').querySelectorAll('.session-client-sel').forEach(sel => {
    sel.addEventListener('change', () => {
      const idx      = parseInt(sel.dataset.idx, 10);
      const clientId = sel.value;
      if (clientId) {
        const c = _clients.find(cl => cl.id === clientId);
        _sessionMatches[idx].clientId   = clientId;
        _sessionMatches[idx].clientName = c?.clientName || '';
      } else {
        _sessionMatches[idx].clientId   = null;
        _sessionMatches[idx].clientName = null;
      }
    });
  });

  // Wire unlink buttons
  qs('#sessionMatchTable').querySelectorAll('[data-unlink]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.unlink, 10);
      _sessionMatches[idx].clientId   = null;
      _sessionMatches[idx].clientName = null;
      _sessionMatches[idx].status     = 'unmatched';
      renderSessionMatches();
    });
  });
}

async function createSessionRecords() {
  const btn      = qs('#createSessionsBtn');
  const statusEl = qs('#sessionsStatus');
  const dateVal  = qs('#sessionsDate').value;
  const counselor = qs('#sessionsCounselor').value;
  const hours    = parseFloat(qs('#sessionsHours').value) || 1;

  statusEl.style.color = 'var(--danger)';
  if (!dateVal)    { statusEl.textContent = 'Please select a session date.';   return; }
  if (!counselor)  { statusEl.textContent = 'Please select a counselor.';      return; }
  statusEl.style.color = '';

  const pending = _sessionMatches.filter(m => m.status !== 'created');
  if (!pending.length) {
    statusEl.textContent = 'All registrants already have sessions.';
    return;
  }

  btn.disabled    = true;
  btn.textContent = 'Creating…';

  const sessionBase = {
    counselingType: 'Group Education',
    hudType:        'Group Education',
    date:           new Date(dateVal + 'T12:00:00'),
    hours,
    counselor,
    workshopName:   _currentWs?.title || '',
    workshopId:     _currentId,
    source:         'workshop',
    createdAt:      serverTimestamp(),
  };

  let saved = 0, failed = 0;

  for (const match of pending) {
    try {
      let clientId   = match.clientId;
      let clientName = match.clientName;

      if (!clientId) {
        // No match selected — create a new client from registrant data
        const r    = match.reg;
        const name = `${r.firstName || ''} ${r.lastName || ''}`.trim();
        const ref  = await addDoc(collection(db, 'clients'), {
          clientName:        name,
          email:             (r.email  || '').toLowerCase(),
          phone:             r.phone   || '',
          city:              r.city    || '',
          counselor,
          intakeDate:        dateVal,
          status:            'Active',
          createdAt:         serverTimestamp(),
          updatedAt:         serverTimestamp(),
          sessionCount:      0,
          totalOutcomeValue: 0,
        });
        clientId   = ref.id;
        clientName = name;
        // Cache so subsequent renders show the new client in dropdowns
        _clients.push({ id: clientId, clientName: name, email: (r.email || '').toLowerCase().trim() });
      }

      await addDoc(collection(db, 'clients', clientId, 'sessions'), { ...sessionBase });

      // Mark the registration as session-created
      await updateDoc(doc(db, 'workshopRegistrations', match.reg.id), {
        sessionCreated:    true,
        sessionClientId:   clientId,
        sessionClientName: clientName,
        updatedAt:         serverTimestamp(),
      });

      // Keep in-memory registrant list in sync
      const ri = _registrants.findIndex(r => r.id === match.reg.id);
      if (ri !== -1) {
        _registrants[ri].sessionCreated    = true;
        _registrants[ri].sessionClientId   = clientId;
        _registrants[ri].sessionClientName = clientName;
      }
      match.status     = 'created';
      match.clientId   = clientId;
      match.clientName = clientName;
      saved++;
    } catch (_) {
      failed++;
    }
  }

  btn.disabled    = false;
  btn.textContent = 'Create Session Records';

  if (failed) {
    statusEl.textContent = `${saved} created, ${failed} failed — check console for details.`;
    statusEl.style.color = 'var(--danger)';
  } else {
    statusEl.textContent = `✓ ${saved} session${saved !== 1 ? 's' : ''} created.`;
    statusEl.style.color = 'var(--success, #16a34a)';
  }

  renderSessionMatches();
}
