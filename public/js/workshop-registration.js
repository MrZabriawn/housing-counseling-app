import { db } from './firebase-config.js';
import {
  doc, getDoc, collection, runTransaction, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function qs(sel) { return document.querySelector(sel); }
function setDisplay(el, show) { if (el) el.style.display = show ? '' : 'none'; }

function showError(msg) {
  const el = qs('#alertError');
  el.textContent = msg;
  el.classList.add('show');
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function clearError() {
  const el = qs('#alertError');
  el.textContent = '';
  el.classList.remove('show');
}

function formatDate(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
const RATE_MS = 90_000; // 90 seconds between submissions
function checkRateLimit() {
  try {
    const last = parseInt(sessionStorage.getItem('ws_last_submit') || '0', 10);
    if (Date.now() - last < RATE_MS) return false;
  } catch (_) { /* sessionStorage blocked — allow */ }
  return true;
}
function stampRateLimit() {
  try { sessionStorage.setItem('ws_last_submit', String(Date.now())); } catch (_) { /* ignore */ }
}

// ── Workshop loading ──────────────────────────────────────────────────────────

const params = new URLSearchParams(location.search);
const workshopId = params.get('w');

let _workshopData = null;

async function loadWorkshop() {
  if (!workshopId) {
    showStatus('🔍', 'Workshop not found', 'No workshop ID was provided in this link. Please use the link you were given.');
    return;
  }

  let snap;
  try {
    snap = await getDoc(doc(db, 'workshops', workshopId));
  } catch (err) {
    showStatus('⚠️', 'Unable to load', 'There was a problem loading this workshop. Please try refreshing the page.');
    return;
  }

  if (!snap.exists()) {
    showStatus('🔍', 'Workshop not found', 'This workshop link is not valid. Please contact Housing Opportunities Inc. for the correct link.');
    return;
  }

  const data = snap.data();
  _workshopData = data;

  if (!data.active) {
    showStatus('🔒', 'Registration is closed', 'Registration for this workshop is no longer available. Contact us if you have questions.');
    return;
  }

  renderHero(data);
  renderLocations(data.locations || []);
  setDisplay(qs('#mortgageCard'), !!data.askMortgage);
  setDisplay(qs('#raffleCard'), !!data.hasRaffle);
}

function showStatus(icon, title, body) {
  qs('#statusIcon').textContent = icon;
  qs('#statusTitle').textContent = title;
  qs('#statusBody').textContent = body;
  qs('#statusScreen').classList.add('show');
  qs('#regForm').style.display = 'none';
}

function renderHero(data) {
  qs('#heroTitle').textContent = data.title || 'Workshop';
  qs('#heroSubtitle').textContent = data.subtitle || '';
  if (data.date) {
    qs('#heroMeta').innerHTML = `<span>📅 ${formatDate(data.date)}</span>`;
  }
}

function renderLocations(locs) {
  const container = qs('#locationList');
  if (!locs.length) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:0.875rem;">No locations available.</p>';
    return;
  }

  container.innerHTML = locs.map(loc => {
    const remaining = (loc.cap || 999) - (loc.seatCount || 0);
    const isFull = remaining <= 0;
    const isLow = !isFull && remaining <= 10;
    const seatLabel = isFull ? 'Full' : `${remaining} seat${remaining === 1 ? '' : 's'} remaining`;
    const seatClass = isFull ? 'full' : isLow ? 'low' : 'available';
    return `
      <div class="location-option">
        <input type="radio" name="location" id="loc_${loc.id}" value="${loc.id}"
          ${isFull ? 'disabled' : ''} required>
        <label for="loc_${loc.id}" class="location-label ${isFull ? 'full' : ''}">
          <span class="loc-name">${escHtml(loc.label)}</span>
          <span class="loc-seats ${seatClass}">${seatLabel}</span>
        </label>
      </div>`;
  }).join('');
}

// ── Form submission ───────────────────────────────────────────────────────────

qs('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();

  // Honeypot check — silently fake success if filled
  const hp = qs('#website').value;
  if (hp) {
    fakeSuccess();
    return;
  }

  // Rate limit
  if (!checkRateLimit()) {
    showError('Please wait a moment before submitting again.');
    return;
  }

  // Validate
  const locationId = (qs('input[name="location"]:checked') || {}).value;
  if (!locationId) { showError('Please select a location.'); return; }

  const firstName = qs('#firstName').value.trim();
  const lastName  = qs('#lastName').value.trim();
  const email     = qs('#email').value.trim();
  const phone     = qs('#phone').value.trim();
  const city      = qs('#city').value.trim();

  if (!firstName || !lastName) { showError('Please enter your first and last name.'); return; }
  if (!email || !email.includes('@')) { showError('Please enter a valid email address.'); return; }
  if (!phone) { showError('Please enter a phone number.'); return; }
  if (!city) { showError('Please enter your city.'); return; }

  const data = _workshopData;
  let hasMortgage = null;
  if (data.askMortgage) {
    const mortgageEl = qs('input[name="hasMortgage"]:checked');
    if (!mortgageEl) { showError('Please answer the mortgage question.'); return; }
    hasMortgage = mortgageEl.value;
  }

  const raffleEntry = data.hasRaffle ? qs('#raffleEntry').checked : false;

  const submitBtn = qs('#submitBtn');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting…';

  try {
    const workshopRef = doc(db, 'workshops', workshopId);
    const regRef = doc(collection(db, 'workshopRegistrations'));

    await runTransaction(db, async (txn) => {
      const wSnap = await txn.get(workshopRef);
      if (!wSnap.exists()) throw new Error('Workshop not found');

      const wData = wSnap.data();
      if (!wData.active) throw new Error('CLOSED');

      const locs = wData.locations || [];
      const locIdx = locs.findIndex(l => l.id === locationId);
      if (locIdx === -1) throw new Error('Invalid location');

      const loc = locs[locIdx];
      const remaining = (loc.cap || 999) - (loc.seatCount || 0);
      if (remaining <= 0) throw new Error('FULL');

      const newLocs = locs.map((l, i) =>
        i === locIdx ? { ...l, seatCount: (l.seatCount || 0) + 1 } : l
      );
      txn.update(workshopRef, { locations: newLocs });

      txn.set(regRef, {
        workshopId,
        locationId,
        firstName,
        lastName,
        email: email.toLowerCase(),
        phone,
        city,
        hasMortgage,
        raffleEntry,
        createdAt: serverTimestamp(),
      });
    });

    stampRateLimit();
    showSuccess(locationId);

  } catch (err) {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Register Now';
    if (err.message === 'FULL') {
      showError('Sorry, that location just filled up. Please select another location or check back later.');
      // Refresh seat counts
      loadWorkshop();
    } else if (err.message === 'CLOSED') {
      showError('Registration for this workshop has closed.');
    } else {
      showError('Something went wrong. Please try again in a moment.');
    }
  }
});

function showSuccess(locationId) {
  const locs = _workshopData.locations || [];
  const loc = locs.find(l => l.id === locationId);
  qs('#successLoc').textContent = loc ? loc.label : 'the event';
  qs('#regForm').classList.add('hide');
  qs('#successScreen').classList.add('show');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function fakeSuccess() {
  qs('#regForm').classList.add('hide');
  qs('#successScreen').classList.add('show');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Init ──────────────────────────────────────────────────────────────────────
loadWorkshop();
