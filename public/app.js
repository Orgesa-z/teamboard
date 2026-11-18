const $ = (id) => document.getElementById(id);
const authBox = $('auth'), appBox = $('app'), logoutBtn = $('logout'), who = $('who');
let socket = null;

// ---------- Login / signup ----------
function saveSession(data) {
  localStorage.setItem('tb-token', data.token);
  localStorage.setItem('tb-id', data.id);
  localStorage.setItem('tb-name', data.name);
}
function logout() {
  localStorage.removeItem('tb-token');
  localStorage.removeItem('tb-id');
  localStorage.removeItem('tb-name');
  location.reload();
}
logoutBtn.addEventListener('click', logout);

$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const mode = e.submitter.dataset.mode; // 'login' or 'signup'
  $('authError').textContent = '';
  const res = await fetch('/api/' + mode, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: $('username').value, password: $('password').value }),
  });
  const data = await res.json();
  if (!res.ok) { $('authError').textContent = data.error; return; }
  saveSession(data);
  startBoard();
});

// ---------- Board ----------
function startBoard() {
  const token = localStorage.getItem('tb-token');
  const myId = Number(localStorage.getItem('tb-id'));
  if (!token) { authBox.hidden = false; return; }

  authBox.hidden = true;
  appBox.hidden = false;
  logoutBtn.hidden = false;

  socket = io({ auth: { token } });
  socket.on('connect_error', (err) => { if (err.message === 'unauthorized') logout(); });

  const lists = {};
  document.querySelectorAll('#app section').forEach((sec) => {
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
      el.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', card.id);
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => el.classList.remove('dragging'));

      const text = document.createElement('span');
      text.textContent = card.text; // textContent prevents XSS
      el.appendChild(text);

      if (card.author) {
        const by = document.createElement('small');
        by.textContent = 'added by ' + card.author;
        el.appendChild(by);
      }

      // Only the author sees the delete button (the server checks this too)
      if (!card.authorId || card.authorId === myId) {
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

  socket.on('online', (names) => {
    who.textContent = names.length + ' online: ' + names.join(', ');
  });
}

$('add').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('text');
  if (input.value.trim() && socket) socket.emit('card:add', input.value);
  input.value = '';
  input.focus();
});

startBoard();