// AI strategies for the card game.
//
// Three named strategies live side-by-side:
//   AI_V1 — the original rule-based strategy, preserved for benchmarks.
//   AI_V2 — probabilistic heuristic. Card tracking, position awareness,
//           opponent hand-count awareness, smarter cut-dump. No simulation.
//   AI_V3 — Perfect-Information Monte Carlo (the current default). Samples
//           plausible opponent hands consistent with seen cards, cut history
//           and hand sizes, plays the trick forward, and scores outcomes.
//           This is the "plan ahead / figure out what they might have"
//           strategy.
//
// `AI.chooseCard(ctx)` dispatches to V3. Callers build `ctx` via
// `AI.buildContext(game, player)` so neither the browser nor the server has
// to duplicate game-state plumbing.

const _AI_SUITS = ['clubs', 'diamonds', 'hearts', 'spades'];
const _AI_RANK_VALUES = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };
const _AI_RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

const AI = {
  // Default public entry point. Dispatches to V3 (PIMC).
  chooseCard(ctx) {
    return AI_V3.chooseCard(ctx);
  },

  // Build a decision context from game state. Shared by browser (ui.js) and
  // server (aiScheduler.js). Returns an object that all strategies consume.
  buildContext(game, player) {
    const validCards = game.getValidCards(player);
    const trickSoFar = game.currentTrick ? game.currentTrick.plays : [];
    const leadSuit = game.currentTrick ? game.currentTrick.leadSuit : null;
    const isLeading = trickSoFar.length === 0;

    const handCounts = {};
    for (const p of game.players) handCounts[p.id] = p.hand.length;

    // Who is still to play in this trick (after me).
    const playedIds = new Set(trickSoFar.map(p => p.player.id));
    const participants = game.currentTrick ? (game.currentTrick.participantIds || []) : [];
    const playersToPlay = participants.filter(id => id !== player.id && !playedIds.has(id));

    // Cards visible so far this deal: everything in completed tricks + the
    // cards already played in the current trick. Stored as "suit:rank" keys.
    const seenCards = new Set();
    if (game.trickHistory) {
      for (const t of game.trickHistory) {
        for (const pl of t.plays) seenCards.add(pl.card.suit + ':' + pl.card.rank);
      }
    }
    for (const pl of trickSoFar) seenCards.add(pl.card.suit + ':' + pl.card.rank);

    return {
      // `player.hand` is the LEGAL card set — the decision space.
      player: {
        id: player.id,
        hand: validCards,
        hasSuit: (s) => validCards.some(c => c.suit === s),
      },
      // `ownFullHand` is the unfiltered hand, useful for reasoning about
      // future tricks (suit distribution, high-card exposure, etc.).
      ownFullHand: player.hand,
      trickSoFar,
      leadSuit,
      isLeading,
      activePlayers: game.players.filter(p => !p.isOut).length,
      phase: game.phase,
      handCounts,
      playersToPlay,
      seenCards,
      cutHistory: game.cutHistory || {},
    };
  },
};

// =====================================================================
// AI_V1 — original rule-based strategy, preserved for benchmark compares
// =====================================================================
const AI_V1 = {
  chooseCard(ctx) {
    const hand = ctx.player.hand;
    const activeCount = ctx.activePlayers || 4;
    const cutHistory = ctx.cutHistory || {};

    if (ctx.isLeading) return this._chooseLead(hand, activeCount, cutHistory);
    if (ctx.leadSuit && ctx.player.hasSuit(ctx.leadSuit)) {
      return this._chooseFollow(hand, ctx.leadSuit, ctx.trickSoFar);
    }
    return this._chooseCut(hand);
  },

  _cutCount(cutHistory, suit) {
    return cutHistory[suit] ? cutHistory[suit].size : 0;
  },

  _chooseLead(hand, activeCount, cutHistory) {
    const bySuit = {};
    for (const card of hand) {
      if (!bySuit[card.suit]) bySuit[card.suit] = [];
      bySuit[card.suit].push(card);
    }
    const suits = Object.keys(bySuit);
    let bestSuit = null;
    let bestScore = Infinity;
    for (const suit of suits) {
      const cards = bySuit[suit];
      const cutters = this._cutCount(cutHistory, suit);
      const cutPenalty = cutters * 100;
      const countBonus = cards.length <= 5 ? cards.length * 3 : 0;
      const lowestRank = Math.min(...cards.map(c => c.rankValue));
      const score = cutPenalty - countBonus + lowestRank;
      if (score < bestScore) {
        bestScore = score;
        bestSuit = suit;
      }
    }
    const suitCards = bySuit[bestSuit];
    return suitCards.reduce((low, c) => c.rankValue < low.rankValue ? c : low);
  },

  _chooseFollow(hand, leadSuit, trickSoFar) {
    const suitCards = hand.filter(c => c.suit === leadSuit);
    const trickLeadCards = trickSoFar
      .filter(p => p.card.suit === leadSuit)
      .map(p => p.card);
    const currentWinnerValue = trickLeadCards.length > 0
      ? Math.max(...trickLeadCards.map(c => c.rankValue))
      : 0;
    const losingCards = suitCards.filter(c => c.rankValue < currentWinnerValue);
    if (losingCards.length > 0) {
      return losingCards.reduce((high, c) => c.rankValue > high.rankValue ? c : high);
    }
    return suitCards.reduce((low, c) => c.rankValue < low.rankValue ? c : low);
  },

  _chooseCut(hand) {
    const bySuit = {};
    for (const card of hand) {
      if (!bySuit[card.suit]) bySuit[card.suit] = [];
      bySuit[card.suit].push(card);
    }
    let bestCard = null;
    let bestScore = Infinity;
    for (const suit of Object.keys(bySuit)) {
      const cards = bySuit[suit];
      for (const card of cards) {
        const score = cards.length * 100 - card.rankValue;
        if (score < bestScore) {
          bestScore = score;
          bestCard = card;
        }
      }
    }
    return bestCard || hand[0];
  },
};

// =====================================================================
// AI_V2 — smarter default strategy
// =====================================================================
//
// Core improvements over V1:
//   1. Uses game.cutHistory which is reset per deal (no stale memory bleed).
//   2. Tracks seen cards to decide if a held card is "actually safe" to play.
//   3. Position awareness: last-to-play optimizations in follow branch.
//   4. Hand-count awareness: applies end-game pressure when an opponent is
//      close to elimination.
//   5. Cut-dump prefers BOTH emptying short suits AND dumping high cards,
//      rather than just short suits.
//
// The strategy still uses hand-crafted scoring (not search/MCTS). The
// "smarter" improvements are about feeding it more signal and letting those
// signals break ties the right way.
//
const AI_V2 = {
  chooseCard(ctx) {
    const hand = ctx.player.hand;
    if (!hand.length) return null;

    if (ctx.isLeading) return this._chooseLead(ctx);
    if (ctx.leadSuit && ctx.player.hasSuit(ctx.leadSuit)) {
      return this._chooseFollow(ctx);
    }
    return this._chooseCut(ctx);
  },

  // --- internal helpers ---

  _groupBySuit(cards) {
    const m = {};
    for (const c of cards) {
      if (!m[c.suit]) m[c.suit] = [];
      m[c.suit].push(c);
    }
    for (const s of Object.keys(m)) m[s].sort((a, b) => a.rankValue - b.rankValue);
    return m;
  },

  // Cards of `suit` neither visible this deal nor in my hand.
  // These are the cards distributed among opponents' hidden hands.
  _unseenOfSuit(ctx, suit) {
    const own = ctx.ownFullHand || [];
    let n = 0;
    for (const r of _AI_RANKS) {
      const key = suit + ':' + r;
      if (ctx.seenCards.has(key)) continue;
      if (own.some(c => c.suit === suit && c.rank === r)) continue;
      n++;
    }
    return n;
  },

  _totalUnseen(ctx) {
    let n = 0;
    for (const s of _AI_SUITS) n += this._unseenOfSuit(ctx, s);
    return n;
  },

  // Unseen cards of `suit` with rank strictly greater than `rv`.
  _unseenHigherOfSuit(ctx, suit, rv) {
    const own = ctx.ownFullHand || [];
    let n = 0;
    for (const r of _AI_RANKS) {
      if (_AI_RANK_VALUES[r] <= rv) continue;
      const key = suit + ':' + r;
      if (ctx.seenCards.has(key)) continue;
      if (own.some(c => c.suit === suit && c.rank === r)) continue;
      n++;
    }
    return n;
  },

  // P(opponent holds at least one card of `suit`).
  // Known cutters → 0. Otherwise approximate with hypergeometric-lite:
  // P(has ≥ 1) ≈ 1 − (1 − unseenOfSuit / totalUnseen)^opponentHand.
  _pHasSuit(ctx, opponentId, suit) {
    const cuts = ctx.cutHistory && ctx.cutHistory[suit];
    if (cuts && cuts.has && cuts.has(opponentId)) return 0;
    const hc = ctx.handCounts[opponentId] || 0;
    if (hc === 0) return 0;
    const total = this._totalUnseen(ctx);
    if (total <= 0) return 0;
    const ofSuit = this._unseenOfSuit(ctx, suit);
    if (ofSuit <= 0) return 0;
    const pNone = Math.pow(1 - ofSuit / total, hc);
    return Math.min(1, Math.max(0, 1 - pNone));
  },

  // P(opponent holds a lead-suit card strictly higher than `rv`).
  _pHasHigher(ctx, opponentId, suit, rv) {
    const cuts = ctx.cutHistory && ctx.cutHistory[suit];
    if (cuts && cuts.has && cuts.has(opponentId)) return 0;
    const hc = ctx.handCounts[opponentId] || 0;
    if (hc === 0) return 0;
    const total = this._totalUnseen(ctx);
    if (total <= 0) return 0;
    const hi = this._unseenHigherOfSuit(ctx, suit, rv);
    if (hi <= 0) return 0;
    const pNone = Math.pow(1 - hi / total, hc);
    return Math.min(1, Math.max(0, 1 - pNone));
  },

  _activeOtherIds(ctx) {
    const out = [];
    for (const k of Object.keys(ctx.handCounts)) {
      const id = Number(k);
      if (id === ctx.player.id) continue;
      if (ctx.handCounts[k] > 0) out.push(id);
    }
    return out;
  },

  // --- leading ---
  //
  // Pick a card that minimises expected cards I take.
  // When I lead:
  //   * If everyone follows → highest lead-suit card wins. I want that to be
  //     NOT me, so lead a low card in a suit others clearly have.
  //   * If ANYONE cuts → trick ends and the highest lead-suit card so far
  //     wins. If only I've played lead-suit at that point, I WIN. Bad.
  //   * End-game: if an opponent has ≤ 2 cards, be careful — helping them
  //     dump a card safely lets them get out.
  _chooseLead(ctx) {
    const bySuit = this._groupBySuit(ctx.player.hand);
    const suits = Object.keys(bySuit);
    const opponents = this._activeOtherIds(ctx);
    const trickSize = ctx.activePlayers;

    let best = null;
    let bestScore = Infinity;

    for (const suit of suits) {
      const cards = bySuit[suit];   // sorted ascending
      const lowest = cards[0];

      // P(everyone follows)
      let pAllFollow = 1;
      for (const op of opponents) pAllFollow *= this._pHasSuit(ctx, op, suit);

      // On all-follow: highest lead card wins. P(my lowest stays highest) is
      // tiny unless everyone held only lower cards. Use _pHasHigher per
      // opponent and combine: P(no one plays higher) = Π (1 − pHasHigher).
      let pNoOneHigher = 1;
      for (const op of opponents) {
        pNoOneHigher *= (1 - this._pHasHigher(ctx, op, suit, lowest.rankValue));
      }
      const eTakeAllFollow = pAllFollow * pNoOneHigher * trickSize;

      // On cut-early: with my lead being the only lead-suit card at the
      // moment of the cut, I win. Approx: P(first-to-play after me cuts).
      // Rough model: pCut ≈ 1 − pAllFollow; the expected "take size" when
      // someone cuts early is around 2 (my card + the cutter's). Underweight
      // because cuts can also happen late (after many followers).
      const pCutEarly = 1 - pAllFollow;
      const eTakeCut = pCutEarly * 2.0;

      // End-game pressure: if any opponent is near zero, don't lead a suit
      // they definitely hold (they'd dump it cleanly and get out).
      let endGamePenalty = 0;
      for (const op of opponents) {
        const hc = ctx.handCounts[op];
        if (hc <= 2) {
          endGamePenalty += this._pHasSuit(ctx, op, suit) * (3 - hc) * 1.5;
        }
      }

      const score = eTakeAllFollow + eTakeCut + endGamePenalty;
      if (score < bestScore) {
        bestScore = score;
        best = lowest;
      }
    }
    return best || ctx.player.hand[0];
  },

  // --- following suit ---
  //
  // Key insight: if ANY later player cuts, trick ends and the highest
  // lead-suit card so far wins. So whether I "win" depends on:
  //   * current highest among played lead-suit cards
  //   * whether later players will play higher lead-suit BEFORE any cut
  //
  // Strategy:
  //   * If I have cards below the current winner, play my highest such
  //     (burn a decent card without winning).
  //   * If I'm LAST to play and all followed, I either win (play lowest
  //     winner) or lose-burn (play highest loser).
  //   * If others remain and I'm likely to be overtaken anyway, burn high.
  _chooseFollow(ctx) {
    const leadSuit = ctx.leadSuit;
    const suitCards = ctx.player.hand
      .filter(c => c.suit === leadSuit)
      .sort((a, b) => a.rankValue - b.rankValue);

    const played = ctx.trickSoFar
      .filter(p => p.card.suit === leadSuit)
      .map(p => p.card);
    const winnerVal = played.length ? Math.max(...played.map(c => c.rankValue)) : 0;

    const losing = suitCards.filter(c => c.rankValue < winnerVal);
    const winning = suitCards.filter(c => c.rankValue >= winnerVal);

    // I'm last — pure decision, no uncertainty about overtakers.
    if (ctx.playersToPlay.length === 0) {
      if (losing.length) return losing[losing.length - 1];   // highest losing
      return winning[0];                                      // lowest winning
    }

    // Not last. Safer to play below current winner — I can't take even if
    // someone later cuts (the cut ends the trick and the higher card wins).
    if (losing.length) return losing[losing.length - 1];

    // All my cards are ≥ winner. Estimate how likely I get overtaken.
    const myHighest = suitCards[suitCards.length - 1];
    let pNoOvertake = 1;
    for (const op of ctx.playersToPlay) {
      pNoOvertake *= (1 - this._pHasHigher(ctx, op, leadSuit, myHighest.rankValue));
    }
    // pOvertake = 1 − pNoOvertake. If high, I'll lose the trick anyway → burn high.
    if (1 - pNoOvertake > 0.7) return myHighest;
    // Otherwise minimise damage with lowest winning card.
    return winning[0];
  },

  // --- cutting ---
  //
  // Cutting is GOOD for me: the trick ends immediately and the highest
  // lead-suit card so far (played by someone else) wins. I don't take.
  // So cutting is a free opportunity to dump a bad card.
  //
  // Ranking:
  //   * high rank → dump first (most dangerous to keep)
  //   * singletons → dump to clear the suit entirely (immunity from future
  //     forced follows there)
  //   * short suits beat long suits at equal rank
  _chooseCut(ctx) {
    const bySuit = this._groupBySuit(ctx.player.hand);

    let best = null;
    let bestScore = -Infinity;

    for (const suit of Object.keys(bySuit)) {
      const cards = bySuit[suit];
      const len = cards.length;
      for (const card of cards) {
        let score = card.rankValue * 8;
        if (len === 1) score += 55;
        else score -= (len - 1) * 9;
        if (card.rankValue >= 13) score += 20;   // A / K extra priority
        if (score > bestScore) {
          bestScore = score;
          best = card;
        }
      }
    }
    return best || ctx.player.hand[0];
  },
};

// =====================================================================
// AI_V3 — Perfect-Information Monte Carlo (PIMC) with forward simulation
// =====================================================================
//
// How it plans ahead:
//   1. SAMPLE WORLDS — Build plausible distributions of opponents' hidden
//      hands from everything known: cards seen in prior tricks, each
//      opponent's current hand count, and who has cut which suits (a
//      cutter provably holds zero of that suit).
//   2. SIMULATE — For each legal candidate card, for each sampled world,
//      actually play the card, then have the remaining trick participants
//      play under a fast heuristic that mirrors sensible play.
//   3. SCORE — Score the rollout outcome: big penalty if I take cards,
//      big reward if I empty my hand without taking (I'm out), small
//      reward for dumping high-rank cards safely, mild penalty if an
//      opponent gets out.
//   4. AVERAGE — Each candidate's score is averaged across worlds. The
//      card with the best expected score is chosen.
//
// Common Random Numbers: every candidate is evaluated against the SAME
// sampled worlds, so differences in score reflect the candidate, not the
// sampling noise.
//
const AI_V3 = {
  SAMPLES: 30,
  MAX_MS: 150,

  chooseCard(ctx) {
    const hand = ctx.player.hand;
    if (!hand.length) return null;
    if (hand.length === 1) return hand[0];

    // If probabilistic info is too sparse (early-game, nothing seen yet),
    // V2 is already good and cheaper. Use PIMC mid-to-late when it matters.
    const totalHandCards = Object.values(ctx.handCounts).reduce((a, b) => a + b, 0);
    if (totalHandCards > 48 || ctx.activePlayers < 2) {
      return AI_V2.chooseCard(ctx);
    }

    const candidates = hand;
    const scores = new Array(candidates.length).fill(0);
    const counts = new Array(candidates.length).fill(0);

    const start = Date.now();
    for (let s = 0; s < this.SAMPLES; s++) {
      if (Date.now() - start > this.MAX_MS) break;
      const world = this._sampleWorld(ctx);
      if (!world) continue;
      for (let i = 0; i < candidates.length; i++) {
        // Clone per candidate so mutations in rollout don't leak across.
        const worldCopy = this._cloneWorld(world);
        scores[i] += this._rollout(ctx, worldCopy, candidates[i]);
        counts[i]++;
      }
    }

    let bestIdx = 0;
    let bestAvg = -Infinity;
    for (let i = 0; i < candidates.length; i++) {
      const n = counts[i] || 1;
      const avg = scores[i] / n;
      if (avg > bestAvg) { bestAvg = avg; bestIdx = i; }
    }
    // Safety fallback: if all samples failed, defer to V2.
    if (counts.every(c => c === 0)) return AI_V2.chooseCard(ctx);
    return candidates[bestIdx];
  },

  // --- world sampling ---
  //
  // Deal every unseen card to an opponent such that:
  //   * each opponent ends up with exactly handCounts[id] cards,
  //   * an opponent in cutHistory[suit] receives no cards of `suit`.
  // Greedy random placement with several restarts. Returns Map<id, card[]>
  // or null if infeasible (rare — would require degenerate constraints).
  _sampleWorld(ctx) {
    const ownKeys = new Set((ctx.ownFullHand || []).map(c => c.suit + ':' + c.rank));
    const unseen = [];
    for (const suit of _AI_SUITS) {
      for (const rank of _AI_RANKS) {
        const key = suit + ':' + rank;
        if (ctx.seenCards.has(key)) continue;
        if (ownKeys.has(key)) continue;
        unseen.push({ suit, rank, rankValue: _AI_RANK_VALUES[rank] });
      }
    }

    const opponents = [];
    for (const k of Object.keys(ctx.handCounts)) {
      const id = Number(k);
      if (id === ctx.player.id) continue;
      const need = ctx.handCounts[k];
      if (need > 0) opponents.push({ id, need });
    }

    const totalNeed = opponents.reduce((a, o) => a + o.need, 0);
    if (totalNeed !== unseen.length) {
      // Either something was missed in seenCards or hand counts are stale.
      // Fall back to best-effort: don't attempt sampling.
      if (totalNeed > unseen.length) return null;
    }

    for (let attempt = 0; attempt < 8; attempt++) {
      const pool = unseen.slice();
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      const hands = new Map();
      for (const o of opponents) hands.set(o.id, []);

      let ok = true;
      for (const card of pool) {
        const eligible = [];
        for (const o of opponents) {
          if (hands.get(o.id).length >= o.need) continue;
          const cuts = ctx.cutHistory && ctx.cutHistory[card.suit];
          if (cuts && cuts.has && cuts.has(o.id)) continue;
          eligible.push(o);
        }
        if (eligible.length === 0) { ok = false; break; }
        const pick = eligible[Math.floor(Math.random() * eligible.length)];
        hands.get(pick.id).push(card);
      }
      if (!ok) continue;

      let done = true;
      for (const o of opponents) {
        if (hands.get(o.id).length !== o.need) { done = false; break; }
      }
      if (done) return hands;
    }
    return null;
  },

  _cloneWorld(world) {
    const copy = new Map();
    for (const [id, cards] of world.entries()) copy.set(id, cards.slice());
    return copy;
  },

  // --- rollout ---
  //
  // Play myCard, then have the remaining trick participants play their
  // cards under a fast heuristic. Stop if anyone cuts. Score the outcome
  // of the trick from MY perspective.
  _rollout(ctx, worldHands, myCard) {
    const me = ctx.player.id;
    const plays = [];
    for (const p of ctx.trickSoFar) {
      plays.push({ id: p.player.id, card: p.card });
    }
    const leadSuit = ctx.leadSuit || myCard.suit;

    plays.push({ id: me, card: myCard });
    const iCut = plays.length > 1 && myCard.suit !== leadSuit;

    if (!iCut) {
      for (const opId of ctx.playersToPlay) {
        const opHand = worldHands.get(opId);
        if (!opHand || opHand.length === 0) continue;
        const sameSuit = opHand.filter(c => c.suit === leadSuit);
        const legal = sameSuit.length > 0 ? sameSuit : opHand;
        const chosen = this._opponentChoose(legal, leadSuit, plays);
        const idx = opHand.indexOf(chosen);
        if (idx !== -1) opHand.splice(idx, 1);
        plays.push({ id: opId, card: chosen });
        if (chosen.suit !== leadSuit) break;   // cut ends trick
      }
    }

    // Resolve trick outcome
    const leadPlays = plays.filter(p => p.card.suit === leadSuit);
    const allFollowed = plays.every(p => p.card.suit === leadSuit);
    let takerId = null;
    if (!allFollowed && leadPlays.length > 0) {
      // Opening-trick special case: A♠ holder (the lead) takes on any cut.
      // The lead always plays A♠ in opening, so highest-spade-of-plays is
      // the lead — our "highest lead-suit card" rule matches the result.
      const big = leadPlays.reduce((b, p) =>
        p.card.rankValue > b.card.rankValue ? p : b);
      takerId = big.id;
    }

    return this._score(ctx, plays, takerId, myCard, worldHands);
  },

  // Opponent model during rollouts. Must be fast and reasonable, not
  // optimal. Mirrors V2's core logic: follow losing-high, cut-dump by
  // short-suit and high-rank.
  _opponentChoose(legal, leadSuit, plays) {
    const sorted = legal.slice().sort((a, b) => a.rankValue - b.rankValue);
    const followable = sorted.filter(c => c.suit === leadSuit);
    if (followable.length > 0) {
      const leadPlays = plays.filter(p => p.card.suit === leadSuit);
      const maxPlayed = leadPlays.length
        ? Math.max(...leadPlays.map(p => p.card.rankValue))
        : 0;
      const losing = followable.filter(c => c.rankValue < maxPlayed);
      if (losing.length) return losing[losing.length - 1];
      return followable[0];
    }
    // Cut — dump a high card from a short suit.
    const bySuit = {};
    for (const c of sorted) {
      if (!bySuit[c.suit]) bySuit[c.suit] = [];
      bySuit[c.suit].push(c);
    }
    let best = sorted[sorted.length - 1];
    let bestScore = -Infinity;
    for (const suit of Object.keys(bySuit)) {
      const len = bySuit[suit].length;
      for (const c of bySuit[suit]) {
        const score = c.rankValue * 8 - (len - 1) * 9 + (len === 1 ? 55 : 0);
        if (score > bestScore) { bestScore = score; best = c; }
      }
    }
    return best;
  },

  // Score the rollout outcome from my perspective.
  //
  //   HAND-SIZE DELTA  : taking grows my hand; not taking shrinks it.
  //   GOT-OUT BONUS    : huge positive if I emptied my hand and didn't take.
  //   DUMP BONUS       : rewards shedding high cards when I don't take.
  //   OPP-OUT PENALTY  : mild cost if an opponent gets out (less field to
  //                      share the losing slot with).
  _score(ctx, plays, takerId, myCard, worldHands) {
    const me = ctx.player.id;
    let score = 0;

    // Hand-size delta for me
    const myHandNow = ctx.ownFullHand.length;
    const myHandAfter = (takerId === me)
      ? myHandNow - 1 + plays.length
      : myHandNow - 1;
    const myDelta = myHandAfter - myHandNow;
    score -= myDelta * 10;

    // Got-out bonus
    if (takerId !== me && myHandAfter === 0) {
      score += 500;
    }

    // Dump bonus: high cards are liabilities if kept.
    if (takerId !== me) {
      score += myCard.rankValue * 0.6;
    } else {
      // If I took using a high card, penalise slightly — wasted a big card.
      score -= myCard.rankValue * 0.2;
    }

    // Opponent-out penalty
    const playersInTrick = new Set(plays.map(p => p.id));
    const stillToPlay = new Set(ctx.playersToPlay);
    for (const idStr of Object.keys(ctx.handCounts)) {
      const id = Number(idStr);
      if (id === me) continue;
      if (!playersInTrick.has(id)) continue;   // didn't play in this trick
      // If they were a known-to-play participant, they spent 1 card in the
      // rollout; if they were already in trickSoFar, handCounts already
      // reflects their played card.
      const decrement = stillToPlay.has(id) ? 1 : 0;
      const base = ctx.handCounts[id] - decrement;
      const after = (id === takerId) ? base + plays.length : base;
      if (after === 0 && id !== takerId) score -= 20;
    }

    return score;
  },
};
