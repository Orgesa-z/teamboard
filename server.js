const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
const DB_FILE = path.join(__dirname, 'data.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const COLUMNS = ['todo', 'doing', 'done'];

function load(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
let cards = load(DB_FILE, [{ id: 1, text: 'Drag me to another column', col: 'todo' }]);
let users = load(USERS_FILE, []);
let nextId = cards.reduce((max, c) => Math.max(max, c.id), 0) + 1;

const saveCards = () => fs.writeFileSync(DB_FILE, JSON.stringify(cards, null, 2));
const saveUsers = () => fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
const online = new Map(); // socket.id -> username

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
  if (users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }
  const user = { id: Date.now(), username, hash: await bcrypt.hash(password, 10) };
  users.push(user);
  saveUsers();
  res.status(201).json(reply(user));
});

app.post('/api/login', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = users.find((u) => u.username.toLowerCase() === username);
  const ok = user && (await bcrypt.compare(password, user.hash));
  if (!ok) return res.status(401).json({ error: 'Wrong username or password.' });
  res.json(reply(user));
});

// ---------- Real-time ----------
// Only logged-in users can open a socket connection
io.use((socket, next) => {
  try {
    const p = jwt.verify(socket.handshake.auth.token, SECRET);
    socket.user = { id: p.id, name: p.name };
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

const broadcast = () => io.emit('cards', cards);
const sendOnline = () => io.emit('online', [...new Set(online.values())]);

io.on('connection', (socket) => {
  online.set(socket.id, socket.user.name);
  socket.emit('cards', cards);
  sendOnline();

  socket.on('card:add', (text) => {
    text = String(text).trim().slice(0, 140);
    if (!text) return;
    cards.push({ id: nextId++, text, col: 'todo', author: socket.user.name, authorId: socket.user.id });
    saveCards();
    broadcast();
  });

  socket.on('card:move', ({ id, col }) => {
    const card = cards.find((c) => c.id === id);
    if (!card || !COLUMNS.includes(col)) return;
    card.col = col;
    saveCards();
    broadcast();
  });

  // Permission rule: you can only delete your own notes
  socket.on('card:delete', (id) => {
    const card = cards.find((c) => c.id === id);
    if (!card) return;
    if (card.authorId && card.authorId !== socket.user.id) return;
    cards = cards.filter((c) => c.id !== id);
    saveCards();
    broadcast();
  });

  socket.on('disconnect', () => {
    online.delete(socket.id);
    sendOnline();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Board running at http://localhost:${PORT}`));