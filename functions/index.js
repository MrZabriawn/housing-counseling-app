'use strict';

const functions  = require('firebase-functions');
const { defineSecret } = require('firebase-functions/params');
const admin      = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

const SYNC_API_KEY = defineSecret('QREW_SYNC_API_KEY');

// Qrew status values this endpoint accepts, mapped to Housing internal statuses.
// Qrew only pushes statuses that have a Housing equivalent.
const QREW_TO_HOUSING = {
  er_review:    'er_review',
  repair_ready: 'repair_ready',
  complete:     'complete',
};

/**
 * Leg 1 — Receive status pushes from Qrew.
 *
 * POST /api/qrew-status-update
 * Header:  X-Api-Key: <shared secret>
 * Body:    { housingRecordId, status, _syncSource: "qrew" }
 * Returns: { ok: true }
 */
exports.qrewStatusUpdate = functions
  .runWith({ secrets: [SYNC_API_KEY] })
  .https.onRequest(async (req, res) => {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (req.headers['x-api-key'] !== SYNC_API_KEY.value()) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { housingRecordId, status, _syncSource } = req.body || {};

    if (_syncSource !== 'qrew') {
      return res.status(400).json({ error: 'Invalid _syncSource — expected "qrew"' });
    }
    if (!housingRecordId || typeof housingRecordId !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid housingRecordId' });
    }
    const housingStatus = QREW_TO_HOUSING[status];
    if (!housingStatus) {
      return res.status(400).json({ error: `Invalid status "${status}". Accepted: ${Object.keys(QREW_TO_HOUSING).join(', ')}` });
    }

    try {
      await db.collection('higWaitlist').doc(housingRecordId).update({
        status:      housingStatus,
        _syncSource: 'qrew',
        updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.json({ ok: true });
    } catch (err) {
      if (err.code === 5) {
        return res.status(404).json({ error: 'Housing record not found' });
      }
      functions.logger.error('qrewStatusUpdate: Firestore update failed', { housingRecordId });
      return res.status(500).json({ error: 'Update failed' });
    }
  });
