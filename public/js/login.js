import { auth } from './firebase-config.js';
import {
  GoogleAuthProvider,
  signInWithPopup,
  onAuthStateChanged,
  signOut
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const ALLOWED_DOMAIN = 'housingopps.org';

// If already signed in, skip straight to dashboard
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
