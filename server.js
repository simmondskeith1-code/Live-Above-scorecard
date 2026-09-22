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
// ssl is required for Render's Postgres in production.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
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
        allComplete: r.all_complete
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

      return {
        name: m.name,
        email: m.email,
        memberId: m.memberId,
        today,
        streak,
        last30
      };
    });

    res.json({ members });
  } catch (err) {
    console.error('admin summary failed:', err);
    res.status(500).json({ error: 'failed to load summary' });
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
