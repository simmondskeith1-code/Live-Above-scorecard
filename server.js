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
  // Added this session: added-sugar and alcohol tracking. ADD COLUMN IF NOT EXISTS instead of
  // folding these into the CREATE TABLE above, because CREATE TABLE IF NOT EXISTS is a no-op on
  // a table that already exists in production — the columns would silently never get added.
  await pool.query(`
    ALTER TABLE nutrition_logs
      ADD COLUMN IF NOT EXISTS added_sugar_g REAL,
      ADD COLUMN IF NOT EXISTS added_sugar_streak INTEGER,
      ADD COLUMN IF NOT EXISTS drinks_alcohol BOOLEAN,
      ADD COLUMN IF NOT EXISTS alcohol_cal REAL,
      ADD COLUMN IF NOT EXISTS no_alcohol_streak INTEGER;
  `);
  // Added this session: glycemic load tracking (whole foods only — restaurant/custom items never
  // carry a GI, so gl_coverage_pct legitimately stays low or null on days built mostly from those).
  await pool.query(`
    ALTER TABLE nutrition_logs
      ADD COLUMN IF NOT EXISTS gl REAL,
      ADD COLUMN IF NOT EXISTS gl_coverage_pct INTEGER;
  `);
  // Member profile / custom foods / supplements / drinks — previously localStorage-only on the
  // calculator, which meant a member switching devices or clearing browser data lost all of it.
  // One row per member, upserted whenever any of it changes, pulled down on a fresh device that
  // has no local profile yet.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS member_data (
      member_key TEXT PRIMARY KEY,
      member_id TEXT,
      member_email TEXT,
      member_name TEXT,
      profile JSONB,
      custom_foods JSONB,
      supplements JSONB,
      drinks JSONB,
      updated_at TIMESTAMPTZ NOT NULL
    );
  `);
  // Sleep Quality Index widget's backing table.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sleep_logs (
      id SERIAL PRIMARY KEY,
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
    micros, microPct, lowestMicroKey, dietTags,
    // Added this session: added-sugar and alcohol figures, plus each streak as of this sync,
    // computed client-side from the member's own 30-day archive.
    addedSugarG, addedSugarStreak, drinksAlcohol, alcoholCal, noAlcoholStreak,
    // Added this session: glycemic load, whole-foods-only (see nutrient-calculator.html's
    // computeTotalsForStoredItems — restaurant/custom items never carry a gi field).
    glycemicLoad, glCoveragePct
  } = req.body || {};

  const memberKey = memberId ? `id:${memberId}` : (memberEmail ? `email:${memberEmail}` : null);
  if (!memberKey || !date) {
    return res.status(400).json({ error: 'memberId or memberEmail, plus date, are required' });
  }

  try {
    await pool.query(
      `INSERT INTO nutrition_logs
         (member_key, member_id, member_email, member_name, date, calories, goal_calories, protein_g, carbs_g, fat_g, micros, micro_pct, lowest_micro_key, diet_tags, added_sugar_g, added_sugar_streak, drinks_alcohol, alcohol_cal, no_alcohol_streak, gl, gl_coverage_pct, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
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
         added_sugar_g = EXCLUDED.added_sugar_g,
         added_sugar_streak = EXCLUDED.added_sugar_streak,
         drinks_alcohol = EXCLUDED.drinks_alcohol,
         alcohol_cal = EXCLUDED.alcohol_cal,
         no_alcohol_streak = EXCLUDED.no_alcohol_streak,
         gl = EXCLUDED.gl,
         gl_coverage_pct = EXCLUDED.gl_coverage_pct,
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
        addedSugarG ?? null,
        addedSugarStreak ?? null,
        drinksAlcohol ?? false,
        alcoholCal ?? null,
        noAlcoholStreak ?? null,
        glycemicLoad ?? null,
        glCoveragePct ?? null,
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
      `SELECT date, calories, goal_calories, protein_g, carbs_g, fat_g, micros, micro_pct, lowest_micro_key,
              added_sugar_g, added_sugar_streak, drinks_alcohol, alcohol_cal, no_alcohol_streak,
              gl, gl_coverage_pct
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
      lowestMicroKey: r.lowest_micro_key,
      addedSugarG: r.added_sugar_g,
      addedSugarStreak: r.added_sugar_streak,
      drinksAlcohol: r.drinks_alcohol,
      alcoholCal: r.alcohol_cal,
      noAlcoholStreak: r.no_alcohol_streak,
      glycemicLoad: r.gl,
      glCoveragePct: r.gl_coverage_pct
    }));

    res.json({ entries });
  } catch (err) {
    console.error('nutrition-log fetch failed:', err);
    res.status(500).json({ error: 'failed to load nutrition log' });
  }
});

// ---- TEMPORARY DEBUG ROUTES — remove once the missing-member investigation is closed ----
// The earlier debug-recent-logs route (raw nutrition_logs search) confirmed the target member's
// data never reaches this table under any name/email variant, so the problem is client-side,
// before any POST is ever sent. These two routes replace it: a fire-and-forget beacon the
// calculator pings at each identity-gate lifecycle stage, and a viewer for those pings, so the
// next time that member's device opens the app, we get real telemetry instead of another guess.
// In-memory only (resets on redeploy/restart) — fine for a short debugging window.
var identityDebugEvents = [];
app.get('/api/admin/debug-identity-event', (req, res) => {
  identityDebugEvents.push({
    stage: req.query.stage || '',
    detail: req.query.detail || '',
    ua: req.headers['user-agent'] || '',
    at: new Date().toISOString()
  });
  if (identityDebugEvents.length > 200) identityDebugEvents.shift();
  res.status(204).end();
});
app.get('/api/admin/debug-identity-events', (req, res) => {
  if (req.query.key !== ADMIN_KEY && req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  res.json({ events: identityDebugEvents });
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
        microPct: r.micro_pct || {},
        // Added this session — see the two new Nutrition-tab columns in admin.html.
        addedSugarG: r.added_sugar_g,
        addedSugarStreak: r.added_sugar_streak,
        drinksAlcohol: r.drinks_alcohol,
        alcoholCal: r.alcohol_cal,
        noAlcoholStreak: r.no_alcohol_streak,
        // Added this session — glycemic load, whole-foods-only (see gl_coverage_pct: a low
        // number means most of the day's carbs came from restaurant/custom items with no GI,
        // not that the member ate low-GL).
        gl: r.gl,
        glCoveragePct: r.gl_coverage_pct,
        // Added this session — lets the admin dashboard flag a member whose device has stopped
        // reaching the server at all, instead of that going unnoticed forever.
        updatedAt: r.updated_at
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

      // Consistently high glycemic load: only counts a day toward this if at least 30% of that
      // day's net carbs actually had a published GI behind them (gl_coverage_pct) — a day built
      // almost entirely from restaurant/custom items has an honest gl near 0 that means nothing
      // and shouldn't count as either a "good" or "bad" day for this flag.
      const highGlDays = m.days.filter(d => d.glCoveragePct != null && d.glCoveragePct >= 30 && d.gl != null);
      const highGlCount = highGlDays.filter(d => d.gl > 120).length;
      const flaggedHighGl = (highGlDays.length >= 3 && highGlCount >= Math.ceil(highGlDays.length / 2))
        ? { daysHigh: highGlCount, evaluableDays: highGlDays.length }
        : null;

      const latest = m.days[m.days.length - 1] || null;

      // addedSugarStreak / drinksAlcohol / noAlcoholStreak aren't recomputed here — the
      // calculator already works these out client-side from the member's full 30-day archive
      // every time it syncs, so the most recent synced day's numbers are the current numbers,
      // the same way `latest.calories` already works a few lines below.
      return {
        name: m.name,
        email: m.email,
        memberId: m.memberId,
        loggedDays,
        latest,
        flaggedDeficiency,
        flaggedHighGl,
        days: m.days,
        addedSugarStreak: latest ? latest.addedSugarStreak : null,
        drinksAlcohol: latest ? !!latest.drinksAlcohol : false,
        noAlcoholStreak: latest ? latest.noAlcoholStreak : null
      };
    });

    res.json({ members, windowDays });
  } catch (err) {
    console.error('admin nutrition-summary failed:', err);
    res.status(500).json({ error: 'failed to load nutrition summary' });
  }
});

// ---- sleep quality widget calls this on every "Log Last Night" submit ----
app.post('/api/sleep-score', async (req, res) => {
  const {
    memberId, memberEmail, memberName, date,
    onsetCategory, timeInBedHrs, estSleepHrs, wakeups, wakeVarianceMin, restfulness, score
  } = req.body || {};

  const memberKey = memberId ? `id:${memberId}` : (memberEmail ? `email:${memberEmail}` : null);
  if (!memberKey || !date) {
    return res.status(400).json({ error: 'memberId or memberEmail, plus date, are required' });
  }

  try {
    await pool.query(
      `INSERT INTO sleep_logs
         (member_key, member_id, member_email, member_name, date, onset_category, time_in_bed_hrs, est_sleep_hrs, wakeups, wake_variance_min, restfulness, score, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (member_key, date) DO UPDATE SET
         member_id = EXCLUDED.member_id,
         member_email = EXCLUDED.member_email,
         member_name = EXCLUDED.member_name,
         onset_category = EXCLUDED.onset_category,
         time_in_bed_hrs = EXCLUDED.time_in_bed_hrs,
         est_sleep_hrs = EXCLUDED.est_sleep_hrs,
         wakeups = EXCLUDED.wakeups,
         wake_variance_min = EXCLUDED.wake_variance_min,
         restfulness = EXCLUDED.restfulness,
         score = EXCLUDED.score,
         updated_at = EXCLUDED.updated_at`,
      [
        memberKey,
        memberId || null,
        memberEmail || null,
        memberName || '',
        date,
        onsetCategory || null,
        timeInBedHrs ?? null,
        estSleepHrs ?? null,
        wakeups ?? null,
        wakeVarianceMin ?? null,
        restfulness ?? null,
        score ?? null,
        new Date().toISOString()
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('sleep-score insert failed:', err);
    res.status(500).json({ error: 'failed to save sleep score' });
  }
});

// ---- sleep widget's own history chart calls this, keyed the same way as nutrition-log ----
app.get('/api/sleep-score', async (req, res) => {
  const { memberId, memberEmail, days } = req.query;
  const memberKey = memberId ? `id:${memberId}` : (memberEmail ? `email:${memberEmail}` : null);
  const lookback = parseInt(days, 10) || 30;

  if (!memberKey) {
    return res.status(400).json({ error: 'memberId or memberEmail is required' });
  }

  try {
    const result = await pool.query(
      `SELECT date, onset_category, time_in_bed_hrs, est_sleep_hrs, wakeups, wake_variance_min, restfulness, score
       FROM sleep_logs
       WHERE member_key = $1
       ORDER BY date DESC
       LIMIT $2`,
      [memberKey, lookback]
    );

    // Keep the row shape snake_case here, matching what the widget's renderChart already expects
    // (e.g. e.est_sleep_hrs) rather than camelCasing and having to change the front end too.
    const entries = result.rows.reverse().map(r => ({
      date: r.date,
      onset_category: r.onset_category,
      time_in_bed_hrs: r.time_in_bed_hrs,
      est_sleep_hrs: r.est_sleep_hrs,
      wakeups: r.wakeups,
      wake_variance_min: r.wake_variance_min,
      restfulness: r.restfulness,
      score: r.score
    }));

    const withSleep = entries.filter(e => typeof e.est_sleep_hrs === 'number');
    const averageSleepHrs = withSleep.length
      ? Math.round((withSleep.reduce((sum, e) => sum + e.est_sleep_hrs, 0) / withSleep.length) * 10) / 10
      : 0;

    res.json({ entries, averageSleepHrs });
  } catch (err) {
    console.error('sleep-score fetch failed:', err);
    res.status(500).json({ error: 'failed to load sleep history' });
  }
});

// ---- admin dashboard's Sleep tab, same auth pattern as the other /api/admin/* routes ----
app.get('/api/admin/sleep-summary', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const windowDays = parseInt(req.query.days, 10) || 30;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  try {
    const result = await pool.query(
      `SELECT * FROM sleep_logs WHERE date >= $1 ORDER BY member_key, date`,
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
        onsetCategory: r.onset_category,
        timeInBedHrs: r.time_in_bed_hrs,
        estSleepHrs: r.est_sleep_hrs,
        wakeups: r.wakeups,
        wakeVarianceMin: r.wake_variance_min,
        restfulness: r.restfulness,
        score: r.score
      });
    });

    const members = Object.values(byMember).map(m => {
      m.days.sort((a, b) => a.date.localeCompare(b.date));

      const loggedDays = m.days.length;
      const withSleep = m.days.filter(d => typeof d.estSleepHrs === 'number');
      const withScore = m.days.filter(d => typeof d.score === 'number');

      const avgSleepHrs = withSleep.length
        ? Math.round((withSleep.reduce((sum, d) => sum + d.estSleepHrs, 0) / withSleep.length) * 10) / 10
        : null;
      const avgScore = withScore.length
        ? Math.round(withScore.reduce((sum, d) => sum + d.score, 0) / withScore.length)
        : null;

      const latest = m.days[m.days.length - 1] || null;

      return {
        name: m.name,
        email: m.email,
        memberId: m.memberId,
        loggedDays,
        avgSleepHrs,
        avgScore,
        latest,
        days: m.days
      };
    });

    res.json({ members, windowDays });
  } catch (err) {
    console.error('admin sleep-summary failed:', err);
    res.status(500).json({ error: 'failed to load sleep summary' });
  }
});

// ---- calculator calls this whenever profile/custom foods/supplements/drinks change ----
app.post('/api/member-data', async (req, res) => {
  const { memberId, memberEmail, memberName, profile, customFoods, supplements, drinks } = req.body || {};

  const memberKey = memberId ? `id:${memberId}` : (memberEmail ? `email:${memberEmail}` : null);
  if (!memberKey) {
    return res.status(400).json({ error: 'memberId or memberEmail is required' });
  }

  try {
    await pool.query(
      `INSERT INTO member_data (member_key, member_id, member_email, member_name, profile, custom_foods, supplements, drinks, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (member_key) DO UPDATE SET
         member_id = EXCLUDED.member_id,
         member_email = EXCLUDED.member_email,
         member_name = EXCLUDED.member_name,
         profile = EXCLUDED.profile,
         custom_foods = EXCLUDED.custom_foods,
         supplements = EXCLUDED.supplements,
         drinks = EXCLUDED.drinks,
         updated_at = EXCLUDED.updated_at`,
      [
        memberKey,
        memberId || null,
        memberEmail || null,
        memberName || '',
        JSON.stringify(profile || {}),
        JSON.stringify(customFoods || []),
        JSON.stringify(supplements || []),
        JSON.stringify(drinks || []),
        new Date().toISOString()
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('member-data insert failed:', err);
    res.status(500).json({ error: 'failed to save member data' });
  }
});

// ---- calculator calls this once on identity resolution, to pull down a profile that was set up
// on a different device (a fresh device has nothing in localStorage to fall back on) ----
app.get('/api/member-data', async (req, res) => {
  const { memberId, memberEmail } = req.query;
  const memberKey = memberId ? `id:${memberId}` : (memberEmail ? `email:${memberEmail}` : null);

  if (!memberKey) {
    return res.status(400).json({ error: 'memberId or memberEmail is required' });
  }

  try {
    const result = await pool.query(
      `SELECT profile, custom_foods, supplements, drinks, updated_at FROM member_data WHERE member_key = $1`,
      [memberKey]
    );
    if (result.rows.length === 0) {
      return res.json({ found: false });
    }
    const r = result.rows[0];
    res.json({
      found: true,
      profile: r.profile || {},
      customFoods: r.custom_foods || [],
      supplements: r.supplements || [],
      drinks: r.drinks || [],
      updatedAt: r.updated_at
    });
  } catch (err) {
    console.error('member-data fetch failed:', err);
    res.status(500).json({ error: 'failed to load member data' });
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
