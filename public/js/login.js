import { auth, db } from './firebase-config.js';
import {
  GoogleAuthProvider,
  signInWithPopup,
  onAuthStateChanged,
  signOut
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getDoc, doc } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const ALLOWED_DOMAIN = 'housingopps.org';

// If already in demo mode or signed in, skip straight to dashboard
if (sessionStorage.getItem('demoMode') === '1') {
  window.location.href = 'log.html';
}

onAuthStateChanged(auth, (user) => {
  if (user) window.location.href = 'log.html';
});

const errorEl  = document.getElementById('loginError');
const submitBtn = document.getElementById('submitBtn');

submitBtn.addEventListener('click', async () => {
  errorEl.classList.add('hidden');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Signing in…';

  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ hd: ALLOWED_DOMAIN });
  provider.addScope('https://www.googleapis.com/auth/drive.readonly');

  try {
    const result = await signInWithPopup(auth, provider);
    const domain = result.user.email.split('@')[1];
    if (domain !== ALLOWED_DOMAIN) {
      await signOut(auth);
      throw new Error('wrong-domain');
    }
    // Store Drive access token for use with the file picker
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (credential?.accessToken) {
      sessionStorage.setItem('driveToken', credential.accessToken);
      sessionStorage.setItem('driveTokenTs', Date.now().toString());
    }
    window.location.href = 'log.html';
  } catch (err) {
    errorEl.textContent = friendlyError(err.message || err.code);
    errorEl.classList.remove('hidden');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Sign in with Google';
  }
});

// ── Demo / Funder passcode ────────────────────────────────────────────────────

const demoPasscodeEl = document.getElementById('demoPasscode');
const demoBtn        = document.getElementById('demoBtn');
const demoErrorEl    = document.getElementById('demoError');

demoBtn.addEventListener('click', validateDemoPasscode);
demoPasscodeEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') validateDemoPasscode(); });

async function validateDemoPasscode() {
  const input = demoPasscodeEl.value.trim();
  demoErrorEl.classList.add('hidden');

  if (!input) {
    demoErrorEl.textContent = 'Please enter the demo passcode.';
    demoErrorEl.classList.remove('hidden');
    return;
  }

  demoBtn.disabled    = true;
  demoBtn.textContent = 'Checking…';

  try {
    const snap = await getDoc(doc(db, 'config', 'demo'));
    if (!snap.exists()) throw new Error('not-configured');
    const stored = snap.data().passcode;
    if (!stored || input !== stored) throw new Error('wrong-passcode');

    sessionStorage.setItem('demoMode', '1');
    window.location.href = 'log.html';
  } catch (err) {
    demoErrorEl.textContent =
      err.message === 'wrong-passcode'   ? 'Incorrect passcode.' :
      err.message === 'not-configured'   ? 'Demo mode is not configured.' :
                                           'Unable to verify. Please try again.';
    demoErrorEl.classList.remove('hidden');
    demoBtn.disabled    = false;
    demoBtn.textContent = 'Enter Demo Mode';
  }
}

function friendlyError(code) {
  const map = {
    'wrong-domain':                  `Only @${ALLOWED_DOMAIN} accounts are allowed.`,
    'auth/popup-closed-by-user':     'Sign-in cancelled.',
    'auth/popup-blocked':            'Popup was blocked. Please allow popups for this site.',
    'auth/too-many-requests':        'Too many attempts. Please try again later.',
    'auth/network-request-failed':   'Network error. Check your connection.',
    'auth/user-disabled':            'This account has been disabled.',
  };
  return map[code] || 'Sign-in failed. Please try again.';
}
