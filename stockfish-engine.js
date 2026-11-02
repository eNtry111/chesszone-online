'use strict';

// One small Stockfish process serves all rooms sequentially so a free server
// does not launch a separate engine for every online game.
const { spawn } = require('child_process');
let engine = null;
let available = false;
let booting = false;
let current = null;
let queue = [];
let buffer = '';
let cooldownUntil = 0;

function command(value) {
  if (engine?.stdin?.writable) engine.stdin.write(value + '\n');
}

function fail(error) {
  const active = current;
  const waiting = queue;
  current = null;
  queue = [];
  available = false;
  booting = false;
  if (active) {
    clearTimeout(active.timer);
    active.reject(error);
  }
  for (const job of waiting) job.reject(error);
  if (engine) {
    const old = engine;
    engine = null;
    try { old.kill(); } catch (_) { /* process already stopped */ }
  }
  cooldownUntil = Date.now() + 10000;
}

function receive(line) {
  if (line === 'readyok') {
    booting = false;
    available = true;
    pump();
    return;
  }
  if (!current) return;
  const match = /^bestmove\s+([a-h][1-8][a-h][1-8][qrbn]?|\(none\))/.exec(line);
  if (match) {
    const finished = current;
    current = null;
    clearTimeout(finished.timer);
    if (match[1] === '(none)') finished.reject(new Error('Stockfish не нашёл ход.'));
    else finished.resolve(match[1]);
    pump();
  }
}

function start() {
  if (engine || booting) return;
  if (Date.now() < cooldownUntil) throw new Error('Stockfish временно недоступен. Повтори позже.');
  const stockfish = require('stockfish');
  const enginePath = stockfish.findEngine('lite-single');
  buffer = '';
  booting = true;
  available = false;
  const child = spawn(process.execPath, [enginePath], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  engine = child;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    if (engine !== child) return;
    buffer += chunk;
    if (buffer.length > 200000) buffer = buffer.slice(-10000);
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      receive(buffer.slice(0, end).trim());
      buffer = buffer.slice(end + 1);
    }
  });
  child.stderr.on('data', () => {});
  child.on('error', err => {
    if (engine === child) fail(err);
  });
  child.on('exit', code => {
    if (engine === child) fail(new Error('Stockfish завершился (код ' + code + ').'));
  });
  command('uci');
  command('isready');
  setTimeout(() => {
    if (engine === child && !available) fail(new Error('Stockfish не ответил при запуске.'));
  }, 20000).unref();
}

function pump() {
  if (!available || current || !queue.length) return;
  const job = queue.shift();
  current = job;
  // Skill Level is an official UCI option, range 0-20.
  command(`setoption name Skill Level value ${job.level}`);
  command('setoption name Hash value 16');
  command(`position fen ${job.fen}`);
  command(`go movetime ${job.moveTime}`);
  job.timer = setTimeout(() => {
    if (current === job) fail(new Error('Stockfish слишком долго выбирал ход.'));
  }, 12000);
  job.timer.unref();
}

function bestMove(fen, level = 8) {
  return new Promise((resolve, reject) => {
    if (queue.length >= 32) {
      reject(new Error('Очередь Stockfish заполнена. Повтори позже.'));
      return;
    }
    try { start(); } catch (error) { reject(error); return; }
    const safeLevel = [2, 8, 18].includes(level) ? level : 8;
    queue.push({ fen, level: safeLevel, moveTime: safeLevel === 2 ? 250 : safeLevel === 8 ? 500 : 950, resolve, reject, timer: null });
    pump();
  });
}

process.on('exit', () => { if (engine) try { engine.kill(); } catch (_) {} });
module.exports = { bestMove, shutdown: () => fail(new Error('Stockfish остановлен.')) };

