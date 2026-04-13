const Lobby = {
  socket: null,
  roomCode: null,
  mySeatIndex: null,
  myToken: null,

  _initialized: false,
  _isRoomPage: false,

  // ── Init ───────────────────────────────────────────────────────────────
  init() {
    this._isRoomPage = !!document.getElementById('waiting-room') && !document.getElementById('lobby-form');

    if (!this._initialized) {
      const createBtn = document.getElementById('create-room-btn');
      const joinBtn = document.getElementById('join-room-btn');
      const joinCodeInput = document.getElementById('join-code-input');
      const startBtn = document.getElementById('lobby-start-btn');

      if (createBtn) createBtn.addEventListener('click', () => this.onCreateRoom());
      if (joinBtn) joinBtn.addEventListener('click', () => this.onJoinRoom());
      if (joinCodeInput) joinCodeInput.addEventListener('input', e => {
        e.target.value = e.target.value.toUpperCase();
      });
      if (startBtn) startBtn.addEventListener('click', () => this.onStartGame());
      this._initialized = true;
    }

    if (this._isRoomPage) {
      // On /room/:code page — get room code from URL and reconnect
      const match = window.location.pathname.match(/^\/room\/([A-Z]{4})$/i);
      if (match) {
        this.roomCode = match[1].toUpperCase();
        document.getElementById('room-code-display').textContent = this.roomCode;
        this._tryReconnect();
      } else {
        window.location.href = '/lobby';
      }
    }
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
      // Navigate to room page
      window.location.href = '/room/' + data.code;
    });

    s.on('room-joined', data => {
      this.roomCode = data.code || this.roomCode;
      this.mySeatIndex = data.seatIndex;
      if (data.token) {
        this.myToken = data.token;
        this._saveSession(this.roomCode, data.seatIndex, data.token);
      }
      if (this._isRoomPage) {
        this._renderWaitingRoom(data.roomState, false);
      } else {
        // Navigate to room page
        window.location.href = '/room/' + this.roomCode;
      }
    });

    s.on('room-error', data => {
      this._setLobbyError(data.message);
    });

    s.on('lobby-update', data => {
      if (this._isRoomPage) {
        this._renderWaitingRoom(data.roomState, false);
      }
    });

    s.on('game-started', data => {
      sessionStorage.setItem('cardgame-online-start', JSON.stringify({
        roomCode: this.roomCode,
        seatIndex: this.mySeatIndex,
        gameState: data.gameState
      }));
      window.location.href = '/game';
    });

    s.on('room-closed', data => {
      this._clearSession();
      alert(data.reason || 'The room was closed.');
      window.location.href = '/lobby';
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
    document.getElementById('room-code-display').textContent = roomState.code;
    document.title = 'Card Game — Room ' + roomState.code;

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

    const startBtn = document.getElementById('lobby-start-btn');
    const isHostNow = roomState.seats[roomState.hostSeatIndex]?.index === this.mySeatIndex;
    startBtn.style.display = (isHost || isHostNow) ? 'block' : 'none';

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

// Auto-init on lobby or room pages
document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('lobby-screen')) {
    Lobby.init();
  }
});
