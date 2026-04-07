import { db } from './firebase-config.js';
import { requireED, setupNav } from './auth.js';
import {
  doc, getDoc, setDoc
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const DEFAULTS = { amiWeight: 50, budgetWeight: 15, timeWeight: 15, waitTimeWeight: 20 };

requireED(async (user, profile) => {
  setupNav(profile, 'settings');

  // Load current weights
  const snap = await getDoc(doc(db, 'config', 'higWeights'));
  const saved = snap.exists() ? snap.data() : DEFAULTS;

  setSlider('wAmi',    'wAmiVal',    saved.amiWeight    ?? DEFAULTS.amiWeight);
  setSlider('wBudget', 'wBudgetVal', saved.budgetWeight ?? DEFAULTS.budgetWeight);
  setSlider('wTime',   'wTimeVal',   saved.timeWeight   ?? DEFAULTS.timeWeight);
  setSlider('wWait',   'wWaitVal',   saved.waitTimeWeight ?? DEFAULTS.waitTimeWeight);

  // Live value display
  ['wAmi', 'wBudget', 'wTime', 'wWait'].forEach(id => {
    document.getElementById(id).addEventListener('input', (e) => {
      document.getElementById(id + 'Val').textContent = e.target.value;
    });
  });

  document.getElementById('saveWeights').addEventListener('click', async () => {
    const btn     = document.getElementById('saveWeights');
    const msgEl   = document.getElementById('settingsMsg');
    btn.disabled  = true;
    btn.textContent = 'Saving…';
    msgEl.classList.add('hidden');

    try {
      await setDoc(doc(db, 'config', 'higWeights'), {
        amiWeight:      parseInt(document.getElementById('wAmi').value,    10),
        budgetWeight:   parseInt(document.getElementById('wBudget').value, 10),
        timeWeight:     parseInt(document.getElementById('wTime').value,   10),
        waitTimeWeight: parseInt(document.getElementById('wWait').value,   10),
      });
      msgEl.textContent = 'Weights saved.';
      msgEl.style.color = 'var(--accent)';
      msgEl.classList.remove('hidden');
    } catch (err) {
      msgEl.textContent = 'Save failed: ' + err.message;
      msgEl.style.color = 'var(--danger)';
      msgEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save Weights';
    }
  });
});

function setSlider(sliderId, valId, value) {
  document.getElementById(sliderId).value     = value;
  document.getElementById(valId).textContent  = value;
}
