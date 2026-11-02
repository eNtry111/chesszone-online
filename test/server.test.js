'use strict';
const { test:nodeTest, before, after, beforeEach, afterEach, mock } = require('node:test');
const test = (name, fn) => nodeTest(name, {timeout:5000}, fn);
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { io: clientIO } = require('socket.io-client');
const engine = require('../stockfish-engine');
const jobs = [];
mock.method(engine, 'bestMove', (fen, level) => new Promise((resolve, reject) => {
  jobs.push({ fen, level, resolve, reject, settled:false });
}));
const api = require('../server');
const { Chess } = require('chess.js');
let url, clients, serial = 0;
const emit = (socket, event, data = {}) => new Promise((resolve, reject) => {
  socket.timeout(2000).emit(event, data, (error, reply) => error ? reject(error) : resolve(reply));
});
async function until(predicate, message = 'Timed out') {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function connect() {
  const client = clientIO(url, { transports:['websocket'], reconnection:false });
  clients.push(client);
  client.on('joined', joined => client.joined = joined);
  client.on('game-state', state => client.state = state);
  await once(client, 'connect');
  return client;
}
async function create(mode = 'friend', level = 8) {
  const client = await connect();
  const name = 'Player_' + ++serial;
  assert.deepEqual(await emit(client, mode === 'ai' ? 'create-ai-game' : 'create-room', {name, level}), {ok:true});
  return client;
}
async function pair() {
  const white = await create();
  const black = await connect();
  assert.deepEqual(await emit(black, 'join-room', {code:white.joined.code, name:'Guest_' + ++serial}), {ok:true});
  return {white, black, room:api.rooms.get(white.joined.code)};
}
function answer(job, uci) { job.settled = true; job.resolve(uci); }
function fail(job) { job.settled = true; job.reject(new Error('test engine unavailable')); }
before(async () => {
  api.server.listen(0, '127.0.0.1');
  await once(api.server, 'listening');
  url = 'http://127.0.0.1:' + api.server.address().port;
});
beforeEach(() => { clients = []; jobs.length = 0; });
afterEach(async () => {
  for (const client of clients) client.disconnect();
  await until(() => api.io.sockets.sockets.size === 0);
  for (const job of jobs) if (!job.settled) answer(job, 'e2e4');
  await new Promise(resolve => setImmediate(resolve));
  api.rooms.clear();
});
after(() => api.close());

test('all three difficulties create a bot opponent and leave the human moves manual', async () => {
  for (const level of [2, 8, 18]) {
    const player = await create('ai', level);
    const room = api.rooms.get(player.joined.code);
    assert.equal(room.players.b.isBot, true);
    assert.equal(player.state.bot.level, level);
    assert.equal(player.state.turn, 'w');
    assert.equal(player.state.players.b.online, true);
    assert.equal(player.state.players.w.token, undefined);
    assert.deepEqual(await emit(player, 'make-move', {from:'e2', to:'e4'}), {ok:true});
    const job = jobs.at(-1);
    assert.equal(job.level, level);
    assert.equal(new Chess(job.fen).turn(), 'b');
    assert.ok((await emit(player, 'make-move', {from:'e7', to:'e5'})).error);
    answer(job, 'e7e5');
    await until(() => room.game.history().length === 2);
    assert.equal(room.game.turn(), 'w');
  }
});

test('PvP never enables engine assistance; solo blocks human guests and freedom mode', async () => {
  const {white, black} = await pair();
  for (const player of [white, black]) {
    assert.ok((await emit(player, 'toggle-ai')).error);
    assert.ok((await emit(player, 'set-ai-level', {level:18})).error);
  }
  assert.deepEqual(await emit(white, 'make-move', {from:'e2', to:'e4'}), {ok:true});
  assert.equal(jobs.length, 0);
  const solo = await create('ai');
  const stranger = await connect();
  for (const token of ['', null, {}, 'wrong']) {
    assert.ok((await emit(stranger, 'join-room', {code:solo.joined.code, token, name:'Stranger'})).error);
  }
  assert.ok((await emit(solo, 'set-freedom', {enabled:true})).error);
});

test('changing bot difficulty invalidates an already queued answer', async () => {
  const player = await create('ai', 2);
  const room = api.rooms.get(player.joined.code);
  await emit(player, 'make-move', {from:'e2', to:'e4'});
  await emit(player, 'set-ai-level', {level:18});
  answer(jobs[0], 'e7e5');
  await until(() => jobs.length === 2);
  assert.equal(room.game.history().length, 1);
  assert.equal(jobs[1].level, 18);
  answer(jobs[1], 'c7c5');
  await until(() => room.game.history().length === 2);
  assert.equal(room.game.get('c5').type, 'p');
});

test('solo rematch swaps sides and the bot makes the first move', async () => {
  const player = await create('ai');
  const room = api.rooms.get(player.joined.code);
  await emit(player, 'resign');
  assert.deepEqual(await emit(player, 'rematch'), {ok:true});
  assert.equal(room.round, 2);
  assert.equal(room.players.w.isBot, true);
  assert.equal(room.players.b.socketId, player.id);
  answer(jobs[0], 'e2e4');
  await until(() => room.game.history().length === 1);
  assert.deepEqual(await emit(player, 'make-move', {from:'e7', to:'e5'}), {ok:true});
  const reconnect = await connect();
  assert.deepEqual(await emit(reconnect, 'join-room', player.joined), {ok:true});
  assert.equal(reconnect.joined.color, 'b');
  assert.equal(reconnect.state.bot.color, 'w');
});

test('a late engine answer cannot change a resigned or rematched game', async () => {
  const player = await create('ai');
  const room = api.rooms.get(player.joined.code);
  await emit(player, 'make-move', {from:'e2', to:'e4'});
  await emit(player, 'resign');
  await emit(player, 'rematch');
  answer(jobs[0], 'e7e5');
  await until(() => jobs.length === 2);
  assert.equal(room.game.history().length, 0);
  answer(jobs[1], 'd2d4');
  await until(() => room.game.history().length === 1);
  assert.equal(room.game.get('d4').color, 'w');
});

test('disconnect pauses solo clocks and stale engine work is retried after recovery', async () => {
  const player = await create('ai');
  const saved = player.joined;
  const room = api.rooms.get(saved.code);
  await emit(player, 'make-move', {from:'e2', to:'e4'});
  player.disconnect();
  await until(() => room.players.w.socketId === null);
  assert.equal(room.clock.deadline, null);
  answer(jobs[0], 'e7e5');
  await until(() => !room.aiPending);
  assert.equal(room.game.history().length, 1);
  const reconnect = await connect();
  assert.deepEqual(await emit(reconnect, 'join-room', saved), {ok:true});
  await until(() => jobs.length === 2);
  answer(jobs[1], 'e7e5');
  await until(() => room.game.history().length === 2);
});

test('engine failure pauses clocks, reports an error and offers a working retry', async () => {
  const player = await create('ai');
  const room = api.rooms.get(player.joined.code);
  await emit(player, 'make-move', {from:'e2', to:'e4'});
  fail(jobs[0]);
  await until(() => room.aiError && !room.aiPending);
  assert.equal(room.clock.deadline, null);
  assert.deepEqual(await emit(player, 'retry-ai'), {ok:true});
  assert.equal(room.aiError, null);
  assert.ok(room.clock.deadline);
  answer(jobs[1], 'e7e5');
  await until(() => room.game.history().length === 2);
});

test('recovery token transfers an online seat, nickname and invitation ownership', async () => {
  const original = await create();
  const replaced = once(original, 'session-replaced');
  const next = await connect();
  assert.deepEqual(await emit(next, 'join-room', original.joined), {ok:true});
  await replaced;
  assert.equal(api.rooms.get(original.joined.code).players.w.socketId, next.id);
  assert.ok((await emit(original, 'make-move', {from:'e2', to:'e4'})).error);
  assert.ok((await emit(original, 'register-nickname', {name:next.state.players.w.name})).error);
});

test('recovery succeeds even if an unrelated visitor has taken the temporary nickname', async () => {
  const player = await create();
  const saved = player.joined, name = player.state.players.w.name;
  player.disconnect();
  await until(() => !api.rooms.get(saved.code).players.w.socketId);
  const visitor = await connect();
  assert.deepEqual(await emit(visitor, 'register-nickname', {name}), {ok:true, name});
  const recovered = await connect();
  const notification = once(recovered, 'nickname-unavailable');
  assert.deepEqual(await emit(recovered, 'join-room', saved), {ok:true});
  await notification;
  const sender = await create();
  const invite = once(visitor, 'incoming-invite');
  assert.ok((await emit(sender, 'invite-by-nick', {target:name})).ok);
  await invite;
});

test('joining the same room again cannot allocate a second seat to one socket', async () => {
  const player = await create();
  assert.deepEqual(await emit(player, 'join-room', {code:player.joined.code}), {ok:true});
  assert.equal(player.joined.color, 'w');
  assert.equal(api.rooms.get(player.joined.code).players.b, null);
});

test('malformed payload types return errors without killing the server', async () => {
  const client = await connect();
  const value = {toString:null};
  assert.ok((await emit(client, 'register-nickname', {name:value})).error);
  assert.ok((await emit(client, 'invite-by-nick', {name:'SafeName', target:value})).error);
  assert.ok((await emit(client, 'create-room', {name:value})).error);
  assert.ok((await emit(client, 'join-room', {code:value})).error);
  assert.ok((await emit(client, 'invite-reply', {id:value})).error);
  assert.ok((await emit(client, 'create-ai-game', {name:'SafeName', level:value})).error);
  assert.deepEqual(await emit(client, 'create-room', {name:'SafeName', moveTimeMs:value}), {ok:true});
  const other = await connect();
  await emit(other, 'join-room', {code:client.joined.code, name:'SafeOther'});
  assert.ok((await emit(client, 'make-move', {from:value, to:'e4'})).error);
  assert.ok((await emit(client, 'chat', {message:value})).error);
  assert.deepEqual(await emit(client, 'make-move', {from:'e2', to:'e4'}), {ok:true});
});

test('invites verify the recipient, reject busy users and close when the recipient creates a room', async () => {
  const sender = await create();
  const target = await connect(), third = await connect();
  await emit(target, 'register-nickname', {name:'InviteTarget'});
  await emit(third, 'register-nickname', {name:'InviteThird'});
  const incoming = once(target, 'incoming-invite');
  await emit(sender, 'invite-by-nick', {target:'InviteTarget'});
  const [invite] = await incoming;
  assert.ok((await emit(third, 'invite-reply', {id:invite.id, accept:true})).error);
  const feedback = once(sender, 'invite-feedback');
  assert.ok((await emit(target, 'invite-by-nick', {target:'InviteThird'})).ok);
  await feedback;
  assert.ok((await emit(target, 'invite-reply', {id:invite.id, accept:true})).error);
  const stranger = await create();
  assert.match((await emit(stranger, 'invite-by-nick', {target:'InviteTarget'})).error, /уже играет/);
});

test('accept and decline are single-use and a full room cannot accept a stale invite', async () => {
  const sender = await create(), target = await connect(), outsider = await connect();
  await emit(target, 'register-nickname', {name:'AcceptTarget'});
  const incoming = once(target, 'incoming-invite');
  await emit(sender, 'invite-by-nick', {target:'AcceptTarget'});
  const [invite] = await incoming;
  assert.deepEqual(await emit(target, 'invite-reply', {id:invite.id, accept:true}), {ok:true});
  assert.ok((await emit(target, 'invite-reply', {id:invite.id, accept:true})).error);
  assert.ok((await emit(outsider, 'join-room', {code:sender.joined.code, name:'Outsider'})).error);
  const sender2 = await create(), target2 = await connect();
  await emit(target2, 'register-nickname', {name:'DeclineTarget'});
  const incoming2 = once(target2, 'incoming-invite');
  await emit(sender2, 'invite-by-nick', {target:'DeclineTarget'});
  const [decline] = await incoming2;
  assert.deepEqual(await emit(target2, 'invite-reply', {id:decline.id, accept:false}), {ok:true});
  assert.ok((await emit(target2, 'invite-reply', {id:decline.id, accept:true})).error);
});

test('entering freedom retains en-passant even when the pawn is pinned in standard chess', async () => {
  const {white, black, room} = await pair();
  room.game.load('4k3/8/8/8/4p3/8/3P4/K3R3 w - - 0 1');
  await emit(white, 'make-move', {from:'d2', to:'d4'});
  assert.equal(room.game.fen().split(' ')[3], '-');
  await emit(white, 'set-freedom', {enabled:true});
  assert.equal(room.freedom.ep, 'd3');
  assert.deepEqual(await emit(black, 'make-move', {from:'e4', to:'d3'}), {ok:true});
  assert.equal(room.freedom.board.d4, undefined);
  assert.equal(room.freedom.board.d3, 'p');
  assert.deepEqual(room.freedom.captures.w, ['p']);
});

test('freedom retains piece geometry, alternation and owner-only control', async () => {
  const {white, black, room} = await pair();
  assert.ok((await emit(black, 'set-freedom', {enabled:true})).error);
  await emit(white, 'set-freedom', {enabled:true});
  assert.equal(room.clock.deadline, null);
  assert.ok((await emit(white, 'make-move', {from:'a1', to:'a4'})).error);
  assert.ok((await emit(white, 'make-move', {from:'e2', to:'f3'})).error);
  assert.deepEqual(await emit(white, 'make-move', {from:'e2', to:'e4'}), {ok:true});
  assert.ok((await emit(white, 'make-move', {from:'d2', to:'d4'})).error);
  await emit(white, 'set-freedom', {enabled:false});
  assert.equal(room.game.fen(), new Chess().fen());
  assert.equal(room.players.w.socketId, white.id);
  assert.ok(room.clock.deadline);
});

test('custom lone-king victory and two-king draw agree in both modes and stop moves', async () => {
  const cases = [
    ['7k/8/8/8/8/8/8/KR6 w - - 0 1', 'lone_king', /белые/],
    ['6rk/8/8/8/8/8/8/K7 w - - 0 1', 'lone_king', /чёрные/],
    ['7k/8/8/8/8/8/8/K7 w - - 0 1', 'bare_kings', /Ничья/]
  ];
  for (const [fen, cause, winner] of cases) {
    const {white, room} = await pair();
    room.game.load(fen);
    for (const free of [false, true]) {
      if (free) await emit(white, 'set-freedom', {enabled:true});
      const result = api.gameStatus(room);
      assert.equal(result.over, true);
      assert.equal(result.cause, cause);
      assert.match(result.text, winner);
      assert.ok((await emit(white, 'make-move', {from:'a1', to:'a2'})).error);
    }
  }
});

test('freedom permits capturing a king and continues while other pieces can move', async () => {
  const {white, black, room} = await pair();
  room.game.load('4k3/7r/8/8/8/8/4R3/K7 w - - 0 1');
  await emit(white, 'set-freedom', {enabled:true});
  assert.deepEqual(await emit(white, 'make-move', {from:'e2', to:'e8'}), {ok:true});
  assert.equal(api.gameStatus(room).over, false);
  assert.deepEqual(await emit(black, 'make-move', {from:'h7', to:'h6'}), {ok:true});
});
