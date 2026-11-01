'use strict';
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { Chess } = require('chess.js');
const { Server } = require('socket.io');
const { bestMove } = require('./stockfish-engine');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 20_000 });
const rooms = new Map();
const nicknameOwners = new Map(); // case-insensitive nickname -> socket.id
const pendingInvites = new Map(); // secret invitation id -> invitation
const invitesByTarget = new Map();
const invitesBySender = new Map();
const INVITE_LIFETIME_MS = 45000;

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));

function cleanName(value) { return String(value || '').trim().slice(0, 24) || 'Игрок'; }
function codeForRoom() {
  // Six easy-to-read characters; no 0/O or 1/I confusion.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = [...crypto.randomBytes(6)].map(byte => alphabet[byte & 31]).join('');
  } while (rooms.has(code));
  return code;
}
function secretToken() { return crypto.randomBytes(24).toString('hex'); }

function nicknameKey(value) { return value.toLocaleLowerCase('ru'); }
function validateNickname(value) {
  const name = String(value ?? '').trim();
  if (!/^[\p{L}\p{N}_-]{2,24}$/u.test(name)) {
    return { error: 'Ник: от 2 до 24 символов (буквы, цифры, _ или -), без пробелов.' };
  }
  return { name, key: nicknameKey(name) };
}
function registerNickname(socket, value) {
  const parsed = validateNickname(value);
  if (parsed.error) return parsed;
  if (socket.data.nicknameKey === parsed.key) return { ok:true, name:socket.data.nickname };
  if (socket.data.code) return { error:'Ник меняется только в главном меню.' };
  const holder = nicknameOwners.get(parsed.key);
  if (holder && holder !== socket.id && io.sockets.sockets.has(holder)) {
    return { error:'Этот ник уже занят другим игроком онлайн.' };
  }
  const previous = socket.data.nicknameKey;
  if (previous && nicknameOwners.get(previous) === socket.id) nicknameOwners.delete(previous);
  socket.data.nicknameKey = parsed.key;
  socket.data.nickname = parsed.name;
  nicknameOwners.set(parsed.key, socket.id);
  socket.emit('nickname-ready', { name: parsed.name });
  return { ok:true, name:parsed.name };
}
function closeInvite(invite, senderMessage = null, notifyTarget = false) {
  if (!invite || !pendingInvites.has(invite.id)) return;
  pendingInvites.delete(invite.id);
  if (invitesByTarget.get(invite.targetId) === invite.id) invitesByTarget.delete(invite.targetId);
  if (invitesBySender.get(invite.senderId) === invite.id) invitesBySender.delete(invite.senderId);
  clearTimeout(invite.timer);
  if (senderMessage) io.to(invite.senderId).emit('invite-feedback', { text:senderMessage });
  if (notifyTarget) io.to(invite.targetId).emit('invite-closed', { id:invite.id });
}
function cancelInvitesFor(socketId) {
  for (const invite of [...pendingInvites.values()]) {
    if (invite.senderId === socketId) closeInvite(invite, null, true);
    else if (invite.targetId === socketId) {
      closeInvite(invite, 'Приглашённый игрок больше не доступен.', false);
    }
  }
}
function createRoomFor(socket, name, requestedTime) {
  const code = codeForRoom(), secret = secretToken();
  const duration = [30000, 60000, 120000].includes(Number(requestedTime)) ? Number(requestedTime) : 60000;
  const room = {
    code,
    game: new Chess(),
    ownerToken: secret,
    round: 1,
    players: { w:{ name, token:secret, socketId:null }, b:null },
    chat: [],
    rematch: { w:false, b:false },
    result: null,
    freedom: null,
    aiEnabled: false,
    aiLevel: 8,
    aiPending: false,
    aiGeneration: 0,
    clock: { perMoveMs:duration, remainingMs:duration, deadline:null },
    updated: Date.now()
  };
  rooms.set(code, room);
  join(socket, room, 'w', secret);
  return room;
}
function sendAck(ack, data) { if (typeof ack === 'function') ack(data); }
function playerView(player) {
  return player ? { name: player.name, online: Boolean(player.socketId) } : null;
}
function getPlayer(room, socket) {
  if (room?.players.w?.socketId === socket.id) return 'w';
  if (room?.players.b?.socketId === socket.id) return 'b';
  return null;
}
function connected(room) { return !!(room.players.w?.socketId && room.players.b?.socketId); }
// Room creator is identified by a secret token, never by piece colour.
function ownerColor(room) {
  if (room.players.w?.token === room.ownerToken) return 'w';
  if (room.players.b?.token === room.ownerToken) return 'b';
  return null;
}
function isOwner(room, socket) {
  const color = room && getPlayer(room, socket);
  return !!color && room.players[color]?.token === room.ownerToken;
}
function gameStatus(room) {
  if (room.freedom) return {
    over: false,
    text: '∞ Свобода хода — ход ' + (room.freedom.turn === 'w' ? 'белых' : 'чёрных'),
    cause: 'freedom'
  };
  if (room.result) return room.result;
  const game = room.game;
  if (game.isCheckmate()) return { over: true, text: `Мат! Победили ${game.turn() === 'w' ? 'чёрные' : 'белые'}.`, cause: 'checkmate' };
  if (game.isStalemate()) return { over: true, text: 'Ничья — пат.', cause: 'draw' };
  if (game.isThreefoldRepetition()) return { over: true, text: 'Ничья — троекратное повторение.', cause: 'draw' };
  if (game.isInsufficientMaterial()) return { over: true, text: 'Ничья — недостаточно материала.', cause: 'draw' };
  if (game.isDraw()) return { over: true, text: 'Ничья по правилам шахмат.', cause: 'draw' };
  return { over: false, text: `${game.turn() === 'w' ? 'Ход белых' : 'Ход чёрных'}${game.isCheck() ? ' — шах!' : ''}`, cause: '' };
}
function clockView(room) {
  const clock = room.clock;
  return {
    perMoveMs: clock.perMoveMs,
    remainingMs: clock.deadline === null ? clock.remainingMs : Math.max(0, clock.deadline - Date.now()),
    deadline: clock.deadline,
    serverTime: Date.now(),
    paused: clock.deadline === null,
    active: room.freedom ? room.freedom.turn : room.game.turn()
  };
}

// Freedom mode owns its own board. It never calls chess.js move()/load()
// for arbitrary moves, so check, checkmate and missing kings cannot corrupt
// the ordinary game engine. It is still synchronized and validated server-side.
function freeBoardFromFen(fen) {
  const board = {};
  const rows = fen.split(' ')[0].split('/');
  for (let rank = 0; rank < 8; rank++) {
    let file = 0;
    for (const c of rows[rank]) {
      if (/^[1-8]$/.test(c)) file += Number(c);
      else board['abcdefgh'[file++] + (8 - rank)] = c;
    }
  }
  return board;
}
function freeFen(free) {
  const rows = [];
  for (let rank = 8; rank >= 1; rank--) {
    let text = '', empty = 0;
    for (const file of 'abcdefgh') {
      const piece = free.board[file + rank];
      if (!piece) empty++;
      else {
        if (empty) text += empty;
        empty = 0;
        text += piece;
      }
    }
    if (empty) text += empty;
    rows.push(text);
  }
  return rows.join('/') + ' ' + free.turn + ' ' +
    (free.castling || '-') + ' ' + (free.ep || '-') + ' 0 1';
}
function freePieceColor(piece) {
  return !piece ? null : piece === piece.toUpperCase() ? 'w' : 'b';
}

// These are pseudo-legal CHESS moves: normal piece geometry, blocking,
// captures, pawn rules, promotion and castling. Only king-safety checks
// are omitted. Moving into check, ignoring check and capturing a king
// are intentionally allowed. Both colours still take alternating turns.
function freePseudoMoves(free) {
  const board = free.board;
  const color = free.turn;
  const files = 'abcdefgh';
  const moves = [];
  const friendly = square => freePieceColor(board[square]) === color;
  const enemy = square => !!board[square] && !friendly(square);
  const onBoard = (x, y) => x >= 0 && x < 8 && y >= 1 && y <= 8;
  const squareAt = (x, y) => files[x] + y;

  for (const [from, piece] of Object.entries(board)) {
    if (freePieceColor(piece) !== color) continue;
    const x = files.indexOf(from[0]);
    const y = Number(from[1]);
    const type = piece.toLowerCase();
    const add = (to, flag = '') => {
      if (!to || friendly(to)) return;
      if (type === 'p' && Number(to[1]) === (color === 'w' ? 8 : 1)) {
        for (const promotion of ['q', 'r', 'b', 'n']) moves.push({from, to, promotion, flag});
      } else moves.push({from, to, promotion:'', flag});
    };
    const step = (dx, dy, slide = false) => {
      for (let nx = x + dx, ny = y + dy; onBoard(nx, ny); nx += dx, ny += dy) {
        const to = squareAt(nx, ny);
        if (friendly(to)) break;
        add(to);
        if (board[to] || !slide) break;
      }
    };

    if (type === 'p') {
      const forward = color === 'w' ? 1 : -1;
      const frontY = y + forward;
      if (onBoard(x, frontY)) {
        const front = squareAt(x, frontY);
        if (!board[front]) {
          add(front);
          const start = color === 'w' ? 2 : 7;
          const secondY = y + 2 * forward;
          if (y === start && onBoard(x, secondY)) {
            const second = squareAt(x, secondY);
            if (!board[second]) add(second);
          }
        }
        for (const dx of [-1, 1]) {
          if (!onBoard(x + dx, frontY)) continue;
          const to = squareAt(x + dx, frontY);
          if (enemy(to)) add(to);
          else if (!board[to] && to === free.ep) {
            const capturedSquare = files[x + dx] + y;
            if (board[capturedSquare] === (color === 'w' ? 'p' : 'P')) {
              add(to, 'ep');
            }
          }
        }
      }
    } else if (type === 'n') {
      for (const [dx, dy] of [[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]]) {
        if (onBoard(x + dx, y + dy)) add(squareAt(x + dx, y + dy));
      }
    } else if (type === 'b' || type === 'r' || type === 'q') {
      const diagonal = [[1,1],[-1,1],[1,-1],[-1,-1]];
      const straight = [[1,0],[-1,0],[0,1],[0,-1]];
      const vectors = type === 'b' ? diagonal : type === 'r' ? straight : [...diagonal, ...straight];
      for (const [dx, dy] of vectors) step(dx, dy, true);
    } else if (type === 'k') {
      for (const dx of [-1,0,1]) for (const dy of [-1,0,1]) {
        if ((dx || dy) && onBoard(x+dx,y+dy)) add(squareAt(x+dx,y+dy));
      }
      // Castling uses regular empty squares and rook positions. In free
      // mode we deliberately do NOT forbid castling through check.
      const home = color === 'w' ? '1' : '8';
      if (from === 'e' + home) {
        const rights = free.castling || '';
        const kingRight = color === 'w' ? 'K' : 'k';
        const queenRight = color === 'w' ? 'Q' : 'q';
        const rook = color === 'w' ? 'R' : 'r';
        if (rights.includes(kingRight) && board['h'+home] === rook &&
            !board['f'+home] && !board['g'+home]) add('g'+home, 'castle');
        if (rights.includes(queenRight) && board['a'+home] === rook &&
            !board['b'+home] && !board['c'+home] && !board['d'+home]) add('c'+home, 'castle');
      }
    }
  }
  return moves;
}
function freeCaptureHistory(room) {
  return room.freedom ? room.freedom.captures : capturedPieces(room);
}
function moveFreely(room, color, from, to, promotion) {
  const free = room.freedom;
  if (!free || from === to) throw new Error('Выбери другую клетку.');
  if (free.turn !== color) throw new Error('Сейчас не твой ход.');
  const piece = free.board[from];
  if (!piece || freePieceColor(piece) !== color) {
    throw new Error('Выбери свою фигуру.');
  }
  const move = freePseudoMoves(free).find(candidate =>
    candidate.from === from && candidate.to === to &&
    (!candidate.promotion || candidate.promotion === promotion)
  );
  if (!move) throw new Error('Фигура не может так ходить. Шах можно игнорировать, но правила движения фигур сохраняются.');

  const capturedSquare = move.flag === 'ep' ? to[0] + from[1] : to;
  const captured = free.board[capturedSquare];
  if (captured) {
    const victim = freePieceColor(captured);
    free.captures[victim].push(captured.toLowerCase());
  }
  delete free.board[from];
  if (captured) delete free.board[capturedSquare];
  free.board[to] = move.promotion
    ? (color === 'w' ? move.promotion.toUpperCase() : move.promotion)
    : piece;
  if (move.flag === 'castle') {
    const rank = from[1];
    const rookFrom = (to[0] === 'g' ? 'h' : 'a') + rank;
    const rookTo = (to[0] === 'g' ? 'f' : 'd') + rank;
    free.board[rookTo] = free.board[rookFrom];
    delete free.board[rookFrom];
  }

  const castleRights = {a1:'Q', h1:'K', a8:'q', h8:'k'};
  let rights = free.castling || '';
  if (piece === 'K') rights = rights.replace(/[KQ]/g, '');
  if (piece === 'k') rights = rights.replace(/[kq]/g, '');
  if (castleRights[from]) rights = rights.replace(castleRights[from], '');
  if (castleRights[capturedSquare] && captured) {
    rights = rights.replace(castleRights[capturedSquare], '');
  }
  free.castling = rights;
  free.ep = piece.toLowerCase() === 'p' &&
    Math.abs(Number(from[1]) - Number(to[1])) === 2
    ? from[0] + ((Number(from[1]) + Number(to[1])) / 2)
    : null;

  const notation = move.flag === 'castle'
    ? (to[0] === 'g' ? 'O-O' : 'O-O-O')
    : piece.toUpperCase() + from + (captured ? 'x' : '–') + to +
      (move.promotion ? '=' + move.promotion.toUpperCase() : '');
  free.moves.push(notation);
  free.turn = color === 'w' ? 'b' : 'w';
}

function capturedPieces(room) {
  const captured = { w: [], b: [] };
  for (const move of room.game.history({ verbose: true })) {
    if (move.captured) {
      const victimColor = move.color === 'w' ? 'b' : 'w';
      captured[victimColor].push(move.captured);
    }
  }
  return captured;
}

function view(room) {
  return {
    code: room.code,
    fen: room.freedom ? freeFen(room.freedom) : room.game.fen(),
    turn: room.freedom ? room.freedom.turn : room.game.turn(),
    status: gameStatus(room),
    players: { w: playerView(room.players.w), b: playerView(room.players.b) },
    moves: room.freedom ? room.freedom.moves : room.game.history(),
    captures: freeCaptureHistory(room),
    // Freedom moves are calculated client-side for highlighting and
    // individually validated on the server to avoid huge payloads.
    legal: room.freedom
      ? freePseudoMoves(room.freedom).map(move => ({ from: move.from, to: move.to, promotion: move.promotion }))
      : room.game.moves({ verbose: true }).map(move => ({ from: move.from, to: move.to, promotion: move.promotion || '' })),
    chat: room.chat,
    rematch: { ...room.rematch },
    clock: clockView(room),
    round: room.round,
    freedom: !!room.freedom
  };
}
function broadcast(room) {
  room.updated = Date.now();
  io.to(room.code).emit('game-state', view(room));
  scheduleAI(room);
}
function sendOwnerSettings(socket, room) {
  if (isOwner(room, socket)) {
    socket.emit('ai-state', { enabled: room.aiEnabled, level: room.aiLevel });
  }
}
function stopAI(room) {
  room.aiGeneration++;
  room.aiEnabled = false;
}
function pauseClock(room) {
  if (room.clock.deadline !== null) {
    room.clock.remainingMs = Math.max(0, room.clock.deadline - Date.now());
    room.clock.deadline = null;
  }
}
function resumeClock(room) {
  if (room.freedom || gameStatus(room).over || !connected(room) || room.clock.deadline !== null) return;
  room.clock.deadline = Date.now() + room.clock.remainingMs;
}
function endGame(room, result) {
  pauseClock(room);
  room.result = { over: true, ...result };
  stopAI(room);
  broadcast(room);
}
function enforceClock(room) {
  if (room.freedom || !room.clock.deadline || gameStatus(room).over || !connected(room)) return false;
  if (Date.now() < room.clock.deadline) return false;
  const loser = room.game.turn();
  room.clock.remainingMs = 0;
  room.clock.deadline = null;
  endGame(room, {
    cause: 'timeout',
    text: `Время вышло! ${loser === 'w' ? 'Белые' : 'Чёрные'} не успели сделать ход. Победил соперник.`
  });
  return true;
}
function nextTurnClock(room) {
  room.clock.remainingMs = room.clock.perMoveMs;
  room.clock.deadline = null;
  if (!gameStatus(room).over) resumeClock(room);
}
function scheduleAI(room) {
  if (room.freedom || !room.aiEnabled || room.aiPending || !connected(room) ||
      room.game.turn() !== ownerColor(room) || gameStatus(room).over) return;
  const fen = room.game.fen();
  const generation = room.aiGeneration;
  const level = room.aiLevel;
  room.aiPending = true;
  bestMove(fen, level).then(uci => {
    if (!room.aiEnabled || room.aiGeneration !== generation || room.game.fen() !== fen ||
        room.game.turn() !== ownerColor(room) || !connected(room) ||
        gameStatus(room).over || enforceClock(room)) return;
    const candidate = room.game.moves({ verbose: true }).find(m => m.from === uci.slice(0, 2) && m.to === uci.slice(2, 4) && (m.promotion || '') === (uci[4] || ''));
    if (!candidate) throw new Error('Stockfish предложил недопустимый ход.');
    room.game.move({ from: candidate.from, to: candidate.to, promotion: candidate.promotion || 'q' });
    nextTurnClock(room);
    broadcast(room);
  }).catch(err => {
    if (room.aiEnabled && room.aiGeneration === generation) {
      const owner = io.sockets.sockets.get(room.players[ownerColor(room)]?.socketId);
      owner?.emit('ai-error', { message: 'Stockfish: ' + err.message });
      stopAI(room);
      if (owner) sendOwnerSettings(owner, room);
    }
  }).finally(() => {
    room.aiPending = false;
    if (room.aiEnabled && room.aiGeneration !== generation) scheduleAI(room);
  });
}
function join(socket, room, color, secret) {
  if (socket.data.code && socket.data.code !== room.code) return false;
  const oldId = room.players[color]?.socketId;
  if (oldId && oldId !== socket.id) {
    const previous = io.sockets.sockets.get(oldId);
    if (previous) {
      previous.leave(room.code);
      previous.data.code = null;
      previous.data.color = null;
      previous.emit('session-replaced');
    }
  }
  room.players[color].socketId = socket.id;
  socket.data.code = room.code;
  socket.data.color = color;
  socket.join(room.code);
  socket.emit('joined', { code: room.code, color, token: secret, owner: isOwner(room, socket), round: room.round });
  sendOwnerSettings(socket, room);
  resumeClock(room);
  broadcast(room);
  return true;
}
function leave(socket, sendResponse = true) {
  cancelInvitesFor(socket.id);
  const room = rooms.get(socket.data.code);
  if (!room) { socket.data.code = null; socket.data.color = null; return; }
  const color = getPlayer(room, socket);
  if (color) {
    pauseClock(room);
    room.players[color].socketId = null;
    socket.leave(room.code);
    socket.data.code = null;
    socket.data.color = null;
    broadcast(room);
  }
  if (sendResponse) socket.emit('left-room');
}

io.on('connection', socket => {

  // Registering a nickname makes the player discoverable while online.
  socket.on('register-nickname', (data, ack) => {
    if (invitesByTarget.has(socket.id)) {
      return sendAck(ack, { error:'Сначала ответь на приглашение.' });
    }
    sendAck(ack, registerNickname(socket, data?.name));
  });

  socket.on('create-room', (data, ack) => {
    if (socket.data.code) return sendAck(ack, { error:'Сначала выйди в главное меню.' });
    const registered = registerNickname(socket, data?.name || socket.data.nickname || 'Игрок');
    if (registered.error) return sendAck(ack, registered);
    cancelInvitesFor(socket.id);
    createRoomFor(socket, registered.name, data?.moveTimeMs);
    sendAck(ack, { ok:true });
  });

  socket.on('join-room', (data, ack) => {
    const code = String(data?.code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return sendAck(ack, { error: 'Комната не найдена. После перезапуска сервера старые комнаты исчезают.' });
    if (socket.data.code && socket.data.code !== code) return sendAck(ack, { error: 'Сначала выйди в главное меню.' });
    const supplied = String(data?.token || '');
    const known = ['w', 'b'].find(c => room.players[c]?.token === supplied);
    const color = known || (!room.players.b ? 'b' : null);
    if (!color) return sendAck(ack, { error: 'Оба места уже заняты.' });
    const joinName = known ? room.players[color].name : (data?.name || socket.data.nickname || 'Игрок');
    const registered = registerNickname(socket, joinName);
    if (registered.error) return sendAck(ack, registered);
    cancelInvitesFor(socket.id);
    if (!room.players[color]) room.players[color] = { name: registered.name, token: secretToken(), socketId: null };
    join(socket, room, color, room.players[color].token);
    sendAck(ack, { ok: true });
  });


  // New rooms and existing waiting rooms can invite someone by online nickname.
  socket.on('invite-by-nick', (data, ack) => {
    const registered = registerNickname(socket, data?.name || socket.data.nickname || 'Игрок');
    if (registered.error) return sendAck(ack, registered);
    const requested = validateNickname(data?.target);
    if (requested.error) return sendAck(ack, { error:'Введи правильный ник друга (2–24 символа).' });
    if (requested.key === socket.data.nicknameKey) {
      return sendAck(ack, { error:'Себя пригласить нельзя.' });
    }
    const targetId = nicknameOwners.get(requested.key);
    const target = targetId && io.sockets.sockets.get(targetId);
    if (!target) return sendAck(ack, { error:'Игрок не в сети. Он должен открыть ChessZone и сохранить ник.' });
    if (target.data.code) return sendAck(ack, { error:'Игрок уже играет в другой партии.' });
    if (invitesByTarget.has(target.id)) return sendAck(ack, { error:'Игрок уже получил другое приглашение.' });
    if (invitesBySender.has(socket.id)) return sendAck(ack, { error:'Подожди ответа на предыдущее приглашение.' });
    if (socket.data.lastInvite && Date.now()-socket.data.lastInvite < 3000) {
      return sendAck(ack, { error:'Подожди пару секунд перед следующим приглашением.' });
    }
    let room = socket.data.code ? rooms.get(socket.data.code) : null;
    if (socket.data.code && (!room || !getPlayer(room, socket))) {
      return sendAck(ack, { error:'Твоя комната недоступна.' });
    }
    if (room && room.players.w && room.players.b) {
      return sendAck(ack, { error:'В твоей комнате уже два игрока.' });
    }
    if (room && gameStatus(room).over) {
      return sendAck(ack, { error:'Партия уже завершена. Создай новую комнату.' });
    }
    if (!room) room = createRoomFor(socket, registered.name, data?.moveTimeMs);

    const invite = {
      id:secretToken(), senderId:socket.id, targetId:target.id,
      senderName:socket.data.nickname, targetName:target.data.nickname,
      roomCode:room.code, timer:null
    };
    pendingInvites.set(invite.id, invite);
    invitesBySender.set(socket.id, invite.id);
    invitesByTarget.set(target.id, invite.id);
    socket.data.lastInvite = Date.now();
    invite.timer = setTimeout(() => {
      closeInvite(invite, 'Время приглашения истекло — друг не ответил.', true);
    }, INVITE_LIFETIME_MS);
    invite.timer.unref();
    target.emit('incoming-invite', {
      id:invite.id, from:invite.senderName, expiresInSeconds:INVITE_LIFETIME_MS/1000
    });
    sendAck(ack, { ok:true, text:'Приглашение для '+invite.targetName+' отправлено. Ждём ответ…' });
  });

  socket.on('invite-reply', (data, ack) => {
    const invite = pendingInvites.get(String(data?.id || ''));
    if (!invite || invite.targetId !== socket.id) {
      return sendAck(ack, { error:'Приглашение уже недействительно.' });
    }
    if (data?.accept !== true) {
      closeInvite(invite, 'Игрок '+invite.targetName+' отклонил приглашение.', true);
      return sendAck(ack, { ok:true });
    }
    const room = rooms.get(invite.roomCode);
    const sender = io.sockets.sockets.get(invite.senderId);
    if (!room || !sender || sender.data.code !== room.code || !getPlayer(room, sender)) {
      closeInvite(invite, 'Отправитель уже вышел из комнаты.', true);
      return sendAck(ack, { error:'Отправитель вышел из комнаты.' });
    }
    if (socket.data.code) {
      closeInvite(invite, 'Игрок уже играет в другой партии.', true);
      return sendAck(ack, { error:'Ты уже в другой партии.' });
    }
    const emptySeat = !room.players.b ? 'b' : !room.players.w ? 'w' : null;
    if (!emptySeat || gameStatus(room).over) {
      closeInvite(invite, 'В комнате больше нет свободного места.', true);
      return sendAck(ack, { error:'В комнате больше нет свободного места.' });
    }
    const secret = secretToken();
    room.players[emptySeat] = { name:socket.data.nickname, token:secret, socketId:null };
    closeInvite(invite, 'Игрок '+invite.targetName+' принял приглашение!', true);
    join(socket, room, emptySeat, secret);
    sendAck(ack, { ok:true });
  });

  socket.on('leave-room', (_, ack) => {
    leave(socket);
    sendAck(ack, { ok: true });
  });

  socket.on('make-move', (data, ack) => {
    const room = rooms.get(socket.data.code);
    const color = room && getPlayer(room, socket);
    if (!room || !color) return sendAck(ack, { error: 'Сначала войди в комнату.' });
    if (enforceClock(room) || gameStatus(room).over) return sendAck(ack, { error: 'Партия закончена.' });
    if (!connected(room)) return sendAck(ack, { error: 'Подожди возвращения соперника.' });
    if ((room.freedom ? room.freedom.turn : room.game.turn()) !== color) {
      return sendAck(ack, { error: 'Сейчас ход соперника.' });
    }
    if (isOwner(room, socket) && room.aiEnabled) return sendAck(ack, { error: 'Отключи Stockfish, чтобы ходить самостоятельно.' });
    if (!/^[a-h][1-8]$/.test(data?.from) || !/^[a-h][1-8]$/.test(data?.to)) return sendAck(ack, { error: 'Некорректный ход.' });
    const promotion = ['q','r','b','n'].includes(data?.promotion) ? data.promotion : 'q';
    try {
      if (room.freedom) {
        moveFreely(room, color, data.from, data.to, promotion);
      } else {
        room.game.move({ from: data.from, to: data.to, promotion });
        nextTurnClock(room);
      }
      room.rematch = { w: false, b: false };
      broadcast(room);
      sendAck(ack, { ok: true });
    } catch (error) {
      sendAck(ack, { error: room.freedom ? error.message : 'Так ходить нельзя.' });
    }
  });

  // Changing the rules affects the whole room, so only its creator controls it.
  // Returning to regular chess always starts a fresh position.
  socket.on('set-freedom', (data, ack) => {
    const room = rooms.get(socket.data.code);
    if (!room || !isOwner(room, socket)) {
      return sendAck(ack, { error: 'Включать режим свободы может только создатель лобби.' });
    }
    const desired = data?.enabled === true;
    if (desired === !!room.freedom) return sendAck(ack, { ok: true });
    if (desired) {
      pauseClock(room);
      room.freedom = {
        board: freeBoardFromFen(room.game.fen()),
        turn: room.game.turn(),
        moves: room.game.history(),
        captures: capturedPieces(room),
        castling: room.game.fen().split(' ')[2].replace('-', ''),
        ep: room.game.fen().split(' ')[3] === '-' ? null : room.game.fen().split(' ')[3]
      };
      room.result = null; // Keep playing even after checkmate / time loss.
      room.rematch = { w: false, b: false };
      stopAI(room);
      sendOwnerSettings(socket, room);
    } else {
      room.freedom = null;
      room.game = new Chess();
      room.result = null;
      room.rematch = { w: false, b: false };
      stopAI(room);
      room.clock.remainingMs = room.clock.perMoveMs;
      room.clock.deadline = null;
      sendOwnerSettings(socket, room);
      resumeClock(room);
    }
    broadcast(room);
    sendAck(ack, { ok: true });
  });

  socket.on('toggle-ai', (_data, ack) => {
    const room = rooms.get(socket.data.code);
    if (!room || !isOwner(room, socket)) return sendAck(ack, { error: 'Только создатель комнаты управляет Stockfish.' });
    if (room.freedom) return sendAck(ack, { error: 'Stockfish недоступен в режиме свободы хода.' });
    room.aiEnabled = !room.aiEnabled;
    room.aiGeneration++;
    sendOwnerSettings(socket, room);
    scheduleAI(room);
    sendAck(ack, { ok: true });
  });

  socket.on('set-ai-level', (data, ack) => {
    const room = rooms.get(socket.data.code);
    if (!room || !isOwner(room, socket)) return sendAck(ack, { error: 'Только создатель комнаты настраивает Stockfish.' });
    const level = Number(data?.level);
    if (![2,8,18].includes(level)) return sendAck(ack, { error: 'Неизвестная сложность.' });
    room.aiLevel = level;
    room.aiGeneration++;
    sendOwnerSettings(socket, room);
    scheduleAI(room);
    sendAck(ack, { ok: true });
  });

  socket.on('chat', (data, ack) => {
    const room = rooms.get(socket.data.code);
    const color = room && getPlayer(room, socket);
    if (!room || !color) return sendAck(ack, { error: 'Сначала войди в комнату.' });
    const message = String(data?.message || '').trim().slice(0, 350);
    if (!message) return sendAck(ack, { error: 'Напиши сообщение.' });
    if (socket.data.lastChat && Date.now() - socket.data.lastChat < 500) return sendAck(ack, { error: 'Слишком быстро.' });
    socket.data.lastChat = Date.now();
    room.chat.push({ name: room.players[color].name, message, at: Date.now() });
    if (room.chat.length > 80) room.chat.shift();
    broadcast(room);
    sendAck(ack, { ok: true });
  });

  socket.on('resign', (_data, ack) => {
    const room = rooms.get(socket.data.code);
    const color = room && getPlayer(room, socket);
    if (!room || !color || gameStatus(room).over || room.freedom) return sendAck(ack, { error: 'Сдача недоступна в свободном режиме.' });
    if (!room.players.b) return sendAck(ack, { error: 'Соперник ещё не вошёл.' });
    endGame(room, { cause: 'resign', text: `${color === 'w' ? 'Белые' : 'Чёрные'} сдались. Победил соперник.` });
    sendAck(ack, { ok: true });
  });

  socket.on('rematch', (_data, ack) => {
    const room = rooms.get(socket.data.code);
    const color = room && getPlayer(room, socket);
    if (!room || !color || !room.players.b) return sendAck(ack, { error: 'Нужны два игрока.' });
    if (room.freedom) return sendAck(ack, { error: 'Для новой партии отключи свободу хода в настройках.' });
    if (!gameStatus(room).over) return sendAck(ack, { error: 'Завершите партию.' });
    room.rematch[color] = true;
    if (room.rematch.w && room.rematch.b) {
      room.game = new Chess();
      room.result = null;
      room.chat = [];
      room.rematch = { w: false, b: false };
      room.clock.remainingMs = room.clock.perMoveMs;
      room.clock.deadline = null;
      room.aiGeneration++;

      // Every accepted rematch swaps the real player seats, including their
      // reconnect tokens. The creator remains the owner regardless of colour.
      const previousWhite = room.players.w;
      room.players.w = room.players.b;
      room.players.b = previousWhite;
      room.round++;

      for (const newColor of ['w', 'b']) {
        const player = room.players[newColor];
        const client = io.sockets.sockets.get(player?.socketId);
        if (!client) continue;
        client.data.color = newColor;
        client.emit('seat-updated', {
          color: newColor,
          owner: isOwner(room, client),
          round: room.round
        });
        sendOwnerSettings(client, room);
      }
      resumeClock(room);
    }
    broadcast(room);
    sendAck(ack, { ok: true });
  });

  socket.on('disconnect', () => {
    leave(socket, false);
    if (socket.data.nicknameKey && nicknameOwners.get(socket.data.nicknameKey) === socket.id) {
      nicknameOwners.delete(socket.data.nicknameKey);
    }
  });
});

const ticker = setInterval(() => {
  for (const room of rooms.values()) enforceClock(room);
}, 250);
ticker.unref();

const cleanup = setInterval(() => {
  for (const [code, room] of rooms) {
    if (Date.now() - room.updated > 86400000 && !room.players.w?.socketId && !room.players.b?.socketId) rooms.delete(code);
  }
}, 3600000);
cleanup.unref();

const port = Number(process.env.PORT) || 3000;
server.listen(port, '0.0.0.0', () => console.log(`ChessZone: http://localhost:${port}`));
