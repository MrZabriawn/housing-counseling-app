import { db } from './firebase-config.js';
import { GOOGLE_CHAT_SURVEY_WEBHOOK } from './app-config.js';
import {
  doc, getDoc, updateDoc, addDoc, collection, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const params  = new URLSearchParams(window.location.search);
const tokenId = params.get('token');
const app     = document.getElementById('svApp');

const QUESTIONS_CORE = [
  { key: 'overallRating',          label: 'How would you rate the overall quality of your counseling?',                           options: ['Excellent','Good','Fair','Poor'] },
  { key: 'optionsExplained',       label: 'Did your counselor explain your options clearly?',                                      options: ['Yes','Somewhat','No'] },
  { key: 'feltHeard',              label: 'Did you feel heard and respected throughout the process?',                              options: ['Yes','Somewhat','No'] },
  { key: 'tookAction',             label: 'Were you able to take action as a result of your session(s)?',                         options: ['Yes','Still working on it','No'] },
  { key: 'wouldRecommend',         label: 'Would you recommend this service to someone in a similar situation?',                   options: ['Definitely','Probably','Probably not','No'] },
  { key: 'housingSituationChange', label: 'How has your housing situation changed since you started counseling?',                  options: ['Improved','About the same','Worsened'] },
];

const QUESTIONS_BUYER_READY = [
  { key: 'purchasedHome', label: 'Have you purchased a home since completing the program?',                              options: ['Yes','Not yet','No longer planning to'] },
  { key: 'receivedDpa',   label: 'Did you receive down payment assistance (DPA)?',                                       options: ['Yes','No','Applied but did not qualify'] },
  { key: 'howPrepared',   label: 'How prepared did you feel to buy a home after your counseling?',                       options: ['Very Prepared','Prepared','Somewhat Prepared','Not Prepared'] },
];

const QUESTIONS_RENT_READY = [
  { key: 'securedHousing',        label: 'Did you secure or maintain stable housing since your counseling?',             options: ['Yes','Not yet','No'] },
  { key: 'currentOnRent',         label: 'Have you been able to stay current on rent payments?',                         options: ['Yes','Most months','No'] },
  { key: 'financialImprovement',  label: 'Did your financial situation improve as a result of this program?',            options: ['Yes','Somewhat','No'] },
];

const BLOCK_LABELS = {
  'buyer-ready': 'Buyer Ready',
  'rent-ready':  'Rent Ready',
};

function renderState(icon, title, body) {
  app.innerHTML = `
    <div class="sv-state">
      <div class="sv-state-icon">${icon}</div>
      <div class="sv-state-title">${title}</div>
      <div class="sv-state-body">${body}</div>
    </div>`;
}

function renderQuestion(q, idx) {
  return `<div class="sv-q">
    <label class="sv-q-label">${idx + 1}. ${q.label}</label>
    <div class="sv-options">
      ${q.options.map(opt => `
        <label class="sv-option">
          <input type="radio" name="${q.key}" value="${opt}" required>
          ${opt}
        </label>`).join('')}
    </div>
  </div>`;
}

function renderForm(tokenData) {
  const { clientName, programBlock } = tokenData;
  const addonLabel = programBlock && BLOCK_LABELS[programBlock]
    ? `<span class="sv-addon-badge">${BLOCK_LABELS[programBlock]}</span>`
    : '';

  const addonQuestions = programBlock === 'buyer-ready' ? QUESTIONS_BUYER_READY
    : programBlock === 'rent-ready'  ? QUESTIONS_RENT_READY
    : [];

  const coreHtml   = QUESTIONS_CORE.map((q, i) => renderQuestion(q, i)).join('');
  const addonHtml  = addonQuestions.length
    ? `<div class="sv-section-label">${BLOCK_LABELS[programBlock]} — Additional Questions${addonLabel}</div>` +
      addonQuestions.map((q, i) => renderQuestion(q, QUESTIONS_CORE.length + i)).join('')
    : '';

  const commentIdx = QUESTIONS_CORE.length + addonQuestions.length;

  app.innerHTML = `
    <div class="sv-title">Client Satisfaction Survey</div>
    <p class="sv-intro">
      Thank you for working with Housing Opportunities, Inc., ${clientName ? escHtml(clientName.split(' ')[0]) : 'and welcome'}.
      Your feedback helps us improve our services. This survey takes about 2 minutes.
    </p>

    <form id="svForm" novalidate>
      <div class="sv-section-label">Your Experience</div>
      ${coreHtml}
      ${addonHtml}
      <div class="sv-section-label">Comments</div>
      <div class="sv-q">
        <label class="sv-q-label">${commentIdx + 1}. Any additional comments or suggestions?</label>
        <textarea class="sv-comments form-control" name="additionalComments" placeholder="Optional"></textarea>
      </div>

      <div class="sv-submit">
        <button type="submit" class="btn btn-primary" id="svSubmitBtn">Submit Survey</button>
        <div class="sv-error" id="svError"></div>
      </div>
    </form>`;

  document.getElementById('svForm').addEventListener('submit', e => handleSubmit(e, tokenData));
}

async function handleSubmit(e, tokenData) {
  e.preventDefault();
  const form      = e.target;
  const errorEl   = document.getElementById('svError');
  const submitBtn = document.getElementById('svSubmitBtn');
  errorEl.style.display = 'none';

  // Validate all required radio groups
  const required = [...QUESTIONS_CORE, ...(
    tokenData.programBlock === 'buyer-ready' ? QUESTIONS_BUYER_READY :
    tokenData.programBlock === 'rent-ready'  ? QUESTIONS_RENT_READY  : []
  )];
  for (const q of required) {
    if (!form.querySelector(`input[name="${q.key}"]:checked`)) {
      errorEl.textContent   = 'Please answer all questions before submitting.';
      errorEl.style.display = 'block';
      return;
    }
  }

  submitBtn.disabled    = true;
  submitBtn.textContent = 'Submitting…';

  const responses = {};
  required.forEach(q => {
    const checked = form.querySelector(`input[name="${q.key}"]:checked`);
    if (checked) responses[q.key] = checked.value;
  });
  const comments = form.querySelector('[name="additionalComments"]');
  if (comments?.value.trim()) responses.additionalComments = comments.value.trim();

  try {
    await addDoc(collection(db, 'surveyResponses'), {
      tokenId:       tokenId,
      clientId:      tokenData.clientId,
      clientName:    tokenData.clientName  || '',
      counselingType:tokenData.counselingType || '',
      programBlock:  tokenData.programBlock || null,
      counselor:     tokenData.counselor   || '',
      responses,
      submittedAt:   serverTimestamp(),
    });

    await updateDoc(doc(db, 'surveyTokens', tokenId), { used: true });

    postToWebhook(tokenData, responses);

    renderState('✅', 'Thank You!',
      'Your response has been recorded. We appreciate you taking the time to share your experience with Housing Opportunities, Inc.');

  } catch (err) {
    errorEl.textContent   = 'Could not submit. Please try again.';
    errorEl.style.display = 'block';
    submitBtn.disabled    = false;
    submitBtn.textContent = 'Submit Survey';
  }
}

function postToWebhook(tokenData, responses) {
  if (!GOOGLE_CHAT_SURVEY_WEBHOOK) return;
  const rating   = responses.overallRating         || '—';
  const recommend= responses.wouldRecommend         || '—';
  const change   = responses.housingSituationChange || '—';
  const block    = tokenData.programBlock && BLOCK_LABELS[tokenData.programBlock]
    ? ` (${BLOCK_LABELS[tokenData.programBlock]})` : '';
  const text = `📋 *Survey Response Received*\n`
    + `*Client:* ${tokenData.clientName || '(unknown)'}\n`
    + `*Program:* ${tokenData.counselingType || '—'}${block}\n`
    + `*Counselor:* ${tokenData.counselor || '—'}\n`
    + `*Rating:* ${rating}  |  *Would Recommend:* ${recommend}  |  *Housing Change:* ${change}`;

  fetch(GOOGLE_CHAT_SURVEY_WEBHOOK, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ text }),
  }).catch(() => {});
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function init() {
  if (!tokenId) {
    renderState('🔗', 'Invalid Link', 'This survey link is not valid. Please contact <a href="mailto:office@housingopps.org">office@housingopps.org</a> if you need a new link.');
    return;
  }

  try {
    const snap = await getDoc(doc(db, 'surveyTokens', tokenId));

    if (!snap.exists()) {
      renderState('🔗', 'Link Not Found', 'This survey link could not be found. It may have already expired or been removed.');
      return;
    }

    const data = snap.data();

    if (data.used) {
      renderState('✅', 'Already Submitted', 'Your survey response has already been recorded. Thank you for your feedback!');
      return;
    }

    const expires = data.expiresAt?.toDate ? data.expiresAt.toDate() : new Date(data.expiresAt);
    if (expires < new Date()) {
      renderState('⏰', 'Link Expired', 'This survey link has expired. Please contact <a href="mailto:office@housingopps.org">office@housingopps.org</a> if you need a new link.');
      return;
    }

    renderForm(data);

  } catch (err) {
    renderState('⚠️', 'Something Went Wrong', 'Could not load the survey. Please try again or contact <a href="mailto:office@housingopps.org">office@housingopps.org</a>.');
  }
}

init();
