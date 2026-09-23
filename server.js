require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Render's managed Postgres provides this connection string automatically
// as an environment variable once the database is attached to this service.
//
// SSL handling: Render's INTERNAL connection string (the one used here, a
// short hostname like "dpg-xxxxx-a" with no domain suffix) is private
// network traffic and does NOT use SSL. Render's EXTERNAL connection string
// (a full hostname like "dpg-xxxxx-a.oregon-postgres.render.com") does
// require SSL. Forcing SSL on the internal connection makes the handshake
// hang instead of failing cleanly, which is what caused the stuck deploy.
// Detect which one we have by checking whether the host contains a dot.
function resolveSslConfig(connectionString) {
  if (!connectionString) return false;
  try {
    const url = new URL(connectionString);
    const isInternal = !url.hostname.includes('.');
    if (isInternal) return false;
    return { rejectUnauthorized: false };
  } catch (e) {
    // If the string can't be parsed for some reason, default to no SSL
    // rather than risk another hang.
    return false;
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolveSslConfig(process.env.DATABASE_URL)
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS checkins (
      id SERIAL PRIMARY KEY,
      member_key TEXT NOT NULL,
      member_id TEXT,
      member_email TEXT,
      member_name TEXT,
      date TEXT NOT NULL,
      items JSONB NOT NULL,
      completed_count INTEGER NOT NULL,
      total INTEGER NOT NULL,
      all_complete BOOLEAN NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE(member_key, date)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nutrition_logs (
      id SERIAL PRIMARY KEY,
      member_key TEXT NOT NULL,
      member_id TEXT,
      member_email TEXT,
      member_name TEXT,
      date TEXT NOT NULL,
      calories REAL,
      goal_calories REAL,
      protein_g REAL,
      carbs_g REAL,
      fat_g REAL,
      micros JSONB,
      micro_pct JSONB,
      lowest_micro_key TEXT,
      diet_tags JSONB,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE(member_key, date)
    );
  `);
}

const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me';

// ---- member widget calls this on every check/uncheck ----
app.post('/api/checkin', async (req, res) => {
  const { memberId, memberEmail, memberName, date, items, completedCount, total, allComplete } = req.body || {};
  // member_key is whichever identifier we actually have: Movement's member id
  // (preferred, confirmed via dataLayer.user.id) or the manually entered email
  // (fallback, used when a member is browsing without a Movement session or
  // dataLayer hasn't fired yet).
  const memberKey = memberId ? `id:${memberId}` : (memberEmail ? `email:${memberEmail}` : null);
  if (!memberKey || !date) {
    return res.status(400).json({ error: 'memberId or memberEmail, plus date, are required' });
  }

  try {
    await pool.query(
      `INSERT INTO checkins (member_key, member_id, member_email, member_name, date, items, completed_count, total, all_complete, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (member_key, date) DO UPDATE SET
         member_id = EXCLUDED.member_id,
         member_email = EXCLUDED.member_email,
         member_name = EXCLUDED.member_name,
         items = EXCLUDED.items,
         completed_count = EXCLUDED.completed_count,
         total = EXCLUDED.total,
         all_complete = EXCLUDED.all_complete,
         updated_at = EXCLUDED.updated_at`,
      [
        memberKey,
        memberId || null,
        memberEmail || null,
        memberName || '',
        date,
        JSON.stringify(items || {}),
        completedCount || 0,
        total || 0,
        !!allComplete,
        new Date().toISOString()
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('checkin insert failed:', err);
    res.status(500).json({ error: 'failed to save check-in' });
  }
});

// ---- admin dashboard calls this, protected by a shared key ----
app.get('/api/admin/summary', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const result = await pool.query(`SELECT * FROM checkins ORDER BY member_key, date`);
    const rows = result.rows;

    const byMember = {};
    rows.forEach(r => {
      if (!byMember[r.member_key]) {
        byMember[r.member_key] = {
          name: r.member_name,
          email: r.member_email,
          memberId: r.member_id,
          days: []
        };
      }
      byMember[r.member_key].days.push({
        date: r.date,
        completedCount: r.completed_count,
        total: r.total,
        allComplete: r.all_complete,
        items: r.items
      });
    });

    const todayStr = new Date().toISOString().slice(0, 10);

    const members = Object.values(byMember).map(m => {
      m.days.sort((a, b) => a.date.localeCompare(b.date));

      const byDate = {};
      m.days.forEach(d => { byDate[d.date] = d; });

      // current streak: consecutive fully-complete days ending today or yesterday
      let streak = 0;
      let cursor = new Date();
      const cursorStr = () => cursor.toISOString().slice(0, 10);
      if (byDate[cursorStr()] && byDate[cursorStr()].allComplete) {
        streak = 1;
      }
      cursor.setDate(cursor.getDate() - 1);
      while (byDate[cursorStr()] && byDate[cursorStr()].allComplete) {
        streak++;
        cursor.setDate(cursor.getDate() - 1);
      }

      const today = byDate[todayStr] || { completedCount: 0, total: 0, allComplete: false };

      // last 30 days, oldest to newest
      const last30 = [];
      for (let i = 29; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        last30.push(byDate[key] || { date: key, completedCount: 0, total: 0, allComplete: false });
      }

      // per-item miss rate over the last 30 days: which boxes this member
      // skips most often. Only counts days that actually have a check-in
      // (no check-in at all isn't the same as "missed this box"). Item ids
      // are read from whatever keys show up in their own check-ins, so this
      // doesn't need to know the widget's current checklist in advance.
      const recordedItemSets = last30
        .filter(d => d.items)
        .map(d => d.items);
      const recordedDays = recordedItemSets.length;
      const itemIds = new Set();
      recordedItemSets.forEach(items => Object.keys(items).forEach(id => itemIds.add(id)));
      const itemMissRates = Array.from(itemIds).map(id => {
        const missed = recordedItemSets.filter(items => !items[id]).length;
        return {
          id,
          missed,
          recordedDays,
          missRatePct: recordedDays ? Math.round((missed / recordedDays) * 100) : 0
        };
      }).sort((a, b) => b.missRatePct - a.missRatePct);

      return {
        name: m.name,
        email: m.email,
        memberId: m.memberId,
        today,
        streak,
        last30,
        itemMissRates
      };
    });

    res.json({ members });
  } catch (err) {
    console.error('admin summary failed:', err);
    res.status(500).json({ error: 'failed to load summary' });
  }
});

// ---- nutrient calculator calls this on every meal save ----
app.post('/api/nutrition-log', async (req, res) => {
  const {
    memberId, memberEmail, memberName, date,
    calories, goalCalories, proteinG, carbsG, fatG,
    micros, microPct, lowestMicroKey, dietTags
  } = req.body || {};

  const memberKey = memberId ? `id:${memberId}` : (memberEmail ? `email:${memberEmail}` : null);
  if (!memberKey || !date) {
    return res.status(400).json({ error: 'memberId or memberEmail, plus date, are required' });
  }

  try {
    await pool.query(
      `INSERT INTO nutrition_logs
         (member_key, member_id, member_email, member_name, date, calories, goal_calories, protein_g, carbs_g, fat_g, micros, micro_pct, lowest_micro_key, diet_tags, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (member_key, date) DO UPDATE SET
         member_id = EXCLUDED.member_id,
         member_email = EXCLUDED.member_email,
         member_name = EXCLUDED.member_name,
         calories = EXCLUDED.calories,
         goal_calories = EXCLUDED.goal_calories,
         protein_g = EXCLUDED.protein_g,
         carbs_g = EXCLUDED.carbs_g,
         fat_g = EXCLUDED.fat_g,
         micros = EXCLUDED.micros,
         micro_pct = EXCLUDED.micro_pct,
         lowest_micro_key = EXCLUDED.lowest_micro_key,
         diet_tags = EXCLUDED.diet_tags,
         updated_at = EXCLUDED.updated_at`,
      [
        memberKey,
        memberId || null,
        memberEmail || null,
        memberName || '',
        date,
        calories ?? null,
        goalCalories ?? null,
        proteinG ?? null,
        carbsG ?? null,
        fatG ?? null,
        JSON.stringify(micros || {}),
        JSON.stringify(microPct || {}),
        lowestMicroKey || null,
        JSON.stringify(dietTags || []),
        new Date().toISOString()
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('nutrition-log insert failed:', err);
    res.status(500).json({ error: 'failed to save nutrition log' });
  }
});

// ---- calculator's own 30-day view calls this, so it survives a device switch ----
app.get('/api/nutrition-log', async (req, res) => {
  const { memberId, memberEmail, days } = req.query;
  const memberKey = memberId ? `id:${memberId}` : (memberEmail ? `email:${memberEmail}` : null);
  const lookback = parseInt(days, 10) || 30;

  if (!memberKey) {
    return res.status(400).json({ error: 'memberId or memberEmail is required' });
  }

  try {
    const result = await pool.query(
      `SELECT date, calories, goal_calories, protein_g, carbs_g, fat_g, micros, micro_pct, lowest_micro_key
       FROM nutrition_logs
       WHERE member_key = $1
       ORDER BY date DESC
       LIMIT $2`,
      [memberKey, lookback]
    );

    // JSONB columns come back already parsed as JS objects — no JSON.parse needed.
    const entries = result.rows.reverse().map(r => ({
      date: r.date,
      calories: r.calories,
      goalCalories: r.goal_calories,
      proteinG: r.protein_g,
      carbsG: r.carbs_g,
      fatG: r.fat_g,
      micros: r.micros || {},
      microPct: r.micro_pct || {},
      lowestMicroKey: r.lowest_micro_key
    }));

    res.json({ entries });
  } catch (err) {
    console.error('nutrition-log fetch failed:', err);
    res.status(500).json({ error: 'failed to load nutrition log' });
  }
});

// ---- admin dashboard's Nutrition tab, same auth pattern as /api/admin/summary ----
// Flags a member's most persistently low micronutrient over the trailing window
// (default 21 days) — below 50% DV on at least half the days actually logged,
// so one bad day doesn't trigger a false flag.
app.get('/api/admin/nutrition-summary', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const windowDays = parseInt(req.query.days, 10) || 21;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  try {
    const result = await pool.query(
      `SELECT * FROM nutrition_logs WHERE date >= $1 ORDER BY member_key, date`,
      [cutoffStr]
    );
    const rows = result.rows;

    const byMember = {};
    rows.forEach(r => {
      if (!byMember[r.member_key]) {
        byMember[r.member_key] = { name: r.member_name, email: r.member_email, memberId: r.member_id, days: [] };
      }
      byMember[r.member_key].days.push({
        date: r.date,
        calories: r.calories,
        goalCalories: r.goal_calories,
        proteinG: r.protein_g,
        carbsG: r.carbs_g,
        fatG: r.fat_g,
        microPct: r.micro_pct || {}
      });
    });

    const members = Object.values(byMember).map(m => {
      m.days.sort((a, b) => a.date.localeCompare(b.date));

      const lowCounts = {};
      m.days.forEach(d => {
        Object.keys(d.microPct || {}).forEach(key => {
          if (d.microPct[key] < 50) lowCounts[key] = (lowCounts[key] || 0) + 1;
        });
      });

      let flagged = null;
      let flaggedCount = 0;
      Object.keys(lowCounts).forEach(key => {
        if (lowCounts[key] > flaggedCount) { flagged = key; flaggedCount = lowCounts[key]; }
      });

      const loggedDays = m.days.length;
      const flaggedDeficiency = (flagged && loggedDays > 0 && flaggedCount >= Math.ceil(loggedDays / 2))
        ? { key: flagged, daysLow: flaggedCount, loggedDays }
        : null;

      const latest = m.days[m.days.length - 1] || null;

      return { name: m.name, email: m.email, memberId: m.memberId, loggedDays, latest, flaggedDeficiency, days: m.days };
    });

    res.json({ members, windowDays });
  } catch (err) {
    console.error('admin nutrition-summary failed:', err);
    res.status(500).json({ error: 'failed to load nutrition summary' });
  }
});

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Live Above scorecard backend running on port ${PORT}`));
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
