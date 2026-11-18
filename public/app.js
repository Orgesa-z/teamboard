const $ = (id) => document.getElementById(id);
const authBox = $('auth'), appBox = $('app'), logoutBtn = $('logout'), who = $('who'), msg = $('msg');
let token = localStorage.getItem('tb-token');
const myId = Number(localStorage.getItem('tb-id'));
let socket = null, boards = [], currentBoardId = null, role = null;

// ---------- Login / signup ----------
function logout() {
  ['tb-token', 'tb-id', 'tb-name'].forEach((k) => localStorage.removeItem(k));
  location.reload();
}
logoutBtn.addEventListener('click', logout);

$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('authError').textContent = '';
  const res = await fetch('/api/' + e.submitter.dataset.mode, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: $('username').value, password: $('password').value }),
  });
  const data = await res.json();
  if (!res.ok) { $('authError').textContent = data.error; return; }
  localStorage.setItem('tb-token', data.token);
  localStorage.setItem('tb-id', data.id);
  localStorage.setItem('tb-name', data.name);
  location.reload();
});

// ---------- Helpers ----------
const flash = (text) => { msg.textContent = text || ''; };

async function api(url, method = 'GET', body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { logout(); throw new Error('Please log in again.'); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

// ---------- Boards ----------
async function loadBoards(preferId) {
  boards = await api('/api/boards');
  const select = $('boardSelect');
  select.innerHTML = '';
  boards.forEach((b) => {
    const o = document.createElement('option');
    o.value = b.id;
    o.textContent = b.name + (b.role === 'owner' ? '' : ' (member)');
    select.appendChild(o);
  });
  const stillThere = boards.find((b) => b.id === (preferId || currentBoardId));
  const target = stillThere || boards[0];
  $('boardArea').hidden = $('boardTools').hidden = !target;
  select.hidden = !target;
  if (!target) { currentBoardId = null; flash('Create your first board to get started.'); who.textContent = ''; return; }
  select.value = target.id;
  openBoard(target.id);
}

function openBoard(id) {
  currentBoardId = id;
  socket.emit('board:join', id, (res) => {
    if (res.error) { flash(res.error); return; }
    role = res.role;
    $('invite').hidden = $('delBoard').hidden = role !== 'owner';
    flash('');
    loadMembers();
  });
}

async function loadMembers() {
  const list = await api(`/api/boards/${currentBoardId}/members`);
  $('members').textContent = 'Members: ' + list.map((m) => m.username + (m.role === 'owner' ? ' (owner)' : '')).join(', ');
}

$('boardSelect').addEventListener('change', (e) => openBoard(Number(e.target.value)));

$('newBoard').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const b = await api('/api/boards', 'POST', { name: $('newBoardName').value });
    $('newBoardName').value = '';
    await loadBoards(b.id);
  } catch (err) { flash(err.message); }
});

$('invite').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api(`/api/boards/${currentBoardId}/members`, 'POST', { username: $('inviteName').value });
    $('inviteName').value = '';
    flash(r.username + ' was added to the board.');
    loadMembers();
  } catch (err) { flash(err.message); }
});

$('delBoard').addEventListener('click', async () => {
  if (!confirm('Delete this board and all its notes?')) return;
  try { await api('/api/boards/' + currentBoardId, 'DELETE'); } catch (err) { flash(err.message); }
});

// ---------- Notes ----------
function startApp() {
  authBox.hidden = true;
  appBox.hidden = false;
  logoutBtn.hidden = false;

  socket = io({ auth: { token } });
  socket.on('connect_error', (err) => { if (err.message === 'unauthorized') logout(); });
  socket.on('connect', () => { loadBoards(currentBoardId).catch((e) => flash(e.message)); });
  socket.on('boards:changed', () => loadBoards(currentBoardId).catch(() => {}));

  const lists = {};
  document.querySelectorAll('#boardArea section').forEach((sec) => {
    const col = sec.dataset.col;
    lists[col] = sec.querySelector('.list');
    sec.addEventListener('dragover', (e) => { e.preventDefault(); sec.classList.add('over'); });
    sec.addEventListener('dragleave', () => sec.classList.remove('over'));
    sec.addEventListener('drop', (e) => {
      e.preventDefault();
      sec.classList.remove('over');
      socket.emit('card:move', { id: Number(e.dataTransfer.getData('text/plain')), col });
    });
  });

  socket.on('cards', (cards) => {
    for (const col in lists) lists[col].innerHTML = '';
    cards.forEach((card) => {
      const el = document.createElement('div');
      el.className = 'note';
      el.draggable = true;
      el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', card.id); el.classList.add('dragging'); });
      el.addEventListener('dragend', () => el.classList.remove('dragging'));

      const text = document.createElement('span');
      text.textContent = card.text; // textContent prevents XSS
      el.appendChild(text);

      if (card.author) {
        const by = document.createElement('small');
        by.textContent = 'added by ' + card.author;
        el.appendChild(by);
      }
      // Authors can delete their notes, the board owner can delete any note
      if (card.authorId === myId || role === 'owner') {
        const del = document.createElement('button');
        del.textContent = '×';
        del.title = 'Delete note';
        del.addEventListener('click', () => socket.emit('card:delete', card.id));
        el.appendChild(del);
      }
      lists[card.col].appendChild(el);
    });
    for (const col in lists) {
      if (!lists[col].children.length) lists[col].innerHTML = '<p class="empty">Nothing here yet.</p>';
    }
  });

  socket.on('online', (names) => { who.textContent = names.length + ' online: ' + names.join(', '); });
}

$('add').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('text');
  if (input.value.trim() && socket) socket.emit('card:add', input.value);
  input.value = '';
  input.focus();
});

if (token) startApp(); else authBox.hidden = false;