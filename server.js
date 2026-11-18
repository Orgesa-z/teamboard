const express = require('express');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { Server } = require('socket.io');

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
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ---------- Database ----------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, username TEXT NOT NULL, hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (lower(username));

    CREATE TABLE IF NOT EXISTS boards (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS board_members (
      board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      user_id  INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
      role     TEXT NOT NULL CHECK (role IN ('owner','member')),
      PRIMARY KEY (board_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS cards (
      id SERIAL PRIMARY KEY, text TEXT NOT NULL,
      col TEXT NOT NULL DEFAULT 'todo' CHECK (col IN ('todo','doing','done')),
      author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE cards ADD COLUMN IF NOT EXISTS board_id INTEGER REFERENCES boards(id) ON DELETE CASCADE;
    DELETE FROM cards WHERE board_id IS NULL;
  `);
}

async function roleOf(boardId, userId) {
  if (!Number.isInteger(boardId)) return null;
  const { rows } = await pool.query('SELECT role FROM board_members WHERE board_id = $1 AND user_id = $2', [boardId, userId]);
  return rows[0] ? rows[0].role : null;
}

async function getCards(boardId) {
  const { rows } = await pool.query(`
    SELECT c.id, c.text, c.col, c.author_id AS "authorId", u.username AS author
    FROM cards c LEFT JOIN users u ON u.id = c.author_id
    WHERE c.board_id = $1 ORDER BY c.id`, [boardId]);
  return rows;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => { console.error(err); res.status(500).json({ error: 'Something went wrong. Try again.' }); });

// ---------- Accounts ----------
const makeToken = (u) => jwt.sign({ id: u.id, name: u.username }, SECRET, { expiresIn: '7d' });
const reply = (u) => ({ token: makeToken(u), id: u.id, name: u.username });

app.post('/api/signup', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 letters, numbers or underscores.' });
  }
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query('INSERT INTO users (username, hash) VALUES ($1, $2) RETURNING id, username', [username, hash]);
    res.status(201).json(reply(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That username is already taken.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
});

app.post('/api/login', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM users WHERE lower(username) = lower($1)', [String(req.body.username || '').trim()]);
  const user = rows[0];
  const ok = user && (await bcrypt.compare(String(req.body.password || ''), user.hash));
  if (!ok) return res.status(401).json({ error: 'Wrong username or password.' });
  res.json(reply(user));
}));

function auth(req, res, next) {
  try {
    const p = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET);
    req.user = { id: p.id, name: p.name };
    next();
  } catch {
    res.status(401).json({ error: 'Please log in again.' });
  }
}

// ---------- Boards ----------
app.get('/api/boards', auth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.id, b.name, m.role FROM boards b JOIN board_members m ON m.board_id = b.id
     WHERE m.user_id = $1 ORDER BY b.id`, [req.user.id]);
  res.json(rows);
}));

app.post('/api/boards', auth, wrap(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'Give the board a name.' });
  const { rows } = await pool.query('INSERT INTO boards (name, owner_id) VALUES ($1, $2) RETURNING id, name', [name, req.user.id]);
  await pool.query(`INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, 'owner')`, [rows[0].id, req.user.id]);
  res.status(201).json({ ...rows[0], role: 'owner' });
}));

app.get('/api/boards/:id/members', auth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!(await roleOf(id, req.user.id))) return res.status(403).json({ error: 'You are not on this board.' });
  const { rows } = await pool.query(
    `SELECT u.username, m.role FROM board_members m JOIN users u ON u.id = m.user_id
     WHERE m.board_id = $1 ORDER BY m.role DESC, u.username`, [id]);
  res.json(rows);
}));

// Only the owner can invite people
app.post('/api/boards/:id/members', auth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if ((await roleOf(id, req.user.id)) !== 'owner') return res.status(403).json({ error: 'Only the owner can invite people.' });
  const { rows } = await pool.query('SELECT id, username FROM users WHERE lower(username) = lower($1)', [String(req.body.username || '').trim()]);
  if (!rows[0]) return res.status(404).json({ error: 'No user with that username.' });
  await pool.query(`INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [id, rows[0].id]);
  io.to('user:' + rows[0].id).emit('boards:changed');
  res.json({ ok: true, username: rows[0].username });
}));

// Only the owner can delete a board
app.delete('/api/boards/:id', auth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if ((await roleOf(id, req.user.id)) !== 'owner') return res.status(403).json({ error: 'Only the owner can delete this board.' });
  const { rows } = await pool.query('SELECT user_id FROM board_members WHERE board_id = $1', [id]);
  await pool.query('DELETE FROM boards WHERE id = $1', [id]);
  rows.forEach((r) => io.to('user:' + r.user_id).emit('boards:changed'));
  res.json({ ok: true });
}));

// ---------- Real-time ----------
io.use(async (socket, next) => {
  try {
    const p = jwt.verify(socket.handshake.auth.token, SECRET);
    const { rows } = await pool.query('SELECT id, username FROM users WHERE id = $1', [p.id]);
    if (!rows[0]) throw new Error('no such user');
    socket.user = { id: rows[0].id, name: rows[0].username };
    socket.data.name = rows[0].username;
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

async function sendPresence(boardId) {
  if (!boardId) return;
  const room = 'board:' + boardId;
  const socks = await io.in(room).fetchSockets();
  io.to(room).emit('online', [...new Set(socks.map((s) => s.data.name))]);
}
const sendCards = async (boardId) => io.to('board:' + boardId).emit('cards', await getCards(boardId));

io.on('connection', (socket) => {
  socket.join('user:' + socket.user.id);
  const safe = (fn) => async (...args) => { try { await fn(...args); } catch (err) { console.error(err); } };

  socket.on('board:join', safe(async (boardId, ack) => {
    const role = await roleOf(boardId, socket.user.id);
    if (!role) return ack && ack({ error: 'No access to this board.' });
    const old = socket.boardId;
    if (old) { socket.leave('board:' + old); socket.boardId = null; await sendPresence(old); }
    socket.boardId = boardId;
    socket.join('board:' + boardId);
    ack && ack({ role });
    socket.emit('cards', await getCards(boardId));
    await sendPresence(boardId);
  }));

  // Every action re-checks membership in the database
  socket.on('card:add', safe(async (text) => {
    text = String(text).trim().slice(0, 140);
    if (!text || !(await roleOf(socket.boardId, socket.user.id))) return;
    await pool.query('INSERT INTO cards (text, board_id, author_id) VALUES ($1, $2, $3)', [text, socket.boardId, socket.user.id]);
    await sendCards(socket.boardId);
  }));

  socket.on('card:move', safe(async ({ id, col }) => {
    if (!Number.isInteger(id) || !COLUMNS.includes(col)) return;
    if (!(await roleOf(socket.boardId, socket.user.id))) return;
    await pool.query('UPDATE cards SET col = $1 WHERE id = $2 AND board_id = $3', [col, id, socket.boardId]);
    await sendCards(socket.boardId);
  }));

  // Members delete their own notes, the owner can delete any note on the board
  socket.on('card:delete', safe(async (id) => {
    const role = await roleOf(socket.boardId, socket.user.id);
    if (!role || !Number.isInteger(id)) return;
    await pool.query('DELETE FROM cards WHERE id = $1 AND board_id = $2 AND ($3 OR author_id = $4)',
      [id, socket.boardId, role === 'owner', socket.user.id]);
    await sendCards(socket.boardId);
  }));

  socket.on('disconnect', () => sendPresence(socket.boardId));
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => {
    console.log('Database ready');
    server.listen(PORT, () => console.log(`Board running at http://localhost:${PORT}`));
  })
  .catch((err) => { console.error('Could not connect to the database:', err.message); process.exit(1); });