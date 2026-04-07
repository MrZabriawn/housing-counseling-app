/**
 * picker.js — Google Drive file picker utility
 *
 * Uses the Google Picker API with the OAuth token stored at login.
 * If the token is stale (> 45 min), re-authenticates silently via popup.
 *
 * Usage:
 *   import { openDrivePicker } from './picker.js';
 *   const file = await openDrivePicker(); // { id, name, url }
 */

import { auth } from './firebase-config.js';
import {
  GoogleAuthProvider,
  signInWithPopup
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const ALLOWED_DOMAIN = 'housingopps.org';
const TOKEN_TTL_MS   = 45 * 60 * 1000; // 45 minutes

// Firebase API key doubles as the browser key for Picker API
const API_KEY = 'AIzaSyDr37nN71_lgHcEElGa0SmDnML2rTyZsuo';

async function getFreshToken() {
  const token = sessionStorage.getItem('driveToken');
  const ts    = parseInt(sessionStorage.getItem('driveTokenTs') || '0', 10);
  if (token && Date.now() - ts < TOKEN_TTL_MS) return token;

  // Re-authenticate to get a fresh token
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ hd: ALLOWED_DOMAIN, prompt: 'none' });
  provider.addScope('https://www.googleapis.com/auth/drive.readonly');
  const result = await signInWithPopup(auth, provider);
  const credential = GoogleAuthProvider.credentialFromResult(result);
  const fresh = credential?.accessToken;
  if (fresh) {
    sessionStorage.setItem('driveToken', fresh);
    sessionStorage.setItem('driveTokenTs', Date.now().toString());
  }
  return fresh;
}

function loadGapi() {
  return new Promise((resolve) => {
    if (window.gapi) { resolve(); return; }
    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';
    script.onload = resolve;
    document.head.appendChild(script);
  });
}

function loadPicker() {
  return new Promise((resolve) => {
    window.gapi.load('picker', resolve);
  });
}

export function openDrivePicker() {
  return new Promise(async (resolve, reject) => {
    try {
      await loadGapi();
      await loadPicker();
      const token = await getFreshToken();
      if (!token) throw new Error('Could not obtain Drive access token.');

      const picker = new google.picker.PickerBuilder()
        .addView(google.picker.ViewId.DOCS)
        .setOAuthToken(token)
        .setDeveloperKey(API_KEY)
        .setCallback((data) => {
          if (data.action === google.picker.Action.PICKED) {
            const doc = data.docs[0];
            resolve({
              id:   doc.id,
              name: doc.name,
              url:  doc.url,
            });
          } else if (data.action === google.picker.Action.CANCEL) {
            resolve(null);
          }
        })
        .build();

      picker.setVisible(true);
    } catch (err) {
      reject(err);
    }
  });
}
