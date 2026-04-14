const UI = {
  game: null,
  humanPlayerIndex: -1,
  waitingForClick: false,

  // ── Online mode state ──────────────────────────────────
  mode: 'local',       // 'local' | 'online'
  socket: null,
  roomCode: null,
  onlineSeatIndex: -1,
  onlineState: null,   // latest gameState from server

  // ── INIT ───────────────────────────────────────────────
  init() {
    document.getElementById('cover-ready-btn').addEventListener('click', () => this._onCoverReady());

    // Check if we have local game config from the setup page
    const localConfig = sessionStorage.getItem('cardgame-local-config');
    if (localConfig) {
      sessionStorage.removeItem('cardgame-local-config');
      this._startLocalGame(JSON.parse(localConfig));
      return;
    }

    // Check if we were sent here from the lobby with a fresh game start
    const onlineStart = sessionStorage.getItem('cardgame-online-start');
    if (onlineStart) {
      sessionStorage.removeItem('cardgame-online-start');
      try {
        const { roomCode, seatIndex, gameState } = JSON.parse(onlineStart);
        this.mode = 'online';
        this.roomCode = roomCode;
        this.onlineSeatIndex = seatIndex;
        const socket = io();
        this._registerOnlineEvents(socket);
        // Reconnect the socket to the room using the saved session token
        const session = localStorage.getItem('cardgame-session');
        if (session) {
          const { token } = JSON.parse(session);
          socket.emit('reconnect-room', { code: roomCode, sessionToken: token });
        }
        this._showScreen('game-screen');
        this.applyServerState(gameState);
        return;
      } catch (_) {}
    }

    // Check if we have an online session to reconnect to (e.g. page refresh)
    const session = localStorage.getItem('cardgame-session');
    if (session) {
      try {
        const { code, seatIndex, token } = JSON.parse(session);
        if (code && token) {
          this.mode = 'online';
          this.roomCode = code;
          this.onlineSeatIndex = seatIndex;
          const socket = io();
          this._registerOnlineEvents(socket);
          socket.emit('reconnect-room', { code, sessionToken: token });
          this._showScreen('game-screen');
          this._setStatus('Reconnecting…');
          return;
        }
      } catch (_) {}
    }

    // No config found — redirect back to home
    window.location.href = '/';
  },

  // ── LOCAL GAME ─────────────────────────────────────────
  _startLocalGame(configs) {
    this.mode = 'local';
    const humanIndices = configs.map((c, i) => c.isAI ? -1 : i).filter(i => i >= 0);
    this.humanPlayerIndex = humanIndices.length === 1 ? humanIndices[0] : -1;
    this.game = new Game(configs);
    this.game.deal();
    this._showScreen('game-screen');
    this.renderAll();
    this.beginTurn();
  },

  beginTurn() {
    if (this.mode === 'online') return; // server drives turns in online mode

    const game = this.game;
    if (game.phase === 'finished') { this.showEndScreen(); return; }
    const player = game.players[game.activePlayerIndex];
    this.renderAll();

    if (player.isAI) {
      this._setStatus(`${player.name} is thinking…`);
      setTimeout(() => {
        const trickSoFar = game.currentTrick.plays;
        const leadSuit = game.currentTrick.leadSuit;
        const isLeading = trickSoFar.length === 0;
        const validCards = game.getValidCards(player);
        const activeCount = game.players.filter(p => !p.isOut).length;
        const chosen = AI.chooseCard(
          { hand: validCards, hasSuit: (s) => validCards.some(c => c.suit === s), id: player.id },
          trickSoFar, leadSuit, isLeading, activeCount
        );
        const result = game.playCard(player, chosen);
        this.renderAll();
        this._handleResult(result);
      }, 400 + Math.random() * 400);
    } else {
      const needsCover = this.humanPlayerIndex === -1;
      if (needsCover) {
        this._showCoverScreen(player, () => {
          this.waitingForClick = true;
          this.renderAll();
          this._setStatus(`${player.name} — tap a glowing card to play.`);
        });
      } else {
        this.waitingForClick = true;
        this._renderHand();
        this._setStatus(`Your turn, ${player.name} — tap a glowing card to play.`);
      }
    }
  },

  _onCardClick(player, card) {
    if (!this.waitingForClick) return;
    this.waitingForClick = false;

    if (this.mode === 'online') {
      this.socket.emit('play-card', { code: this.roomCode, suit: card.suit, rank: card.rank });
      return;
    }

    const result = this.game.playCard(player, card);
    this.renderAll();
    this._handleResult(result);
  },

  _handleResult(result) {
    if (result === null) { this.beginTurn(); return; }

    // Show the completed trick (all N cards) on the table during the pause,
    // since _resolveTrick() has already cleared currentTrick for the next one.
    this._renderCompletedTrick();

    let msg = '';
    if (result.type === 'discard') {
      msg = 'All players followed suit — cards discarded! Same player leads again.';
    } else if (result.type === 'take') {
      msg = `Not everyone had spades — ${result.winner.name} takes all ${result.cardsGiven.length} cards!`;
    } else {
      msg = `${result.winner.name} wins the trick and takes ${result.cardsGiven.length} cards!`;
    }
    if (result.eliminated.length > 0) {
      msg += ' ' + result.eliminated.map(p => `${p.name} is out!`).join(' ');
    }
    this._setStatus(msg);

    if (result.gameOver) {
      setTimeout(() => this.showEndScreen(), 2000);
    } else {
      setTimeout(() => this.beginTurn(), 1400);
    }
  },

  // ── ONLINE MODE ────────────────────────────────────────
  initOnline(socket, roomCode, mySeatIndex, gameState) {
    this.mode = 'online';
    this.socket = socket;
    this.roomCode = roomCode;
    this.onlineSeatIndex = mySeatIndex;

    // Save session info so game page can reconnect
    sessionStorage.setItem('cardgame-online', JSON.stringify({
      roomCode, seatIndex: mySeatIndex
    }));

    this._registerOnlineEvents(socket);

    this._showScreen('game-screen');
    this.applyServerState(gameState);
  },

  _registerOnlineEvents(socket) {
    this.socket = socket;

    socket.on('game-state', data => {
      this.onlineState = data.gameState;
      this.applyServerState(data.gameState);
    });

    socket.on('trick-result', data => {
      // Show the fully-resolved trick (all N cards) on the table during the
      // pause. Server already started the next trick, so data.gameState
      // .currentTrick.plays is empty — use trickHistory[0] instead.
      this._renderOnlineCompletedTrick(data.gameState);
      this._showTrickResultMsg(data.result);
      setTimeout(() => {
        this.onlineState = data.gameState;
        this.applyServerState(data.gameState);
      }, 1400);
    });

    socket.on('game-over', data => {
      setTimeout(() => this.showEndScreen(data.winners, data.loser), 2000);
    });

    socket.on('move-rejected', data => {
      this._setStatus(`Move rejected: ${data.reason}`);
      this.waitingForClick = true;
      this._renderOnlineHand(this.onlineState);
    });

    socket.on('player-disconnected', data => {
      const msg = data.convertedToAI
        ? `${data.playerName} timed out and was replaced by AI.`
        : `${data.playerName} disconnected. Waiting 60s…`;
      this._setStatus(msg);
    });

    socket.on('player-reconnected', data => {
      this._setStatus(`${data.playerName} reconnected!`);
    });

    socket.on('room-closed', data => {
      alert(data.reason || 'The room was closed.');
      window.location.href = '/';
    });

    socket.on('room-error', data => {
      alert(data.message || 'Room error.');
      window.location.href = '/';
    });

    socket.on('room-joined', data => {
      window.location.href = '/room/' + (data.code || this.roomCode);
    });

    socket.on('game-started', data => {
      this._showScreen('game-screen');
      this.applyServerState(data.gameState);
    });
  },

  applyServerState(gs) {
    this.onlineState = gs;

    const me = gs.players[gs.mySeatIndex];
    const isMyTurn = gs.activePlayerIndex === gs.mySeatIndex;
    this.waitingForClick = !!(me && !me.isOut && isMyTurn);

    this._renderOnlineTrick(gs);
    this._renderOnlineScoreboard(gs);
    this._renderOnlineHistory(gs);
    this._renderOnlineHand(gs);

    if (!me) return;
    if (me.isOut) {
      this._setStatus('You are out — watch the others finish!');
    } else if (isMyTurn) {
      this._setStatus('Your turn — tap a glowing card to play.');
    } else {
      const active = gs.players[gs.activePlayerIndex];
      this._setStatus(active ? `${active.name} is playing…` : 'Waiting…');
    }
  },

  _renderOnlineCompletedTrick(gs) {
    if (!gs.trickHistory || gs.trickHistory.length === 0) return;
    const area = document.getElementById('trick-area');
    area.innerHTML = '';
    for (const p of gs.trickHistory[0].plays) {
      const wrap = document.createElement('div');
      wrap.className = 'trick-play';
      wrap.appendChild(this._cardEl(p.card, false));
      const lbl = document.createElement('div');
      lbl.className = 'player-label';
      lbl.textContent = p.playerName;
      wrap.appendChild(lbl);
      area.appendChild(wrap);
    }
  },

  _renderOnlineTrick(gs) {
    const area = document.getElementById('trick-area');
    area.innerHTML = '';
    if (!gs.currentTrick) return;
    for (const p of gs.currentTrick.plays) {
      const wrap = document.createElement('div');
      wrap.className = 'trick-play';
      wrap.appendChild(this._cardEl(p.card, false));
      const lbl = document.createElement('div');
      lbl.className = 'player-label';
      lbl.textContent = p.playerName;
      wrap.appendChild(lbl);
      area.appendChild(wrap);
    }
  },

  _renderOnlineScoreboard(gs) {
    const board = document.getElementById('scoreboard');
    board.innerHTML = '<h3>Players</h3>';
    gs.players.forEach(p => {
      const row = document.createElement('div');
      row.className = 'score-row' +
        (p.isOut ? ' out' : '') +
        (p.id === gs.activePlayerIndex && !p.isOut ? ' active-turn' : '');
      const nameEl = document.createElement('span');
      nameEl.className = 'sname';
      nameEl.textContent = (p.isAI ? '🤖 ' : '👤 ') + p.name + (p.isYou ? ' (you)' : '');
      row.appendChild(nameEl);
      if (p.isOut) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'OUT';
        row.appendChild(badge);
      } else {
        const cnt = document.createElement('span');
        cnt.className = 'scount';
        cnt.textContent = p.handCount + ' cards';
        row.appendChild(cnt);
      }
      board.appendChild(row);
    });
  },

  _renderOnlineHand(gs) {
    const area = document.getElementById('hand-area');
    const container = document.getElementById('cards-container');
    container.innerHTML = '';

    const me = gs.players[gs.mySeatIndex];
    if (!me || me.isOut || !me.hand) {
      area.querySelector('h3').textContent = me?.isOut ? 'You are out!' : 'Your hand';
      return;
    }

    area.querySelector('h3').textContent = `Your hand — ${me.hand.length} cards`;
    const isMyTurn = gs.activePlayerIndex === gs.mySeatIndex && this.waitingForClick;

    const sortedHand = [...me.hand].sort((a, b) => {
      if (a.suit !== b.suit) return SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
      return RANK_VALUES[a.rank] - RANK_VALUES[b.rank];
    });

    for (const card of sortedHand) {
      const isValid = isMyTurn && gs.validCards.some(c => c.suit === card.suit && c.rank === card.rank);
      const el = this._cardEl(card, isValid);
      if (!isMyTurn) el.classList.add('dimmed');
      if (isValid) {
        el.addEventListener('click', () => this._onCardClick(me, card));
      }
      container.appendChild(el);
    }
  },

  _renderOnlineHistory(gs) {
    const list = document.getElementById('history-list');
    list.innerHTML = '';
    if (!gs.trickHistory || gs.trickHistory.length === 0) return;

    const entry = gs.trickHistory[gs.trickHistory.length - 1];
    const row = document.createElement('div');
    row.className = 'history-row';

    const num = document.createElement('span');
    num.className = 'trick-num';
    num.textContent = `#${entry.number}`;
    row.appendChild(num);

    const plays = document.createElement('div');
    plays.className = 'history-plays';
    for (const p of entry.plays) {
      const wrap = document.createElement('div');
      wrap.className = 'history-play';
      const cardEl = document.createElement('span');
      cardEl.className = `h-card suit-${p.card.suit}`;
      const sym = { clubs:'♣', diamonds:'♦', hearts:'♥', spades:'♠' }[p.card.suit];
      cardEl.textContent = p.card.rank + sym;
      wrap.appendChild(cardEl);
      const name = document.createElement('span');
      name.className = 'h-name';
      name.textContent = p.playerName;
      wrap.appendChild(name);
      plays.appendChild(wrap);
    }
    row.appendChild(plays);

    const outcome = document.createElement('span');
    outcome.className = 'history-outcome';
    if (entry.type === 'discard') {
      outcome.classList.add('discarded');
      outcome.textContent = 'Discarded';
    } else {
      outcome.classList.add('taken');
      outcome.textContent = `→ ${entry.winnerName}`;
    }
    row.appendChild(outcome);
    list.appendChild(row);
  },

  _showTrickResultMsg(result) {
    let msg = '';
    if (result.type === 'discard') {
      msg = 'All players followed suit — cards discarded!';
    } else if (result.type === 'take') {
      msg = `Not everyone had spades — ${result.winnerName} takes all ${result.cardCount} cards!`;
    } else {
      msg = `${result.winnerName} wins the trick and takes ${result.cardCount} cards!`;
    }
    if (result.eliminatedNames?.length > 0) {
      msg += ' ' + result.eliminatedNames.map(n => `${n} is out!`).join(' ');
    }
    this._setStatus(msg);
    this.waitingForClick = false;
  },

  // ── LOCAL RENDERING ────────────────────────────────────
  renderAll() {
    this._renderTrick();
    this._renderScoreboard();
    this._renderHand();
    this._renderHistory();
  },

  _renderCompletedTrick() {
    const history = this.game?.trickHistory;
    if (!history || history.length === 0) return;
    const area = document.getElementById('trick-area');
    area.innerHTML = '';
    for (const { player, card } of history[history.length - 1].plays) {
      const wrap = document.createElement('div');
      wrap.className = 'trick-play';
      wrap.appendChild(this._cardEl(card, false));
      const lbl = document.createElement('div');
      lbl.className = 'player-label';
      lbl.textContent = player.name;
      wrap.appendChild(lbl);
      area.appendChild(wrap);
    }
  },

  _renderTrick() {
    const area = document.getElementById('trick-area');
    area.innerHTML = '';
    if (!this.game?.currentTrick) return;
    for (const { player, card } of this.game.currentTrick.plays) {
      const wrap = document.createElement('div');
      wrap.className = 'trick-play';
      wrap.appendChild(this._cardEl(card, false));
      const lbl = document.createElement('div');
      lbl.className = 'player-label';
      lbl.textContent = player.name;
      wrap.appendChild(lbl);
      area.appendChild(wrap);
    }
  },

  _renderScoreboard() {
    const board = document.getElementById('scoreboard');
    board.innerHTML = '<h3>Players</h3>';
    const activeId = this.game.players[this.game.activePlayerIndex]?.id;
    for (const p of this.game.players) {
      const row = document.createElement('div');
      row.className = 'score-row' +
        (p.isOut ? ' out' : '') +
        (p.id === activeId && !p.isOut ? ' active-turn' : '');
      const nameEl = document.createElement('span');
      nameEl.className = 'sname';
      nameEl.textContent = (p.isAI ? '🤖 ' : '👤 ') + p.name;
      row.appendChild(nameEl);
      if (p.isOut) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'OUT';
        row.appendChild(badge);
      } else {
        const cnt = document.createElement('span');
        cnt.className = 'scount';
        cnt.textContent = p.hand.length + ' cards';
        row.appendChild(cnt);
      }
      board.appendChild(row);
    }
  },

  _renderHand() {
    const area = document.getElementById('hand-area');
    const container = document.getElementById('cards-container');
    container.innerHTML = '';
    const game = this.game;
    const activePlayer = game.players[game.activePlayerIndex];
    let displayPlayer = null;

    if (this.humanPlayerIndex >= 0) {
      displayPlayer = game.players[this.humanPlayerIndex];
      area.querySelector('h3').textContent = `Your hand (${displayPlayer.name}) — ${displayPlayer.hand.length} cards`;
    } else {
      if (activePlayer && !activePlayer.isAI) {
        displayPlayer = activePlayer;
        area.querySelector('h3').textContent = `${displayPlayer.name}'s hand — ${displayPlayer.hand.length} cards`;
      } else {
        area.querySelector('h3').textContent = 'AI playing…';
      }
    }

    if (!displayPlayer || displayPlayer.isOut) return;

    const validCards = game.getValidCards(displayPlayer);
    const isTheirTurn = activePlayer && activePlayer.id === displayPlayer.id && !activePlayer.isAI && this.waitingForClick;
    const sortedHand = [...displayPlayer.hand].sort((a, b) => {
      if (a.suit !== b.suit) return SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
      return a.rankValue - b.rankValue;
    });

    for (const card of sortedHand) {
      const isValid = isTheirTurn && validCards.some(c => c.suit === card.suit && c.rank === card.rank);
      const el = this._cardEl(card, isValid);
      if (!isTheirTurn) el.classList.add('dimmed');
      if (isValid) el.addEventListener('click', () => this._onCardClick(displayPlayer, card));
      container.appendChild(el);
    }
  },

  _highlightValidCards() { this._renderHand(); },

  _renderHistory() {
    const list = document.getElementById('history-list');
    list.innerHTML = '';
    if (!this.game) return;
    const history = this.game.trickHistory;
    if (history.length === 0) return;

    const entry = history[history.length - 1];
    const row = document.createElement('div');
    row.className = 'history-row';

    const num = document.createElement('span');
    num.className = 'trick-num';
    num.textContent = `#${entry.number}`;
    row.appendChild(num);

    const plays = document.createElement('div');
    plays.className = 'history-plays';
    for (const { player, card } of entry.plays) {
      const wrap = document.createElement('div');
      wrap.className = 'history-play';
      const cardEl = document.createElement('span');
      cardEl.className = `h-card suit-${card.suit}`;
      cardEl.textContent = card.displayName;
      wrap.appendChild(cardEl);
      const name = document.createElement('span');
      name.className = 'h-name';
      name.textContent = player.name;
      wrap.appendChild(name);
      plays.appendChild(wrap);
    }
    row.appendChild(plays);

    const outcome = document.createElement('span');
    outcome.className = 'history-outcome';
    if (entry.type === 'discard') {
      outcome.classList.add('discarded');
      outcome.textContent = 'Discarded';
    } else {
      outcome.classList.add('taken');
      outcome.textContent = `→ ${entry.winner.name}`;
    }
    row.appendChild(outcome);
    list.appendChild(row);
  },

  _cardEl(card, valid = false) {
    const suit = card.suit;
    const rank = card.rank;
    const sym = card.suitSymbol || { clubs:'♣', diamonds:'♦', hearts:'♥', spades:'♠' }[suit];
    const el = document.createElement('div');
    el.className = `card suit-${suit}` + (valid ? ' valid-play' : '');
    el.innerHTML = `
      <div class="top"><span>${rank}</span><span>${sym}</span></div>
      <div class="center">${sym}</div>
      <div class="bottom"><span>${rank}</span><span>${sym}</span></div>
    `;
    return el;
  },

  _setStatus(msg) {
    document.querySelector('#status-bar .status-text').textContent = msg;
  },

  // ── COVER SCREEN ──────────────────────────────────────
  _pendingCoverCallback: null,

  _showCoverScreen(player, callback) {
    this._pendingCoverCallback = callback;
    document.getElementById('cover-screen').querySelector('h2').textContent = `Pass the device to ${player.name}`;
    document.getElementById('cover-screen').querySelector('p').textContent = `Tap the button when you're ready to see your cards.`;
    this._showScreen('cover-screen');
  },

  _onCoverReady() {
    this._showScreen('game-screen');
    if (this._pendingCoverCallback) {
      this._pendingCoverCallback();
      this._pendingCoverCallback = null;
    }
  },

  // ── END SCREEN ────────────────────────────────────────
  showEndScreen(winners, loser) {
    const w = winners || (this.game ? this.game.winners.map((p, i) => ({ name: p.name, finishPosition: i + 1 })) : []);
    const l = loser || (this.game?.loser ? { name: this.game.loser.name, handCount: this.game.loser.hand.length } : null);

    sessionStorage.setItem('cardgame-end', JSON.stringify({
      winners: w,
      loser: l,
      mode: this.mode,
      roomCode: this.roomCode,
    }));

    if (this.socket) this.socket.disconnect();
    window.location.href = '/game-over';
  },

  // ── HELPERS ───────────────────────────────────────────
  _showScreen(id) {
    ['cover-screen', 'game-screen'].forEach(s => {
      const el = document.getElementById(s);
      if (el) el.classList.toggle('active', s === id);
    });
  },
};

document.addEventListener('DOMContentLoaded', () => UI.init());
