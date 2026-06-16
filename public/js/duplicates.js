import { db } from './firebase-config.js';
import { requireAuth, setupNav } from './auth.js';
import { isDemoMode, demoClientName } from './demo-mode.js';
import {
  findReasons, pairKey, confidenceColor, confidenceLabel, confRank,
} from './duplicate-scanner.js';
import {
  collection, collectionGroup, doc, getDoc, getDocs, updateDoc, deleteDoc, writeBatch,
  query, where, orderBy, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

let _dismissedPairs = new Set();
let _pendingMerge   = null;
const _sessionMonthCache = new Map();

requireAuth(async (user, profile) => {
  setupNav(profile, 'duplicates');

  document.getElementById('scanDuplicatesBtn').addEventListener('click', scanDuplicates);
  document.getElementById('mergeCancelBtn').addEventListener('click', () => {
    document.getElementById('mergeModal').classList.add('hidden');
  });
  document.getElementById('mergeConfirmBtn').onclick = () => performMerge();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(str) {
  return (str || '').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function toTitleCase(str) {
  return (str || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}
function fmtLastSession(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
function showMsg(el, text, success) {
  el.textContent = text;
  el.style.color = success ? 'var(--accent)' : 'var(--danger)';
  el.classList.remove('hidden');
  if (success) setTimeout(() => el.classList.add('hidden'), 4000);
}

// ── Scanner ───────────────────────────────────────────────────────────────────

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
          const aName = isDemoMode() ? demoClientName(a.id) : toTitleCase(a.clientName);
          const bName = isDemoMode() ? demoClientName(b.id) : toTitleCase(b.clientName);
          const aSessions = a.sessionCount || 0;
          const bSessions = b.sessionCount || 0;
          const totalSessions = aSessions + bSessions;
          const smartKeep = bSessions > aSessions ? b : a;
          const smartDrop = bSessions > aSessions ? a : b;
          const smartKeepName = isDemoMode() ? demoClientName(smartKeep.id) : toTitleCase(smartKeep.clientName);
          const smartDropName = isDemoMode() ? demoClientName(smartDrop.id) : toTitleCase(smartDrop.clientName);
          return `
          <div class="dup-pair"
            data-key="${escAttr(key)}"
            data-conf="${topConf.confidence}"
            data-names="${escAttr((aName + ' ' + bName).toLowerCase())}"
            data-counselors="${escAttr(((a.counselor || '') + ' ' + (b.counselor || '')).toLowerCase())}"
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
                <span style="font-size:0.72rem;font-weight:700;color:${confidenceColor[topConf.confidence]};">${confidenceLabel[topConf.confidence]}</span>
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
        if (sortVal === 'sessions') return Number(b.dataset.totalSessions) - Number(a.dataset.totalSessions);
        if (sortVal === 'alpha')    return (a.dataset.names || '').localeCompare(b.dataset.names || '');
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
      const monthVal  = document.getElementById('dupFilterMonth')?.value || '';

      let sessionIds = null;
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
          } catch (_) { sessionIds = null; }
        }
      }

      container.querySelectorAll('.dup-pair').forEach(pair => {
        const nameMatch      = !search    || pair.dataset.names.includes(search);
        const confMatch      = !conf      || pair.dataset.conf === conf;
        const counselorMatch = !counselor || pair.dataset.counselors.includes(counselor);
        const typeMatch      = !type      || pair.dataset.types.includes(type);
        const clientA = pair.dataset.clientA || '';
        const clientB = pair.dataset.clientB || '';
        const monthMatch = !sessionIds || (clientA && sessionIds.has(clientA)) || (clientB && sessionIds.has(clientB));
        pair.style.display = (nameMatch && confMatch && counselorMatch && typeMatch && monthMatch) ? '' : 'none';
      });
      updateDupCount();
    }

    document.getElementById('dupSort').addEventListener('change', () => { sortPairs(); updateDupCount(); });

    const applyBtn = document.getElementById('dupApplyBtn');
    applyBtn.addEventListener('click', async () => {
      applyBtn.disabled = true; applyBtn.textContent = 'Loading…';
      try { await applyDupFilter(); }
      finally { applyBtn.disabled = false; applyBtn.textContent = 'Apply Filters'; }
    });

    sortPairs();

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

    container.querySelectorAll('.merge-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _pendingMerge = {
          keepId: btn.dataset.keep, dropId: btn.dataset.drop,
          keepName: btn.dataset.keepName, dropName: btn.dataset.dropName,
          pairKey: btn.closest('.dup-pair').dataset.key,
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

    container.querySelectorAll('.smart-merge-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _pendingMerge = {
          keepId: btn.dataset.keep, dropId: btn.dataset.drop,
          keepName: btn.dataset.keepName, dropName: btn.dataset.dropName,
          pairKey: btn.closest('.dup-pair').dataset.key,
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

    document.getElementById('mergeConfirmBtn').onclick = () => performMerge();

  } catch (err) {
    container.innerHTML = `<p class="error-msg">Scan failed: ${escHtml(err.message)}</p>`;
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Scan Clients';
  }
}

// ── Merge ─────────────────────────────────────────────────────────────────────

async function performMerge() {
  if (!_pendingMerge) return;
  const { keepId, dropId, keepName, dropName, pairKey: pk } = _pendingMerge;
  const confirmBtn = document.getElementById('mergeConfirmBtn');
  const errorEl    = document.getElementById('mergeModalError');
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Merging…';
  errorEl.classList.add('hidden');

  try {
    const [keepSnap, dropSnap] = await Promise.all([
      getDoc(doc(db, 'clients', keepId)),
      getDoc(doc(db, 'clients', dropId)),
    ]);
    if (!keepSnap.exists()) throw new Error(`"${keepName}" no longer exists — it may have already been merged. Refresh and scan again.`);
    if (!dropSnap.exists()) throw new Error(`"${dropName}" no longer exists — it may have already been merged. Refresh and scan again.`);

    const keep = keepSnap.data();
    const drop = dropSnap.data();

    const sessSnap   = await getDocs(collection(db, 'clients', dropId, 'sessions'));
    const dropSessions = sessSnap.docs.map(d => ({ id: d.id, ...d.data() }));

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

    const mergedRx    = [...new Set([...(keep.rxNumbers || []), ...(drop.rxNumbers || [])].filter(Boolean))];
    const mergedAreas = [...new Set([...(keep.areasOfInterest || []), ...(drop.areasOfInterest || [])].filter(Boolean))];

    const allSessSnap = await getDocs(collection(db, 'clients', keepId, 'sessions'));
    const allSessions = allSessSnap.docs.map(d => d.data());
    const sessionCount      = allSessions.length;
    const totalOutcomeValue = allSessions.reduce((s, r) => s + (Number(r.dollarsAwarded) || 0), 0);

    function toDate(ts) { return ts ? (ts.toDate ? ts.toDate() : new Date(ts)) : null; }
    const dated = allSessions.map(s => toDate(s.date)).filter(Boolean).sort((a, b) => a - b);
    const firstSessionDate = dated[0] || toDate(keep.firstSessionDate) || toDate(drop.firstSessionDate) || null;
    const lastSessionDate  = dated[dated.length - 1] || toDate(keep.lastSessionDate) || toDate(drop.lastSessionDate) || null;

    const keepDate = keep.lastSessionDate ? toDate(keep.lastSessionDate).getTime() : 0;
    const dropDate = drop.lastSessionDate ? toDate(drop.lastSessionDate).getTime() : 0;
    const activeCounselingType = dropDate > keepDate
      ? (drop.counselingType || keep.counselingType)
      : (keep.counselingType || drop.counselingType);

    await updateDoc(doc(db, 'clients', keepId), {
      rxNumbers: mergedRx, areasOfInterest: mergedAreas,
      sessionCount, totalOutcomeValue,
      firstSessionDate: firstSessionDate || null,
      lastSessionDate:  lastSessionDate  || null,
      counselingType: activeCounselingType,
      guarantor:  keep.guarantor  || drop.guarantor  || '',
      zipCode:    keep.zipCode    || drop.zipCode    || '',
      counselor:  keep.counselor  || drop.counselor  || '',
      updatedAt: now,
    });

    await deleteDoc(doc(db, 'clients', dropId));

    const [dropHigSnap, keepHigSnap] = await Promise.all([
      getDocs(query(collection(db, 'higWaitlist'), where('clientId', '==', dropId))),
      getDocs(query(collection(db, 'higWaitlist'), where('clientId', '==', keepId))),
    ]);
    for (const higDoc of dropHigSnap.docs) {
      if (keepHigSnap.size > 0) {
        await deleteDoc(doc(db, 'higWaitlist', higDoc.id));
      } else {
        await updateDoc(doc(db, 'higWaitlist', higDoc.id), { clientId: keepId, updatedAt: now });
      }
    }

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
