'use strict';

// Wires every socket.io event to its handler. Exports a single function —
// call it once from server.js entry point after building the dependencies.
//
// Event map:
//   create-room    → create a room, seat the host
//   join-room      → seat a guest in an existing room
//   reconnect-room → reattach a returning socket to its seat via sessionToken
//   start-game     → host deals, game begins, AI scheduler kicks off
//   play-card      → validate + apply a human move, then hand turn to AI
//   play-again     → reset the room back to the lobby
//   disconnect     → mark seat disconnected; 60s grace before AI takeover

module.exports = function registerSocketHandlers({ io, rm, Game, broadcast, aiScheduler }) {
  const { broadcastGameState, broadcastTrickResult, broadcastToRoom } = broadcast;
  const { scheduleAiTurn, scheduleAiTurnAfterTrickResult, clearAiTimers } = aiScheduler;

  io.on('connection', socket => {
    console.log(`[connect] ${socket.id}`);

    // ── Create room ──────────────────────────────────────────────────────
    socket.on('create-room', ({ playerCount, humanCount, hostName }) => {
      const count = Math.min(6, Math.max(2, parseInt(playerCount) || 4));
      const humans = Math.min(count, Math.max(1, parseInt(humanCount) || 1));
      const { code, seatIndex, token } = rm.createRoom(socket.id, count, humans, hostName);
      const room = rm.getRoom(code);

      socket.join(code);
      socket.emit('room-created', {
        code,
        seatIndex,
        token,
        roomState: rm.buildRoomState(room, seatIndex),
      });
      console.log(`[room] created ${code} by ${hostName}`);
    });

    // ── Join room ────────────────────────────────────────────────────────
    socket.on('join-room', ({ code, playerName }) => {
      const result = rm.joinRoom(socket.id, code?.toUpperCase(), playerName);
      if (result.error) {
        socket.emit('room-error', { message: result.error });
        return;
      }
      const room = rm.getRoom(code.toUpperCase());
      socket.join(code.toUpperCase());

      socket.emit('room-joined', {
        code: code.toUpperCase(),
        seatIndex: result.seatIndex,
        token: result.token,
        roomState: rm.buildRoomState(room, result.seatIndex),
      });

      broadcastToRoom(room, 'lobby-update', { roomState: rm.buildRoomState(room, null) });
      console.log(`[room] ${playerName} joined ${code}`);
    });

    // ── Reconnect ────────────────────────────────────────────────────────
    socket.on('reconnect-room', ({ code, sessionToken }) => {
      const result = rm.reconnectRoom(socket.id, code?.toUpperCase(), sessionToken);
      if (result.error) {
        socket.emit('room-error', { message: result.error });
        return;
      }
      const room = rm.getRoom(code.toUpperCase());
      socket.join(code.toUpperCase());

      if (room.phase === 'lobby') {
        socket.emit('room-joined', {
          code: code.toUpperCase(),
          seatIndex: result.seatIndex,
          token: sessionToken,
          roomState: rm.buildRoomState(room, result.seatIndex),
        });
      } else {
        socket.emit('game-state', {
          gameState: rm.buildGameStateFor(room, socket.id),
        });
        broadcastToRoom(room, 'player-reconnected', {
          seatIndex: result.seatIndex,
          playerName: result.seat.name,
        });
      }
      console.log(`[room] ${result.seat.name} reconnected to ${code}`);
    });

    // ── Start game ───────────────────────────────────────────────────────
    socket.on('start-game', ({ code }) => {
      const room = rm.getRoom(code?.toUpperCase());
      if (!room) return;
      if (room.hostSocketId !== socket.id) {
        socket.emit('room-error', { message: 'Only the host can start the game.' });
        return;
      }
      if (room.phase !== 'lobby') return;
      if (!rm.allHumanSeatsFilled(room)) {
        socket.emit('room-error', { message: 'Waiting for all players to join.' });
        return;
      }

      const configs = room.config.seats.map(s => ({ name: s.name, isAI: s.isAI }));
      room.game = new Game(configs);
      room.game.deal();
      room.phase = 'playing';

      for (const [socketId] of room.playerSocketMap) {
        const sock = io.sockets.sockets.get(socketId);
        if (sock) {
          sock.emit('game-started', {
            gameState: rm.buildGameStateFor(room, socketId),
          });
        }
      }

      scheduleAiTurn(room);
      console.log(`[game] started in room ${code}`);
    });

    // ── Play card ────────────────────────────────────────────────────────
    socket.on('play-card', ({ code, suit, rank }) => {
      const room = rm.getRoom(code?.toUpperCase());
      if (!room || room.phase !== 'playing') return;

      const seatIndex = rm.getSeatIndex(room, socket.id);
      if (seatIndex === undefined) return;

      const game = room.game;
      if (game.activePlayerIndex !== seatIndex) {
        socket.emit('move-rejected', { reason: 'Not your turn.' });
        return;
      }

      const player = game.players[seatIndex];
      const card = player.hand.find(c => c.suit === suit && c.rank === rank);
      if (!card) {
        socket.emit('move-rejected', { reason: 'Card not in hand.' });
        return;
      }

      const result = game.playCard(player, card);

      if (result !== null) {
        broadcastTrickResult(room, result);
        if (!result.gameOver) scheduleAiTurnAfterTrickResult(room);
      } else {
        broadcastGameState(room);
        scheduleAiTurn(room);
      }
    });

    // ── Play again ───────────────────────────────────────────────────────
    socket.on('play-again', ({ code }) => {
      const room = rm.getRoom(code?.toUpperCase());
      if (!room) return;

      clearAiTimers(room);
      room.game = null;
      room.phase = 'lobby';

      for (const [socketId, seatIdx] of room.playerSocketMap) {
        const sock = io.sockets.sockets.get(socketId);
        if (sock) {
          sock.emit('room-joined', {
            code: room.code,
            seatIndex: seatIdx,
            token: room.config.seats[seatIdx].sessionToken,
            roomState: rm.buildRoomState(room, seatIdx),
          });
        }
      }
    });

    // ── Disconnect ───────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      console.log(`[disconnect] ${socket.id}`);
      const room = rm.getRoomBySocket(socket.id);
      if (!room) return;

      const seatIndex = rm.getSeatIndex(room, socket.id);
      if (seatIndex === undefined) return;

      const seat = room.config.seats[seatIndex];
      seat.connected = false;

      if (room.phase === 'lobby') {
        // Grace period: player may be navigating between pages
        room.disconnectTimers[seatIndex] = setTimeout(() => {
          if (room.config.seats[seatIndex].connected) return;
          if (socket.id === room.hostSocketId) {
            broadcastToRoom(room, 'room-closed', { reason: 'Host left the lobby.' });
            clearAiTimers(room);
            rm.deleteRoom(room.code);
          } else {
            seat.socketId = null;
            room.playerSocketMap.delete(socket.id);
            broadcastToRoom(room, 'lobby-update', { roomState: rm.buildRoomState(room, null) });
          }
        }, 5000);
        return;
      }

      broadcastToRoom(room, 'player-disconnected', {
        seatIndex,
        playerName: seat.name,
      });

      // 60-second grace period before converting the seat to AI
      room.disconnectTimers[seatIndex] = setTimeout(() => {
        if (!room.config.seats[seatIndex].connected) {
          seat.isAI = true;
          if (room.game) room.game.players[seatIndex].isAI = true;
          room.playerSocketMap.delete(socket.id);
          broadcastToRoom(room, 'player-disconnected', {
            seatIndex,
            playerName: seat.name,
            convertedToAI: true,
          });
          scheduleAiTurn(room);
        }
      }, 60000);
    });
  });
};
