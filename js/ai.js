const AI = {
  // Track which suits have been cut by which players
  _cutHistory: {},  // { suitName: Set of playerIds who cut it }

  resetMemory() {
    this._cutHistory = {};
  },

  recordCut(playerId, suit) {
    if (!this._cutHistory[suit]) this._cutHistory[suit] = new Set();
    this._cutHistory[suit].add(playerId);
  },

  // How many players have shown they lack this suit
  _cutCount(suit) {
    return this._cutHistory[suit] ? this._cutHistory[suit].size : 0;
  },

  chooseCard(player, trickSoFar, leadSuit, isLeading, activePlayers) {
    const hand = player.hand;
    const activeCount = activePlayers || 4;

    if (isLeading) {
      return this._chooseLead(hand, activeCount);
    }

    // Following suit if possible
    if (leadSuit && player.hasSuit(leadSuit)) {
      return this._chooseFollow(hand, leadSuit, trickSoFar);
    }

    // Cutting: play the highest card of the suit most cut by others
    // (opponents probably can't follow it either, so it'll get discarded
    // or someone else takes it). Failing that, dump the highest card of
    // the suit we have the fewest of — burn singletons and doubletons.
    return this._chooseCut(hand);
  },

  _chooseLead(hand, activeCount) {
    // Group cards by suit
    const bySuit = {};
    for (const card of hand) {
      if (!bySuit[card.suit]) bySuit[card.suit] = [];
      bySuit[card.suit].push(card);
    }

    const suits = Object.keys(bySuit);

    // Score each suit — lower is better to lead
    // We WANT everyone to follow (so the trick is discarded).
    // Avoid suits that have been cut (opponents lack them → we'll win and take cards).
    let bestSuit = null;
    let bestScore = Infinity;

    for (const suit of suits) {
      const cards = bySuit[suit];
      const cutters = this._cutCount(suit);

      // Penalty for each player known to lack this suit
      // (each cutter means ~guaranteed we take cards)
      const cutPenalty = cutters * 100;

      // Prefer suits where we have many cards (more likely others have them too)
      // But not TOO many — if we have most of a suit, others might not
      const countBonus = cards.length <= 5 ? cards.length * 3 : 0;

      // Prefer leading low cards (less likely to win if someone plays higher)
      const lowestRank = Math.min(...cards.map(c => c.rankValue));

      const score = cutPenalty - countBonus + lowestRank;

      if (score < bestScore) {
        bestScore = score;
        bestSuit = suit;
      }
    }

    // If ALL suits have been cut by someone, pick the one with fewest cutters
    // and lead the lowest card
    const suitCards = bySuit[bestSuit];
    return suitCards.reduce((low, c) => c.rankValue < low.rankValue ? c : low);
  },

  _chooseFollow(hand, leadSuit, trickSoFar) {
    const suitCards = hand.filter(c => c.suit === leadSuit);

    // Find the current highest card of lead suit in trick
    const trickLeadCards = trickSoFar
      .filter(p => p.card.suit === leadSuit)
      .map(p => p.card);
    const currentWinnerValue = trickLeadCards.length > 0
      ? Math.max(...trickLeadCards.map(c => c.rankValue))
      : 0;

    // Cards that would lose the trick (below current winner)
    const losingCards = suitCards.filter(c => c.rankValue < currentWinnerValue);
    if (losingCards.length > 0) {
      // Play the highest losing card (use up a decent card without winning)
      return losingCards.reduce((high, c) => c.rankValue > high.rankValue ? c : high);
    }

    // All our cards would win — play the lowest to minimise damage
    return suitCards.reduce((low, c) => c.rankValue < low.rankValue ? c : low);
  },

  _chooseCut(hand) {
    // When cutting, we want to dump cards strategically:
    // 1. Play the highest card of the suit we have the fewest of (burn singletons)
    // 2. This empties out weak suits so we can follow less often and get out faster

    const bySuit = {};
    for (const card of hand) {
      if (!bySuit[card.suit]) bySuit[card.suit] = [];
      bySuit[card.suit].push(card);
    }

    // Find suit with fewest cards (prefer dumping singletons/doubletons)
    let bestCard = null;
    let bestScore = Infinity;

    for (const suit of Object.keys(bySuit)) {
      const cards = bySuit[suit];
      for (const card of cards) {
        // Lower count = better to dump from (empties a suit)
        // Higher rank = better to dump (get rid of dangerous high cards)
        const score = cards.length * 100 - card.rankValue;
        if (score < bestScore) {
          bestScore = score;
          bestCard = card;
        }
      }
    }

    return bestCard || hand[0];
  }
};
