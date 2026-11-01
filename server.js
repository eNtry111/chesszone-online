'use strict';
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { Chess } = require('chess.js');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 20_000 });
const rooms = new Map();

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));

function cleanName(value) {
  return String(value || '').trim().slice(0, 24) || 'Игрок';
}
function roomCode() {
  let code;
  do { code = crypto.randomBytes(5).toString('hex').toUpperCase(); }
  while (rooms.has(code));
  return code;
}
function token() { return crypto.randomBytes(24).toString('hex'); }
function playerView(p) { return p ? { name: p.name, online: !!p.socketId } : null; }
function getStatus(room) {
  if (room.result) return room.result;
  const g = room.game;
  if (g.isCheckmate()) return { over: true, text: `Мат! Победили ${g.turn() === 'w' ? 'чёрные' : 'белые'}.` };
  if (g.isStalemate()) return { over: true, text: 'Ничья — пат.' };
  if (g.isThreefoldRepetition()) return { over: true, text: 'Ничья — троекратное повторение позиции.' };
  if (g.isInsufficientMaterial()) return { over: true, text: 'Ничья — недостаточно материала.' };
  if (g.isDraw()) return { over: true, text: 'Ничья по правилам шахмат.' };
  return { over: false, text: `${g.turn() === 'w' ? 'Ход белых' : 'Ход чёрных'}${g.isCheck() ? ' — шах!' : ''}` };
}
function view(room) {
  return {
    code: room.code,
    fen: room.game.fen(),
    turn: room.game.turn(),
    status: getStatus(room),
    players: { w: playerView(room.players.w), b: playerView(room.players.b) },
    moves: room.game.history(),
    legal: room.game.moves({ verbose: true }).map(m => ({ from: m.from, to: m.to, promotion: m.promotion || '' })),
    chat: room.chat,
    rematch: { w: room.rematch.w, b: room.rematch.b }
  };
}
function broadcast(room) {
  room.updated = Date.now();
  io.to(room.code).emit('game-state', view(room));
  scheduleAI(room);
}

// Простой бот играет белыми за создателя комнаты.
function scheduleAI(room) {
  if (room.aiTimer || !room.aiEnabled || !room.players.b ||
      room.game.turn() !== 'w' || getStatus(room).over) return;
  room.aiTimer = setTimeout(() => {
    room.aiTimer = null;
    if (!room.aiEnabled || !room.players.b ||
        room.game.turn() !== 'w' || getStatus(room).over) return;
    const moves = room.game.moves({ verbose: true });
    if (!moves.length) return;
    const values = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
    const ranked = moves.map(move => ({
      move,
      score: 10 * (values[move.captured] || 0) +
        (move.promotion ? 9 : 0) +
        (move.san.includes('#') ? 1000 : 0) +
        (move.san.includes('+') ? 2 : 0) +
        Math.random() * 3
    }));
    ranked.sort((a, b) => b.score - a.score);
    const best = ranked[0].move;
    room.game.move({ from: best.from, to: best.to,
      promotion: best.promotion || 'q' });
    broadcast(room);
  }, 750);
}

function sendAIState(socket, room) {
  if (room.players.w?.socketId === socket.id) {
    socket.emit('ai-state', { enabled: room.aiEnabled });
  }
}
function getPlayer(room, socket) {
  return room.players.w?.socketId === socket.id ? 'w' : room.players.b?.socketId === socket.id ? 'b' : null;
}
function join(socket, room, color, secret) {
  if (socket.data.code && socket.data.code !== room.code) return false;
  const oldId = room.players[color]?.socketId;
  if (oldId && oldId !== socket.id) {
    const old = io.sockets.sockets.get(oldId);
    if (old) { old.leave(room.code); old.data.code = null; old.emit('session-replaced'); }
  }
  room.players[color].socketId = socket.id;
  socket.data.code = room.code;
  socket.data.color = color;
  socket.join(room.code);
  socket.emit('joined', { code: room.code, color, token: secret });
  sendAIState(socket, room);
  broadcast(room);
  return true;
}
function report(ack, data) { if (typeof ack === 'function') ack(data); }

io.on('connection', socket => {
  socket.on('create-room', (data, ack) => {
    if (socket.data.code) return report(ack, { error: 'Ты уже находишься в комнате. Обнови страницу, чтобы создать новую.' });
    const code = roomCode(), secret = token();
    const room = { code, game: new Chess(), players: { w: { name: cleanName(data?.name), token: secret, socketId: null }, b: null }, chat: [], rematch: { w: false, b: false }, result: null, aiEnabled: false, aiTimer: null, updated: Date.now() };
    rooms.set(code, room);
    join(socket, room, 'w', secret);
    report(ack, { ok: true });
  });

  socket.on('join-room', (data, ack) => {
    const code = String(data?.code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return report(ack, { error: 'Комната не найдена. Проверь код. После перезапуска сервера старые комнаты исчезают.' });
    if (socket.data.code && socket.data.code !== code) return report(ack, { error: 'Ты уже подключён к другой комнате. Обнови страницу.' });
    const requestedToken = String(data?.token || '');
    const known = (['w', 'b']).find(color => room.players[color]?.token === requestedToken);
    const color = known || (!room.players.b ? 'b' : null);
    if (!color) return report(ack, { error: 'Оба места заняты. Эта комната только для двух игроков.' });
    if (!room.players[color]) room.players[color] = { name: cleanName(data?.name), token: token(), socketId: null };
    join(socket, room, color, room.players[color].token);
    report(ack, { ok: true });
  });

  socket.on('make-move', (data, ack) => {
    const room = rooms.get(socket.data.code), color = room && getPlayer(room, socket);
    if (!room || !color) return report(ack, { error: 'Сначала войди в комнату.' });
    if (getStatus(room).over) return report(ack, { error: 'Партия закончена.' });
    if (!room.players.b) return report(ack, { error: 'Подожди, пока друг подключится.' });
    if (room.game.turn() !== color) return report(ack, { error: 'Сейчас ход соперника.' });
    if (color === 'w' && room.aiEnabled) return report(ack, { error: 'Отключи ИИ, чтобы ходить самому.' });
    if (!/^[a-h][1-8]$/.test(data?.from) || !/^[a-h][1-8]$/.test(data?.to)) return report(ack, { error: 'Некорректный ход.' });
    const promotion = ['q', 'r', 'b', 'n'].includes(data?.promotion) ? data.promotion : 'q';
    try {
      room.game.move({ from: data.from, to: data.to, promotion });
      room.rematch = { w: false, b: false };
      broadcast(room);
      report(ack, { ok: true });
    } catch { report(ack, { error: 'Так ходить нельзя.' }); }
  });

  // Только создатель комнаты (белый игрок) может управлять ботом.
  socket.on('toggle-ai', (_data, ack) => {
    const room = rooms.get(socket.data.code);
    const color = room && getPlayer(room, socket);
    if (!room || color !== 'w') {
      return report(ack, { error: 'Управлять ИИ может только создатель комнаты.' });
    }
    room.aiEnabled = !room.aiEnabled;
    if (!room.aiEnabled && room.aiTimer) {
      clearTimeout(room.aiTimer);
      room.aiTimer = null;
    }
    sendAIState(socket, room);
    broadcast(room);
    report(ack, { ok: true });
  });

  socket.on('chat', (data, ack) => {
    const room = rooms.get(socket.data.code), color = room && getPlayer(room, socket);
    if (!room || !color) return report(ack, { error: 'Необходимо войти в комнату.' });
    const message = String(data?.message || '').trim().slice(0, 350);
    if (!message) return report(ack, { error: 'Напиши сообщение.' });
    if (socket.data.lastChat && Date.now() - socket.data.lastChat < 500) return report(ack, { error: 'Слишком быстро.' });
    socket.data.lastChat = Date.now();
    room.chat.push({ name: room.players[color].name, message, at: Date.now() });
    if (room.chat.length > 80) room.chat.shift();
    broadcast(room); report(ack, { ok: true });
  });

  socket.on('resign', (_data, ack) => {
    const room = rooms.get(socket.data.code), color = room && getPlayer(room, socket);
    if (!room || !color || getStatus(room).over) return report(ack, { error: 'Сдаться сейчас нельзя.' });
    if (!room.players.b) return report(ack, { error: 'Соперник ещё не подключился.' });
    room.result = { over: true, text: `${color === 'w' ? 'Белые' : 'Чёрные'} сдались. Победил соперник.` };
    if (room.aiTimer) { clearTimeout(room.aiTimer); room.aiTimer = null; }
    broadcast(room); report(ack, { ok: true });
  });

  socket.on('rematch', (_data, ack) => {
    const room = rooms.get(socket.data.code), color = room && getPlayer(room, socket);
    if (!room || !color || !room.players.b) return report(ack, { error: 'Нужны два игрока.' });
    if (!getStatus(room).over) return report(ack, { error: 'Сначала завершите партию.' });
    room.rematch[color] = true;
    if (room.rematch.w && room.rematch.b) {
      if (room.aiTimer) { clearTimeout(room.aiTimer); room.aiTimer = null; }
      room.game = new Chess(); room.result = null; room.chat = [];
      room.rematch = { w: false, b: false };
    }
    broadcast(room); report(ack, { ok: true });
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.code);
    if (!room) return;
    const color = getPlayer(room, socket);
    if (color) { room.players[color].socketId = null; broadcast(room); }
  });
});

setInterval(() => {
  for (const [code, room] of rooms) {
    if (Date.now() - room.updated > 24 * 60 * 60 * 1000 && !room.players.w?.socketId && !room.players.b?.socketId) rooms.delete(code);
  }
}, 60 * 60 * 1000).unref();

const port = Number(process.env.PORT) || 3000;
server.listen(port, '0.0.0.0', () => console.log(`ChessZone: http://localhost:${port}`));