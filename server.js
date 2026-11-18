const express = require('express');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { Server } = require('socket.io');

// Local development: read DATABASE_URL from the .env file (on Render it is set in the dashboard)
try { process.loadEnvFile(); } catch {}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is missing. Create a .env file with your Neon connection string.');
  process.exit(1);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
const COLUMNS = ['todo', 'doing', 'done'];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ---------- Database ----------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id         SERIAL PRIMARY KEY,
      username   TEXT NOT NULL,
      hash       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (lower(username));

    CREATE TABLE IF NOT EXISTS cards (
      id         SERIAL PRIMARY KEY,
      text       TEXT NOT NULL,
      col        TEXT NOT NULL DEFAULT 'todo' CHECK (col IN ('todo','doing','done')),
      author_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM cards');
  if (rows[0].n === 0) {
    await pool.query(`INSERT INTO cards (text, col) VALUES ('Drag me to another column', 'todo')`);
  }
}

async function getCards() {
  const { rows } = await pool.query(`
    SELECT c.id, c.text, c.col, c.author_id AS "authorId", u.username AS author
    FROM cards c
    LEFT JOIN users u ON u.id = c.author_id
    ORDER BY c.id`);
  return rows;
}

const online = new Map(); // socket.id -> username
const broadcast = async () => io.emit('cards', await getCards());
const sendOnline = () => io.emit('online', [...new Set(online.values())]);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Accounts ----------
const makeToken = (u) => jwt.sign({ id: u.id, name: u.username }, SECRET, { expiresIn: '7d' });
const reply = (u) => ({ token: makeToken(u), id: u.id, name: u.username });

app.post('/api/signup', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 letters, numbers or underscores.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (username, hash) VALUES ($1, $2) RETURNING id, username',
      [username, hash]
    );
    res.status(201).json(reply(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That username is already taken.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
});

app.post('/api/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE lower(username) = lower($1)', [username]);
    const user = rows[0];
    const ok = user && (await bcrypt.compare(password, user.hash));
    if (!ok) return res.status(401).json({ error: 'Wrong username or password.' });
    res.json(reply(user));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
});

// ---------- Real-time ----------
// Only logged-in users that exist in the database can connect
io.use(async (socket, next) => {
  try {
    const p = jwt.verify(socket.handshake.auth.token, SECRET);
    const { rows } = await pool.query('SELECT id, username FROM users WHERE id = $1', [p.id]);
    if (!rows[0]) throw new Error('no such user');
    socket.user = { id: rows[0].id, name: rows[0].username };
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

io.on('connection', async (socket) => {
  online.set(socket.id, socket.user.name);
  socket.emit('cards', await getCards());
  sendOnline();

  // Every handler is wrapped so a database error never crashes the server
  const safe = (fn) => async (...args) => {
    try { await fn(...args); } catch (err) { console.error(err); }
  };

  socket.on('card:add', safe(async (text) => {
    text = String(text).trim().slice(0, 140);
    if (!text) return;
    await pool.query('INSERT INTO cards (text, author_id) VALUES ($1, $2)', [text, socket.user.id]);
    await broadcast();
  }));

  socket.on('card:move', safe(async ({ id, col }) => {
    if (!Number.isInteger(id) || !COLUMNS.includes(col)) return;
    await pool.query('UPDATE cards SET col = $1 WHERE id = $2', [col, id]);
    await broadcast();
  }));

  // Permission rule: you can only delete your own notes
  socket.on('card:delete', safe(async (id) => {
    if (!Number.isInteger(id)) return;
    await pool.query('DELETE FROM cards WHERE id = $1 AND (author_id IS NULL OR author_id = $2)', [id, socket.user.id]);
    await broadcast();
  }));

  socket.on('disconnect', () => {
    online.delete(socket.id);
    sendOnline();
  });
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => {
    console.log('Database ready');
    server.listen(PORT, () => console.log(`Board running at http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('Could not connect to the database:', err.message);
    process.exit(1);
  });