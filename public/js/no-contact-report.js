import { db } from './firebase-config.js';
import {
  collection, getDocs, query, orderBy, collectionGroup,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const escHtml = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const escAttr = s => String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;');

let _isED   = false;
let _myName = '';

export async function initNoContactReport(user, profile) {
  _isED   = profile.role === 'executive_director';
  _myName = profile.name || profile.email || '';

  try {
    const snap = await getDocs(query(collection(db, 'counselors'), orderBy('name')));
    const sel  = document.getElementById('noContactCounselor');
    snap.docs.filter(d => d.data().active !== false).forEach(d => {
      const o = document.createElement('option');
      o.value = d.data().name; o.textContent = d.data().name;
      sel.appendChild(o);
    });
    if (!_isED) sel.value = _myName;
  } catch (_) {}

  document.getElementById('loadNoContactBtn').addEventListener('click', loadNoContact);
}

async function loadNoContact() {
  const btn      = document.getElementById('loadNoContactBtn');
  const resultEl = document.getElementById('noContactResult');
  const counsel  = document.getElementById('noContactCounselor').value;

  btn.disabled    = true;
  btn.textContent = 'Loading…';
  resultEl.innerHTML = '<p style="color:var(--text-muted);font-size:0.875rem;">Loading clients…</p>';

  try {
    const [clientSnap, sessSnap] = await Promise.all([
      getDocs(collection(db, 'clients')),
      getDocs(collectionGroup(db, 'sessions')),
    ]);

    const sessions = sessSnap.docs.map(d => ({ clientId: d.ref.parent.parent.id, ...d.data() }));

    const toDateTs = ts => ts?.toDate ? ts.toDate() : (ts ? new Date(ts) : null);
    const now = Date.now();

    let clients = clientSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(c => !c.deleted && (c.status || 'active') === 'active');

    if (counsel) clients = clients.filter(c => c.counselor === counsel);

    const stale = clients
      .map(c => {
        const lastTs   = c.lastSessionDate || c.firstSessionDate;
        const lastD    = toDateTs(lastTs);
        const daysSince = lastD ? Math.floor((now - lastD.getTime()) / 86400000) : null;
        return { ...c, daysSince };
      })
      .filter(c => c.daysSince !== null && c.daysSince >= 60)
      .sort((a, b) => b.daysSince - a.daysSince);

    if (!stale.length) {
      resultEl.innerHTML = '<p style="color:var(--accent);font-weight:600;">No clients without recent contact.</p>';
      return;
    }

    const critical = stale.filter(c => c.daysSince >= 120).length;
    const followUp = stale.filter(c => c.daysSince < 120).length;

    const TH = 'style="text-align:left;padding:0.4rem 0.6rem;border-bottom:2px solid var(--border);font-size:0.68rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);white-space:nowrap;"';
    const TD = 'style="padding:0.35rem 0.5rem;border-bottom:1px solid #f0f1f3;vertical-align:middle;"';

    const rows = stale.map(c => {
      const tier  = c.daysSince >= 120 ? 'critical' : 'followup';
      const color = tier === 'critical' ? '#9a3412' : '#854d0e';
      const bg    = tier === 'critical' ? '#fee2e2' : '#fefce8';
      const label = tier === 'critical' ? '120+ days' : '60–119 days';
      return `<tr>
        <td ${TD}><a href="client.html?id=${escAttr(c.id)}" style="color:var(--primary);font-weight:600;">${escHtml(c.clientName || '—')}</a></td>
        <td ${TD}>${escHtml(c.counselor || '—')}</td>
        <td ${TD} style="text-align:center;">
          <span style="background:${bg};color:${color};padding:0.15rem 0.5rem;border-radius:10px;font-size:0.72rem;font-weight:700;">${c.daysSince}d</span>
        </td>
        <td ${TD}>
          <span style="background:${bg};color:${color};padding:0.1rem 0.4rem;border-radius:10px;font-size:0.7rem;font-weight:700;">${label}</span>
        </td>
      </tr>`;
    }).join('');

    const summary = [
      critical > 0 ? `<span style="color:#9a3412;font-weight:700;">${critical} critical (120+ days)</span>` : '',
      followUp > 0 ? `<span style="color:#854d0e;font-weight:700;">${followUp} follow-up (60–119 days)</span>` : '',
    ].filter(Boolean).join(' &nbsp;·&nbsp; ');

    resultEl.innerHTML = `
      <div style="margin-bottom:0.75rem;font-size:0.82rem;">${summary}</div>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:0.875rem;">
          <thead>
            <tr>
              <th ${TH}>Client</th>
              <th ${TH}>Counselor</th>
              <th ${TH} style="text-align:center;">Days Since Contact</th>
              <th ${TH}>Tier</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } catch (err) {
    resultEl.innerHTML = `<p style="color:var(--danger);font-size:0.875rem;">Error loading data: ${escHtml(err.message)}</p>`;
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Load';
  }
}
