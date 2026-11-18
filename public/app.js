const socket = io();

let name = localStorage.getItem('teamboard-name');
if (!name) {
  name = (prompt('Your name?') || 'Guest').trim() || 'Guest';
  localStorage.setItem('teamboard-name', name);
}
socket.emit('join', name);

const who = document.getElementById('who');
const lists = {};
document.querySelectorAll('section').forEach((sec) => {
  const col = sec.dataset.col;
  lists[col] = sec.querySelector('.list');

  sec.addEventListener('dragover', (e) => { e.preventDefault(); sec.classList.add('over'); });
  sec.addEventListener('dragleave', () => sec.classList.remove('over'));
  sec.addEventListener('drop', (e) => {
    e.preventDefault();
    sec.classList.remove('over');
    const id = Number(e.dataTransfer.getData('text/plain'));
    socket.emit('card:move', { id, col });
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
    text.textContent = card.text;           // textContent prevents XSS
    el.appendChild(text);

    if (card.author) {
      const by = document.createElement('small');
      by.textContent = 'added by ' + card.author;
      el.appendChild(by);
    }

    const del = document.createElement('button');
    del.textContent = '×';
    del.title = 'Delete note';
    del.addEventListener('click', () => socket.emit('card:delete', card.id));
    el.appendChild(del);

    lists[card.col].appendChild(el);
  });

  for (const col in lists) {
    if (!lists[col].children.length) {
      lists[col].innerHTML = '<p class="empty">Nothing here yet.</p>';
    }
  }
});

socket.on('online', (names) => {
  who.textContent = names.length + ' online: ' + names.join(', ');
});

document.getElementById('add').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('text');
  if (input.value.trim()) socket.emit('card:add', input.value);
  input.value = '';
  input.focus();
});
