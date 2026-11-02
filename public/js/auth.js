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
      window.location.href = 'clients.html';
      return;
    }
    callback(user, profile);
  });
}

export function requireED(callback) {
  requireAuth((user, profile) => {
    if (profile.role !== 'executive_director') {
      if (profile.role !== 'demo') alert('Access denied. Executive Director only.');
      window.location.href = 'clients.html';
      return;
    }
    callback(user, profile);
  });
}

export async function logout() {
  await signOut(auth);
  window.location.href = 'index.html';
}

// Grouped navigation. All office staff (ED, admin, housing counselors) see the
// same menu — no role gating. Display labels differ from page keys where a page
// was renamed (Intake→Intake Letter, Operations→Guidance, Dashboard→Metrics);
// the `page` key still matches what each page passes to setupNav() for active state.
const NAV_GROUPS = [
  { label: 'Clients', items: [
    { label: 'Counseling Log', page: 'clients',      href: 'clients.html' },
    { label: 'New Client',     page: 'new-client',   href: 'new-client.html' },
    { label: 'Intake Letter',  page: 'intake',       href: 'intake.html' },
    { label: 'Guidance',       page: 'operations',   href: 'operations.html' },
  ]},
  { label: 'Programs', items: [
    { label: 'Buyer Ready',    page: 'buyer-ready',  href: 'buyer-ready.html' },
    { label: 'Rent Ready',     page: 'rent-ready',   href: 'rent-ready.html' },
    { label: 'Repair Ready',   page: 'repair-ready', href: 'repair-ready.html' },
  ]},
  { label: 'Engagement', items: [
    { label: 'Outreach',       page: 'outreach',     href: 'outreach.html' },
    { label: 'Workshops',      page: 'workshops',    href: 'workshop-admin.html' },
    { label: 'Training',       page: 'training',     href: 'training.html' },
  ]},
  { label: 'Compliance', items: [
    { label: 'HUD',            page: 'hud',          href: 'hud.html' },
    { label: 'Reports',        page: 'reports',      href: 'reports.html' },
    { label: 'Metrics',        page: 'dashboard',    href: 'dashboard.html' },
  ]},
  { label: 'Admin', items: [
    { label: 'Duplicates',     page: 'duplicates',   href: 'duplicates.html' },
    { label: 'Settings',       page: 'settings',     href: 'settings.html' },
    { label: 'Import',         page: 'import',       href: 'import.html' },
  ]},
];

export function setupNav(profile, activePage) {
  const nav = document.querySelector('nav.nav');
  if (nav) {
    const groupsHtml = NAV_GROUPS.map(g => `
      <div class="nav-group">
        <button type="button" class="nav-group-btn" aria-haspopup="true" aria-expanded="false">${g.label}<span class="nav-caret">&#9662;</span></button>
        <div class="nav-dropdown">
          ${g.items.map(it => `<a href="${it.href}" data-page="${it.page}" class="nav-drop-link">${it.label}</a>`).join('')}
        </div>
      </div>`).join('');

    nav.innerHTML = `
      <a class="nav-brand" href="clients.html"><img src="img/logo.png" alt="Housing Opportunities"></a>
      <div class="nav-links">${groupsHtml}</div>
      <div class="nav-user">
        <span id="navUserName"></span>
        <button id="logoutBtn" class="btn-logout">Logout</button>
      </div>
      <button id="navToggle" class="nav-toggle" type="button" aria-label="Toggle navigation menu" aria-expanded="false">&#9776;</button>`;
  }

  // Mobile hamburger
  const navToggle = document.getElementById('navToggle');
  if (nav && navToggle) {
    navToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = nav.classList.toggle('nav-open');
      navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  // Dropdown groups — click to open one at a time
  if (nav) {
    nav.querySelectorAll('.nav-group-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const grp = btn.closest('.nav-group');
        const wasOpen = grp.classList.contains('open');
        nav.querySelectorAll('.nav-group.open').forEach(g => {
          g.classList.remove('open');
          g.querySelector('.nav-group-btn')?.setAttribute('aria-expanded', 'false');
        });
        if (!wasOpen) { grp.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); }
      });
    });
    // Click anywhere else closes any open group + the mobile menu
    document.addEventListener('click', () => {
      nav.querySelectorAll('.nav-group.open').forEach(g => g.classList.remove('open'));
      nav.classList.remove('nav-open');
    });
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

  // Legacy role-gated elements (kept working, just always shown now)
  document.querySelectorAll('.admin-only, .ed-only').forEach(el => el.classList.remove('hidden'));

  // Active state — highlight the current item and its parent group
  if (activePage && nav) {
    const link = nav.querySelector(`.nav-drop-link[data-page="${activePage}"]`);
    if (link) {
      link.classList.add('active');
      link.closest('.nav-group')?.querySelector('.nav-group-btn')?.classList.add('active');
    }
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
