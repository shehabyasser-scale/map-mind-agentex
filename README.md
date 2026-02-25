# MapMind

Two AI agents — **Atlas** (methodical) and **Compass** (intuitive) — compete head-to-head to identify locations from photos. Click Start and watch them battle it out.

## How It Works

1. A photo of a real-world location is shown to both agents
2. Each agent streams its reasoning in real-time as it analyzes the image
3. Both agents make a guess (lat/lng coordinate)
4. Results show each guess on a map with distance from the actual location
5. After 5 rounds, the agent with the lowest total distance wins

## Quick Start

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000).

## Project Structure

```
├── server.js              # Express + WebSocket game server
├── data/
│   └── sample_rounds.json # 12 locations across 6 continents
├── public/
│   ├── index.html         # Single-page app (4 screens)
│   ├── css/game.css       # Dark theme with glassmorphism
│   ├── js/app.js          # Connection, map, and game logic
│   └── images/globe.svg   # Animated landing globe
├── Dockerfile             # Single-stage Node.js container
└── package.json
```

## Architecture

- **Server**: Node.js with Express (static files) + `ws` (WebSocket game coordination)
- **Client**: Vanilla JS, Leaflet.js for maps, no build step
- **Agents**: Currently mock — hardcoded reasoning text with randomized coordinate guesses. Designed to be replaced with real AgentEx agents.

## Game Flow

```
Landing → Countdown (3,2,1) → Photo + Dual AI Streaming → See Results → Map + Distance → Next Round → Final Scoreboard
```

### WebSocket Messages

| Client → Server     | Server → Client      |
|---------------------|----------------------|
| `start_game`        | `game_starting`      |
| `request_results`   | `countdown`          |
| `next_round`        | `round_start`        |
| `show_scoreboard`   | `ai_stream`          |
| `play_again`        | `analysis_complete`  |
|                     | `round_results`      |
|                     | `final_scoreboard`   |
|                     | `game_reset`         |

## Docker

```bash
docker build -t mapmind .
docker run -p 3000:3000 mapmind
```
