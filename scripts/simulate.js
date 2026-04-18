#!/usr/bin/env node
'use strict';

// Headless AI duel harness.
//
// Runs N games with a mix of AI strategies seated alternately (V1, V2, V1, V2, ...).
// No server, no sockets, no UI — just the shared game engine driven synchronously.
// Prints aggregate stats per strategy so we can see whether V2 is actually smarter
// than V1 (lower last-place rate is the key metric).
//
// Usage:
//   node scripts/simulate.js                          # defaults: 1000 games, 4 players, duel
//   node scripts/simulate.js --games 2000 --players 4
//   node scripts/simulate.js --mode v1-only --games 200  # regression check
//   node scripts/simulate.js --mode v2-only --games 200

const path = require('path');
const vm = require('vm');
const fs = require('fs');

// Load shared game-logic files into this module's scope, matching the pattern
// used by server/server.js. After this, Card, Player, AI, AI_V1, AI_V2, Game
// are all bound as top-level names here.
['card.js', 'player.js', 'ai.js', 'game.js'].forEach(file => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8');
  vm.runInThisContext(code);
});

function parseArgs(argv) {
  const args = { games: 1000, players: 4, mode: 'duel' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--games' || a === '-g') && argv[i + 1]) args.games = parseInt(argv[++i], 10);
    else if ((a === '--players' || a === '-p') && argv[i + 1]) args.players = parseInt(argv[++i], 10);
    else if ((a === '--mode' || a === '-m') && argv[i + 1]) args.mode = argv[++i];
  }
  return args;
}

// Choose strategy per seat based on duel mode.
function strategyForSeat(seatIndex, mode) {
  if (mode === 'v1-only') return AI_V1;
  if (mode === 'v2-only') return AI_V2;
  // duel: alternate V1 / V2 so any seat-position advantage averages out
  return seatIndex % 2 === 0 ? AI_V1 : AI_V2;
}

function runOneGame(numPlayers, mode) {
  const configs = [];
  const strategies = [];
  for (let i = 0; i < numPlayers; i++) {
    configs.push({ name: `P${i}`, isAI: true });
    strategies.push(strategyForSeat(i, mode));
  }
  const game = new Game(configs);
  game.deal();

  // Drive the game forward. playCard() returns a TrickResult when the trick
  // resolves and null otherwise; in either case, after the call the active
  // player index points to whoever should act next (or the game is finished).
  let safety = 10000;
  while (game.phase !== 'finished' && safety-- > 0) {
    const player = game.players[game.activePlayerIndex];
    if (!player || player.isOut) break;
    const strategy = strategies[player.id];
    const ctx = AI.buildContext(game, player);
    const chosen = strategy.chooseCard(ctx);
    if (!chosen) throw new Error(`seat ${player.id} picked no card (hand=${player.hand.length})`);
    game.playCard(player, chosen);
  }
  if (safety <= 0) throw new Error('game did not terminate in 10000 moves');

  // Elimination order: game.winners is in order they got out (best rank first).
  // game.loser is the single player left holding cards (worst rank).
  const rankOf = new Array(numPlayers);
  let rank = 1;
  for (const w of game.winners) rankOf[w.id] = rank++;
  if (game.loser) rankOf[game.loser.id] = numPlayers;
  // Fill in any unassigned (shouldn't happen in normal flow — defensive)
  for (let i = 0; i < numPlayers; i++) {
    if (rankOf[i] == null) rankOf[i] = rank++;
  }

  const results = [];
  for (let i = 0; i < numPlayers; i++) {
    results.push({
      seatId: i,
      strategyName: strategies[i] === AI_V1 ? 'V1' : 'V2',
      rank: rankOf[i],
      cardsHeld: game.players[i].hand.length,
    });
  }
  return results;
}

function pad(s, w) { return String(s).padEnd(w); }

function printSummary(agg, totalPlayers) {
  const names = Object.keys(agg).sort();
  const cols = ['Strategy', 'Seats', 'AvgRank', 'WinRate', 'LossRate', 'AvgCards'];
  const widths = [10, 8, 9, 9, 10, 10];
  console.log(cols.map((h, i) => pad(h, widths[i])).join(''));
  console.log('-'.repeat(widths.reduce((a, b) => a + b, 0)));
  for (const name of names) {
    const a = agg[name];
    console.log(
      pad(name, widths[0]) +
      pad(a.seats, widths[1]) +
      pad((a.rankSum / a.seats).toFixed(3), widths[2]) +
      pad(((a.wins / a.seats) * 100).toFixed(1) + '%', widths[3]) +
      pad(((a.losses / a.seats) * 100).toFixed(1) + '%', widths[4]) +
      pad((a.cardsHeldSum / a.seats).toFixed(2), widths[5])
    );
  }

  console.log('\nRank distribution (% of seats finishing at each rank):');
  const rankCols = ['Strategy', ...Array.from({ length: totalPlayers }, (_, i) => 'Rank ' + (i + 1))];
  const rankWidths = [10, ...Array(totalPlayers).fill(10)];
  console.log(rankCols.map((h, i) => pad(h, rankWidths[i])).join(''));
  console.log('-'.repeat(rankWidths.reduce((a, b) => a + b, 0)));
  for (const name of names) {
    const a = agg[name];
    const row = [name];
    for (let r = 1; r <= totalPlayers; r++) {
      const count = a.rankCounts[r] || 0;
      row.push(((count / a.seats) * 100).toFixed(1) + '%');
    }
    console.log(row.map((v, i) => pad(v, rankWidths[i])).join(''));
  }
}

function main() {
  const args = parseArgs(process.argv);
  console.log(`Running ${args.games} games · ${args.players} players · mode=${args.mode}\n`);

  const agg = {};
  const start = Date.now();
  let completed = 0;

  for (let g = 0; g < args.games; g++) {
    let results;
    try {
      results = runOneGame(args.players, args.mode);
    } catch (err) {
      console.error(`game ${g} failed: ${err.message}`);
      continue;
    }
    for (const r of results) {
      if (!agg[r.strategyName]) {
        agg[r.strategyName] = {
          seats: 0, rankSum: 0, wins: 0, losses: 0,
          cardsHeldSum: 0, rankCounts: {},
        };
      }
      const a = agg[r.strategyName];
      a.seats++;
      a.rankSum += r.rank;
      if (r.rank === 1) a.wins++;
      if (r.rank === args.players) a.losses++;
      a.cardsHeldSum += r.cardsHeld;
      a.rankCounts[r.rank] = (a.rankCounts[r.rank] || 0) + 1;
    }
    completed++;
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`Completed ${completed}/${args.games} games in ${elapsed}s\n`);
  printSummary(agg, args.players);

  // Quick verdict when duelling
  if (args.mode === 'duel' && agg.V1 && agg.V2) {
    const v1Loss = agg.V1.losses / agg.V1.seats;
    const v2Loss = agg.V2.losses / agg.V2.seats;
    const diff = (v1Loss - v2Loss) * 100;
    console.log(
      `\nVerdict: V2 last-place rate is ${Math.abs(diff).toFixed(1)} pp ` +
      `${diff > 0 ? 'LOWER (better)' : 'HIGHER (worse)'} than V1.`
    );
  }
}

main();
