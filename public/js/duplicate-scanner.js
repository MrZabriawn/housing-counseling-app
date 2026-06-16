/**
 * duplicate-scanner.js — Pure matching logic shared between settings.js and duplicates.js
 * No DOM, no Firebase. All functions are exported.
 */

export function nameTokens(name) {
  return (name || '').toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean);
}

export function tokenOverlapScore(a, b) {
  const ta = new Set(nameTokens(a));
  const tb = nameTokens(b);
  if (!ta.size || !tb.length) return 0;
  const shared = tb.filter(t => ta.has(t)).length;
  return shared / Math.max(ta.size, tb.length);
}

function editDistance(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

export function nameSimilarity(a, b) {
  const na = (a || '').toLowerCase().replace(/[^a-z]/g, '');
  const nb = (b || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!na || !nb) return 0;
  const maxLen = Math.max(na.length, nb.length);
  return 1 - editDistance(na, nb) / maxLen;
}

export function reversedName(name) {
  const m = (name || '').match(/^([^,]+),\s*(.+)$/);
  return m ? `${m[2]} ${m[1]}` : name;
}

export function rxOverlap(a, b) {
  const rxA = (a.rxNumbers || []).filter(r => r && r.trim());
  const rxB = new Set((b.rxNumbers || []).filter(r => r && r.trim()));
  return rxA.filter(r => rxB.has(r));
}

export function findReasons(a, b) {
  const reasons = [];

  // Shared Rx numbers (highest-confidence signal)
  const shared = rxOverlap(a, b);
  if (shared.length) reasons.push({ text: `Shared Rx: ${shared.join(', ')}`, confidence: 'high' });

  // Missing first/last name detection — one record is a single token that appears in the other
  const aTokens = nameTokens(a.clientName);
  const bTokens = nameTokens(b.clientName);
  if (aTokens.length === 1 && bTokens.length > 1 && bTokens.includes(aTokens[0])) {
    reasons.push({ text: `"${a.clientName}" may be missing a name part (found in "${b.clientName}")`, confidence: 'medium' });
  } else if (bTokens.length === 1 && aTokens.length > 1 && aTokens.includes(bTokens[0])) {
    reasons.push({ text: `"${b.clientName}" may be missing a name part (found in "${a.clientName}")`, confidence: 'medium' });
  }

  // Name similarity signals — minimum 75% to surface as a name-only match
  const overlap       = tokenOverlapScore(a.clientName, b.clientName);
  const similarity    = nameSimilarity(a.clientName, b.clientName);
  const revA          = reversedName(a.clientName);
  const revSimilarity = nameSimilarity(revA, b.clientName);
  const revOverlap    = tokenOverlapScore(revA, b.clientName);

  if (overlap >= 0.99 || similarity >= 0.97) {
    reasons.push({ text: 'Near-identical names', confidence: 'high' });
  } else if (revSimilarity >= 0.85 || revOverlap >= 0.85) {
    reasons.push({ text: 'Possible name reversal (Last, First vs First Last)', confidence: 'high' });
  } else if (overlap >= 0.75 || similarity >= 0.80) {
    reasons.push({ text: `Similar names (${Math.round(Math.max(overlap, similarity) * 100)}% match)`, confidence: 'medium' });
  }
  // Below 75%: name alone is not enough — no reason added

  // Same zip + same counseling type + any name similarity (non-name signals required)
  if (!reasons.length && a.zipCode && a.zipCode === b.zipCode && a.counselingType === b.counselingType && overlap >= 0.3) {
    reasons.push({ text: `Same zip (${a.zipCode}) + same counseling type + partial name match`, confidence: 'low' });
  }

  return reasons;
}

export function pairKey(a, b) {
  return [a.id, b.id].sort().join('|');
}

export const confidenceColor = { high: 'var(--danger)', medium: '#e65100', low: 'var(--text-muted)' };
export const confidenceLabel = { high: 'Strong match', medium: 'Possible match', low: 'Weak signal' };

export function confRank(r) {
  return r.confidence === 'high' ? 0 : r.confidence === 'medium' ? 1 : 2;
}
