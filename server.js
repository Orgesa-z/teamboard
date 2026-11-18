const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const DB_FILE = path.join(__dirname, 'data.json');
const COLUMNS = ['todo', 'doing', 'done'];

// Load saved cards (or start with one example card)
let cards;
try {
  cards = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
} catch {
  cards = [{ id: 1, text: 'Drag me to another column', col: 'todo' }];
}
let nextId = cards.reduce((max, c) => Math.max(max, c.id), 0) + 1;

const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(cards, null, 2));
const online = new Map(); // socket.id -> name

function broadcast() {
  io.emit('cards', cards);
}

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  socket.emit('cards', cards);
  io.emit('online', [...online.values()]);

  socket.on('join', (name) => {
    online.set(socket.id, String(name).trim().slice(0, 20) || 'Guest');
    io.emit('online', [...online.values()]);
  });

  socket.on('card:add', (text) => {
    text = String(text).trim().slice(0, 140);
    if (!text) return;
    const author = online.get(socket.id) || 'Guest';
    cards.push({ id: nextId++, text, col: 'todo', author });
    save();
    broadcast();
  });

  socket.on('card:move', ({ id, col }) => {
    const card = cards.find((c) => c.id === id);
    if (!card || !COLUMNS.includes(col)) return;
    card.col = col;
    save();
    broadcast();
  });

  socket.on('card:delete', (id) => {
    cards = cards.filter((c) => c.id !== id);
    save();
    broadcast();
  });

  socket.on('disconnect', () => {
    online.delete(socket.id);
    io.emit('online', [...online.values()]);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Board running at http://localhost:${PORT}`));
