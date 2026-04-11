const Lobby = {
  socket: null,
  roomCode: null,
  mySeatIndex: null,
  myToken: null,

  _initialized: false,

  // ── Init ───────────────────────────────────────────────────────────────
  init() {
    if (!this._initialized) {
      document.getElementById('create-room-btn').addEventListener('click', () => this.onCreateRoom());
      document.getElementById('join-room-btn').addEventListener('click', () => this.onJoinRoom());
      document.getElementById('lobby-start-btn').addEventListener('click', () => this.onStartGame());
      document.getElementById('lobby-back-btn').addEventListener('click', () => UI._showScreen('mode-screen'));
      document.getElementById('join-code-input').addEventListener('input', e => {
        e.target.value = e.target.value.toUpperCase();
      });
      this._initialized = true;
    }

    // Check for saved session each time lobby is opened
    this._tryReconnect();
  },

  _connect() {
    if (this.socket && this.socket.connected) return;
    this.socket = io();
    this._registerSocketEvents();
  },

  _registerSocketEvents() {
    const s = this.socket;

    s.on('room-created', data => {
      this.roomCode = data.code;
      this.mySeatIndex = data.seatIndex;
      this.myToken = data.token;
      this._saveSession(data.code, data.seatIndex, data.token);
      this._renderWaitingRoom(data.roomState, true);
    });

    s.on('room-joined', data => {
      this.roomCode = data.code || this.roomCode;
      this.mySeatIndex = data.seatIndex;
      if (data.token) {
        this.myToken = data.token;
        this._saveSession(this.roomCode, data.seatIndex, data.token);
      }
      this._renderWaitingRoom(data.roomState, false);
    });

    s.on('room-error', data => {
      this._setLobbyError(data.message);
    });

    s.on('lobby-update', data => {
      this._renderWaitingRoom(data.roomState, false);
    });

    s.on('game-started', data => {
      UI.initOnline(this.socket, this.roomCode, this.mySeatIndex, data.gameState);
    });

    s.on('room-closed', data => {
      this._clearSession();
      alert(data.reason || 'The room was closed.');
      UI._showScreen('mode-screen');
    });

    s.on('connect_error', () => {
      this._setLobbyError('Could not connect to server. Please try again.');
    });
  },

  // ── Actions ────────────────────────────────────────────────────────────
  onCreateRoom() {
    const count = parseInt(document.querySelector('#create-player-count .count-btn.active')?.dataset.count || '4');
    const humanCount = parseInt(document.querySelector('#create-human-count .count-btn.active')?.dataset.count || '1');
    const name = document.getElementById('create-name-input').value.trim() || 'Player 1';
    if (humanCount > count) {
      this._setLobbyError('Human players cannot exceed total players.');
      return;
    }
    this._setLobbyError('');
    this._connect();
    this.socket.emit('create-room', { playerCount: count, humanCount, hostName: name });
  },

  onJoinRoom() {
    const code = document.getElementById('join-code-input').value.trim().toUpperCase();
    const name = document.getElementById('join-name-input').value.trim() || 'Player';
    if (code.length !== 4) { this._setLobbyError('Enter a 4-letter room code.'); return; }
    this._setLobbyError('');
    this.roomCode = code;
    this._connect();
    this.socket.emit('join-room', { code, playerName: name });
  },

  onStartGame() {
    if (!this.roomCode) return;
    this.socket.emit('start-game', { code: this.roomCode });
  },

  // ── Waiting room rendering ─────────────────────────────────────────────
  _renderWaitingRoom(roomState, isHost) {
    UI._showScreen('lobby-screen');
    document.getElementById('lobby-form').style.display = 'none';
    document.getElementById('waiting-room').style.display = 'block';

    document.getElementById('room-code-display').textContent = roomState.code;

    const list = document.getElementById('seat-list');
    list.innerHTML = '';
    roomState.seats.forEach(seat => {
      const li = document.createElement('li');
      li.className = 'seat-row' + (seat.index === this.mySeatIndex ? ' my-seat' : '');
      const status = seat.isAI ? '🤖 AI' : (seat.filled ? '👤 ' + seat.name : '⌛ Waiting…');
      const hostBadge = seat.isHost ? ' <span class="host-badge">HOST</span>' : '';
      li.innerHTML = `<span>${status}${hostBadge}</span>`;
      list.appendChild(li);
    });

    // Show start button only for host
    const startBtn = document.getElementById('lobby-start-btn');
    const isHostNow = roomState.seats[roomState.hostSeatIndex]?.index === this.mySeatIndex;
    startBtn.style.display = (isHost || isHostNow) ? 'block' : 'none';

    // Check if all seats filled
    const allFilled = roomState.seats.every(s => s.isAI || s.filled);
    startBtn.disabled = !allFilled;
    startBtn.textContent = allFilled ? 'Start Game' : `Waiting for players… (${roomState.seats.filter(s => s.isAI || s.filled).length}/${roomState.seats.length})`;
  },

  // ── Reconnect ──────────────────────────────────────────────────────────
  _tryReconnect() {
    const raw = localStorage.getItem('cardgame-session');
    if (!raw) return;
    try {
      const { code, seatIndex, token } = JSON.parse(raw);
      if (!code || !token) return;
      this.roomCode = code;
      this.mySeatIndex = seatIndex;
      this.myToken = token;
      this._connect();
      this.socket.emit('reconnect-room', { code, sessionToken: token });
    } catch (_) {
      this._clearSession();
    }
  },

  _saveSession(code, seatIndex, token) {
    localStorage.setItem('cardgame-session', JSON.stringify({ code, seatIndex, token }));
  },

  _clearSession() {
    localStorage.removeItem('cardgame-session');
  },

  // ── Helpers ────────────────────────────────────────────────────────────
  _setLobbyError(msg) {
    const el = document.getElementById('lobby-error');
    if (el) el.textContent = msg;
  },
};
