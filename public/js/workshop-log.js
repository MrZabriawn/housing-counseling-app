// workshop-log.js — Log a completed workshop's attendance (moved here from the
// Outreach page). Creates a "Workshop" / "Group Education" session for each
// attendee, and a client record for anyone new. Imported by workshop-admin.js.
import { db } from './firebase-config.js';
import {
  collection, addDoc, getDocs, query, orderBy, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

let _wsAttendees      = [];
let _wsSelectedClient = null;
let _wsAllClients     = [];
let _wlCounselor      = '';

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function initWorkshopLog(profile) {
  if (!document.getElementById('wsSaveWorkshopBtn')) return;  // card not on page
  _wlCounselor = profile.name || profile.email || '';

  const sel = document.getElementById('wsWorkshopCounselor');
  if (sel) {
    try {
      const snap = await getDocs(query(collection(db, 'counselors'), orderBy('name')));
      snap.docs
        .filter(d => d.data().active !== false && d.data().isCounselor !== false)
        .forEach(d => {
          const o = document.createElement('option');
          o.value = d.data().name; o.textContent = d.data().name;
          sel.appendChild(o);
        });
      if (_wlCounselor) sel.value = _wlCounselor;
    } catch (_) {}
  }
  const dateEl = document.getElementById('wsWorkshopDate');
  if (dateEl && !dateEl.value) dateEl.value = new Date().toISOString().split('T')[0];

  document.getElementById('wsClientSearch')?.addEventListener('input', renderWsClientSearch);
  document.getElementById('wsAddExistingBtn')?.addEventListener('click', addExistingToWorkshop);
  document.getElementById('wsShowNewFormBtn')?.addEventListener('click', () => {
    document.getElementById('wsNewAttendeeForm').classList.remove('hidden');
    document.getElementById('wsShowNewFormBtn').classList.add('hidden');
  });
  document.getElementById('wsCancelNewBtn')?.addEventListener('click', () => {
    document.getElementById('wsNewAttendeeForm').classList.add('hidden');
    document.getElementById('wsShowNewFormBtn').classList.remove('hidden');
    ['wsNewName', 'wsNewPhone', 'wsNewEmail', 'wsNewAddress'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
  });
  document.getElementById('wsAddNewBtn')?.addEventListener('click', addNewToWorkshop);
  document.getElementById('wsSaveWorkshopBtn')?.addEventListener('click', saveWorkshop);
  renderAttendeeList();
}

async function renderWsClientSearch() {
  const q   = document.getElementById('wsClientSearch').value.trim().toLowerCase();
  const box = document.getElementById('wsClientResults');
  _wsSelectedClient = null;
  document.getElementById('wsAddExistingBtn').disabled = true;

  if (!q || q.length < 2) { box.style.display = 'none'; return; }

  if (!_wsAllClients.length) {
    box.innerHTML = '<div style="padding:0.6rem 0.75rem;color:var(--text-muted);">Loading…</div>';
    box.style.display = 'block';
    try {
      const snap = await getDocs(query(collection(db, 'clients'), orderBy('clientName')));
      _wsAllClients = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (_) { _wsAllClients = []; }
  }

  const matches = _wsAllClients
    .filter(c => (c.clientName || '').toLowerCase().includes(q))
    .slice(0, 8);

  if (!matches.length) { box.style.display = 'none'; return; }

  box.innerHTML = '';
  matches.forEach(c => {
    const item = document.createElement('div');
    item.className = 'client-result-item';
    item.textContent = c.clientName;
    item.addEventListener('click', () => {
      _wsSelectedClient = { id: c.id, clientName: c.clientName };
      document.getElementById('wsClientSearch').value = c.clientName;
      box.style.display = 'none';
      document.getElementById('wsAddExistingBtn').disabled = false;
    });
    box.appendChild(item);
  });
  box.style.display = 'block';
}

function addExistingToWorkshop() {
  if (!_wsSelectedClient) return;
  if (_wsAttendees.find(a => a.id === _wsSelectedClient.id)) {
    document.getElementById('wsClientSearch').value = '';
    _wsSelectedClient = null;
    document.getElementById('wsAddExistingBtn').disabled = true;
    return;
  }
  _wsAttendees.push({ type: 'existing', id: _wsSelectedClient.id, clientName: _wsSelectedClient.clientName });
  document.getElementById('wsClientSearch').value = '';
  document.getElementById('wsClientResults').style.display = 'none';
  _wsSelectedClient = null;
  document.getElementById('wsAddExistingBtn').disabled = true;
  renderAttendeeList();
}

function addNewToWorkshop() {
  const name = document.getElementById('wsNewName').value.trim();
  if (!name) { document.getElementById('wsNewName').focus(); return; }
  _wsAttendees.push({
    type:       'new',
    clientName: name,
    phone:      document.getElementById('wsNewPhone').value.trim(),
    email:      document.getElementById('wsNewEmail').value.trim(),
    address:    document.getElementById('wsNewAddress').value.trim(),
  });
  ['wsNewName', 'wsNewPhone', 'wsNewEmail', 'wsNewAddress'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('wsNewAttendeeForm').classList.add('hidden');
  document.getElementById('wsShowNewFormBtn').classList.remove('hidden');
  renderAttendeeList();
}

function renderAttendeeList() {
  const list  = document.getElementById('wsAttendeeList');
  const empty = document.getElementById('wsAttendeeEmpty');
  const count = document.getElementById('wsAttendeeCount');
  if (!list) return;

  count.textContent = _wsAttendees.length
    ? `${_wsAttendees.length} attendee${_wsAttendees.length !== 1 ? 's' : ''}`
    : '';

  list.querySelectorAll('.ws-attendee-row').forEach(r => r.remove());
  if (!_wsAttendees.length) { empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');

  _wsAttendees.forEach((a, i) => {
    const row = document.createElement('div');
    row.className = 'ws-attendee-row';
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:0.35rem 0;border-bottom:1px solid var(--border);';
    const badge = a.type === 'new' ? '<span style="font-size:0.7rem;color:var(--text-muted);margin-left:0.35rem;">new</span>' : '';
    row.innerHTML = `<span>${escHtml(a.clientName)}${badge}</span><button style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:1rem;padding:0 0.25rem;" aria-label="Remove">&times;</button>`;
    row.querySelector('button').addEventListener('click', () => { _wsAttendees.splice(i, 1); renderAttendeeList(); });
    list.appendChild(row);
  });
}

async function saveWorkshop() {
  const btn   = document.getElementById('wsSaveWorkshopBtn');
  const msgEl = document.getElementById('wsWorkshopMsg');
  msgEl.textContent = ''; msgEl.style.color = '';

  const workshopName = document.getElementById('wsWorkshopName').value.trim();
  const date         = document.getElementById('wsWorkshopDate').value;
  const counselor    = document.getElementById('wsWorkshopCounselor').value;
  const hours        = document.getElementById('wsWorkshopHours').value;

  if (!workshopName) { msgEl.textContent = 'Workshop name is required.'; msgEl.style.color = 'var(--danger)'; return; }
  if (!date)         { msgEl.textContent = 'Date is required.';           msgEl.style.color = 'var(--danger)'; return; }
  if (!counselor)    { msgEl.textContent = 'Counselor is required.';      msgEl.style.color = 'var(--danger)'; return; }
  if (!_wsAttendees.length) { msgEl.textContent = 'Add at least one attendee.'; msgEl.style.color = 'var(--danger)'; return; }

  btn.disabled = true; btn.textContent = 'Saving…';

  const sessionData = {
    counselingType: 'Workshop',
    hudType:        'Group Education',
    date,
    hours:          Number(hours) || 0,
    counselor,
    workshopName,
    source:         'workshop',
    createdAt:      serverTimestamp(),
  };

  try {
    let saved = 0;
    for (const a of _wsAttendees) {
      let clientId = a.id;
      if (a.type === 'new') {
        const clientRef = await addDoc(collection(db, 'clients'), {
          clientName:  a.clientName,
          phone:       a.phone   || '',
          email:       a.email   || '',
          address:     a.address || '',
          counselor,
          intakeDate:  date,
          status:      'Active',
          createdAt:   serverTimestamp(),
          updatedAt:   serverTimestamp(),
          sessionCount: 0,
          totalOutcomeValue: 0,
        });
        clientId = clientRef.id;
      }
      await addDoc(collection(db, 'clients', clientId, 'sessions'), { ...sessionData });
      saved++;
    }

    msgEl.textContent = `Saved ${saved} session${saved !== 1 ? 's' : ''} for "${workshopName}".`;
    msgEl.style.color = 'var(--success, green)';
    _wsAttendees = [];
    renderAttendeeList();
    document.getElementById('wsWorkshopName').value  = '';
    document.getElementById('wsWorkshopDate').value  = new Date().toISOString().split('T')[0];
    document.getElementById('wsWorkshopHours').value = '';
    document.getElementById('wsWorkshopCounselor').value = _wlCounselor || '';
  } catch (err) {
    msgEl.textContent = 'Save failed: ' + err.message;
    msgEl.style.color = 'var(--danger)';
  } finally {
    btn.disabled = false; btn.textContent = 'Save Workshop';
  }
}
