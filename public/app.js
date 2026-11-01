'use strict';
const $ = selector => document.querySelector(selector);
const socket = io();
let state = null;
let seat = null;
let selected = null;
let pendingPromotion = null;
let roomCode = null;
let aiEnabled = false;
const glyph = { wk: '♔', wq: '♕', wr: '♖', wb: '♗', wn: '♘', wp: '♙', bk: '♚', bq: '♛', br: '♜', bb: '♝', bn: '♞', bp: '\u265F\uFE0E' };
const names = { q: 'Ферзь', r: 'Ладья', b: 'Слон', n: 'Конь' };

function toast(message) {
  const el = $('#toast'); el.textContent = message; el.classList.remove('hidden');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.add('hidden'), 3400);
}
function savedToken(code) { return localStorage.getItem(`chesszone:${code}`) || ''; }
function enterRoom({ code, color, token }) {
  roomCode = code; seat = color; selected = null;
  $('#ai-toggle').classList.toggle('hidden', color !== 'w');
  if (color !== 'w') aiEnabled = false;
  localStorage.setItem(`chesszone:${code}`, token);
  history.replaceState(null, '', `?room=${encodeURIComponent(code)}`);
  $('#lobby').classList.add('hidden'); $('#game').classList.remove('hidden');
  $('#room-code').textContent = code;
  $('#my-color').textContent = color === 'w' ? 'Белые' : 'Чёрные';
  $('#opponent-color').textContent = color === 'w' ? 'Чёрные' : 'Белые';
}
function submitJoin(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) return toast('Введи код комнаты.');
  const name = $('#name').value.trim() || localStorage.getItem('chesszone:name') || 'Игрок';
  localStorage.setItem('chesszone:name', name);
  socket.emit('join-room', { code: normalized, name, token: savedToken(normalized) }, response => {
    if (response?.error) toast(response.error);
  });
}
function createRoom() {
  const name = $('#name').value.trim() || 'Игрок';
  localStorage.setItem('chesszone:name', name);
  socket.emit('create-room', { name }, response => { if (response?.error) toast(response.error); });
}
$('#create').addEventListener('click', createRoom);
$('#join').addEventListener('click', () => submitJoin($('#room-input').value));
$('#room-input').addEventListener('keydown', e => { if (e.key === 'Enter') submitJoin(e.target.value); });
$('#name').value = localStorage.getItem('chesszone:name') || '';
const prefill = new URLSearchParams(location.search).get('room');
if (prefill && /^[A-Fa-f0-9]{10}$/.test(prefill)) $('#room-input').value = prefill.toUpperCase();

socket.on('connect', () => {
  $('#connection').textContent = 'На связи'; $('#connection').classList.add('online');
  if (roomCode) submitJoin(roomCode);
  else if (prefill && savedToken(prefill.toUpperCase())) submitJoin(prefill);
});
socket.on('disconnect', () => {
  $('#connection').textContent = 'Соединение потеряно'; $('#connection').classList.remove('online');
});
socket.on('session-replaced', () => toast('Эта партия открылась в другой вкладке.'));
socket.on('joined', enterRoom);
socket.on('ai-state', ({ enabled }) => {
  if (seat !== 'w') return;
  aiEnabled = !!enabled;
  $('#ai-toggle').textContent = aiEnabled ? '🤖 ИИ: включён' : '🤖 ИИ: выключен';
  renderBoard();
});
socket.on('game-state', next => { state = next; selected = null; render(); });

function pieceMap(fen) {
  const map = {};
  fen.split(' ')[0].split('/').forEach((row, r) => {
    let file = 0;
    for (const char of row) {
      if (/\d/.test(char)) file += Number(char);
      else {
        const color = char === char.toUpperCase() ? 'w' : 'b';
        const sq = 'abcdefgh'[file] + (8 - r);
        map[sq] = { color, type: char.toLowerCase() };
        file++;
      }
    }
  });
  return map;
}
function isMyTurn() {
  return state && state.turn === seat && state.players.w && state.players.b && !state.status.over && !aiEnabled;
}
function renderBoard() {
  const board = $('#board'); board.replaceChildren();
  if (!state) return;
  const pieces = pieceMap(state.fen), files = seat === 'b' ? 'hgfedcba' : 'abcdefgh';
  const ranks = seat === 'b' ? '12345678' : '87654321';
  const targets = selected ? state.legal.filter(m => m.from === selected).map(m => m.to) : [];
  for (const rank of ranks) for (const file of files) {
    const sq = file + rank, p = pieces[sq], light = ('abcdefgh'.indexOf(file) + Number(rank)) % 2 === 0;
    const button = document.createElement('button');
    button.className = `square ${light ? 'light' : 'dark'}${selected === sq ? ' selected' : ''}${targets.includes(sq) ? ' target' : ''}${p ? ' occupied' : ''}`;
    button.type = 'button'; button.setAttribute('aria-label', `${sq}: ${p ? `${p.color === 'w' ? 'белая' : 'чёрная'} фигура` : 'пусто'}`);
    if (p) {
      const el = document.createElement('span'); el.className = `piece ${p.color}`;
      el.textContent = glyph[p.color + p.type]; button.append(el);
    }
    if (file === files[0]) {
      const el = document.createElement('span'); el.className = 'coord rank'; el.textContent = rank; button.append(el);
    }
    if (rank === ranks[ranks.length - 1]) {
      const el = document.createElement('span'); el.className = 'coord file'; el.textContent = file; button.append(el);
    }
    button.addEventListener('click', () => clickSquare(sq, pieces)); board.append(button);
  }
}
function clickSquare(sq, pieces) {
  if (!isMyTurn()) return;
  if (pieces[sq]?.color === seat) { selected = selected === sq ? null : sq; return renderBoard(); }
  if (!selected) return;
  const possible = state.legal.filter(m => m.from === selected && m.to === sq);
  if (possible.length === 0) { selected = null; return renderBoard(); }
  if (possible.some(m => m.promotion)) return promote(selected, sq);
  sendMove(selected, sq, 'q');
}
function sendMove(from, to, promotion) {
  socket.emit('make-move', { from, to, promotion }, response => { if (response?.error) toast(response.error); });
  selected = null; renderBoard();
}
function promote(from, to) {
  pendingPromotion = { from, to }; $('#promotion').classList.remove('hidden');
  const options = $('#promotion-options'); options.replaceChildren();
  for (const type of ['q', 'r', 'b', 'n']) {
    const button = document.createElement('button'); button.textContent = glyph[seat + type]; button.title = names[type];
    button.addEventListener('click', () => { $('#promotion').classList.add('hidden'); sendMove(from, to, type); pendingPromotion = null; });
    options.append(button);
  }
}
$('#cancel-promotion').addEventListener('click', () => { $('#promotion').classList.add('hidden'); pendingPromotion = null; });
function render() {
  if (!state) return;
  const them = seat === 'w' ? 'b' : 'w';
  $('#my-name').textContent = state.players[seat]?.name || 'Ты';
  $('#opponent-name').textContent = state.players[them]?.name || 'Ожидаем друга';
  $('#opponent-online').textContent = !state.players[them] ? 'Друг ещё не зашёл' : state.players[them].online ? 'В сети' : 'Не в сети';
  $('#my-online').textContent = state.players[seat]?.online ? 'В сети' : 'Переподключение';
  $('#game-status').textContent = state.players.b ? state.status.text : 'Ожидаем второго игрока';
  const moves = $('#moves'); moves.replaceChildren();
  if (!state.moves.length) { const el = document.createElement('span'); el.className='muted'; el.textContent='Пока ходов нет'; moves.append(el); }
  else for (let i=0;i<state.moves.length;i+=2) {
    const el=document.createElement('span'); el.className='move-pair';
    el.textContent=`${Math.floor(i/2)+1}. ${state.moves[i]} ${state.moves[i+1] || ''}`; moves.append(el);
  }
  const chat = $('#chat-list'); chat.replaceChildren();
  if (!state.chat.length) { const el=document.createElement('span'); el.className='muted'; el.textContent='Сообщений пока нет'; chat.append(el); }
  state.chat.forEach(entry => { const item = document.createElement('div'); item.className='chat-message'; const who=document.createElement('strong'); who.textContent=entry.name; const content=document.createElement('span'); content.textContent=entry.message; item.append(who,content); chat.append(item); });
  chat.scrollTop=chat.scrollHeight;
  $('#resign').disabled = !state.players.b || state.status.over;
  $('#rematch').classList.toggle('hidden', !state.status.over);
  $('#rematch').textContent = state.rematch[seat] ? 'Ожидаем согласия друга…' : 'Сыграть ещё раз';
  $('#rematch').disabled = !!state.rematch[seat];
  renderBoard();
}
$('#copy-link').addEventListener('click', async () => {
  if (!roomCode) return;
  const url = new URL(location.href); url.searchParams.set('room', roomCode);
  try { await navigator.clipboard.writeText(url.href); toast('Ссылка скопирована! Отправь её другу.'); }
  catch { window.prompt('Скопируй эту ссылку:', url.href); }
});
$('#chat-form').addEventListener('submit', e => {
  e.preventDefault(); const input = $('#chat-text');
  socket.emit('chat', { message: input.value }, response => { if (response?.error) toast(response.error); });
  input.value='';
});
$('#resign').addEventListener('click', () => {
  if (!confirm('Ты действительно хочешь сдаться?')) return;
  socket.emit('resign', {}, response => { if(response?.error) toast(response.error); });
});
$('#rematch').addEventListener('click', () => {
  socket.emit('rematch', {}, response => { if(response?.error) toast(response.error); });
});

// Кнопку видит только создатель. Сервер тоже проверяет права.
$('#ai-toggle').addEventListener('click', () => {
  if (seat !== 'w') return;
  socket.emit('toggle-ai', {}, response => {
    if (response?.error) toast(response.error);
  });
});
