(function () {
  const raw = sessionStorage.getItem('cardgame-end');
  const data = raw ? JSON.parse(raw) : { winners: [], loser: null, mode: 'local' };
  sessionStorage.removeItem('cardgame-end');

  const winnerList = document.getElementById('winner-list');
  if (!data.winners || data.winners.length === 0) {
    winnerList.innerHTML = '<li>No winners this round.</li>';
  } else {
    data.winners.forEach(p => {
      const li = document.createElement('li');
      li.textContent = `#${p.finishPosition} ${p.name}`;
      winnerList.appendChild(li);
    });
  }

  const loserEl = document.getElementById('loser-name');
  loserEl.textContent = data.loser ? `${data.loser.name} (${data.loser.handCount} cards left)` : '—';

  document.getElementById('play-again-btn').addEventListener('click', () => {
    if (data.mode === 'online' && data.roomCode) {
      const socket = io();
      const session = localStorage.getItem('cardgame-session');
      const token = session ? JSON.parse(session).token : null;
      socket.on('room-joined', d => {
        window.location.href = '/room/' + (d.code || data.roomCode);
      });
      socket.emit('reconnect-room', { code: data.roomCode, sessionToken: token });
      socket.emit('play-again', { code: data.roomCode });
    } else {
      window.location.href = '/setup';
    }
  });
})();
