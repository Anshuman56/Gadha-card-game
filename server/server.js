'use strict';

// Entry point. This file's only jobs are:
//   1. Load the browser-shared game logic files into this Node context
//      (they use plain `class` declarations, no module.exports).
//   2. Wire express + socket.io.
//   3. Build broadcast + aiScheduler and hand them to socketHandlers.
//
// Actual logic lives in:
//   broadcast.js       — outgoing socket traffic
//   aiScheduler.js     — AI turn timing
//   socketHandlers.js  — every incoming socket event
//   roomManager.js     — room + seat state, hand-privacy game state builder

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const vm = require('vm');
const fs = require('fs');

// Load game logic files into this module's context. vm.runInThisContext
// exposes top-level class declarations (Card, Player, AI, Game) to the
// surrounding scope, which we then pass explicitly into socketHandlers.
['card.js', 'player.js', 'ai.js', 'game.js'].forEach(file => {
  const code = fs.readFileSync(path.join(__dirname, '../js', file), 'utf8');
  vm.runInThisContext(code);
});

const rm = require('./roomManager');
const createBroadcast = require('./broadcast');
const createAiScheduler = require('./aiScheduler');
const registerSocketHandlers = require('./socketHandlers');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '..')));

const broadcast = createBroadcast(io, rm);
const aiScheduler = createAiScheduler({ AI, broadcast });

registerSocketHandlers({ io, rm, Game, broadcast, aiScheduler });

server.listen(PORT, () => console.log(`Card game server running on http://localhost:${PORT}`));
