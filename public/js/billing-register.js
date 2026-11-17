import { db } from './firebase-config.js';
import { isAdmin } from './auth.js?v=2';
import {
  collection, getDocs, addDoc, updateDoc, doc,
  query, orderBy, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

let _entries = [];
let _profile = null;
let _loaded  = false;

const PROGRAM_COLORS = {
  CHCI:  'background:#dbeafe;color:#1e40af',
  HEMAP: 'background:#ffedd5;color:#c2410c',
  HUD:   'background:#ede9fe;color:#6d28d9',
  JTBC:  'background:#ccfbf1;color:#0f766e',
  TMCRF: 'background:#ffe4e6;color:#be123c',
};

function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function statusPill(s) {
  const styles = {
    billed: 'background:#dbeafe;color:#1e40af',
    paid:   'background:#dcfce7;color:#15803d',
    void:   'background:#f1f5f9;color:#64748b',
  };
  const label = s === 'billed' ? 'Billed' : s === 'paid' ? 'Paid' : 'Void';
  return `<span style="display:inline-block;padding:0.15em 0.6em;border-radius:999px;font-size:0.72rem;font-weight:700;${styles[s] || ''}">${label}</span>`;
}

function programBadge(p) {
  const style = PROGRAM_COLORS[p] || 'background:#f1f5f9;color:#374151';
  return `<span style="display:inline-block;padding:0.15em 0.6em;border-radius:4px;font-size:0.72rem;font-weight:700;${style}">${p}</span>`;
}

export async function initBillingRegister(user, profile) {
  _profile = profile;

  document.getElementById('brAddBtn').addEventListener('click', () => {
    document.getElementById('brManualForm').style.display = 'block';
    document.getElementById('brAddBtn').style.display = 'none';
  });
  document.getElementById('brManualCancelBtn').addEventListener('click', () => {
    document.getElementById('brManualForm').style.display = 'none';
    document.getElementById('brAddBtn').style.display = '';
    document.getElementById('brManualMsg').textContent = '';
  });
  document.getElementById('brManualSaveBtn').addEventListener('click', saveManualEntry);
  document.getElementById('brRefreshBtn').addEventListener('click', () => load(true));
  document.getElementById('brProgramFilter').addEventListener('change', render);

  // Lazy load on first tab activation — caller triggers this after wiring
  await load(false);
}

async function load(force = false) {
  if (_loaded && !force) return;
  try {
    const snap = await getDocs(query(collection(db, 'billingRegister'), orderBy('createdAt', 'desc')));
    _entries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _loaded = true;
  } catch (_) {
    _entries = [];
  }
  render();
}

function render() {
  const filter = document.getElementById('brProgramFilter')?.value || '';
  const rows   = filter ? _entries.filter(e => e.program === filter) : _entries;
  const tbody  = document.getElementById('brRegisterBody');
  if (!tbody) return;

  const totalBilled = rows.filter(e => e.status !== 'void').reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const totalPaid   = rows.filter(e => e.status === 'paid').reduce((s, e) => s + (Number(e.paidAmount ?? e.amount) || 0), 0);
  const billedEl = document.getElementById('brTotalBilled');
  const paidEl   = document.getElementById('brTotalPaid');
  if (billedEl) billedEl.textContent = fmtMoney(totalBilled);
  if (paidEl)   paidEl.textContent   = fmtMoney(totalPaid);

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--text-muted);">No entries${filter ? ' for ' + filter : ''}.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(e => {
    const admin = isAdmin(_profile);
    const canPay  = e.status === 'billed';
    const canVoid = e.status !== 'void' && admin;
    const streamStr = e.streams
      ? Object.entries(e.streams).filter(([,v]) => v).map(([k,v]) => `${k.toUpperCase()}: ${fmtMoney(v)}`).join(' · ')
      : '';
    return `<tr data-id="${e.id}">
      <td style="padding:0.5rem 0.75rem;white-space:nowrap;">${programBadge(e.program)}</td>
      <td style="padding:0.5rem 0.75rem;white-space:nowrap;">${e.billingMonth || '—'}</td>
      <td style="padding:0.5rem 0.75rem;text-align:right;white-space:nowrap;">${fmtMoney(e.amount)}${streamStr ? `<div style="font-size:0.72rem;color:var(--text-muted);margin-top:0.1rem;">${streamStr}</div>` : ''}</td>
      <td style="padding:0.5rem 0.75rem;">${statusPill(e.status)}</td>
      <td style="padding:0.5rem 0.75rem;text-align:right;">${e.paidAmount != null ? fmtMoney(e.paidAmount) : '—'}</td>
      <td style="padding:0.5rem 0.75rem;">${e.paidDate || '—'}</td>
      <td style="padding:0.5rem 0.75rem;max-width:180px;font-size:0.8125rem;color:var(--text-muted);">${e.notes || ''}</td>
      <td style="padding:0.5rem 0.75rem;white-space:nowrap;">
        ${canPay  ? `<button class="btn btn-secondary btn-sm br-pay-btn" data-id="${e.id}" style="margin-right:0.35rem;">Mark Paid</button>` : ''}
        ${canVoid ? `<button class="btn btn-sm br-void-btn" data-id="${e.id}" style="background:none;border:1px solid var(--border);font-size:0.78rem;color:var(--text-muted);">Void</button>` : ''}
      </td>
    </tr>
    <tr class="br-pay-row hidden" id="br-pay-row-${e.id}">
      <td colspan="8" style="padding:0.5rem 1rem;background:#f8f9fb;">
        <div style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;">
          <span style="font-size:0.8rem;font-weight:600;">Payment:</span>
          <input type="number" class="br-pay-amt" placeholder="Amount paid" step="0.01" min="0"
            style="width:120px;padding:0.3rem 0.5rem;border:1px solid var(--border);border-radius:var(--radius);font-size:0.875rem;">
          <input type="date" class="br-pay-date"
            style="padding:0.3rem 0.5rem;border:1px solid var(--border);border-radius:var(--radius);font-size:0.875rem;">
          <button class="btn btn-primary btn-sm br-pay-confirm" data-id="${e.id}">Save</button>
          <button class="btn btn-secondary btn-sm br-pay-cancel" data-id="${e.id}">Cancel</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  // Wire up pay/void/cancel buttons
  tbody.querySelectorAll('.br-pay-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById(`br-pay-row-${btn.dataset.id}`)?.classList.remove('hidden');
      btn.style.display = 'none';
    });
  });
  tbody.querySelectorAll('.br-pay-cancel').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById(`br-pay-row-${btn.dataset.id}`)?.classList.add('hidden');
      tbody.querySelector(`.br-pay-btn[data-id="${btn.dataset.id}"]`).style.display = '';
    });
  });
  tbody.querySelectorAll('.br-pay-confirm').forEach(btn => {
    btn.addEventListener('click', () => markPaid(btn.dataset.id));
  });
  tbody.querySelectorAll('.br-void-btn').forEach(btn => {
    btn.addEventListener('click', () => voidEntry(btn.dataset.id));
  });
}

async function markPaid(id) {
  const row     = document.getElementById(`br-pay-row-${id}`);
  const amtEl   = row?.querySelector('.br-pay-amt');
  const dateEl  = row?.querySelector('.br-pay-date');
  const paidAmt = parseFloat(amtEl?.value);
  const paidDate = dateEl?.value;
  if (!paidDate) { alert('Please enter a payment date.'); return; }
  try {
    await updateDoc(doc(db, 'billingRegister', id), {
      status: 'paid',
      paidAmount: isNaN(paidAmt) ? null : paidAmt,
      paidDate,
    });
    const idx = _entries.findIndex(e => e.id === id);
    if (idx >= 0) Object.assign(_entries[idx], { status: 'paid', paidAmount: isNaN(paidAmt) ? null : paidAmt, paidDate });
    render();
  } catch (err) {
    alert('Save failed: ' + err.message);
  }
}

async function voidEntry(id) {
  if (!confirm('Mark this entry as void?')) return;
  try {
    await updateDoc(doc(db, 'billingRegister', id), { status: 'void' });
    const idx = _entries.findIndex(e => e.id === id);
    if (idx >= 0) _entries[idx].status = 'void';
    render();
  } catch (err) {
    alert('Void failed: ' + err.message);
  }
}

async function saveManualEntry() {
  const btn    = document.getElementById('brManualSaveBtn');
  const msgEl  = document.getElementById('brManualMsg');
  const prog   = document.getElementById('brManualProgram').value;
  const month  = document.getElementById('brManualMonth').value.trim();
  const amount = parseFloat(document.getElementById('brManualAmount').value);
  const notes  = document.getElementById('brManualNotes').value.trim();

  if (!prog)        { msgEl.textContent = 'Select a program.'; return; }
  if (!month)       { msgEl.textContent = 'Enter a billing month.'; return; }
  if (isNaN(amount) || amount <= 0) { msgEl.textContent = 'Enter a valid amount.'; return; }

  btn.disabled = true;
  btn.textContent = 'Saving…';
  msgEl.textContent = '';
  try {
    const ref = await addDoc(collection(db, 'billingRegister'), {
      program: prog, billingMonth: month, amount,
      status: 'billed', sourceType: 'manual', sourceId: null,
      paidDate: null, paidAmount: null, notes,
      createdAt: serverTimestamp(),
      createdBy: _profile?.name || '',
    });
    _entries.unshift({ id: ref.id, program: prog, billingMonth: month, amount, status: 'billed', sourceType: 'manual', sourceId: null, paidDate: null, paidAmount: null, notes, createdBy: _profile?.name || '' });
    msgEl.style.color = 'var(--success,green)';
    msgEl.textContent = 'Saved.';
    document.getElementById('brManualProgram').value = '';
    document.getElementById('brManualMonth').value   = '';
    document.getElementById('brManualAmount').value  = '';
    document.getElementById('brManualNotes').value   = '';
    render();
    setTimeout(() => { msgEl.textContent = ''; }, 2500);
  } catch (err) {
    msgEl.style.color = 'var(--danger,red)';
    msgEl.textContent = 'Failed: ' + err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Entry';
  }
}
