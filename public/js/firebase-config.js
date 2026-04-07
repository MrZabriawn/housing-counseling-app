import { initializeApp }  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth }        from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore }   from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ─── REPLACE THIS BLOCK WITH YOUR FIREBASE PROJECT CONFIG ────────────────────
// Firebase Console → Project Settings → Your apps → SDK setup and configuration
const firebaseConfig = {
  apiKey:            "AIzaSyDr37nN71_lgHcEElGa0SmDnML2rTyZsuo",
  authDomain:        "housing-counseling.firebaseapp.com",
  projectId:         "housing-counseling",
  storageBucket:     "housing-counseling.firebasestorage.app",
  messagingSenderId: "1084104773953",
  appId:             "1:1084104773953:web:b059f405cedf09361c91c0"
};
// ─────────────────────────────────────────────────────────────────────────────

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db   = getFirestore(app);
