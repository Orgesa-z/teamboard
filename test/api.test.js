const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { server, io, pool, initDb } = require('../server');

// Every test account starts with this random tag, so they can be cleaned up afterwards
const tag = 'zz_test_' + Math.random().toString(36).slice(2, 7);
const sockets = [];
let base, A, B, C, boardId;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(check) {
  for (let i = 0; i < 40; i++) {
    if (await check()) return true;
    await sleep(150);
  }
  return false;
}

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}
const signup = async (name) =>
  (await call('/api/signup', { method: 'POST', body: { username: tag + name, password: 'secret123' } })).data;

function open(token) {
  return new Promise((resolve, reject) => {
    const s = connect(base, { auth: { token }, transports: ['websocket'] });
    sockets.push(s);
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}
const join = (s, id) => new Promise((resolve) => s.emit('board:join', id, resolve));
const cards = async () =>
  (await pool.query('SELECT id, text FROM cards WHERE board_id = $1 ORDER BY id', [boardId])).rows;
const find = async (text) => (await cards()).find((c) => c.text === text);

before(async () => {
  await initDb();
  await new Promise((r) => server.listen(0, r));
  base = 'http://localhost:' + server.address().port;
});

after(async () => {
  sockets.forEach((s) => s.close());
  // Deleting the test users also removes their boards and notes (ON DELETE CASCADE)
  await pool.query('DELETE FROM users WHERE username LIKE $1', [tag + '%']);
  await new Promise((r) => io.close(r));
  await pool.end();
});

test('signup and login rules', async () => {
  A = await signup('a');
  assert.ok(A.token, 'signup returns a token');

  const dup = await call('/api/signup', { method: 'POST', body: { username: tag + 'a', password: 'secret123' } });
  assert.equal(dup.status, 409, 'duplicate username is rejected');

  const short = await call('/api/signup', { method: 'POST', body: { username: tag + 'x', password: '123' } });
  assert.equal(short.status, 400, 'short password is rejected');

  const wrong = await call('/api/login', { method: 'POST', body: { username: tag + 'a', password: 'nope-nope' } });
  assert.equal(wrong.status, 401, 'wrong password is rejected');

  const ok = await call('/api/login', { method: 'POST', body: { username: tag + 'a', password: 'secret123' } });
  assert.equal(ok.status, 200);
});

test('only members see a board, only the owner invites or deletes', async () => {
  B = await signup('b');
  C = await signup('c');

  const made = await call('/api/boards', { method: 'POST', token: A.token, body: { name: 'Test board' } });
  assert.equal(made.status, 201);
  assert.equal(made.data.role, 'owner');
  boardId = made.data.id;

  assert.equal((await call(`/api/boards/${boardId}/members`, { token: B.token })).status, 403, 'outsider cannot see members');
  assert.equal((await call(`/api/boards/${boardId}/members`, { method: 'POST', token: B.token, body: { username: tag + 'c' } })).status, 403, 'outsider cannot invite');
  assert.equal((await call(`/api/boards/${boardId}/members`, { method: 'POST', token: A.token, body: { username: 'nobody_here_123' } })).status, 404, 'unknown user');

  assert.equal((await call(`/api/boards/${boardId}/members`, { method: 'POST', token: A.token, body: { username: tag + 'b' } })).status, 200);
  const listB = await call('/api/boards', { token: B.token });
  assert.ok(listB.data.some((b) => b.id === boardId && b.role === 'member'), 'invited user sees the board');

  assert.equal((await call(`/api/boards/${boardId}/members`, { method: 'POST', token: B.token, body: { username: tag + 'c' } })).status, 403, 'member cannot invite');
  assert.equal((await call(`/api/boards/${boardId}`, { method: 'DELETE', token: B.token })).status, 403, 'member cannot delete the board');
});

test('sockets reject bad tokens and non-members', async () => {
  await assert.rejects(open('not-a-real-token'));
  const sC = await open(C.token);
  const res = await join(sC, boardId);
  assert.ok(res.error, 'a non-member cannot join the board');
});

test('notes: authors delete their own, the owner deletes any', async () => {
  const sA = await open(A.token);
  const sB = await open(B.token);
  assert.equal((await join(sA, boardId)).role, 'owner');
  assert.equal((await join(sB, boardId)).role, 'member');

  sA.emit('card:add', 'note from A');
  sB.emit('card:add', 'note from B');
  assert.ok(await eventually(async () => (await cards()).length === 2));
  const noteA = await find('note from A');
  const noteB = await find('note from B');

  sB.emit('card:delete', noteA.id); // a member tries to delete someone else's note
  await sleep(1500);
  assert.equal((await cards()).length, 2, 'member cannot delete the owner note');

  sA.emit('card:delete', noteB.id); // the owner can delete any note
  assert.ok(await eventually(async () => (await cards()).length === 1), 'owner can delete any note');

  sB.emit('card:add', 'second from B');
  assert.ok(await eventually(async () => (await cards()).length === 2));
  sB.emit('card:delete', (await find('second from B')).id); // a member deletes their own note
  assert.ok(await eventually(async () => (await cards()).length === 1), 'member can delete own note');
});

test('deleting a board removes its notes', async () => {
  const res = await call(`/api/boards/${boardId}`, { method: 'DELETE', token: A.token });
  assert.equal(res.status, 200);
  assert.equal((await cards()).length, 0);
});