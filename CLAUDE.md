# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install       # install dependencies (first time)
npm start         # run the server at http://localhost:3000
```

No build step, no bundler, no tests. Open `index.html` directly in a browser for local-only play (no socket.io features). Run the server for online multiplayer.

## Architecture

### Two play modes
- **Local** — `index.html` opened directly, or served by Express. `Game` runs in the browser. `UI.mode = 'local'`.
- **Online** — Node.js server holds one `Game` instance per room. Each browser is a thin view that emits moves and receives state. `UI.mode = 'online'`.

### Game logic files (`js/`)
These four files are **loaded in both environments** — in the browser via `<script>` tags, and on the server via `vm.runInThisContext()` (so they must have zero DOM/`window` references):

| File | Purpose |
|------|---------|
| `js/card.js` | `Card` class, `Card.buildDeck()`, `Card.shuffle()` |
| `js/player.js` | `Player` class — hand management (`addCards`, `removeCard`, `hasSuit`) |
| `js/ai.js` | `AI.chooseCard()` — strategy: burn cards when leading, avoid winning when following |
| `js/game.js` | `Game` class — the entire rule engine. `game.playCard(player, card)` is the single mutation gate; returns `TrickResult` or `null` |

### Game rules (encoded in `js/game.js`)
- **Start:** Player with Ace of Spades leads first and must play it.
- **Opening trick:** All must follow spades. If all followed → discard; if anyone cut → Ace of Spades holder takes all cards.
- **Normal tricks:** Follow led suit if possible; otherwise cut (play anything). As soon as any player cuts, the trick ends immediately — remaining players skip. If all followed → discard all; if someone cut → highest led-suit card wins and takes all played cards into hand.
- **Winning:** Taking cards is BAD. Players who play their last card without winning a trick are OUT (winners). Last player holding cards loses.
- **After each trick:** Player who played the highest card of the led suit leads next (even in the discard case).

### Server files (`server/`)
The server is split into a thin entry point + three factory modules. Each factory takes its dependencies as arguments — there is no shared mutable module state, so the wiring is all in `server.js`.

- **`server/server.js`** — Entry point. Loads `card.js`, `player.js`, `ai.js`, `game.js` via `vm.runInThisContext`, which exposes the top-level `class` declarations (`Card`, `Player`, `AI`, `Game`) to this module's scope. Builds `broadcast` + `aiScheduler` and hands them to `socketHandlers`.
- **`server/broadcast.js`** — `createBroadcast(io, rm)` → `{ broadcastGameState, broadcastTrickResult, broadcastToRoom }`. All outgoing socket traffic flows through here.
- **`server/aiScheduler.js`** — `createAiScheduler({ AI, broadcast })` → `{ scheduleAiTurn, clearAiTimers }`. `scheduleAiTurn(room)` is self-recursive: call it once and it keeps playing AI turns (via a 500–900ms timer) until the active player is human or the game ends. Every timer re-validates that `activePlayerIndex` hasn't changed since it was queued, which prevents double-plays if a human move and an AI timer race.
- **`server/socketHandlers.js`** — `registerSocketHandlers({ io, rm, Game, broadcast, aiScheduler })`. Registers every `io.on('connection')` event in one place.
- **`server/roomManager.js`** — Room state (`Map<code, room>`). `createRoom(socketId, playerCount, humanCount, hostName)` seats the host at 0, reserves seats `1..humanCount-1` as empty human slots for guests, and fills the rest with AI. `buildGameStateFor(room, socketId)` enforces hand privacy — only the target player's own `hand` array is included; everyone else gets `handCount` only.

### Client files (`js/`)
- **`js/lobby.js`** — Create/join room UI, socket connection, session token persistence in `localStorage`.
- **`js/ui.js`** — All DOM rendering and turn loop. Two rendering paths: local (`renderAll()` / `_renderHand()` etc.) and online (`applyServerState(gs)` / `_renderOnlineHand(gs)` etc.).

### Socket event flow (online mode)
```
Client clicks card
  → socket.emit('play-card', { code, suit, rank })
  → server: game.playCard() → null or TrickResult
      → null:  broadcastGameState()   → clients: 'game-state'  → applyServerState()
      → result: broadcastTrickResult() → clients: 'trick-result' → _showTrickResultMsg()
                                                                    + applyServerState() after 1400ms
```

### Key invariants
- `game.playCard()` is the only place game state mutates. Never call it twice for the same move.
- `buildGameStateFor()` must never include another player's `hand` array — only `handCount`.
- `broadcastGameState()` is only called mid-trick (when `result === null`). Trick-resolution always goes through `broadcastTrickResult()` which embeds the gameState.
- `AI.chooseCard()` receives `{ hand: validCards, hasSuit, id }` — a fake player object of only the legal cards, not the full hand.
- After any human `play-card` (whether it resolves a trick or not), call `scheduleAiTurn(room)` so the next AI can play. The scheduler no-ops if the active player is human.
- The game logic files in `js/` are loaded into the server via `vm.runInThisContext`, so they must stay DOM-free (no `window`, no `document`). They declare `class` at the top level — this works on the server because `vm.runInThisContext` exposes top-level class bindings to the calling module's scope.
