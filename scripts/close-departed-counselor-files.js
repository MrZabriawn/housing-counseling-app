/**
 * Close client files assigned to departed counselors.
 * Keeps files open if ANY session belongs to a counselor NOT on the departed list.
 *
 * Usage:
 *   node scripts/close-departed-counselor-files.js <serviceAccountJson> [--execute]
 *
 * Without --execute: dry run (reports only, no writes).
 * With    --execute: applies closures.
 */

const admin  = require('firebase-admin');
const path   = require('path');
const fs     = require('fs');

const DEPARTED = ['Marcia Williams', 'Taylor Balcer', 'Cathy Wise'];
const EXECUTE  = process.argv.includes('--execute');

const keyPath = process.argv.find(a => a.endsWith('.json'));
if (!keyPath || !fs.existsSync(keyPath)) {
  console.error('Usage: node close-departed-counselor-files.js <serviceAccountJson> [--execute]');
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(require(path.resolve(keyPath))) });
const db = admin.firestore();

function isDeparted(name) {
  return DEPARTED.some(d => d.toLowerCase() === (name || '').toLowerCase().trim());
}

async function main() {
  console.log(`\nDeparted counselors: ${DEPARTED.join(', ')}`);
  console.log(EXECUTE ? '*** EXECUTE MODE — changes will be written ***\n' : '*** DRY RUN — no changes written ***\n');

  const clientsSnap = await db.collection('clients')
    .where('status', '!=', 'closed')
    .get();

  const candidates = clientsSnap.docs.filter(d => isDeparted(d.data().counselor));
  console.log(`Active clients assigned to departed counselors: ${candidates.length}`);

  const toClose  = [];
  const keepOpen = [];

  for (const clientDoc of candidates) {
    const c = clientDoc.data();
    const sessionsSnap = await db.collection('clients').doc(clientDoc.id).collection('sessions').get();
    const hasActiveCounselorSession = sessionsSnap.docs.some(s => {
      const sc = (s.data().counselor || '').trim();
      return sc && !isDeparted(sc);
    });

    if (hasActiveCounselorSession) {
      keepOpen.push({ id: clientDoc.id, name: c.clientName, counselor: c.counselor });
    } else {
      toClose.push({ id: clientDoc.id, name: c.clientName, counselor: c.counselor });
    }
  }

  console.log(`\n── KEEP OPEN (has sessions with another counselor) ─────────────────`);
  if (keepOpen.length) {
    keepOpen.forEach(r => console.log(`  KEEP  ${r.name}  [${r.counselor}]`));
  } else {
    console.log('  (none)');
  }

  console.log(`\n── CLOSE (all sessions with departed counselor only) ───────────────`);
  if (toClose.length) {
    toClose.forEach(r => console.log(`  CLOSE ${r.name}  [${r.counselor}]`));
  } else {
    console.log('  (none)');
  }

  console.log(`\nSummary: ${toClose.length} to close, ${keepOpen.length} to keep open.`);

  if (!EXECUTE) {
    console.log('\nRe-run with --execute to apply closures.');
    return;
  }

  if (!toClose.length) {
    console.log('Nothing to close.');
    return;
  }

  console.log('\nWriting closures…');
  const closeDate = admin.firestore.Timestamp.now();
  const batch     = db.batch();
  let   count     = 0;

  for (const r of toClose) {
    batch.update(db.collection('clients').doc(r.id), {
      status:           'closed',
      closureDate:      closeDate,
      closureOutcome:   'Administrative Closure — Counselor No Longer Employed',
      closureAwardType: '',
      updatedAt:        closeDate,
    });
    count++;
    // Firestore batch limit is 500
    if (count % 490 === 0) {
      await batch.commit();
      console.log(`  Committed ${count} so far…`);
    }
  }
  await batch.commit();
  console.log(`\nDone. Closed ${toClose.length} file(s).`);
}

main().catch(err => { console.error(err); process.exit(1); });
