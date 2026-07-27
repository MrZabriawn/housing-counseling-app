// scripts/auto-merge-duplicates.js
// Finds strong-match duplicate client pairs and merges them automatically.
// "Strong match" = shared Rx numbers OR near-identical names (≥97% similarity
// or ≥99% token overlap) OR name reversal (≥85%).
// Mirrors the exact merge logic used in Settings → Duplicate Scanner → Merge.
//
// Usage:
//   node scripts/auto-merge-duplicates.js --dry-run   ← always run this first
//   node scripts/auto-merge-duplicates.js

const path  = require('path');
const admin = require('firebase-admin');

const saPath = process.env.SERVICE_ACCOUNT
  ? path.resolve(process.env.SERVICE_ACCOUNT)
  : path.resolve(__dirname, 'housing-counseling-firebase-adminsdk-fbsvc-7c2887a805.json');

admin.initializeApp({ credential: admin.credential.cert(require(saPath)) });
const db  = admin.firestore();
const now = admin.firestore.FieldValue.serverTimestamp();

// ── Matching logic (mirrors duplicate-scanner.js) ────────────────────────────

function nameTokens(name) {
  return (name || '').toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean);
}

function tokenOverlapScore(a, b) {
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

function nameSimilarity(a, b) {
  const na = (a || '').toLowerCase().replace(/[^a-z]/g, '');
  const nb = (b || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!na || !nb) return 0;
  return 1 - editDistance(na, nb) / Math.max(na.length, nb.length);
}

function reversedName(name) {
  const m = (name || '').match(/^([^,]+),\s*(.+)$/);
  return m ? `${m[2]} ${m[1]}` : name;
}

function rxOverlap(a, b) {
  const rxA = (a.rxNumbers || []).filter(r => r && r.trim());
  const rxB = new Set((b.rxNumbers || []).filter(r => r && r.trim()));
  return rxA.filter(r => rxB.has(r));
}

function isStrongMatch(a, b) {
  const overlap    = tokenOverlapScore(a.clientName, b.clientName);
  const similarity = nameSimilarity(a.clientName, b.clientName);

  // Shared Rx is only treated as a merge signal when names are also similar —
  // otherwise it indicates co-borrowers on the same property, not duplicates.
  const shared = rxOverlap(a, b);
  if (shared.length && (overlap >= 0.5 || similarity >= 0.5)) {
    return `Shared Rx: ${shared.join(', ')} + similar names`;
  }

  if (overlap >= 0.99 || similarity >= 0.97) return `Near-identical names (${Math.round(Math.max(overlap, similarity) * 100)}%)`;

  const revA          = reversedName(a.clientName);
  const revSimilarity = nameSimilarity(revA, b.clientName);
  const revOverlap    = tokenOverlapScore(revA, b.clientName);
  if (revSimilarity >= 0.85 || revOverlap >= 0.85) return `Name reversal match (${Math.round(Math.max(revSimilarity, revOverlap) * 100)}%)`;

  return null;
}

// ── Merge logic (mirrors performMerge in settings.js) ────────────────────────

function toDate(ts) {
  if (!ts) return null;
  if (ts.toDate) return ts.toDate();
  if (ts._seconds) return new Date(ts._seconds * 1000);
  return new Date(ts);
}

async function merge(keepId, dropId, dryRun) {
  const [keepSnap, dropSnap] = await Promise.all([
    db.collection('clients').doc(keepId).get(),
    db.collection('clients').doc(dropId).get(),
  ]);
  if (!keepSnap.exists || !dropSnap.exists) return 'skipped — one or both clients already gone';

  const keep = keepSnap.data();
  const drop = dropSnap.data();

  const sessSnap   = await db.collection('clients').doc(dropId).collection('sessions').get();
  const dropSessions = sessSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  if (dryRun) return `would move ${dropSessions.length} session(s) from "${drop.clientName}" → "${keep.clientName}"`;

  // Move sessions in batches
  for (let i = 0; i < dropSessions.length; i += 490) {
    const batch = db.batch();
    dropSessions.slice(i, i + 490).forEach(s => {
      const { id, ...data } = s;
      batch.set(db.collection('clients').doc(keepId).collection('sessions').doc(), { ...data, mergedFrom: dropId });
      batch.delete(db.collection('clients').doc(dropId).collection('sessions').doc(id));
    });
    await batch.commit();
  }

  // Merge array fields
  const mergedRx    = [...new Set([...(keep.rxNumbers || []), ...(drop.rxNumbers || [])].filter(Boolean))];
  const mergedAreas = [...new Set([...(keep.areasOfInterest || []), ...(drop.areasOfInterest || [])].filter(Boolean))];

  // Recompute denormalized counts from merged sessions
  const allSessSnap  = await db.collection('clients').doc(keepId).collection('sessions').get();
  const allSessions  = allSessSnap.docs.map(d => d.data());
  const sessionCount = allSessions.length;
  const totalOutcomeValue = allSessions.reduce((s, r) => s + (Number(r.dollarsAwarded) || 0), 0);
  const dated = allSessions.map(s => toDate(s.date)).filter(Boolean).sort((a, b) => a - b);
  const firstSessionDate = dated.length ? dated[0] : (toDate(keep.firstSessionDate) || toDate(drop.firstSessionDate));
  const lastSessionDate  = dated.length ? dated[dated.length - 1] : (toDate(keep.lastSessionDate) || toDate(drop.lastSessionDate));

  const keepDate = keep.lastSessionDate ? toDate(keep.lastSessionDate).getTime() : 0;
  const dropDate = drop.lastSessionDate ? toDate(drop.lastSessionDate).getTime() : 0;
  const activeCounselingType = dropDate > keepDate
    ? (drop.counselingType || keep.counselingType)
    : (keep.counselingType || drop.counselingType);

  await db.collection('clients').doc(keepId).update({
    rxNumbers:        mergedRx,
    areasOfInterest:  mergedAreas,
    sessionCount,
    totalOutcomeValue,
    firstSessionDate: firstSessionDate || null,
    lastSessionDate:  lastSessionDate  || null,
    counselingType:   activeCounselingType,
    guarantor:        keep.guarantor  || drop.guarantor  || '',
    zipCode:          keep.zipCode    || drop.zipCode    || '',
    counselor:        keep.counselor  || drop.counselor  || '',
    updatedAt:        now,
  });

  await db.collection('clients').doc(dropId).delete();

  // Clean up higWaitlist
  const [dropHig, keepHig] = await Promise.all([
    db.collection('higWaitlist').where('clientId', '==', dropId).get(),
    db.collection('higWaitlist').where('clientId', '==', keepId).get(),
  ]);
  for (const d of dropHig.docs) {
    if (keepHig.size > 0) {
      await d.ref.delete();
    } else {
      await d.ref.update({ clientId: keepId, updatedAt: now });
    }
  }

  return `merged ${dropSessions.length} session(s) from "${drop.clientName}" → "${keep.clientName}"`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(dryRun ? '[DRY RUN — no writes]\n' : '[LIVE RUN]\n');

  const snap    = await db.collection('clients').get();
  const clients = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(c => !c.deleted);

  console.log(`Loaded ${clients.length} active clients — scanning pairs…\n`);

  // Build session counts for keep/drop decision
  const sessionCounts = {};
  await Promise.all(clients.map(async c => {
    const s = await db.collection('clients').doc(c.id).collection('sessions').get();
    sessionCounts[c.id] = s.size;
  }));

  // Find all strong-match pairs (O(n²), deduped by sorted id pair)
  const pairs  = [];
  const seen   = new Set();
  for (let i = 0; i < clients.length; i++) {
    for (let j = i + 1; j < clients.length; j++) {
      const a = clients[i], b = clients[j];
      const key = [a.id, b.id].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const reason = isStrongMatch(a, b);
      if (reason) pairs.push({ a, b, reason });
    }
  }

  console.log(`Found ${pairs.length} strong-match pair(s):\n`);

  const merged   = new Set(); // track dropped IDs so we don't double-process
  let mergedCount = 0, skippedCount = 0;

  for (const { a, b, reason } of pairs) {
    // Skip if either client was already merged away in this run
    if (merged.has(a.id) || merged.has(b.id)) {
      console.log(`  SKIP  "${a.clientName}" + "${b.clientName}" — one already merged this run`);
      skippedCount++;
      continue;
    }

    // Keep whichever has more sessions; tie-break by earlier intakeDate
    const aCount = sessionCounts[a.id] || 0;
    const bCount = sessionCounts[b.id] || 0;
    let keep, drop;
    if (aCount >= bCount) {
      keep = a; drop = b;
    } else {
      keep = b; drop = a;
    }
    // Tie: prefer earlier intakeDate as the canonical record
    if (aCount === bCount) {
      const aDate = toDate(a.intakeDate) || new Date(9999, 0);
      const bDate = toDate(b.intakeDate) || new Date(9999, 0);
      if (bDate < aDate) { keep = b; drop = a; }
    }

    console.log(`  MERGE "${drop.clientName}" (${sessionCounts[drop.id]} sessions) → "${keep.clientName}" (${sessionCounts[keep.id]} sessions)`);
    console.log(`        Reason: ${reason}`);

    const result = await merge(keep.id, drop.id, dryRun);
    console.log(`        ${result}\n`);
    merged.add(drop.id);
    mergedCount++;
  }

  console.log('— Done —');
  console.log(`  Merged:  ${mergedCount} pair(s)`);
  console.log(`  Skipped: ${skippedCount} (already processed this run)`);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
