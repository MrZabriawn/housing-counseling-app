'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const https = require('https');

admin.initializeApp();
const db = admin.firestore();

/**
 * Fires when a new workshopRegistration document is created.
 * Posts a summary card to the Google Chat space via webhook.
 */
/**
 * Called by the registration page immediately after writing the reg doc.
 * POST /api/workshop-registered  { regId: "<doc id>" }
 */
exports.workshopRegistered = onRequest(
  { secrets: ['GCHAT_WORKSHOP_WEBHOOK'], cors: true, invoker: 'public' },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).end();

    const { regId } = req.body || {};
    if (!regId || typeof regId !== 'string') return res.status(400).json({ error: 'Missing regId' });

    const webhookUrl = (process.env.GCHAT_WORKSHOP_WEBHOOK || '').trim();
    if (!webhookUrl) return res.status(200).json({ ok: true }); // silent no-op if not configured

    try {
      const regDoc = await db.collection('workshopRegistrations').doc(regId).get();
      if (!regDoc.exists) return res.status(404).json({ error: 'Registration not found' });

      const reg = regDoc.data();
      let workshopTitle = reg.workshopId || '';
      let locationLabel = reg.locationId || '';
      let seatsLeft = null;

      try {
        const wsDoc = await db.collection('workshops').doc(reg.workshopId).get();
        if (wsDoc.exists) {
          const ws = wsDoc.data();
          workshopTitle = ws.title || workshopTitle;
          const loc = (ws.locations || []).find(l => l.id === reg.locationId);
          if (loc) {
            locationLabel = loc.label || locationLabel;
            const filled = loc.seatCount || 0;
            const cap    = loc.cap    || 0;
            if (cap) seatsLeft = cap - filled;
          }
        }
      } catch (_) {}

      const name  = [reg.firstName, reg.lastName].filter(Boolean).join(' ') || 'Unknown';
      const city  = reg.city ? ` · ${reg.city}` : '';
      const seats = seatsLeft !== null ? `\n*Seats remaining:* ${seatsLeft} at ${locationLabel}` : '';
      const text  = `*New HOME School registration* 🏡\n*Workshop:* ${workshopTitle}\n*Name:* ${name}${city}\n*Location:* ${locationLabel}${seats}`;

      await postJson(webhookUrl, { text });
      return res.json({ ok: true });
    } catch (err) {
      console.error('workshopRegistered notify failed:', err.message);
      return res.status(500).json({ error: 'Notification failed' });
    }
  }
);

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

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
