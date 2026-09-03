require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = new Database(path.join(__dirname, 'scorecard.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS checkins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_key TEXT NOT NULL,
    member_id TEXT,
    member_email TEXT,
    member_name TEXT,
    date TEXT NOT NULL,
    items TEXT NOT NULL,
    completed_count INTEGER NOT NULL,
    total INTEGER NOT NULL,
    all_complete INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(member_key, date)
  );
`);

// --- Sleep Quality Index table (add near the checkins table setup) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS sleep_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_key TEXT NOT NULL,
    member_id TEXT,
    member_email TEXT,
    member_name TEXT,
    date TEXT NOT NULL,
    onset_category TEXT,
    time_in_bed_hrs REAL,
    est_sleep_hrs REAL,
    wakeups INTEGER,
    wake_variance_min REAL,
    restfulness INTEGER,
    score INTEGER,
    updated_at TEXT NOT NULL,
    UNIQUE(member_key, date)
  );
`);
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me';

app.post('/api/checkin', (req, res) => {
  const { memberId, memberEmail, memberName, date, items, completedCount, total, allComplete } = req.body || {};
  const memberKey = memberId ? `id:${memberId}` : (memberEmail ? `email:${memberEmail}` : null);
  if (!memberKey || !date) {
    return res.status(400).json({ error: 'memberId or memberEmail, plus date, are required' });
  }
  const stmt = db.prepare(`
    INSERT INTO checkins (member_key, member_id, member_email, member_name, date, items, completed_count, total, all_complete, updated_at)
    VALUES (@memberKey, @memberId, @memberEmail, @memberName, @date, @items, @completedCount, @total, @allComplete, @updatedAt)
    ON CONFLICT(member_key, date) DO UPDATE SET
      member_id = excluded.member_id,
      member_email = excluded.member_email,
      member_name = excluded.member_name,
      items = excluded.items,
      completed_count = excluded.completed_count,
      total = excluded.total,
      all_complete = excluded.all_complete,
      updated_at = excluded.updated_at
  `);
  stmt.run({
    memberKey,
    memberId: memberId || null,
    memberEmail: memberEmail || null,
    memberName: memberName || '',
    date,
    items: JSON.stringify(items || {}),
    completedCount: completedCount || 0,
    total: total || 0,
    allComplete: allComplete ? 1 : 0,
    updatedAt: new Date().toISOString()
  });
  res.json({ ok: true });
});

// --- POST: log a night's entry ---
app.post('/api/sleep-score', (req, res) => {
  const {
    memberId, memberEmail, memberName, date,
    onsetCategory, timeInBedHrs, estSleepHrs, wakeups, wakeVarianceMin, restfulness, score
  } = req.body || {};

  const memberKey = memberId ? `id:${memberId}` : (memberEmail ? `email:${memberEmail}` : null);
  if (!memberKey || !date || score == null) {
    return res.status(400).json({ error: 'memberId or memberEmail, plus date and score, are required' });
  }

  const stmt = db.prepare(`
    INSERT INTO sleep_scores
      (member_key, member_id, member_email, member_name, date, onset_category, time_in_bed_hrs, est_sleep_hrs, wakeups, wake_variance_min, restfulness, score, updated_at)
    VALUES
      (@memberKey, @memberId, @memberEmail, @memberName, @date, @onsetCategory, @timeInBedHrs, @estSleepHrs, @wakeups, @wakeVarianceMin, @restfulness, @score, @updatedAt)
    ON CONFLICT(member_key, date) DO UPDATE SET
      member_id = excluded.member_id,
      member_email = excluded.member_email,
      member_name = excluded.member_name,
      onset_category = excluded.onset_category,
      time_in_bed_hrs = excluded.time_in_bed_hrs,
      est_sleep_hrs = excluded.est_sleep_hrs,
      wakeups = excluded.wakeups,
      wake_variance_min = excluded.wake_variance_min,
      restfulness = excluded.restfulness,
      score = excluded.score,
      updated_at = excluded.updated_at
  `);

  stmt.run({
    memberKey,
    memberId: memberId || null,
    memberEmail: memberEmail || null,
    memberName: memberName || '',
    date,
    onsetCategory: onsetCategory || null,
    timeInBedHrs: timeInBedHrs ?? null,
    estSleepHrs: estSleepHrs ?? null,
    wakeups: wakeups ?? null,
    wakeVarianceMin: wakeVarianceMin ?? null,
    restfulness: restfulness ?? null,
    score,
    updatedAt: new Date().toISOString()
  });

  res.json({ ok: true });
});

// --- GET: a single member's recent history, powers the 30-day graph in the widget ---
// e.g. GET /api/sleep-score?memberId=123&days=30  or  ?memberEmail=jane@x.com&days=30
app.get('/api/sleep-score', (req, res) => {
  const { memberId, memberEmail, days } = req.query;
  const memberKey = memberId ? `id:${memberId}` : (memberEmail ? `email:${memberEmail}` : null);
  const lookback = parseInt(days, 10) || 30;

  if (!memberKey) {
    return res.status(400).json({ error: 'memberId or memberEmail is required' });
  }

  const rows = db.prepare(`
    SELECT date, est_sleep_hrs, score
    FROM sleep_scores
    WHERE member_key = ?
    ORDER BY date DESC
    LIMIT ?
  `).all(memberKey, lookback);

  const entries = rows.reverse(); // chronological order for the graph
  const validHrs = entries.map(r => r.est_sleep_hrs).filter(v => v != null);
  const avgHrs = validHrs.length
    ? Math.round((validHrs.reduce((a, b) => a + b, 0) / validHrs.length) * 100) / 100
    : null;

  res.json({ entries, averageSleepHrs: avgHrs });
});
app.get('/api/admin/summary', (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const rows = db.prepare(`SELECT * FROM checkins ORDER BY member_key, date`).all();

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
      allComplete: !!r.all_complete
    });
  });

  const todayStr = new Date().toISOString().slice(0, 10);

  const members = Object.values(byMember).map(m => {
    m.days.sort((a, b) => a.date.localeCompare(b.date));

    const byDate = {};
    m.days.forEach(d => { byDate[d.date] = d; });

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
});

// --- GET: admin visibility, same auth pattern as /api/admin/summary ---
app.get('/api/admin/sleep-summary', (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const rows = db.prepare(`SELECT * FROM sleep_scores ORDER BY member_key, date`).all();

  const byMember = {};
  rows.forEach(r => {
    if (!byMember[r.member_key]) {
      byMember[r.member_key] = { name: r.member_name, email: r.member_email, memberId: r.member_id, days: [] };
    }
    byMember[r.member_key].days.push({
      date: r.date,
      score: r.score,
      onsetCategory: r.onset_category,
      estSleepHrs: r.est_sleep_hrs,
      restfulness: r.restfulness
    });
  });

  const members = Object.values(byMember).map(m => {
    m.days.sort((a, b) => a.date.localeCompare(b.date));
    return { name: m.name, email: m.email, memberId: m.memberId, entries: m.days };
  });

  res.json({ members });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Live Above scorecard backend running on port ${PORT}`));
