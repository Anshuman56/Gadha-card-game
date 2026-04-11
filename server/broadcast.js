'use strict';

// Factory: returns an object with the three broadcast helpers bound to the
// given io + roomManager instances. Keeping these in one place makes it
// obvious that *all* outgoing socket traffic to a room flows through here.

module.exports = function createBroadcast(io, rm) {

  // Send each player in the room their personalised game state.
  // Used mid-trick only — trick resolutions go through broadcastTrickResult.
  function broadcastGameState(room) {
    for (const [socketId] of room.playerSocketMap) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        socket.emit('game-state', { gameState: rm.buildGameStateFor(room, socketId) });
      }
    }
  }

  // Send a trick-result event to everyone, then (if the game just ended)
  // fire a delayed 'game-over' and schedule room cleanup.
  function broadcastTrickResult(room, result) {
    const resultData = {
      type: result.type,
      winnerName: result.winner ? result.winner.name : null,
      cardCount: result.cardsGiven.length,
      eliminatedNames: result.eliminated.map(p => p.name),
      gameOver: result.gameOver,
    };

    for (const [socketId] of room.playerSocketMap) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        socket.emit('trick-result', {
          result: resultData,
          gameState: rm.buildGameStateFor(room, socketId),
        });
      }
    }

    if (result.gameOver) {
      setTimeout(() => {
        const overData = {
          winners: result.winners.map((p, i) => ({ name: p.name, finishPosition: i + 1 })),
          loser: result.loser ? { name: result.loser.name, handCount: result.loser.hand.length } : null,
        };
        for (const [socketId] of room.playerSocketMap) {
          const socket = io.sockets.sockets.get(socketId);
          if (socket) socket.emit('game-over', overData);
        }
        // Schedule room cleanup after 10 minutes
        room.cleanupTimer = setTimeout(() => rm.deleteRoom(room.code), 10 * 60 * 1000);
      }, 2000);
    }
  }

  // Generic fan-out for simple lobby/notification events.
  function broadcastToRoom(room, event, data) {
    for (const [socketId] of room.playerSocketMap) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) socket.emit(event, data);
    }
  }

  return { broadcastGameState, broadcastTrickResult, broadcastToRoom };
};
