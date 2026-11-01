'use strict';
const $ = selector => document.querySelector(selector);
const socket = io();
let state = null;
let seat = null;
let isRoomOwner = false;
let selected = null;
let pendingPromotion = null;
let roomCode = null;
let aiEnabled = false;
let activeIncomingInvite = null;
let clockOffset = 0;
const soundPrefs = {
  enabled: localStorage.getItem('chesszone:sound') !== 'off',
  volume: Math.min(100, Math.max(0, Number(localStorage.getItem('chesszone:volume') ?? 35)))
};
let audioContext = null;

function audio() {
  if (!soundPrefs.enabled) return null;
  try {
    audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
    return audioContext;
  } catch { return null; }
}

// Gentle piece-drag sound made from filtered noise, not an external sound file.
function playMoveSound() {
  const ctx = audio();
  if (!ctx || soundPrefs.volume === 0) return;
  const length = Math.floor(ctx.sampleRate * 0.14);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    const t = i / length;
    channel[i] = (Math.random() * 2 - 1) * (1 - t) * (0.7 + 0.3 * Math.sin(t * 24));
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass'; filter.frequency.value = 1500;
  const gain = ctx.createGain();
  const now = ctx.currentTime;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.07 * soundPrefs.volume / 100, now + 0.018);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
  source.connect(filter).connect(gain).connect(ctx.destination);
  source.start(now); source.stop(now + 0.15);
}

// A short, low wooden tap with a little friction. Unlike the quiet move
// swish, this plays only when a piece is actually captured.
function playCaptureSound(myPieceWasTaken = false) {
  const ctx = audio();
  if (!ctx || soundPrefs.volume === 0) return;
  const now = ctx.currentTime;
  const volume = soundPrefs.volume / 100;
  const duration = 0.17;
  const samples = Math.floor(ctx.sampleRate * duration);
  const buffer = ctx.createBuffer(1, samples, ctx.sampleRate);
  const channel = buffer.getChannelData(0);
  let smoothNoise = 0;
  for (let i = 0; i < samples; i++) {
    const seconds = i / ctx.sampleRate;
    smoothNoise = 0.67 * smoothNoise + 0.33 * (Math.random() * 2 - 1);
    channel[i] = smoothNoise * Math.exp(-seconds * 22);
  }
  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = myPieceWasTaken ? 650 : 900;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.18 * volume + 0.0001, now + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  noise.connect(filter).connect(gain).connect(ctx.destination);
  noise.start(now);
  noise.stop(now + duration);

  const knock = ctx.createOscillator();
  const knockGain = ctx.createGain();
  const pitch = myPieceWasTaken ? 125 : 160;
  knock.type = 'triangle';
  knock.frequency.setValueAtTime(pitch, now);
  knock.frequency.exponentialRampToValueAtTime(pitch * 0.66, now + 0.09);
  knockGain.gain.setValueAtTime(0.0001, now);
  knockGain.gain.exponentialRampToValueAtTime(0.085 * volume + 0.0001, now + 0.006);
  knockGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);
  knock.connect(knockGain).connect(ctx.destination);
  knock.start(now);
  knock.stop(now + 0.12);
}

// Quiet two-note falling tone to signal resignation.
function playResignSound() {
  const ctx = audio();
  if (!ctx || soundPrefs.volume === 0) return;
  const now = ctx.currentTime;
  [330, 247].forEach((frequency, i) => {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, now + i * 0.12);
    oscillator.frequency.exponentialRampToValueAtTime(frequency * .82, now + i * 0.12 + .24);
    gain.gain.setValueAtTime(.0001, now + i * .12);
    gain.gain.exponentialRampToValueAtTime(.075 * soundPrefs.volume / 100, now + i * .12 + .025);
    gain.gain.exponentialRampToValueAtTime(.0001, now + i * .12 + .27);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(now + i * .12);
    oscillator.stop(now + i * .12 + .28);
  });
}

// Browsers only allow audio after a user action.
document.addEventListener('pointerdown', () => audio(), { once: true });

const glyph = { wk: '♔', wq: '♕', wr: '♖', wb: '♗', wn: '♘', wp: '♙', bk: '♚', bq: '♛', br: '♜', bb: '♝', bn: '♞', bp: '\u265F\uFE0E' };
const names = { q: 'Ферзь', r: 'Ладья', b: 'Слон', n: 'Конь' };

function toast(message) {
  const el = $('#toast'); el.textContent = message; el.classList.remove('hidden');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.add('hidden'), 3400);
}
function savedToken(code) { return localStorage.getItem(`chesszone:${code}`) || ''; }
function updateMySeat({ color, owner }) {
  seat = color;
  isRoomOwner = !!owner;
  selected = null;
  pendingPromotion = null;
  $('#promotion').classList.add('hidden');

  // Owner-only AI controls stay with the creator after colour swaps.
  $('#ai-toggle').classList.toggle('hidden', !isRoomOwner);
  $('#owner-ai-level').classList.toggle('hidden', !isRoomOwner);
  $('#freedom-settings').classList.toggle('hidden', !isRoomOwner);
  if (!isRoomOwner) aiEnabled = false;

  const other = color === 'w' ? 'b' : 'w';
  $('#my-color').textContent = color === 'w' ? 'Белые' : 'Чёрные';
  $('#opponent-color').textContent = other === 'w' ? 'Белые' : 'Чёрные';
  const mine = $('#my-avatar'), theirs = $('#opponent-avatar');
  mine.className = 'avatar ' + (color === 'w' ? 'white' : 'black');
  theirs.className = 'avatar ' + (other === 'w' ? 'white' : 'black');
  mine.textContent = color === 'w' ? '♔' : '♚';
  theirs.textContent = other === 'w' ? '♔' : '♚';
}

function enterRoom({ code, color, token, owner }) {
  roomCode = code;
  updateMySeat({ color, owner });
  localStorage.setItem(`chesszone:${code}`, token);
  $('#settings-overlay').classList.add('hidden');
  history.replaceState(null, '', `?room=${encodeURIComponent(code)}`);
  $('#lobby').classList.add('hidden'); $('#game').classList.remove('hidden');
  $('#room-code').textContent = code;
  closeIncomingInvite();
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
  socket.emit('create-room', { name, moveTimeMs: Number($('#move-time').value) }, response => { if (response?.error) toast(response.error); });
}
$('#create').addEventListener('click', createRoom);
$('#join').addEventListener('click', () => submitJoin($('#room-input').value));
$('#room-input').addEventListener('keydown', e => { if (e.key === 'Enter') submitJoin(e.target.value); });
$('#name').value = localStorage.getItem('chesszone:name') || '';

function showNicknameStatus(message, error = false) {
  $('#nick-status').textContent = message;
  $('#nick-status').classList.toggle('error', error);
}
function registerMyNickname() {
  const name = $('#name').value.trim();
  if (!socket.connected) return showNicknameStatus('Нет подключения к серверу.', true);
  if (!name) return showNicknameStatus('Введи ник, прежде чем сохранять.', true);
  socket.emit('register-nickname', { name }, reply => {
    if (reply?.error) return showNicknameStatus(reply.error, true);
    localStorage.setItem('chesszone:name', reply.name);
    showNicknameStatus('✓ Онлайн под ником '+reply.name+'. Тебя можно пригласить.');
  });
}
$('#register-nick').addEventListener('click', registerMyNickname);
$('#name').addEventListener('input', () => {
  showNicknameStatus('После изменения нажми «Сохранить ник».');
});
socket.on('nickname-ready', ({ name }) => {
  $('#name').value = name;
  localStorage.setItem('chesszone:name', name);
  showNicknameStatus('✓ Онлайн под ником '+name+'. Тебя можно пригласить.');
});

function showInviteStatus(message) {
  const text = String(message || '');
  $('#nickname-invite-status').textContent = text;
  $('#room-nickname-invite-status').textContent = text;
  if (text && roomCode) toast(text);
}
function sendNicknameInvite(targetName) {
  const target = String(targetName || '').trim();
  if (!target) return showInviteStatus('Введи ник друга.');
  socket.emit('invite-by-nick', {
    target,
    name: $('#name').value.trim() || localStorage.getItem('chesszone:name') || 'Игрок',
    moveTimeMs: Number($('#move-time').value)
  }, reply => showInviteStatus(reply?.error || reply?.text || 'Не удалось отправить приглашение.'));
}
$('#nickname-invite-form').addEventListener('submit', event => {
  event.preventDefault();
  sendNicknameInvite($('#nickname-invite-target').value);
});
$('#room-nickname-invite-form').addEventListener('submit', event => {
  event.preventDefault();
  sendNicknameInvite($('#room-nickname-invite-target').value);
});
function closeIncomingInvite(id = null) {
  if (id && activeIncomingInvite?.id !== id) return;
  activeIncomingInvite = null;
  $('#incoming-invite-overlay').classList.add('hidden');
}
socket.on('incoming-invite', invite => {
  if (roomCode) {
    socket.emit('invite-reply', { id:invite.id, accept:false });
    return;
  }
  activeIncomingInvite = invite;
  $('#incoming-invite-from').textContent = invite.from;
  $('#incoming-invite-overlay').classList.remove('hidden');
  $('#accept-nickname-invite').focus();
});
socket.on('invite-closed', ({ id }) => closeIncomingInvite(id));
socket.on('invite-feedback', ({ text }) => showInviteStatus(text));
function replyToInvite(accept) {
  const invitation = activeIncomingInvite;
  if (!invitation) return;
  closeIncomingInvite(invitation.id);
  socket.emit('invite-reply', { id:invitation.id, accept }, reply => {
    if (reply?.error) toast(reply.error);
  });
}
$('#accept-nickname-invite').addEventListener('click', () => replyToInvite(true));
$('#decline-nickname-invite').addEventListener('click', () => replyToInvite(false));

let inviteCode = new URLSearchParams(location.search).get('room');
if (inviteCode && /^[A-HJ-NP-Z2-9]{6}$/i.test(inviteCode)) $('#room-input').value = inviteCode.toUpperCase();

socket.on('connect', () => {
  $('#connection').textContent = 'На связи'; $('#connection').classList.add('online');
  if (roomCode) submitJoin(roomCode);
  else if (inviteCode && savedToken(inviteCode.toUpperCase())) submitJoin(inviteCode);
  else if ($('#name').value.trim()) registerMyNickname();
});
socket.on('disconnect', () => {
  $('#connection').textContent = 'Соединение потеряно'; $('#connection').classList.remove('online');
  showNicknameStatus('Нет подключения к серверу.', true);
  closeIncomingInvite();
});
socket.on('session-replaced', () => toast('Эта партия открылась в другой вкладке.'));
socket.on('joined', enterRoom);
socket.on('seat-updated', next => {
  updateMySeat(next);
  if (state) render();
  toast('Новая партия №' + next.round + ': теперь ты играешь ' +
    (next.color === 'w' ? 'белыми' : 'чёрными') + '.');
});
socket.on('ai-state', ({ enabled, level }) => {
  if (!isRoomOwner) return;
  aiEnabled = !!enabled;
  $('#ai-toggle').textContent = aiEnabled ? '🤖 Stockfish: включён' : '🤖 Stockfish: выключен';
  if ([2, 8, 18].includes(Number(level))) $('#ai-level').value = String(level);
  renderBoard();
});
socket.on('ai-error', ({ message }) => toast(message));
socket.on('game-state', next => {
  const previous = state;
  if (next.clock) clockOffset = next.clock.serverTime - Date.now();
  state = next;
  selected = null;
  if (previous && previous.code === next.code && next.moves.length > previous.moves.length) {
    const newWhiteCaptures = (next.captures?.w?.length || 0) - (previous.captures?.w?.length || 0);
    const newBlackCaptures = (next.captures?.b?.length || 0) - (previous.captures?.b?.length || 0);
    // A special sound is heard only by the player whose piece was captured.
    const lostMyPiece = seat === 'w' ? newWhiteCaptures > 0 : newBlackCaptures > 0;
    if (lostMyPiece) playCaptureSound(true);
    else playMoveSound();
  }
  if (previous && previous.code === next.code && !previous.status.over &&
      next.status.over && next.status.cause === 'resign') playResignSound();
  render();
});

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
const pieceNames = {
  p: 'пешка', n: 'конь', b: 'слон',
  r: 'ладья', q: 'ферзь'
};
function renderCapturedPieces() {
  if (!state || !seat) return;

  // Верхняя строка показывает фигуры, взятые соперником.
  // Нижняя — фигуры, которые забрал игрок внизу экрана.
  // Для гостя за чёрных всё правильно меняется местами.
  const opponentColor = seat === 'w' ? 'b' : 'w';
  for (const [position, victim] of [
    ['top', seat],
    ['bottom', opponentColor]
  ]) {
    const container = $(`#captured-${position}`);
    const captured = state.captures?.[victim] || [];
    container.replaceChildren();

    for (const type of captured) {
      const piece = document.createElement('span');
      piece.className = `captured-piece ${victim === 'w' ? 'captured-light' : 'captured-dark'}`;
      piece.textContent = glyph[victim + type] || '';
      piece.title = `${victim === 'w' ? 'Белая' : 'Чёрная'} фигура: ${pieceNames[type] || type}`;
      piece.setAttribute('aria-label', piece.title);
      container.append(piece);
    }

    const victimName = victim === 'w' ? 'белые' : 'чёрные';
    $(`#captured-${position}-title`).textContent = `Съедены ${victimName}`;
    $(`#captured-${position}-count`).textContent = String(captured.length);
    $(`#captured-${position}-row`).setAttribute(
      'aria-label',
      `Съедены ${victimName} фигуры: ${captured.length}`
    );
  }
}

function isMyTurn() {
  return state && state.turn === seat && state.players.w && state.players.b && !state.status.over && !aiEnabled && socket.connected;
}
function renderBoard() {
  const board = $('#board'); board.replaceChildren();
  if (!state) return;
  const pieces = pieceMap(state.fen), files = seat === 'b' ? 'hgfedcba' : 'abcdefgh';
  const ranks = seat === 'b' ? '12345678' : '87654321';
  // Both modes get authoritative move targets from the server. Freedom
  // mode ignores king safety only; every piece retains normal movement.
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
  $('#freedom-banner').classList.toggle('hidden', !state.freedom);
  $('#freedom-toggle').checked = !!state.freedom;
  $('#ai-toggle').disabled = !!state.freedom;
  $('#match-number').textContent = 'Партия №' + (state.round || 1);
  $('#turn-banner').textContent = !state.players.b
    ? 'Ожидание второго игрока'
    : state.status.over ? state.status.text
      : state.freedom ? '∞ Свобода хода · ' + (state.turn === seat ? 'твой ход' : 'ход соперника')
        : state.clock?.paused ? 'Пауза — ожидаем подключения игрока'
        : (state.turn === seat ? '● Твой ход' : '● Ход соперника') + ' · ' + (state.turn === 'w' ? 'ходят белые' : 'ходят чёрные');
  $('#turn-banner').classList.toggle('your-turn', !state.status.over &&
    !!state.players.b && (state.freedom || !state.clock?.paused) && state.turn === seat);
  updateClocks();
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
  $('#resign').disabled = !state.players.b || state.status.over || !!state.freedom;
  $('#rematch').classList.toggle('hidden', !state.status.over || !!state.freedom);
  $('#rematch').textContent = state.rematch[seat] ? 'Ожидаем согласия друга…' : 'Сыграть ещё раз';
  $('#rematch').disabled = !!state.rematch[seat];
  renderCapturedPieces();
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

// Кнопка существует на странице, но показывается только создателю комнаты.
$('#ai-toggle').addEventListener('click', () => {
  if (!isRoomOwner) return;
  socket.emit('toggle-ai', {}, response => {
    if (response?.error) toast(response.error);
  });
});


// Server-authoritative clock: client only displays a synchronized countdown.
function displayTime(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
function updateClocks() {
  if (!state?.clock || !seat) return;
  const them = seat === 'w' ? 'b' : 'w';
  const clock = state.clock;
  const running = !state.status.over && !clock.paused && !!state.players.b;
  const remaining = running && clock.deadline !== null
    ? Math.max(0, clock.deadline - (Date.now() + clockOffset))
    : clock.remainingMs;
  for (const [color, selector] of [[seat, '#my-timer'], [them, '#opponent-timer']]) {
    const el = $(selector);
    const isActive = color === clock.active;
    el.textContent = displayTime(isActive ? remaining : clock.perMoveMs);
    el.classList.toggle('active', isActive && running);
    el.classList.toggle('critical', isActive && running && remaining <= 10000);
    el.classList.toggle('paused', clock.paused && isActive);
  }
}
setInterval(updateClocks, 200);

// UI-only sound settings. Settings do not change the opponent's preferences.
$('#sound-toggle').checked = soundPrefs.enabled;
$('#sound-volume').value = String(soundPrefs.volume);
$('#volume-label').textContent = `${soundPrefs.volume}%`;
$('#sound-toggle').addEventListener('change', event => {
  soundPrefs.enabled = event.target.checked;
  localStorage.setItem('chesszone:sound', soundPrefs.enabled ? 'on' : 'off');
  if (soundPrefs.enabled) audio();
});
$('#sound-volume').addEventListener('input', event => {
  soundPrefs.volume = Number(event.target.value);
  $('#volume-label').textContent = `${soundPrefs.volume}%`;
  localStorage.setItem('chesszone:volume', String(soundPrefs.volume));
});
$('#test-sound').addEventListener('click', playMoveSound);
$('#test-capture-sound').addEventListener('click', () => playCaptureSound(true));
$('#open-settings').addEventListener('click', () => $('#settings-overlay').classList.remove('hidden'));
$('#close-settings').addEventListener('click', () => $('#settings-overlay').classList.add('hidden'));
$('#settings-overlay').addEventListener('click', event => {
  if (event.target.id === 'settings-overlay') $('#settings-overlay').classList.add('hidden');
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') $('#settings-overlay').classList.add('hidden');
});
$('#freedom-toggle').addEventListener('change', event => {
  const desired = event.target.checked;
  if (!isRoomOwner || !roomCode) {
    event.target.checked = !!state?.freedom;
    return;
  }
  if (!desired && !confirm('Выключить свободу хода и начать обычную партию с начальной позиции?')) {
    event.target.checked = true;
    return;
  }
  socket.emit('set-freedom', { enabled: desired }, response => {
    if (response?.error) {
      event.target.checked = !!state?.freedom;
      toast(response.error);
    }
  });
});
$('#ai-level').addEventListener('change', event => {
  if (!isRoomOwner) return;
  socket.emit('set-ai-level', { level: Number(event.target.value) }, response => {
    if (response?.error) toast(response.error);
  });
});

function showLobby() {
  roomCode = null;
  inviteCode = null;
  seat = null;
  isRoomOwner = false;
  state = null;
  aiEnabled = false;
  selected = null;
  history.replaceState(null, '', location.pathname);
  $('#room-input').value = '';
  $('#game').classList.add('hidden');
  $('#lobby').classList.remove('hidden');
  $('#settings-overlay').classList.add('hidden');
  $('#promotion').classList.add('hidden');
  closeIncomingInvite();
  showInviteStatus('');
}
socket.on('left-room', showLobby);
$('#leave-to-menu').addEventListener('click', () => {
  if (!confirm('Выйти в главное меню? При необходимости ты сможешь вернуться по коду комнаты.')) return;
  socket.emit('leave-room', {}, response => {
    if (response?.error) toast(response.error);
    else showLobby();
  });
});


// Personal appearance settings are stored only in this browser.
const defaultTheme = Object.freeze({
  light: '#f8e9f1', dark: '#c891ae',
  background: '#f9f0f5', accent: '#bd6591'
});
const themes = {
  pink: defaultTheme,
  monochrome: { light:'#ffffff', dark:'#292929', background:'#f2f2f2', accent:'#252525' },
  graphite: { light:'#c4c8cd', dark:'#59616a', background:'#e5e8ec', accent:'#414c58' },
  classic: { light:'#eeeed2', dark:'#769656', background:'#f0f4e8', accent:'#568441' },
  ocean: { light:'#e5eff9', dark:'#7b9dc3', background:'#edf4fc', accent:'#426fa8' },
  night: { light:'#b3b6c7', dark:'#555c7b', background:'#22263a', accent:'#7777bf' },
  peach: { light:'#ffe8d1', dark:'#d99375', background:'#fff1e5', accent:'#c47351' },
  violet: { light:'#eee6ff', dark:'#a28bce', background:'#f6f0ff', accent:'#8358b6' },
  forest: { light:'#d2e4cf', dark:'#48785c', background:'#e7f0e6', accent:'#317050' },
  sunset: { light:'#fff0c9', dark:'#d17f77', background:'#fff1e8', accent:'#c85c69' },
  ice: { light:'#f2fcff', dark:'#79b7cc', background:'#e9f7fb', accent:'#287e9b' },
  neon: { light:'#e5e1f5', dark:'#8551b5', background:'#f3eefb', accent:'#7b38ad' }
};
const colorControls = {
  light: '#theme-light',
  dark: '#theme-dark',
  background: '#theme-background',
  accent: '#theme-accent'
};
function validColor(color) { return /^#[0-9a-fA-F]{6}$/.test(color); }
function loadTheme() {
  try {
    const saved = JSON.parse(localStorage.getItem('chesszone:theme') || '{}');
    return Object.fromEntries(Object.entries(defaultTheme).map(([key, value]) =>
      [key, validColor(saved[key]) ? saved[key] : value]
    ));
  } catch { return { ...defaultTheme }; }
}
let currentTheme = loadTheme();
function setTheme(next) {
  currentTheme = Object.fromEntries(Object.entries(defaultTheme).map(([key, fallback]) =>
    [key, validColor(next[key]) ? next[key] : fallback]
  ));
  const root = document.documentElement;
  root.style.setProperty('--light-square', currentTheme.light);
  root.style.setProperty('--dark-square', currentTheme.dark);
  root.style.setProperty('--bg', currentTheme.background);
  root.style.setProperty('--site-accent', currentTheme.accent);
  for (const [key, selector] of Object.entries(colorControls)) {
    $(selector).value = currentTheme[key];
  }
  // Highlight the chosen preset; manual adjustments create a custom theme.
  document.querySelectorAll('[data-theme]').forEach(button => {
    const preset = themes[button.dataset.theme];
    const active = preset && Object.keys(defaultTheme).every(key =>
      preset[key].toLowerCase() === currentTheme[key].toLowerCase());
    button.classList.toggle('selected', !!active);
    button.setAttribute('aria-pressed', String(!!active));
  });
  localStorage.setItem('chesszone:theme', JSON.stringify(currentTheme));
}
setTheme(currentTheme);
for (const [key, selector] of Object.entries(colorControls)) {
  $(selector).addEventListener('input', event => {
    setTheme({ ...currentTheme, [key]: event.target.value });
  });
}
document.querySelectorAll('[data-theme]').forEach(button => {
  button.addEventListener('click', () => {
    setTheme(themes[button.dataset.theme] || defaultTheme);
  });
});
$('#random-theme').addEventListener('click', () => {
  const options = Object.values(themes);
  const available = options.filter(palette =>
    Object.keys(defaultTheme).some(key => palette[key] !== currentTheme[key])
  );
  setTheme(available[Math.floor(Math.random() * available.length)] || defaultTheme);
});
$('#reset-theme').addEventListener('click', () => setTheme(defaultTheme));
