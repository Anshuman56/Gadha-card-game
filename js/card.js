const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_VALUES = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };
const SUIT_SYMBOLS = { clubs:'♣', diamonds:'♦', hearts:'♥', spades:'♠' };

class Card {
  constructor(suit, rank) {
    this.suit = suit;
    this.rank = rank;
  }

  get rankValue() {
    return RANK_VALUES[this.rank];
  }

  get suitSymbol() {
    return SUIT_SYMBOLS[this.suit];
  }

  get displayName() {
    return this.rank + this.suitSymbol;
  }

  isAceOfSpades() {
    return this.suit === 'spades' && this.rank === 'A';
  }

  static buildDeck() {
    const deck = [];
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        deck.push(new Card(suit, rank));
      }
    }
    return Card.shuffle(deck);
  }

  static shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}
