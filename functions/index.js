'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

// Qrew status values this endpoint accepts, all map directly to Housing statuses.
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
exports.qrewStatusUpdate = onRequest(
  { secrets: ['QREW_SYNC_API_KEY'], cors: false, invoker: 'public' },
  async (req, res) => {
    const expectedKey = (process.env.QREW_SYNC_API_KEY || '').trim();

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const providedKey = (req.headers['x-api-key'] || '').trim();
    if (!expectedKey || providedKey !== expectedKey) {
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
      if (err.code === 5 || err.code === 'not-found') {
        return res.status(404).json({ error: 'Housing record not found' });
      }
      if (err.code === 3) {
        return res.status(400).json({ error: 'Invalid housingRecordId' });
      }
      console.error('qrewStatusUpdate: Firestore update failed', housingRecordId);
      return res.status(500).json({ error: 'Update failed' });
    }
  }
);
