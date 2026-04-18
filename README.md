# Card Game

A browser-based trick-taking card game with local and online multiplayer. Built with vanilla JS on the client and Node.js + Socket.IO on the server — no build step, no bundler.

## Quick start

```bash
npm install
npm start
```

Then open http://localhost:3000.

For local-only play (single browser, no server needed), open `index.html` directly.

## How to play

- **Start:** The player holding the Ace of Spades leads first and must play it.
- **Opening trick:** Everyone must follow spades. If all follow, the cards are discarded; if anyone cuts (plays a non-spade), the trick ends immediately and the Ace of Spades holder takes every card played so far.
- **Normal tricks:** Follow the led suit if you can; otherwise cut. The moment anyone cuts, the trick ends — remaining players skip.
  - All followed → discard the played cards.
  - Someone cut → the highest card of the led suit wins and the winner takes all played cards into their hand.
- **Winning:** Taking cards is **bad**. Play your last card without winning a trick and you're out (a winner). The last player still holding cards loses.
- **Lead:** Whoever played the highest card of the led suit leads next — even when the trick was discarded.

## Modes

- **Local** — one browser, humans and AI share the screen.
- **Online** — create or join a room by code. The server runs one `Game` per room; browsers are thin views that emit moves and render state pushed back to them.

## Project layout

```
index.html          entry page
views/              additional routes (lobby, game-over, how-to-play)
css/                styles
js/
  card.js           Card, deck, shuffle
  player.js         Player + hand management
  ai.js             AI.chooseCard() strategy
  game.js           rule engine — game.playCard() is the single mutation gate
  lobby.js          room create/join, session persistence
  ui.js             DOM rendering + turn loop (local and online paths)
server/
  server.js         entry: loads game logic via vm.runInThisContext and wires modules
  broadcast.js      all outgoing socket traffic
  aiScheduler.js    self-recursive AI turn timer
  socketHandlers.js all io.on('connection') events
  roomManager.js    room state, hand-privacy enforcement
```

The four files in `js/` that encode game logic (`card.js`, `player.js`, `ai.js`, `game.js`) are loaded in both the browser and the server and are kept DOM-free.

## Requirements

Node.js 18+.