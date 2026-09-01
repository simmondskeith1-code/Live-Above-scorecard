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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Live Above scorecard backend running on port ${PORT}`));
