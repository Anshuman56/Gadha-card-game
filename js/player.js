class Player {
  constructor(id, name, isAI) {
    this.id = id;
    this.name = name;
    this.isAI = isAI;
    this.hand = [];
    this.isOut = false;
  }

  addCards(cards) {
    this.hand.push(...cards);
  }

  removeCard(card) {
    const idx = this.hand.findIndex(c => c.suit === card.suit && c.rank === card.rank);
    if (idx !== -1) this.hand.splice(idx, 1);
  }

  hasSuit(suit) {
    return this.hand.some(c => c.suit === suit);
  }

  hasCard(suit, rank) {
    return this.hand.some(c => c.suit === suit && c.rank === rank);
  }
}
