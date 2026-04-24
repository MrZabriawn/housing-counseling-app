import { db } from './firebase-config.js';
import { requireAuth, setupNav } from './auth.js';
import { COUNSELING_TYPES, AMI_LEVELS, RE_CODES, AWARD_TYPES } from './data.js';
import {
  collection, addDoc, getDocs, query, orderBy, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const HOUSING_EXP_IDS = [
  'expMortgage1','expMortgage2','expMortgage3','expPropertyTax','expHazardIns',
  'expCondoFees','expAssocDues','expOtherHousing','expElectric','expGas',
  'expOil','expWater','expSewer','expTrash',
];
const LIVING_EXP_IDS = [
  'expGroceries','expLunches','expPetCare','expPetFood','expTobacco','expHairCuts',
  'expLaundry','expClothing','expCellPhone','expHomePhone','expCableTV','expInternet',
  'expHomeMaint','expAutoIns','expGasoline','expCarRepair','expBusParking',
  'expPrescriptions','expCopays','expDayCare','expChurch','expEntertainment',
  'expNewspaper','expClubs','expOtherLiving1','expOtherLiving2','expOtherLiving3',
];

function toTitleCase(str) {
  if (!str) return str;
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function numVal(id) {
  return parseFloat(document.getElementById(id)?.value || '0') || 0;
}

function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escAttr(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

let _user = null;

requireAuth(async (user, profile) => {
  _user = user;
  setupNav(profile, 'clients');

  appendOptions('counselingType', COUNSELING_TYPES);
  appendOptions('amiPercent',     AMI_LEVELS);
  appendOptions('reCode',         RE_CODES);
  appendOptions('awardType',      AWARD_TYPES);
  await loadCounselorOptions('counselor', profile.name);

  document.getElementById('sessionDate').value = new Date().toISOString().split('T')[0];

  document.getElementById('bankruptcyFiled').addEventListener('change', e => {
    document.getElementById('bankruptcyAccountGroup').style.display = e.target.checked ? '' : 'none';
  });

  // Table buttons
  document.getElementById('addEmpRowBtn').addEventListener('click', () => {
    document.getElementById('empBody').appendChild(makeEmpRow());
  });
  document.getElementById('addIncomeRowBtn').addEventListener('click', () => {
    document.getElementById('incomeBody').appendChild(makeIncomeRow());
  });
  document.getElementById('addLiabilityRowBtn').addEventListener('click', () => {
    document.getElementById('liabilityBody').appendChild(makeLiabilityRow());
    updateLiabilityTotals();
  });

  // Expense sheet auto-totals
  document.addEventListener('input', e => {
    if (e.target.classList.contains('housing-exp')) updateHousingTotal();
    if (e.target.classList.contains('living-exp'))  updateLivingTotal();
  });

  // Seed one empty row in each table
  document.getElementById('empBody').appendChild(makeEmpRow());
  document.getElementById('incomeBody').appendChild(makeIncomeRow());
  document.getElementById('liabilityBody').appendChild(makeLiabilityRow());
  updateLiabilityTotals();

  document.getElementById('newClientForm').addEventListener('submit', handleSubmit);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function appendOptions(id, list) {
  const sel = document.getElementById(id);
  if (!sel) return;
  list.forEach(v => {
    const o = document.createElement('option');
    o.value = v; o.textContent = v;
    sel.appendChild(o);
  });
}

async function loadCounselorOptions(selectId, currentUserName) {
  try {
    const snap = await getDocs(query(collection(db, 'counselors'), orderBy('name')));
    const sel  = document.getElementById(selectId);
    snap.docs
      .filter(d => d.data().active !== false)
      .forEach(d => {
        const o = document.createElement('option');
        o.value = d.data().name;
        o.textContent = d.data().name;
        sel.appendChild(o);
      });
    if (currentUserName) {
      for (const opt of sel.options) {
        if (opt.value.toLowerCase() === currentUserName.toLowerCase()) {
          sel.value = opt.value; break;
        }
      }
    }
  } catch (_) {}
}

// ── Employment rows ───────────────────────────────────────────────────────────

function makeEmpRow(r = {}) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="emp-who"      value="${escAttr(r.who || '')}"></td>
    <td><input type="text" class="emp-employer" value="${escAttr(r.employer || '')}"></td>
    <td><input type="text" class="emp-start"    value="${escAttr(r.startDate || '')}" placeholder="MM/YY"></td>
    <td><input type="text" class="emp-end"      value="${escAttr(r.endDate || '')}" placeholder="MM/YY or Current"></td>
    <td><input type="text" class="emp-position" value="${escAttr(r.position || '')}"></td>
    <td><input type="text" class="emp-reason"   value="${escAttr(r.reasonForLeaving || '')}"></td>
    <td><input type="number" class="emp-gross"  value="${r.grossMonthly || ''}" min="0" step="0.01"></td>
    <td><input type="number" class="emp-net"    value="${r.netMonthly || ''}" min="0" step="0.01"></td>
    <td><button type="button" class="del-btn" title="Remove row">&times;</button></td>`;
  tr.querySelector('.del-btn').addEventListener('click', () => tr.remove());
  return tr;
}

function readEmpRows() {
  return [...document.querySelectorAll('#empBody tr')].map(row => ({
    who:              row.querySelector('.emp-who')?.value.trim()       || '',
    employer:         row.querySelector('.emp-employer')?.value.trim()  || '',
    startDate:        row.querySelector('.emp-start')?.value.trim()     || '',
    endDate:          row.querySelector('.emp-end')?.value.trim()       || '',
    position:         row.querySelector('.emp-position')?.value.trim()  || '',
    reasonForLeaving: row.querySelector('.emp-reason')?.value.trim()    || '',
    grossMonthly:     parseFloat(row.querySelector('.emp-gross')?.value || '0') || 0,
    netMonthly:       parseFloat(row.querySelector('.emp-net')?.value   || '0') || 0,
  })).filter(r => r.who || r.employer || r.position || r.grossMonthly);
}

// ── Other income rows ─────────────────────────────────────────────────────────

function makeIncomeRow(r = {}) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text"   class="inc-who"    value="${escAttr(r.who || '')}"></td>
    <td><input type="text"   class="inc-source" value="${escAttr(r.source || '')}"></td>
    <td><input type="number" class="inc-amount" value="${r.monthlyAmount || ''}" min="0" step="0.01"></td>
    <td><input type="text"   class="inc-desc"   value="${escAttr(r.description || '')}"></td>
    <td><button type="button" class="del-btn" title="Remove row">&times;</button></td>`;
  tr.querySelector('.del-btn').addEventListener('click', () => tr.remove());
  return tr;
}

function readIncomeRows() {
  return [...document.querySelectorAll('#incomeBody tr')].map(row => ({
    who:           row.querySelector('.inc-who')?.value.trim()    || '',
    source:        row.querySelector('.inc-source')?.value.trim() || '',
    monthlyAmount: parseFloat(row.querySelector('.inc-amount')?.value || '0') || 0,
    description:   row.querySelector('.inc-desc')?.value.trim()   || '',
  })).filter(r => r.who || r.source || r.monthlyAmount);
}

// ── Liability rows ────────────────────────────────────────────────────────────

function makeLiabilityRow(r = {}) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text"   class="liab-name"          value="${escAttr(r.accountName || '')}"></td>
    <td><input type="number" class="liability-payment"  value="${r.monthlyPayment || ''}" min="0" step="0.01"></td>
    <td><input type="number" class="liability-balance"  value="${r.balance || ''}" min="0" step="0.01"></td>
    <td><input type="number" class="liability-limit"    value="${r.creditLimit || ''}" min="0" step="0.01" placeholder="Revolving only"></td>
    <td><button type="button" class="del-btn" title="Remove row">&times;</button></td>`;
  tr.querySelector('.del-btn').addEventListener('click', () => { tr.remove(); updateLiabilityTotals(); });
  tr.querySelector('.liability-payment').addEventListener('input', updateLiabilityTotals);
  tr.querySelector('.liability-balance').addEventListener('input', updateLiabilityTotals);
  tr.querySelector('.liability-limit').addEventListener('input', updateLiabilityTotals);
  return tr;
}

function readLiabilityRows() {
  return [...document.querySelectorAll('#liabilityBody tr')].map(row => ({
    accountName:    row.querySelector('.liab-name')?.value.trim()             || '',
    monthlyPayment: parseFloat(row.querySelector('.liability-payment')?.value || '0') || 0,
    balance:        parseFloat(row.querySelector('.liability-balance')?.value  || '0') || 0,
    creditLimit:    parseFloat(row.querySelector('.liability-limit')?.value    || '0') || 0,
  })).filter(r => r.accountName || r.monthlyPayment || r.balance);
}

function updateLiabilityTotals() {
  let pay = 0, bal = 0, lim = 0;
  document.querySelectorAll('#liabilityBody tr').forEach(row => {
    pay += parseFloat(row.querySelector('.liability-payment')?.value || '0') || 0;
    bal += parseFloat(row.querySelector('.liability-balance')?.value  || '0') || 0;
    lim += parseFloat(row.querySelector('.liability-limit')?.value    || '0') || 0;
  });
  document.getElementById('liabilityPaymentTotal').textContent     = fmtMoney(pay);
  document.getElementById('liabilityBalanceTotal').textContent      = fmtMoney(bal);
  document.getElementById('liabilityCreditLimitTotal').textContent  = fmtMoney(lim);
}

// ── Expense sheet totals ──────────────────────────────────────────────────────

function updateHousingTotal() {
  const total = HOUSING_EXP_IDS.reduce((s, id) => s + numVal(id), 0);
  document.getElementById('housingTotal').textContent = fmtMoney(total);
  updateGrandExpTotal();
}

function updateLivingTotal() {
  const total = LIVING_EXP_IDS.reduce((s, id) => s + numVal(id), 0);
  document.getElementById('livingTotal').textContent = fmtMoney(total);
  updateGrandExpTotal();
}

function updateGrandExpTotal() {
  const h = HOUSING_EXP_IDS.reduce((s, id) => s + numVal(id), 0);
  const l = LIVING_EXP_IDS.reduce((s, id) => s + numVal(id), 0);
  document.getElementById('grandExpTotal').textContent = fmtMoney(h + l);
}

function readExpFields() {
  const out = {};
  HOUSING_EXP_IDS.forEach(id => { out[id] = numVal(id); });
  LIVING_EXP_IDS.forEach(id => { out[id] = numVal(id); });
  return out;
}

// ── Submit ────────────────────────────────────────────────────────────────────

async function handleSubmit(e) {
  e.preventDefault();
  const errorEl   = document.getElementById('formError');
  const submitBtn = document.getElementById('submitBtn');
  errorEl.classList.add('hidden');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Creating…';

  try {
    const dateVal = document.getElementById('sessionDate').value;
    const now = serverTimestamp();

    const hours          = parseFloat(document.getElementById('hours').value)          || 0;
    const dollarsAwarded = parseFloat(document.getElementById('dollarsAwarded').value) || 0;

    const sessionData = {
      date:          dateVal ? new Date(dateVal + 'T12:00:00') : null,
      counselor:     document.getElementById('counselor').value,
      rxNumber:      document.getElementById('rxNumber').value.trim(),
      hours,
      dollarsAwarded,
      awardType:     document.getElementById('awardType').value,
      caseStatus:    document.getElementById('caseStatus').value.trim(),
      outcome:       document.getElementById('outcome').value.trim(),
      notes:         document.getElementById('notes').value.trim(),
      dollarsFor:    '',
      createdAt:     now,
      updatedAt:     now,
    };

    const rxRaw    = document.getElementById('rxNumber').value.trim();
    const rxNumbers = rxRaw ? [rxRaw] : [];
    const bkFiled  = document.getElementById('bankruptcyFiled').checked;
    const scoreEq  = parseFloat(document.getElementById('finScoreEq').value)  || null;
    const scoreEx  = parseFloat(document.getElementById('finScoreEx').value)  || null;
    const scoreTu  = parseFloat(document.getElementById('finScoreTu').value)  || null;

    const clientData = {
      clientName:        toTitleCase(document.getElementById('clientName').value.trim()),
      counselingType:    document.getElementById('counselingType').value,
      counselor:         document.getElementById('counselor').value,
      guarantor:         document.getElementById('guarantor').value.trim(),
      zipCode:           document.getElementById('zipCode').value.trim(),
      rxNumbers,
      amiPercent:        document.getElementById('amiPercent').value,
      reCode:            document.getElementById('reCode').value,
      hispanic:          document.getElementById('hispanic').checked,
      femaleHeaded:      document.getElementById('femaleHeaded').checked,
      areasOfInterest:   [],
      driveFolderId:     '',
      driveFolderName:   '',
      driveFolderUrl:    '',
      totalDownPayment:  0,
      ccaAmountProvided: 0,
      status:            'active',
      confidentialityTier: document.getElementById('programDesignation').value === 'safely_home' ? 'restricted' : 'standard',
      careTeam:            document.getElementById('programDesignation').value === 'safely_home' ? [_user.uid] : [],
      sessionCount:      1,
      totalOutcomeValue: dollarsAwarded,
      firstSessionDate:  dateVal ? new Date(dateVal + 'T12:00:00') : null,
      lastSessionDate:   dateVal ? new Date(dateVal + 'T12:00:00') : null,

      // Property & Mortgage
      propertyType:      document.getElementById('propertyType').value,
      mortgageType:      document.getElementById('mortgageType').value,
      mortgage1Company:  document.getElementById('mortgage1Company').value.trim(),
      mortgage2Company:  document.getElementById('mortgage2Company').value.trim(),
      mortgage3Company:  document.getElementById('mortgage3Company').value.trim(),
      primaryResidence:  document.getElementById('primaryResidence').checked,
      bankruptcyFiled:   bkFiled,
      bankruptcyAccount: bkFiled ? document.getElementById('bankruptcyAccount').value.trim() : '',

      // Employment & income tables
      employmentHistory:  readEmpRows(),
      otherIncome:        readIncomeRows(),
      monthlyLiabilities: readLiabilityRows(),

      // Expense sheet
      ...readExpFields(),

      // Liquidity & credit
      finLiquidAssets:   parseFloat(document.getElementById('finLiquidAssets').value)   || 0,
      finMonthlySavings: parseFloat(document.getElementById('finMonthlySavings').value) || 0,
      finScoreEq:        scoreEq,
      finScoreEx:        scoreEx,
      finScoreTu:        scoreTu,

      createdAt: now,
      updatedAt: now,
    };

    const clientRef = await addDoc(collection(db, 'clients'), clientData);
    await addDoc(collection(db, 'clients', clientRef.id, 'sessions'), sessionData);

    window.location.href = `client.html?id=${clientRef.id}`;
  } catch (err) {
    errorEl.textContent = 'Save failed: ' + err.message;
    errorEl.classList.remove('hidden');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create Client';
  }
}
