import { db } from './firebase-config.js';
import {
  collection, getDocs, query, orderBy
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const RECOMMEND_POSITIVE = new Set(['Definitely', 'Probably']);
const BLOCK_LABELS = { 'buyer-ready': 'Buyer Ready', 'rent-ready': 'Rent Ready' };

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function ratingBadge(r) {
  const s = {
    Excellent: 'background:#dcfce7;color:#15803d',
    Good:      'background:#dbeafe;color:#1e40af',
    Fair:      'background:#fef9c3;color:#854d0e',
    Poor:      'background:#fee2e2;color:#dc2626',
  };
  return r
    ? `<span style="display:inline-block;padding:0.1em 0.55em;border-radius:999px;font-size:0.72rem;font-weight:700;${s[r] || 'background:#f1f5f9;color:#374151'}">${escHtml(r)}</span>`
    : '—';
}

export async function initCloseoutSurveys() {
  const statsEl = document.getElementById('closeoutStats');
  const tableEl = document.getElementById('closeoutTable');
  if (!statsEl || !tableEl) return;

  statsEl.innerHTML = '<p style="color:var(--text-muted);font-size:0.875rem;">Loading…</p>';
  tableEl.innerHTML = '';

  try {
    const [responsesSnap, tokensSnap] = await Promise.all([
      getDocs(query(collection(db, 'surveyResponses'), orderBy('submittedAt', 'desc'))),
      getDocs(collection(db, 'surveyTokens')),
    ]);

    const responses = responsesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const sent  = tokensSnap.size;
    const count = responses.length;
    const responseRate = sent > 0 ? Math.round(count / sent * 100) : 0;

    const pctOf = (n) => count ? Math.round(n / count * 100) : 0;
    const positiveRating = responses.filter(r => r.responses?.overallRating === 'Excellent' || r.responses?.overallRating === 'Good').length;
    const wouldRecommend = responses.filter(r => RECOMMEND_POSITIVE.has(r.responses?.wouldRecommend)).length;
    const improved       = responses.filter(r => r.responses?.housingSituationChange === 'Improved').length;
    const feltHeard      = responses.filter(r => r.responses?.feltHeard === 'Yes').length;

    statsEl.innerHTML = `
      <div class="stat-grid">
        <div class="stat-card">
          <div class="stat-label">Surveys Sent</div>
          <div class="stat-value">${sent}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Responses Received</div>
          <div class="stat-value">${count}</div>
          <div style="font-size:0.78rem;color:var(--text-muted);">${responseRate}% response rate</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Positive Rating</div>
          <div class="stat-value">${pctOf(positiveRating)}%</div>
          <div style="font-size:0.78rem;color:var(--text-muted);">Excellent or Good</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Would Recommend</div>
          <div class="stat-value">${pctOf(wouldRecommend)}%</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Housing Improved</div>
          <div class="stat-value">${pctOf(improved)}%</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Felt Heard</div>
          <div class="stat-value">${pctOf(feltHeard)}%</div>
        </div>
      </div>`;

    if (!count) {
      tableEl.innerHTML = '<p style="color:var(--text-muted);font-size:0.875rem;padding:0.5rem 0;">No survey responses yet.</p>';
      return;
    }

    // Breakdown by counseling type
    const byType = {};
    responses.forEach(r => {
      const key = r.counselingType || '(unknown)';
      if (!byType[key]) byType[key] = { count: 0, positive: 0, recommend: 0 };
      byType[key].count++;
      if (r.responses?.overallRating === 'Excellent' || r.responses?.overallRating === 'Good') byType[key].positive++;
      if (RECOMMEND_POSITIVE.has(r.responses?.wouldRecommend)) byType[key].recommend++;
    });

    const breakdownRows = Object.entries(byType)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([type, s]) => `<tr>
        <td>${escHtml(type)}</td>
        <td style="text-align:right;">${s.count}</td>
        <td style="text-align:right;">${Math.round(s.positive / s.count * 100)}%</td>
        <td style="text-align:right;">${Math.round(s.recommend / s.count * 100)}%</td>
      </tr>`).join('');

    // Individual responses
    const responseRows = responses.map(r => {
      const prog     = r.programBlock ? (BLOCK_LABELS[r.programBlock] || r.programBlock) : '—';
      const comments = r.responses?.additionalComments || '';
      const preview  = comments.length > 60 ? comments.slice(0, 60) + '…' : comments;
      return `<tr>
        <td style="white-space:nowrap;">${fmtDate(r.submittedAt)}</td>
        <td><a href="client.html?id=${escHtml(r.clientId)}" style="color:var(--primary);text-decoration:none;">${escHtml(r.clientName || '—')}</a></td>
        <td>${escHtml(r.counselor || '—')}</td>
        <td>${escHtml(r.counselingType || '—')}</td>
        <td>${escHtml(prog)}</td>
        <td>${ratingBadge(r.responses?.overallRating)}</td>
        <td>${escHtml(r.responses?.wouldRecommend || '—')}</td>
        <td>${escHtml(r.responses?.housingSituationChange || '—')}</td>
        <td style="font-size:0.78rem;color:var(--text-muted);font-style:italic;">${escHtml(preview) || '—'}</td>
      </tr>`;
    }).join('');

    tableEl.innerHTML = `
      <div style="margin-bottom:1.5rem;">
        <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted);margin-bottom:0.5rem;">By Counseling Type</div>
        <table class="status-table">
          <thead><tr>
            <th>Type</th>
            <th style="text-align:right;">Responses</th>
            <th style="text-align:right;">% Positive</th>
            <th style="text-align:right;">% Recommend</th>
          </tr></thead>
          <tbody>${breakdownRows}</tbody>
        </table>
      </div>
      <div>
        <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted);margin-bottom:0.5rem;">All Responses</div>
        <div style="overflow-x:auto;">
          <table class="status-table">
            <thead><tr>
              <th>Date</th><th>Client</th><th>Counselor</th><th>Type</th><th>Program</th>
              <th>Rating</th><th>Recommend</th><th>Housing</th><th>Comments</th>
            </tr></thead>
            <tbody>${responseRows}</tbody>
          </table>
        </div>
      </div>`;

  } catch (err) {
    statsEl.innerHTML = `<p style="color:var(--danger,#dc2626);font-size:0.875rem;">Failed to load: ${escHtml(err.message)}</p>`;
  }
}
