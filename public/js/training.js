import { db } from './firebase-config.js';
import { requireAuth, setupNav } from './auth.js';
import {
  collection, doc, getDoc, setDoc, getDocs, query, orderBy, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ── Schema — every trackable item ────────────────────────────────────────────
// Each entry: { key, label, hours?, cols: ['planned','actual','cert'] }
// cols drives which date inputs appear for that row.

const SCHEMA = {
  s1: {
    title: 'Section 1 — Ethics & Conduct',
    groups: [
      { label: 'PHFA Ethics & Conduct', rows: [
        { key: 'phfa_ethics', label: 'Signed PHFA\'s Housing Counselor Ethics & Conduct', cols: ['actual','cert'] },
      ]},
      { label: 'National Ethics & Conduct', rows: [
        { key: 'natl_ethics', label: 'Signed National Industry Standards for Homeownership Education and Counseling: Code of Ethics and Conduct', cols: ['actual','cert'] },
      ]},
    ],
  },

  s2: {
    title: 'Section 2 — PHFA Training (Required)',
    groups: [
      { label: 'New Counseling Training', rows: [
        { key: 's2_privacy',   label: 'Best Practices to Protect Your Clients Privacy (Powerpoint)', hours: 1, cols: ['planned','actual'] },
        { key: 's2_chci',      label: 'Comprehensive Housing Counseling Initiative (Webinar)',         hours: 3, cols: ['planned','actual'] },
        { key: 's2_rxoffice',  label: 'RX Office (Webinar)',                                           hours: 3, cols: ['planned','actual'] },
        { key: 's2_stdsolns',  label: 'Standard Solutions to Mitigate Mortgage Default & Delinquency (Webinar)', hours: 3, cols: ['planned','actual'] },
        { key: 's2_hemap',     label: 'HEMAP (Webinar)',                                               hours: 3, cols: ['planned','actual'] },
        { key: 's2_chciprep',  label: 'CHCI Preparation Course for the Competency Exam (Webinar)',    hours: 3, cols: ['planned','actual'] },
      ]},
      { label: 'Housing Counseling Specialist Designation', rows: [
        { key: 's2_specexam',  label: 'Housing Counseling Specialist Exam (passed with 80% or higher)', hours: 2, cols: ['planned','actual','cert'] },
        { key: 's2_speccert',  label: 'Housing Counseling Specialist Certificate', cols: ['cert'] },
      ]},
      { label: 'Continuing Education (Annual)', rows: [
        { key: 's2_hoce', label: 'Homeownership Continuing Education', cols: ['planned','actual'] },
        { key: 's2_srvce', label: 'Servicing Continuing Education', cols: ['planned','actual'] },
      ]},
    ],
  },

  s3: {
    title: 'Section 3 — PHFA HEMAP Certification (Optional)',
    groups: [
      { label: 'HEMAP Certified Counselor', rows: [
        { key: 's3_hemapexam',  label: 'HEMAP Competency Exam (passed with 80% or higher)', hours: 2, cols: ['planned','actual','cert'] },
        { key: 's3_hemapcert',  label: 'HEMAP Certificate', cols: ['cert'] },
      ]},
    ],
  },

  s4: {
    title: 'Section 4 — National Certifications (Required)',
    groups: [
      { label: 'HUD Housing Counselor Certification', rows: [
        { key: 's4_hudtest', label: 'HUD Housing Counselor Certification Test (passed with 80% or higher)', hours: 2, cols: ['planned','actual','cert'] },
      ]},

      { label: 'Homeownership — NCHEC (NeighborWorks)', rows: [
        { key: 's4_nchec_ho1',     label: 'Step 1 — NW Homeownership Counseling Principles, Practices and Techniques, Part 1 (HO250)', hours: '5 days', cols: ['planned','actual'] },
        { key: 's4_nchec_ho2',     label: 'Step 2 — NW Foreclosure Basics (HO109 or HO109el)', hours: '2 days', cols: ['planned','actual'] },
        { key: 's4_nchec_ho3',     label: 'Step 3 — Online Examination (passed with 80% or higher)', cols: ['planned','actual'] },
        { key: 's4_nchec_ho_cert', label: 'NCHEC Homeownership Counseling Certification', cols: ['cert'] },
        { key: 's4_nchec_ho_re',   label: 'NCHEC Homeownership Counseling Certification (Recertification)', hours: '30 hrs CE', cols: ['planned','actual'] },
      ]},

      { label: 'Homeownership — NHNLA (Unidos)', rows: [
        { key: 's4_nhnla_ho1',  label: 'Step 1 — Pre-Purchase: Fundamentals of Pre-Purchase Homebuyer Counseling', hours: '3 days', cols: ['planned','actual'] },
        { key: 's4_nhnla_ho2',  label: 'Step 2 — Webinar of your choice from NHNLA Course Calendar', hours: '2 hrs', cols: ['planned','actual'] },
        { key: 's4_nhnla_ho3',  label: 'Step 3 — Webinar of your choice from NHNLA Course Calendar', hours: '2 hrs', cols: ['planned','actual'] },
        { key: 's4_nhnla_ho4a', label: 'Step 4a — NHNLA Foreclosure Prevention: Fundamentals of Foreclosure Prevention Counseling', hours: '4 days', cols: ['planned','actual'] },
        { key: 's4_nhnla_ho4b', label: 'Step 4b — NHNLA e-learning: Foreclosure Prevention I and II (OR)', hours: '2 days', cols: ['planned','actual'] },
        { key: 's4_nhnla_ho4c', label: 'Step 4c — NeighborWorks: Foreclosure Basics HO109 (OR)', hours: '2 days', cols: ['planned','actual'] },
        { key: 's4_nhnla_ho4d', label: 'Step 4d — HUD Loss Mitigation (OR)', hours: '22 hrs', cols: ['planned','actual'] },
        { key: 's4_nhnla_ho5a', label: 'Step 5a — Online Exam: Pre-Purchase Fundamentals', cols: ['planned','actual'] },
        { key: 's4_nhnla_ho5b', label: 'Step 5b — Online Exam: Foreclosure Prevention Fundamentals', cols: ['planned','actual'] },
        { key: 's4_nhnla_ho_cert', label: 'NHNLA Housing Counselor Certification', cols: ['cert'] },
        { key: 's4_nhnla_ho_re',   label: 'NHNLA Housing Counselor Certification (Recertification)', hours: '30 hrs CE', cols: ['planned','actual'] },
      ]},

      { label: 'Foreclosure — NCHEC (NeighborWorks)', rows: [
        { key: 's4_nchec_fc1',     label: 'Step 1 — Pre-Examination', cols: ['planned','actual'] },
        { key: 's4_nchec_fc2',     label: 'Step 2 — NW Foreclosure Intervention & Default Counseling Part 1 (HO345rq)', hours: '8 days', cols: ['planned','actual'] },
        { key: 's4_nchec_fc3',     label: 'Step 3 — NW Advanced Foreclosure: Case Study Practicum (HO307 or HO307vc)', hours: '2 days', cols: ['planned','actual'] },
        { key: 's4_nchec_fc4',     label: 'Step 4 — Online Examination (passed with 80% or higher)', cols: ['planned','actual'] },
        { key: 's4_nchec_fc_cert', label: 'NCHEC Foreclosure Intervention & Default Counseling Certification', cols: ['cert'] },
        { key: 's4_nchec_fc_re',   label: 'NCHEC Foreclosure Intervention & Default Counseling Certification (Recertification)', hours: '30 hrs CE', cols: ['planned','actual'] },
      ]},

      { label: 'Foreclosure — NHNLA (Unidos)', rows: [
        { key: 's4_nhnla_fc1a', label: 'Step 1a — NHNLA Foreclosure Prevention: Fundamentals of Foreclosure Prevention Counseling', hours: 32, cols: ['planned','actual'] },
        { key: 's4_nhnla_fc1b', label: 'Step 1b — NHNLA e-learning Foreclosure I and II (OR)', cols: ['planned','actual'] },
        { key: 's4_nhnla_fc2',  label: 'Step 2 — NHNLA Predatory Lending Webinar', cols: ['planned','actual'] },
        { key: 's4_nhnla_fc3',  label: 'Step 3 — Online Exam: Foreclosure Prevention Fundamentals', cols: ['planned','actual'] },
        { key: 's4_nhnla_fc_cert', label: 'NHNLA Foreclosure Counselor Certification', cols: ['cert'] },
        { key: 's4_nhnla_fc_re',   label: 'NHNLA Foreclosure Counselor Certification (Recertification)', hours: '30 hrs CE', cols: ['planned','actual'] },
      ]},

      { label: 'Foreclosure — NREI (National Real Estate Institute)', rows: [
        { key: 's4_nrei_fc1',     label: 'Step 1 — Foreclosure Intervention Specialist Certification Course (NREI106)', hours: '3 days', cols: ['planned','actual'] },
        { key: 's4_nrei_fc2',     label: 'Step 2 — Mortgage Diversion Practices and Procedures Course (NREI107)', hours: '2 days', cols: ['planned','actual'] },
        { key: 's4_nrei_fc3',     label: 'Step 3 — Examination (passed with 80% or higher)', cols: ['planned','actual'] },
        { key: 's4_nrei_fc_cert', label: 'NREI Foreclosure Intervention Specialist Certification', cols: ['cert'] },
        { key: 's4_nrei_fc_re',   label: 'NREI Foreclosure Intervention Specialist Certification (Recertification)', hours: '30 hrs CE', cols: ['planned','actual'] },
      ]},

      { label: 'Foreclosure — NFCC Housing Counseling Certification', rows: [
        { key: 's4_nfcc_fc1',     label: 'Step 1 — HUD Loss Mitigation', cols: ['planned','actual'] },
        { key: 's4_nfcc_fc2',     label: 'Step 2 — Active NACCC Credit Counselor Certification', cols: ['planned','actual'] },
        { key: 's4_nfcc_fc3',     label: 'Step 3 — Completed Study Guide', cols: ['planned','actual'] },
        { key: 's4_nfcc_exam',    label: 'NFCC Housing Counselor Examination (passed with 80% or higher)', cols: ['planned','actual'] },
        { key: 's4_nfcc_cert',    label: 'NFCC Housing Counseling Certification', cols: ['cert'] },
        { key: 's4_nfcc_re',      label: 'NFCC Housing Counseling Certification (Recertification)', hours: '20 hrs CE', cols: ['planned','actual'] },
      ]},
    ],
  },

  s5: {
    title: 'Section 5 — National Certifications (Optional)',
    groups: [
      { label: 'HUD HECM Approved', rows: [
        { key: 's5_hecm_exam',   label: 'HECM Online Examination (passed with 80% or higher)', cols: ['planned','actual','cert'] },
        { key: 's5_hecm_roster', label: 'HUD HECM Counselor Roster', cols: ['cert'] },
      ]},

      { label: 'NCHEC (NeighborWorks) Financial Capability Certification', rows: [
        { key: 's5_nchec_fin1',     label: 'Step 1 — Building Skills for Financial Confidence (HO208 or HO208el)', hours: '2 days', cols: ['planned','actual'] },
        { key: 's5_nchec_fin2',     label: 'Step 2 — Delivering Effective Financial Education for Today\'s Consumer (HO209rq)', hours: '3 days', cols: ['planned','actual'] },
        { key: 's5_nchec_fin3',     label: 'Step 3 — Financial Coaching: Helping Clients Reach Their Goals (HO310)', hours: '2 days', cols: ['planned','actual'] },
        { key: 's5_nchec_fin4',     label: 'Step 4 — Online Examination (passed with 80% or higher)', cols: ['planned','actual'] },
        { key: 's5_nchec_fin_cert', label: 'NCHEC Financial Capability Certification', cols: ['cert'] },
        { key: 's5_nchec_fin_re',   label: 'NCHEC Financial Capability Certification (Recertification)', hours: '30 hrs CE', cols: ['planned','actual'] },
      ]},

      { label: 'AFCPE — Accredited Financial Counselor (AFC) Certification', rows: [
        { key: 's5_afc1',     label: 'Step 1 — Self-Paced Study AFC course (Personal Finance, Guide to Surviving Debt, Financial Counseling: A Strategic Approach)', cols: ['planned','actual'] },
        { key: 's5_afc2',     label: 'Step 2 — Proctored Examination (150 questions, pass/fail)', hours: '3 hrs', cols: ['planned','actual'] },
        { key: 's5_afc3',     label: 'Step 3 — Experience (financial counseling)', hours: '1,000 hrs', cols: ['planned','actual'] },
        { key: 's5_afc4',     label: 'Step 4 — Code of Ethics', cols: ['planned','actual'] },
        { key: 's5_afc_cert', label: 'AFCPE Accredited Financial Counselor Certification', cols: ['cert'] },
        { key: 's5_afc_re',   label: 'AFCPE AFC Certification (Recertification)', hours: '30 hrs/2 yrs CE', cols: ['planned','actual'] },
      ]},

      { label: 'AFCPE — Accredited Financial Coach (FFC) Certification', rows: [
        { key: 's5_ffc1',     label: 'Step 1 — AFC designation or Money Management Essentials course', cols: ['planned','actual'] },
        { key: 's5_ffc2',     label: 'Step 2 — FFC Module 1: Coaching Essentials (online or in-person)', hours: '10 hrs', cols: ['planned','actual'] },
        { key: 's5_ffc3',     label: 'Step 3 — FFC Module 2: Coaching Applications (10 Learning Labs, online)', cols: ['planned','actual'] },
        { key: 's5_ffc4',     label: 'Step 4 — FFC Module 3: Coaching Mastery (Coaching Circles and Mastery Milestone, both online)', hours: '12 hrs', cols: ['planned','actual'] },
        { key: 's5_ffc5',     label: 'Step 5 — Experience (financial coaching)', hours: '1,000 hrs', cols: ['planned','actual'] },
        { key: 's5_ffc6',     label: 'Step 6 — Code of Ethics', cols: ['planned','actual'] },
        { key: 's5_ffc_cert', label: 'AFCPE Financial Fitness Coach Certification', cols: ['cert'] },
        { key: 's5_ffc_re',   label: 'AFCPE FFC Certification (Recertification)', hours: '30 hrs/2 yrs CE', cols: ['planned','actual'] },
      ]},
    ],
  },
};

// ── Module state ──────────────────────────────────────────────────────────────
let _isED         = false;
let _myCounselorId = '';
let _myName       = '';
let _edCounselors = [];

// ── Entry point ───────────────────────────────────────────────────────────────
requireAuth(async (user, profile) => {
  _myName = profile.name || profile.email || '';
  _isED   = profile.role === 'executive_director';
  setupNav(profile, 'training');

  // Resolve counselor doc ID by matching email field
  try {
    const snap = await getDocs(query(collection(db, 'counselors'), orderBy('name')));
    const mine = snap.docs.find(d => (d.data().email || '').toLowerCase() === user.email.toLowerCase());
    _myCounselorId = mine ? mine.id : user.uid;

    if (_isED) {
      _edCounselors = snap.docs
        .filter(d => d.data().active !== false && d.id !== _myCounselorId)
        .map(d => ({ id: d.id, ...d.data() }));
    }
  } catch (_) {
    _myCounselorId = user.uid;
  }

  // Render own plan
  const myData = await loadPlan(_myCounselorId);
  renderPlan('mine', myData, _myCounselorId);

  // ED: add a tab + panel per counselor
  if (_isED) {
    const tabBar = document.getElementById('trainTabBar');
    const main   = document.querySelector('main.page');

    for (const c of _edCounselors) {
      const tabId   = `counselor-${c.id}`;
      const panelId = `panel-${tabId}`;

      const btn = document.createElement('button');
      btn.className       = 'train-tab';
      btn.dataset.tab     = tabId;
      btn.textContent     = c.name || c.id;
      tabBar.appendChild(btn);

      const panel = document.createElement('div');
      panel.className = 'train-panel';
      panel.id        = panelId;
      panel.innerHTML = `
        <div id="${tabId}-status" class="status-bar"></div>
        <div id="${tabId}-form"></div>
        <div class="save-bar">
          <button class="btn btn-primary" id="${tabId}-save">Save Changes</button>
          <span id="${tabId}-msg" class="hidden" style="font-size:0.8125rem;"></span>
        </div>`;
      main.appendChild(panel);

      btn.addEventListener('click', async () => {
        switchTab(tabId);
        // Lazy-load on first click
        if (!panel.dataset.loaded) {
          panel.dataset.loaded = '1';
          const data = await loadPlan(c.id);
          renderPlan(tabId, data, c.id);
        }
      });
    }
  }

  // Wire tab bar for "mine" tab
  document.querySelector('.train-tab[data-tab="mine"]').addEventListener('click', () => switchTab('mine'));
});

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.train-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.train-panel').forEach(p => p.classList.toggle('active', p.id === `panel-${tab}`));
}

// ── Firestore ─────────────────────────────────────────────────────────────────
async function loadPlan(counselorId) {
  try {
    const snap = await getDoc(doc(db, 'trainingPlans', counselorId));
    return snap.exists() ? snap.data() : {};
  } catch (_) {
    return {};
  }
}

async function savePlan(counselorId, data, tabId) {
  const saveBtn = document.getElementById(`${tabId}-save`);
  const msgEl   = document.getElementById(`${tabId}-msg`);
  saveBtn.disabled    = true;
  saveBtn.textContent = 'Saving…';
  msgEl.classList.add('hidden');
  try {
    await setDoc(doc(db, 'trainingPlans', counselorId), { ...data, updatedAt: serverTimestamp() }, { merge: true });
    showMsg(msgEl, 'Saved.', true);
    // Refresh status bar
    const fresh = await loadPlan(counselorId);
    renderStatusBar(tabId, fresh);
  } catch (err) {
    showMsg(msgEl, 'Save failed: ' + err.message, false);
  } finally {
    saveBtn.disabled    = false;
    saveBtn.textContent = 'Save Changes';
  }
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderPlan(tabId, data, counselorId) {
  renderStatusBar(tabId, data);
  renderForm(tabId, data, counselorId);
}

function renderStatusBar(tabId, data) {
  const el = document.getElementById(`${tabId}-status`);
  if (!el) return;

  const checks = [
    { label: 'Ethics',         keys: ['phfa_ethics','natl_ethics'],      col: 'cert' },
    { label: 'PHFA Required',  keys: ['s2_specexam','s2_speccert'],       col: 'cert' },
    { label: 'HUD Cert',       keys: ['s4_hudtest'],                      col: 'cert' },
    { label: 'HEMAP',          keys: ['s3_hemapexam'],                    col: 'cert' },
    { label: 'HO — NCHEC',     keys: ['s4_nchec_ho_cert'],               col: 'cert' },
    { label: 'HO — NHNLA',     keys: ['s4_nhnla_ho_cert'],               col: 'cert' },
    { label: 'FC — NCHEC',     keys: ['s4_nchec_fc_cert'],               col: 'cert' },
    { label: 'FC — NHNLA',     keys: ['s4_nhnla_fc_cert'],               col: 'cert' },
    { label: 'FC — NREI',      keys: ['s4_nrei_fc_cert'],                col: 'cert' },
    { label: 'FC — NFCC',      keys: ['s4_nfcc_cert'],                   col: 'cert' },
    { label: 'HECM',           keys: ['s5_hecm_roster'],                  col: 'cert' },
  ];

  el.innerHTML = checks.map(c => {
    const filled   = c.keys.filter(k => data[k]?.[c.col]).length;
    const cls      = filled === c.keys.length ? 'done' : filled > 0 ? 'partial' : 'empty';
    return `<span class="status-chip ${cls}">${escHtml(c.label)}</span>`;
  }).join('');
}

function renderForm(tabId, data, counselorId) {
  const el = document.getElementById(`${tabId}-form`);
  if (!el) return;

  let html = '';
  for (const [sKey, section] of Object.entries(SCHEMA)) {
    html += `
      <div class="train-section open" id="${tabId}-${sKey}">
        <div class="train-section-header">
          <span class="train-section-title">${escHtml(section.title)}</span>
          <span class="train-section-arrow">&#9654;</span>
        </div>
        <div class="train-section-body">`;

    for (const group of section.groups) {
      html += buildGroupTable(tabId, group, data);
    }

    html += `</div></div>`;
  }

  el.innerHTML = html;

  // Toggle collapse
  el.querySelectorAll('.train-section-header').forEach(hdr => {
    hdr.addEventListener('click', () => {
      hdr.closest('.train-section').classList.toggle('open');
    });
  });

  // Save button
  document.getElementById(`${tabId}-save`).addEventListener('click', () => {
    const collected = collectFormData(tabId);
    savePlan(counselorId, collected, tabId);
  });
}

function buildGroupTable(tabId, group, data) {
  // Determine which columns are used across this group's rows
  const allCols = new Set(group.rows.flatMap(r => r.cols));
  const COL_LABELS = { planned: 'Planned', actual: 'Actual', cert: 'Date of Certification' };
  const usedCols = ['planned','actual','cert'].filter(c => allCols.has(c));

  let html = `
    <div class="subsection-label">${escHtml(group.label)}</div>
    <table class="train-table">
      <thead><tr>
        <th style="width:55%;">Course / Requirement</th>
        <th style="width:6%;text-align:center;">Hours</th>
        ${usedCols.map(c => `<th>${COL_LABELS[c]}</th>`).join('')}
      </tr></thead>
      <tbody>`;

  for (const row of group.rows) {
    const saved = data[row.key] || {};
    html += `<tr>
      <td class="row-label">${escHtml(row.label)}</td>
      <td style="text-align:center;white-space:nowrap;">
        ${row.hours != null ? `<span class="hours-badge">${escHtml(String(row.hours))}</span>` : ''}
      </td>`;
    for (const col of usedCols) {
      if (row.cols.includes(col)) {
        html += `<td><input type="date" data-key="${escAttr(row.key)}" data-col="${escAttr(col)}" value="${escAttr(saved[col] || '')}"></td>`;
      } else {
        html += `<td></td>`;
      }
    }
    html += `</tr>`;
  }

  html += `</tbody></table>`;
  return html;
}

function collectFormData(tabId) {
  const panel  = document.getElementById(`panel-${tabId}`);
  const inputs = panel.querySelectorAll('input[data-key]');
  const out    = {};
  inputs.forEach(inp => {
    const key = inp.dataset.key;
    const col = inp.dataset.col;
    if (!out[key]) out[key] = {};
    out[key][col] = inp.value || '';
  });
  return out;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function escHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(str) {
  return (str || '').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function showMsg(el, text, success) {
  el.textContent = text;
  el.style.color = success ? 'var(--accent)' : 'var(--danger)';
  el.classList.remove('hidden');
  if (success) setTimeout(() => el.classList.add('hidden'), 3000);
}
