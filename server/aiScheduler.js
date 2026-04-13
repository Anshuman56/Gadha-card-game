'use strict';

// Factory: returns { scheduleAiTurn, clearAiTimers } bound to the provided
// AI strategy and broadcast helpers. The scheduler is the sole driver of
// AI moves in online games — whenever the active player is an AI, call
// scheduleAiTurn(room) and a timer will play the move and recurse.

module.exports = function createAiScheduler({ AI, broadcast }) {

  function scheduleAiTurn(room) {
    const game = room.game;
    if (!game || game.phase === 'finished') return;

    const player = game.players[game.activePlayerIndex];
    if (!player || !player.isAI) return;

    const t = setTimeout(() => {
      // Re-validate: the active player may have changed since this timer was
      // queued (another timer or a play-card event could have raced us).
      if (!room.game || room.game.phase === 'finished') return;
      if (room.game.activePlayerIndex !== player.id) return;

      const validCards = game.getValidCards(player);
      if (!validCards.length) return;

      const isLeading = game.currentTrick.plays.length === 0;
      const activeCount = game.players.filter(p => !p.isOut).length;
      const chosen = AI.chooseCard(
        { hand: validCards, hasSuit: s => validCards.some(c => c.suit === s), id: player.id },
        game.currentTrick.plays,
        game.currentTrick.leadSuit,
        isLeading,
        activeCount
      );
      const result = game.playCard(player, chosen);
      if (result !== null) {
        broadcast.broadcastTrickResult(room, result);
        if (!result.gameOver) scheduleAiTurnAfterTrickResult(room);
      } else {
        broadcast.broadcastGameState(room);
        scheduleAiTurn(room);
      }
    }, 500 + Math.random() * 400);

    room.aiTimers.push(t);
  }

  // After a trick resolves, clients show the trick-result message for 1400ms
  // before re-applying the gameState embedded in the trick-result event. If
  // we schedule the next AI move too quickly, fresher 'game-state' events get
  // clobbered by that delayed re-apply, which can leave the client stuck on a
  // stale state. Wait until the client's display window is over before
  // advancing the game.
  function scheduleAiTurnAfterTrickResult(room) {
    const t = setTimeout(() => scheduleAiTurn(room), 1600);
    room.aiTimers.push(t);
  }

  function clearAiTimers(room) {
    room.aiTimers.forEach(t => clearTimeout(t));
    room.aiTimers = [];
  }

  return { scheduleAiTurn, scheduleAiTurnAfterTrickResult, clearAiTimers };
};
