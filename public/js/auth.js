import { auth, db } from './firebase-config.js';
import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { doc, getDoc, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { isDemoMode } from './demo-mode.js';

export function requireAuth(callback) {
  if (isDemoMode()) {
    callback({ uid: 'demo', email: 'demo@demo.demo' }, { role: 'demo', name: 'Demo User' });
    return;
  }
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.href = 'index.html';
      return;
    }
    const snap = await getDoc(doc(db, 'users', user.uid));
    if (!snap.exists()) {
      await setDoc(doc(db, 'users', user.uid), {
        uid:       user.uid,
        email:     user.email,
        name:      user.displayName || user.email,
        role:      'pending',
        createdAt: serverTimestamp(),
      });
      window.location.href = 'pending.html';
      return;
    }
    const profile = snap.data();
    if (profile.role === 'pending') {
      window.location.href = 'pending.html';
      return;
    }
    callback(user, profile);
  });
}

export function isAdmin(profile) {
  return profile.role === 'admin' || profile.role === 'executive_director';
}

export function requireAdmin(callback) {
  requireAuth((user, profile) => {
    if (!isAdmin(profile)) {
      if (profile.role !== 'demo') alert('Access denied. Admins only.');
      window.location.href = 'log.html';
      return;
    }
    callback(user, profile);
  });
}

export function requireED(callback) {
  requireAuth((user, profile) => {
    if (profile.role !== 'executive_director') {
      if (profile.role !== 'demo') alert('Access denied. Executive Director only.');
      window.location.href = 'log.html';
      return;
    }
    callback(user, profile);
  });
}

export async function logout() {
  await signOut(auth);
  window.location.href = 'index.html';
}

export function setupNav(profile, activePage) {
  const nav = document.querySelector('nav.nav');
  if (nav) {
    nav.innerHTML = `
      <a class="nav-brand" href="clients.html"><img src="img/logo.png" alt="Housing Opportunities"></a>
      <div class="nav-links">
        <a href="clients.html"      data-page="clients">Counseling Log</a>
        <a href="intake.html"       data-page="intake">Intake</a>
        <a href="buyer-ready.html"  data-page="buyer-ready">Buyer Ready</a>
        <a href="repair-ready.html" data-page="repair-ready">Repair Ready</a>
        <a href="outreach.html"     data-page="outreach">Outreach</a>
        <a href="operations.html"   data-page="operations">Operations</a>
        <a href="hud.html"          data-page="hud">HUD</a>
        <a href="training.html"     data-page="training">Training</a>
        <a href="reports.html"      data-page="reports">Reports</a>
        <a href="duplicates.html"   data-page="duplicates">Duplicates</a>
        <a href="settings.html"     data-page="settings" class="admin-only hidden">Settings</a>
      </div>
      <div class="nav-user">
        <span id="navUserName"></span>
        <button id="logoutBtn" class="btn-logout">Logout</button>
      </div>`;
  }

  const nameEl = document.getElementById('navUserName');
  if (nameEl) nameEl.textContent = profile.name || profile.email || '';

  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    if (isDemoMode()) {
      logoutBtn.textContent = 'Exit Demo';
      logoutBtn.addEventListener('click', () => {
        sessionStorage.removeItem('demoMode');
        window.location.href = 'index.html';
      });
    } else {
      logoutBtn.addEventListener('click', logout);
    }
  }

  if (isAdmin(profile)) {
    document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
  }
  if (profile.role === 'executive_director') {
    document.querySelectorAll('.ed-only').forEach(el => el.classList.remove('hidden'));
  }

  if (activePage) {
    const link = document.querySelector(`.nav-links a[data-page="${activePage}"]`);
    if (link) link.classList.add('active');
  }

  if (isDemoMode()) {
    _injectDemoBanner();
  }
}

function _injectDemoBanner() {
  if (document.getElementById('demoBanner')) return;

  const style = document.createElement('style');
  style.textContent = `
    #demoBanner {
      position: fixed;
      top: 0.85rem;
      right: 1rem;
      z-index: 9999;
      background: #f59e0b;
      color: #fff;
      font-weight: 700;
      font-size: 0.8rem;
      letter-spacing: 0.04em;
      padding: 0.3rem 0.9rem;
      border-radius: 999px;
      cursor: default;
      user-select: none;
    }
    #demoBanner::after {
      content: "You're viewing a live demonstration. Client names and personal information have been replaced to protect privacy.";
      position: absolute;
      top: calc(100% + 0.5rem);
      right: 0;
      background: rgba(0,0,0,0.85);
      color: #fff;
      font-size: 0.73rem;
      font-weight: 400;
      padding: 0.5rem 0.75rem;
      border-radius: 6px;
      white-space: normal;
      width: 240px;
      line-height: 1.55;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.15s;
    }
    #demoBanner:hover::after {
      opacity: 1;
    }
  `;
  document.head.appendChild(style);

  const banner = document.createElement('div');
  banner.id = 'demoBanner';
  banner.textContent = 'Demo Mode';
  document.body.appendChild(banner);
}
