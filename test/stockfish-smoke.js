'use strict';
const assert = require('node:assert/strict');
const { Chess } = require('chess.js');
const { bestMove, shutdown } = require('../stockfish-engine');

async function main() {
  for (const level of [2, 8, 18]) {
    const game = new Chess();
    game.move('e4');
    const uci = await bestMove(game.fen(), level);
    assert.ok(game.move({from:uci.slice(0, 2), to:uci.slice(2, 4), promotion:uci[4] || 'q'}));
    console.log('Stockfish Skill ' + level + ': legal reply ' + uci);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(shutdown);
