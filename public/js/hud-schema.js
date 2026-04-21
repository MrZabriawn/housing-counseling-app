import { db } from './firebase-config.js';
import {
  collection, doc, getDoc, getDocs, addDoc, setDoc, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ═══════════════════════════════════════════════════════════════════════════════
// COUNSELORS COLLECTION — FULL EXPECTED SCHEMA
// ═══════════════════════════════════════════════════════════════════════════════
// counselors/{counselorId}
//   name:        string   — display name used throughout the app
//   email:       string   — login / contact email
//   active:      boolean  — false hides the counselor from all dropdowns
//   // fields added for HUD reporting:
//   staffNumber: number   — staff number used on TAL / training activity log
//   staffTitle:  string   — e.g. "Housing Counselor", "Program Director"
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// SESSIONS SUBCOLLECTION — SCHEMA NOTE
// clients/{clientId}/sessions/{sessionId}
//   date:          Date | null
//   counselor:     string
//   rxNumber:      string
//   hours:         number
//   dollarsFor:    string
//   caseStatus:    string
//   outcome:       string
//   notes:         string
//   createdAt:     timestamp
//   updatedAt:     timestamp
//   // field added for HUD billing reports:
//   billingType:   string | undefined
//     — enum: "In-Person" | "Case Management Activity" | "Court"
//     — absent on all historical sessions; always treat a missing value as null
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// MIGRATION — clients.rxNumber → clients/{id}/rxNumbers subcollection
//
// Run once from the browser console on admin-migrate.html:
//   migrateRxNumbers()
//
// Guarded by _migrations/rxNumbers_v1. If that doc exists the function exits
// immediately. The original rxNumber field is NOT removed (backward compat).
// ═══════════════════════════════════════════════════════════════════════════════

async function migrateRxNumbers() {
  const FLAG_DOC = doc(db, '_migrations', 'rxNumbers_v1');

  const flagSnap = await getDoc(FLAG_DOC);
  if (flagSnap.exists()) {
    const ts = flagSnap.data().completedAt;
    console.warn(
      '[migrateRxNumbers] Already completed on',
      ts?.toDate?.()?.toLocaleString() ?? '(unknown date)',
    );
    return;
  }

  console.log('[migrateRxNumbers] Starting — reading clients collection…');
  const clientsSnap = await getDocs(collection(db, 'clients'));
  let migrated = 0;
  let skipped  = 0;

  for (const clientDoc of clientsSnap.docs) {
    const rxNumber = (clientDoc.data().rxNumber || '').trim();
    if (!rxNumber) {
      skipped++;
      continue;
    }

    await addDoc(collection(db, 'clients', clientDoc.id, 'rxNumbers'), {
      rxNumber,
      guarantor: '',  // to be filled in manually ("NOFA" | "Anti-Pred" | "CHCI")
      active:    true,
      createdAt: serverTimestamp(),
    });

    migrated++;
    console.log(`[migrateRxNumbers] ✓ ${clientDoc.id}  "${rxNumber}"`);
  }

  await setDoc(FLAG_DOC, {
    completedAt:   serverTimestamp(),
    migratedCount: migrated,
    skippedCount:  skipped,
  });

  console.log(
    `[migrateRxNumbers] Done.  Migrated: ${migrated}  |  Skipped (no rxNumber): ${skipped}`,
  );
}

// Expose to browser console when this module is loaded
window.migrateRxNumbers = migrateRxNumbers;

// ═══════════════════════════════════════════════════════════════════════════════
// hudTimeEntries — PAR / CML / Workshop hour tracking
// ═══════════════════════════════════════════════════════════════════════════════
// hudTimeEntries/{entryId}
//   counselorId:         string
//   counselorName:       string
//   month:               string    — "YYYY-MM"
//   date:                string    — "YYYY-MM-DD"
//   section:             string    — see HUD_TIME_SECTIONS below
//   parRow:              string|null
//     PAR-S1 rows: "Processing-Intake" | "Processing-Billing" | "Supervision"
//                  "Management" | "Counseling" | "Group Education"
//     PAR-S2 rows: "Training"
//     PAR-S3 rows: "Marketing"
//     CML / Workshop: null
//   activityDescription: string
//   hours:               number    — 0.25 increments
//   enteredBy:           string    — uid of user who created the entry
//   createdAt:           timestamp

export const HUD_TIME_SECTIONS = ['PAR-S1', 'PAR-S2', 'PAR-S3', 'CML', 'Workshop'];

export const HUD_PAR_ROWS = {
  'PAR-S1':    ['Processing-Intake', 'Processing-Billing', 'Supervision', 'Management', 'Counseling', 'Group Education'],
  'PAR-S2':    ['Training'],
  'PAR-S3':    ['Marketing'],
  'CML':       null,
  'Workshop':  null,
};

export function validateHudTimeEntry(data) {
  const errors = [];
  if (!data.counselorId)   errors.push('counselorId required');
  if (!data.counselorName) errors.push('counselorName required');
  if (!/^\d{4}-\d{2}$/.test(data.month || ''))       errors.push('month must be YYYY-MM');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date || ''))  errors.push('date must be YYYY-MM-DD');
  if (!HUD_TIME_SECTIONS.includes(data.section))
    errors.push(`section must be one of: ${HUD_TIME_SECTIONS.join(', ')}`);

  const validRows = HUD_PAR_ROWS[data.section];
  if (validRows !== undefined) {
    if (validRows === null && data.parRow != null)
      errors.push(`parRow must be null for section ${data.section}`);
    if (validRows !== null && !validRows.includes(data.parRow))
      errors.push(`parRow for ${data.section} must be one of: ${validRows.join(', ')}`);
  }

  if (typeof data.hours !== 'number' || data.hours <= 0)
    errors.push('hours must be a positive number');
  if (Math.round(data.hours * 4) !== data.hours * 4)
    errors.push('hours must be in 0.25 increments');
  if (!data.enteredBy)
    errors.push('enteredBy required');

  return errors;
}

export async function createHudTimeEntry(data, uid) {
  const payload = {
    counselorId:         data.counselorId,
    counselorName:       data.counselorName,
    month:               data.month,
    date:                data.date,
    section:             data.section,
    parRow:              data.parRow ?? null,
    activityDescription: data.activityDescription || '',
    hours:               data.hours,
    enteredBy:           uid,
    createdAt:           serverTimestamp(),
  };

  const errors = validateHudTimeEntry(payload);
  if (errors.length) throw new Error('HUD time entry validation failed: ' + errors.join('; '));

  return addDoc(collection(db, 'hudTimeEntries'), payload);
}

// ═══════════════════════════════════════════════════════════════════════════════
// hudTrainingEntries — TAL (Training Activity Log) source
// ═══════════════════════════════════════════════════════════════════════════════
// hudTrainingEntries/{entryId}
//   counselorId:              string
//   counselorName:            string
//   staffNumber:              number
//   month:                    string   — "YYYY-MM"
//   date:                     string   — "YYYY-MM-DD"
//   time:                     string   — e.g. "9:00 AM"
//   activityDescription:      string
//   certificationActivityType: string  — "T" (Training) | "M" (Marketing)
//   costType:                 string
//   durationHours:            number   — 0.25 increments
//   createdAt:                timestamp

const TRAINING_CERT_TYPES = ['T', 'M'];

export function validateHudTrainingEntry(data) {
  const errors = [];
  if (!data.counselorId)   errors.push('counselorId required');
  if (!data.counselorName) errors.push('counselorName required');
  if (typeof data.staffNumber !== 'number') errors.push('staffNumber must be a number');
  if (!/^\d{4}-\d{2}$/.test(data.month || ''))       errors.push('month must be YYYY-MM');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date || ''))  errors.push('date must be YYYY-MM-DD');
  if (!data.time)          errors.push('time required');
  if (!TRAINING_CERT_TYPES.includes(data.certificationActivityType))
    errors.push('certificationActivityType must be "T" or "M"');
  if (typeof data.durationHours !== 'number' || data.durationHours <= 0)
    errors.push('durationHours must be a positive number');
  if (Math.round(data.durationHours * 4) !== data.durationHours * 4)
    errors.push('durationHours must be in 0.25 increments');
  return errors;
}

export async function createHudTrainingEntry(data) {
  const payload = {
    counselorId:               data.counselorId,
    counselorName:             data.counselorName,
    staffNumber:               data.staffNumber,
    month:                     data.month,
    date:                      data.date,
    time:                      data.time,
    activityDescription:       data.activityDescription || '',
    certificationActivityType: data.certificationActivityType,
    costType:                  data.costType || '',
    durationHours:             data.durationHours,
    createdAt:                 serverTimestamp(),
  };

  const errors = validateHudTrainingEntry(payload);
  if (errors.length) throw new Error('HUD training entry validation failed: ' + errors.join('; '));

  return addDoc(collection(db, 'hudTrainingEntries'), payload);
}

// ═══════════════════════════════════════════════════════════════════════════════
// workshopEntries — workshop attendee sign-in log
// ═══════════════════════════════════════════════════════════════════════════════
// workshopEntries/{entryId}
//   workshopName:   string
//   date:           string         — "YYYY-MM-DD" (one date per workshop event)
//   attendeeName:   string
//   address:        string
//   contactType:    string         — "email" | "phone"
//   contactValue:   string
//   linkedClientId: string|null    — null until manually linked to a client file
//   createdAt:      timestamp

const WORKSHOP_CONTACT_TYPES = ['email', 'phone'];

export function validateWorkshopEntry(data) {
  const errors = [];
  if (!data.workshopName)  errors.push('workshopName required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date || '')) errors.push('date must be YYYY-MM-DD');
  if (!data.attendeeName)  errors.push('attendeeName required');
  if (!WORKSHOP_CONTACT_TYPES.includes(data.contactType))
    errors.push('contactType must be "email" or "phone"');
  return errors;
}

export async function createWorkshopEntry(data) {
  const payload = {
    workshopName:   data.workshopName,
    date:           data.date,
    attendeeName:   data.attendeeName,
    address:        data.address || '',
    contactType:    data.contactType,
    contactValue:   data.contactValue || '',
    linkedClientId: data.linkedClientId ?? null,
    createdAt:      serverTimestamp(),
  };

  const errors = validateWorkshopEntry(payload);
  if (errors.length) throw new Error('Workshop entry validation failed: ' + errors.join('; '));

  return addDoc(collection(db, 'workshopEntries'), payload);
}
