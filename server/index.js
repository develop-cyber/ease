// server/index.js (top)
import express from 'express';
import fetch from 'node-fetch';
import path from 'node:path';
import dotenv from 'dotenv';

// load .env.local (contains OPENAI_API_KEY)
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const app = express();
app.use(express.json());

// GET /api/directions?origin=...&destination=...
app.get('/api/directions', async (req, res) => {
  const { origin, destination } = req.query;
  if (!origin || !destination) {
    return res.status(400).json({ error: 'Missing origin or destination' });
  }

  const u = new URL('https://maps.googleapis.com/maps/api/directions/json');
  u.searchParams.set('origin', origin);
  u.searchParams.set('destination', destination);
  u.searchParams.set('mode', 'driving');
  u.searchParams.set('departure_time', 'now');       // live traffic
  u.searchParams.set('key', process.env.GOOGLE_MAPS_KEY);

  try {
    const r = await fetch(u.toString());
    const j = await r.json();
    if (j.status !== 'OK') {
      return res.status(400).json({ error: j.status, details: j.error_message || j });
    }

    const leg = j.routes[0].legs[0];
    const etaSec = (leg.duration_in_traffic || leg.duration).value;
    const etaMin = Math.round(etaSec / 60);
    const distanceText = leg.distance.text;

    // Try to detect first highway/merge/ramp step
    let nextText = leg.steps[0]?.html_instructions?.replace(/<[^>]+>/g, '') || '';
    let distanceToMotorway = null;
    let accMeters = 0;
    for (const s of leg.steps) {
      accMeters += s.distance.value;
      const instr = (s.html_instructions || '').toLowerCase();
      if (instr.includes('merge') || instr.includes('ramp') || instr.includes('motorway') || instr.includes('highway')) {
        distanceToMotorway = (accMeters / 1609.344).toFixed(1); // miles
        nextText = s.html_instructions.replace(/<[^>]+>/g, '');
        break;
      }
    }

    res.json({ etaMin, distanceText, nextText, distanceToMotorway, gate: null });
  } catch (e) {
    res.status(500).json({ error: 'FETCH_FAILED', details: String(e) });
  }
});

app.listen(8787, () => console.log('API listening on http://localhost:8787'));
