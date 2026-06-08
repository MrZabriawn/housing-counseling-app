import { auth, db } from './firebase-config.js';
import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

export function requireAuth(callback) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.href = 'index.html';
      return;
    }
    const snap = await getDoc(doc(db, 'users', user.uid));
    const profile = snap.exists()
      ? snap.data()
      : { uid: user.uid, name: user.email, role: 'counselor' };
    callback(user, profile);
  });
}

export function isAdmin(profile) {
  return profile.role === 'admin' || profile.role === 'executive_director';
}

export function requireAdmin(callback) {
  requireAuth((user, profile) => {
    if (!isAdmin(profile)) {
      alert('Access denied. Admins only.');
      window.location.href = 'log.html';
      return;
    }
    callback(user, profile);
  });
}

export function requireED(callback) {
  requireAuth((user, profile) => {
    if (profile.role !== 'executive_director') {
      alert('Access denied. Executive Director only.');
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
        <a href="buyer-ready.html"  data-page="buyer-ready">Buyer Ready</a>
        <a href="repair-ready.html" data-page="repair-ready">Repair Ready</a>
        <a href="outreach.html"     data-page="outreach">Outreach</a>
        <a href="hud-time.html"     data-page="hud-time">HUD</a>
        <a href="training.html"     data-page="training">Training</a>
        <a href="operations.html"   data-page="operations">Operations</a>
        <a href="reports.html"      data-page="reports">Reports</a>
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
  if (logoutBtn) logoutBtn.addEventListener('click', logout);

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
}
