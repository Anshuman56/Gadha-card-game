'use strict';

// rooms: Map<code, roomEntry>
const rooms = new Map();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function generateToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

// ── Create / Join ──────────────────────────────────────────────────────────

function createRoom(socketId, playerCount, humanCount, hostName) {
  const code = generateCode();
  const token = generateToken();

  // Clamp humanCount so we always have at least the host (1) and never more than total seats.
  const humans = Math.min(playerCount, Math.max(1, humanCount || 1));

  const seats = [];
  // Seat 0 = host (always a human)
  seats.push({ name: hostName || 'Player 1', isAI: false, socketId, connected: true, sessionToken: token });
  // Seats 1..humans-1 are empty human slots — guests fill them via join-room
  for (let i = 1; i < humans; i++) {
    seats.push({ name: `Player ${i + 1}`, isAI: false, socketId: null, connected: false, sessionToken: null });
  }
  // Remaining seats are AI
  for (let i = humans; i < playerCount; i++) {
    seats.push({ name: `Bot ${i - humans + 1}`, isAI: true, socketId: null, connected: true, sessionToken: null });
  }

  const room = {
    code,
    hostSocketId: socketId,
    phase: 'lobby',
    config: { playerCount, seats },
    game: null,
    playerSocketMap: new Map([[socketId, 0]]),
    aiTimers: [],
    disconnectTimers: {},
    cleanupTimer: null,
  };

  rooms.set(code, room);
  return { code, seatIndex: 0, token };
}

function joinRoom(socketId, code, playerName) {
  const room = rooms.get(code);
  if (!room) return { error: 'Room not found.' };
  if (room.phase !== 'lobby') return { error: 'Game already started.' };

  // Find first empty human seat (no socketId, not AI)
  const seatIndex = room.config.seats.findIndex(s => !s.isAI && !s.socketId);
  if (seatIndex === -1) return { error: 'Room is full.' };

  const token = generateToken();
  room.config.seats[seatIndex].name = playerName || `Player ${seatIndex + 1}`;
  room.config.seats[seatIndex].socketId = socketId;
  room.config.seats[seatIndex].connected = true;
  room.config.seats[seatIndex].sessionToken = token;
  room.playerSocketMap.set(socketId, seatIndex);

  return { seatIndex, token };
}

function reconnectRoom(socketId, code, sessionToken) {
  const room = rooms.get(code);
  if (!room) return { error: 'Room not found.' };

  const seatIndex = room.config.seats.findIndex(s => s.sessionToken === sessionToken);
  if (seatIndex === -1) return { error: 'Session not found.' };

  const seat = room.config.seats[seatIndex];
  // Remove old socket mapping
  if (seat.socketId) room.playerSocketMap.delete(seat.socketId);

  seat.socketId = socketId;
  seat.connected = true;
  room.playerSocketMap.set(socketId, seatIndex);

  // Cancel disconnect timer
  if (room.disconnectTimers[seatIndex]) {
    clearTimeout(room.disconnectTimers[seatIndex]);
    delete room.disconnectTimers[seatIndex];
  }

  return { seatIndex, seat };
}

// ── State builders ─────────────────────────────────────────────────────────

function buildRoomState(room, mySeatIndex) {
  return {
    code: room.code,
    phase: room.phase,
    hostSeatIndex: room.config.seats.findIndex(s => s.socketId === room.hostSocketId),
    mySeatIndex,
    seats: room.config.seats.map((s, i) => ({
      index: i,
      name: s.name,
      isAI: s.isAI,
      connected: s.connected,
      isHost: s.socketId === room.hostSocketId,
      filled: s.isAI || !!s.socketId,
    })),
  };
}

function buildGameStateFor(room, targetSocketId) {
  const game = room.game;
  const mySeatIndex = room.playerSocketMap.get(targetSocketId);

  const players = game.players.map((p, i) => {
    const base = {
      id: p.id,
      name: p.name,
      isAI: p.isAI,
      isOut: p.isOut,
      handCount: p.hand.length,
      isYou: i === mySeatIndex,
    };
    if (i === mySeatIndex) {
      base.hand = p.hand.map(c => ({ suit: c.suit, rank: c.rank }));
    }
    return base;
  });

  // Valid cards only for the active human player
  let validCards = [];
  if (mySeatIndex === game.activePlayerIndex && !game.players[mySeatIndex]?.isAI) {
    validCards = game.getValidCards(game.players[mySeatIndex])
      .map(c => ({ suit: c.suit, rank: c.rank }));
  }

  const currentTrick = game.currentTrick ? {
    leadSuit: game.currentTrick.leadSuit,
    plays: game.currentTrick.plays.map(p => ({
      playerIndex: p.player.id,
      playerName: p.player.name,
      card: { suit: p.card.suit, rank: p.card.rank },
    })),
  } : null;

  const lastTrick = game.trickHistory.length > 0
    ? game.trickHistory[game.trickHistory.length - 1]
    : null;
  const trickHistory = lastTrick ? [{
    number: lastTrick.number,
    plays: lastTrick.plays.map(p => ({
      playerName: p.player.name,
      card: { suit: p.card.suit, rank: p.card.rank },
    })),
    type: lastTrick.type,
    winnerName: lastTrick.winner ? lastTrick.winner.name : null,
  }] : [];

  return {
    code: room.code,
    phase: game.phase,
    mySeatIndex,
    activePlayerIndex: game.activePlayerIndex,
    leadPlayerIndex: game.leadPlayerIndex,
    players,
    currentTrick,
    validCards,
    trickHistory,
    trickCount: game.trickCount,
    winners: game.winners.map((p, i) => ({ name: p.name, finishPosition: i + 1 })),
    loser: game.loser ? { name: game.loser.name, handCount: game.loser.hand.length } : null,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function getRoom(code) { return rooms.get(code); }
function getRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    if (room.playerSocketMap.has(socketId)) return room;
  }
  return null;
}
function deleteRoom(code) { rooms.delete(code); }
function getSeatIndex(room, socketId) { return room.playerSocketMap.get(socketId); }

function allHumanSeatsFilled(room) {
  return room.config.seats.every(s => s.isAI || !!s.socketId);
}

module.exports = {
  createRoom, joinRoom, reconnectRoom,
  buildRoomState, buildGameStateFor,
  getRoom, getRoomBySocket, deleteRoom, getSeatIndex,
  allHumanSeatsFilled,
};
