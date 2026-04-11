class Game {
  constructor(playerConfigs) {
    // playerConfigs: [{name, isAI}, ...]
    this.players = playerConfigs.map((cfg, i) => new Player(i, cfg.name, cfg.isAI));
    this.phase = 'setup'; // 'setup' | 'opening' | 'playing' | 'finished'
    this.currentTrick = null;
    this.leadPlayerIndex = -1;
    this.activePlayerIndex = -1;
    this.winners = [];
    this.loser = null;
    this.trickCount = 0;
    this.trickHistory = []; // [{number, plays:[{player,card}], type, winner}]
  }

  deal() {
    const deck = Card.buildDeck();
    const n = this.players.length;

    // Deal round-robin — earlier seats get extra cards if 52 % n !== 0
    for (let i = 0; i < deck.length; i++) {
      this.players[i % n].addCards([deck[i]]);
    }

    // Find Ace of Spades holder
    for (let i = 0; i < this.players.length; i++) {
      if (this.players[i].hand.some(c => c.isAceOfSpades())) {
        this.leadPlayerIndex = i;
        break;
      }
    }

    this.phase = 'opening';
    this._startTrick();
  }

  _startTrick() {
    this.currentTrick = {
      plays: [],
      leadSuit: null,
      participantIds: this._activePlayers().map(p => p.id),
    };
    this.activePlayerIndex = this.leadPlayerIndex;
  }

  _activePlayers() {
    return this.players.filter(p => !p.isOut);
  }

  getValidCards(player) {
    // On the very first lead (opening phase, this player is the lead)
    if (this.phase === 'opening' && this.currentTrick.plays.length === 0) {
      return player.hand.filter(c => c.isAceOfSpades());
    }

    // If this player is the lead of a normal trick, any card is valid
    if (this.currentTrick.plays.length === 0) {
      return [...player.hand];
    }

    // Must follow lead suit if possible
    const leadSuit = this.currentTrick.leadSuit;
    if (player.hasSuit(leadSuit)) {
      return player.hand.filter(c => c.suit === leadSuit);
    }

    // No lead suit — can play anything
    return [...player.hand];
  }

  // Returns TrickResult when trick is complete, null otherwise
  playCard(player, card) {
    // Validate it's this player's turn
    if (player.id !== this.players[this.activePlayerIndex].id) return null;

    // Validate card is in valid set
    const valid = this.getValidCards(player);
    if (!valid.some(c => c.suit === card.suit && c.rank === card.rank)) return null;

    // Set lead suit from first card played
    if (this.currentTrick.plays.length === 0) {
      this.currentTrick.leadSuit = card.suit;
    }

    // Remove from hand and record play
    player.removeCard(card);
    this.currentTrick.plays.push({ player, card });

    // If this player cut (played a different suit), end the trick immediately —
    // remaining players do not play regardless of what they hold.
    // Exception: in the opening trick, everyone must get a chance to play,
    // because the rule is "all follow spades" — we need every card on the table
    // to determine the outcome (and to hand them to the Ace of Spades holder
    // if anyone cut).
    const didCut = this.phase !== 'opening' &&
                   this.currentTrick.plays.length > 1 &&
                   card.suit !== this.currentTrick.leadSuit;

    // Check if all trick participants have played, or someone just cut
    const participants = this.currentTrick.participantIds;
    if (!didCut && this.currentTrick.plays.length < participants.length) {
      // Advance to next active player in participant list
      const playedIds = new Set(this.currentTrick.plays.map(p => p.player.id));
      const nextId = participants.find(id => !playedIds.has(id));
      this.activePlayerIndex = this.players.findIndex(p => p.id === nextId);
      return null;
    }

    // All played, or a cut ended the trick early — resolve
    return this._resolveTrick();
  }

  _resolveTrick() {
    this.trickCount++;
    if (this.phase === 'opening') {
      return this._openingTrickResolution();
    }
    return this._normalTrickResolution();
  }

  _openingTrickResolution() {
    const plays = this.currentTrick.plays;
    const allFollowed = plays.every(p => p.card.suit === 'spades');
    const aceHolder = this.players[this.leadPlayerIndex];
    const trickCards = plays.map(p => p.card);

    this.phase = 'playing';

    // Record history
    this.trickHistory.push({
      number: this.trickCount,
      plays: plays.map(p => ({ player: p.player, card: p.card })),
      type: allFollowed ? 'discard' : 'take',
      winner: allFollowed ? null : aceHolder,
    });

    let result;
    if (allFollowed) {
      // Discard all cards — no one gets them
      result = {
        type: 'discard',
        winner: null,
        cardsGiven: trickCards,
        eliminated: [],
        gameOver: false,
        winners: [],
        loser: null,
      };
    } else {
      // Ace of Spades player takes all cards
      aceHolder.addCards(trickCards);
      result = {
        type: 'take',
        winner: aceHolder,
        cardsGiven: trickCards,
        eliminated: [],
        gameOver: false,
        winners: [],
        loser: null,
      };
    }

    // Same player leads again
    this._startTrick();
    return result;
  }

  _normalTrickResolution() {
    const plays = this.currentTrick.plays;
    const leadSuit = this.currentTrick.leadSuit;
    const trickCards = plays.map(p => p.card);
    const allFollowed = plays.every(p => p.card.suit === leadSuit);

    let winner = null;
    let eliminated = [];
    let gameOver = false;
    let loser = null;
    let resultType;

    // Highest lead-suit card always determines who leads next
    const leadPlays = plays.filter(p => p.card.suit === leadSuit);
    const biggestPlay = leadPlays.reduce((best, p) =>
      p.card.rankValue > best.card.rankValue ? p : best
    );
    const biggestPlayer = biggestPlay.player;

    if (allFollowed) {
      // Discard all cards — check eliminations for players who emptied their hand
      resultType = 'discard';
      for (const { player } of plays) {
        if (player.hand.length === 0) {
          player.isOut = true;
          eliminated.push(player);
          this.winners.push(player);
        }
      }
    } else {
      // Someone cut — highest lead-suit card wins, that player takes all
      resultType = 'normal-win';
      winner = biggestPlayer;

      // Give all trick cards to winner FIRST
      winner.addCards(trickCards);

      // Then check eliminations (non-winners who emptied their hand)
      for (const { player } of plays) {
        if (player.id !== winner.id && player.hand.length === 0) {
          player.isOut = true;
          eliminated.push(player);
          this.winners.push(player);
        }
      }
    }

    // Record history now that winner is known
    this.trickHistory.push({
      number: this.trickCount,
      plays: plays.map(p => ({ player: p.player, card: p.card })),
      type: resultType,
      winner,
    });

    // Check win condition
    const active = this._activePlayers();
    if (active.length <= 1) {
      gameOver = true;
      if (active.length === 1) {
        loser = active[0];
        this.loser = loser;
      }
      this.phase = 'finished';
    }

    const result = {
      type: resultType,
      winner,
      cardsGiven: trickCards,
      eliminated,
      gameOver,
      winners: [...this.winners],
      loser,
    };

    if (!gameOver) {
      // Player with the biggest led-suit card leads next — but skip any who
      // just got eliminated in the discard case (the take-winner is never out
      // because they took cards). If all led-suit players are out, fall back
      // to the biggest remaining active player from the trick.
      const activeLeadPlays = leadPlays.filter(p => !p.player.isOut);
      const pool = activeLeadPlays.length > 0
        ? activeLeadPlays
        : plays.filter(p => !p.player.isOut);
      const nextLeader = pool.reduce((best, p) =>
        p.card.rankValue > best.card.rankValue ? p : best
      ).player;
      this.leadPlayerIndex = this.players.findIndex(p => p.id === nextLeader.id);
      this._startTrick();
    }

    return result;
  }
}
