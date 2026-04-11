const AI = {
  chooseCard(player, trickSoFar, leadSuit, isLeading) {
    const hand = player.hand;

    // Leading a trick: play the lowest card of the suit with the most cards
    if (isLeading) {
      const suitCounts = {};
      for (const card of hand) {
        suitCounts[card.suit] = (suitCounts[card.suit] || 0) + 1;
      }
      const bestSuit = Object.keys(suitCounts).reduce((a, b) =>
        suitCounts[a] >= suitCounts[b] ? a : b
      );
      const suitCards = hand.filter(c => c.suit === bestSuit);
      return suitCards.reduce((low, c) => c.rankValue < low.rankValue ? c : low);
    }

    // Following suit if possible
    if (leadSuit && player.hasSuit(leadSuit)) {
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
    }

    // Cutting: play the absolute lowest card in hand
    return hand.reduce((low, c) => c.rankValue < low.rankValue ? c : low);
  }
};
