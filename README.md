# MapMind

Two AI agents — **Atlas** (methodical) and **Nova** (intuitive) — compete head-to-head to identify locations from photos. Click Start and watch them battle it out.

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

Open [http://localhost:4567](http://localhost:4567).

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

MapMind is a spectator game — the user doesn't play, they watch two AI agents compete.

- **Atlas** routes through AgentEx (Temporal workflow) with traces pushed to SGP
- **Nova** calls OpenAI GPT-4o directly (no traces)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          BROWSER (MapMind UI)                          │
│                         http://localhost:4567                           │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ WebSocket (bidirectional)
                               │
┌──────────────────────────────▼──────────────────────────────────────────┐
│                     GAME SERVER (Node.js, port 4567)                   │
│                                                                         │
│  Each round:                                                            │
│  1. Picks random location image from data/sample_rounds.json            │
│  2. Sends image to both agents in parallel                              │
│  3. Streams agent reasoning to browser via WebSocket                    │
│  4. Collects coordinate guesses, scores them by distance                │
│                                                                         │
│  ┌─────────────────────┐              ┌─────────────────────┐          │
│  │    ATLAS (AgentEx)   │              │   NOVA (Direct)     │          │
│  │                      │              │                      │          │
│  │ JSON-RPC → AgentEx   │              │ openai.chat.         │          │
│  │ SSE ← stream back    │              │ completions.create() │          │
│  │ Traces in SGP        │              │ No traces            │          │
│  └──────────┬───────────┘              └──────────┬───────────┘          │
└─────────────┼──────────────────────────────────────┼────────────────────┘
              │                                      │
              │ HTTP (JSON-RPC 2.0)                  │ HTTPS
              │                                      │
              ▼                                      ▼
┌─────────────────────────────┐          ┌────────────────────┐
│   AGENTEX BACKEND (k8s)     │          │   OpenAI API       │
│   tunneled to :5003         │          │   api.openai.com   │
│                              │          │                    │
│  POST /agents/name/         │          │  GPT-4o            │
│    {name}/rpc               │          │  (vision+text)     │
│                              │          └────────────────────┘
│  Methods:                    │
│  • task/create → Temporal    │
│  • event/send  → Signal     │
│                              │
│  GET /tasks/{id}/stream      │
│  → SSE event stream          │
│    • "delta" (token chunks)  │
│    • "full"  (complete msg)  │
│    • "done"  (end of msg)    │
└──────────────┬───────────────┘
               │ Temporal (gRPC)
               │
┌──────────────▼───────────────┐
│     TEMPORAL SERVER (k8s)     │
│                               │
│  Workflow queue:              │
│  agent_shehab_3_queue         │
│                               │
│  Workflow: agent-shehab-3     │
└──────────────┬────────────────┘
               │ Poll for tasks
               │
┌──────────────▼────────────────────────────────────────────────────────┐
│              YOUR WORKER (local Python process)                       │
│              project/run_worker.py                                     │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  AgentShehab3Workflow (project/workflow.py)                      │  │
│  │                                                                  │  │
│  │  on_task_create()                                                │  │
│  │    → sends welcome message                                      │  │
│  │    → waits for events                                           │  │
│  │                                                                  │  │
│  │  on_task_event_send(content)                                    │  │
│  │    │                                                             │  │
│  │    ├─ Image URL? ──► execute_activity(analyze_image_location)   │  │
│  │    │                    │                                        │  │
│  │    │                    ▼                                        │  │
│  │    │              ┌─────────────────────────┐                   │  │
│  │    │              │ activities.py            │                   │  │
│  │    │              │ GPT-4o Chat Completions  │──► OpenAI API    │  │
│  │    │              │ (vision: image_url)      │                   │  │
│  │    │              │ Returns: analysis text   │                   │  │
│  │    │              │ + {"lat":..,"lng":..}    │                   │  │
│  │    │              └─────────────────────────┘                   │  │
│  │    │                                                             │  │
│  │    └─ Text? ──► OpenAI Agents SDK (Runner.run)                  │  │
│  │                   model: gpt-4o                                  │  │
│  │                   streaming via TemporalStreamingHooks           │  │
│  │                                                                  │  │
│  │  Wraps each turn in adk.tracing.span() ──────► SGP Dashboard   │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────┘
```

### Communication Protocols

| Leg | Protocol | Direction |
|-----|----------|-----------|
| Browser <-> Game Server | WebSocket | Bidirectional |
| Game Server -> AgentEx | HTTP POST (JSON-RPC 2.0) | Request/Response |
| Game Server <- AgentEx | SSE (GET, long-lived) | Server -> Client stream |
| AgentEx <-> Temporal | gRPC | Bidirectional |
| Worker -> OpenAI | HTTPS | Request/Response |
| Worker -> SGP | HTTPS | Push traces |

### SSE Event Types

Server-Sent Events (SSE) flow from AgentEx (`GET /tasks/{id}/stream`) to the game server:

```
connected    → SSE connection established
delta        → Token-by-token text from the agent  {"delta": {"text_delta": "..."}}
full         → Complete message (fallback)          {"content": {"author": "agent", ...}}
done         → End of a message
```

### Game Flow

```
Landing → Countdown (3, 2, 1) → Photo + Dual AI Streaming → See Results → Map + Distance → Next Round → Final Scoreboard
```

The client has 4 screens, one visible at a time:

1. **Landing** — Agent matchup preview (Atlas vs Nova), Start button
2. **Analysis** — Photo at top, two side-by-side panels streaming agent reasoning
3. **Results** — Leaflet map with pins + distance lines, sidebar ranking
4. **Scoreboard** — Podium with total distance and rounds won

### WebSocket Protocol

All messages are JSON over WebSocket. The server drives the game state machine.

| Client -> Server | Server -> Client | Description |
|----------------|-----------------|-------------|
| `start_game` | | Viewer clicks Start |
| | `game_starting` | Acknowledged |
| | `countdown` `{count: 3}` | Countdown ticks (3, 2, 1) |
| | `round_start` `{round, photo, locationName}` | New round begins |
| | `ai_stream` `{agent, text, done, guess?, confidence?}` | Reasoning chunk from an agent |
| | `analysis_complete` | Both agents finished |
| `request_results` | | Viewer clicks "See Results" |
| | `round_results` `{results, actualLocation, isLastRound, leaderboard}` | Pin positions + distances |
| `next_round` | | Viewer clicks "Next Round" |
| `show_scoreboard` | | After last round |
| | `final_scoreboard` `{leaderboard}` | Total distances + rounds won |
| `play_again` | | Restart |
| | `game_reset` | Reset to landing |

### Scoring

Scoring is purely distance-based:

- Each round: agents are ranked by **haversine distance** (km) from the actual location
- The closer agent wins the round
- Final ranking: **lowest total distance** across all rounds wins
- Tiebreaker display: rounds won shown alongside total distance

## Docker

```bash
docker build -t mapmind .
docker run -p 4567:4567 mapmind
```
