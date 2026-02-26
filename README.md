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

### Overview

MapMind is a spectator game — the user doesn't play, they watch two AI agents compete. The architecture has three layers:

```
┌─────────────────────────────────────────────────┐
│                    Browser                       │
│  ┌───────────┐  ┌──────────┐  ┌──────────────┐ │
│  │ Connection │  │ GameMap  │  │     App      │ │
│  │ (WebSocket)│  │ (Leaflet)│  │ (Controller) │ │
│  └─────┬─────┘  └──────────┘  └──────┬───────┘ │
│        │                              │         │
│        └──────────┬───────────────────┘         │
│                   │ WebSocket                    │
└───────────────────┼─────────────────────────────┘
                    │
┌───────────────────┼─────────────────────────────┐
│              Game Server (Node.js)               │
│  ┌────────────┐  ┌────────────┐  ┌───────────┐ │
│  │   Express   │  │  WebSocket │  │   Agent   │ │
│  │ (static +   │  │   (game    │  │  Engine   │ │
│  │  health)    │  │  protocol) │  │  (mock*)  │ │
│  └────────────┘  └────────────┘  └───────────┘ │
└─────────────────────────────────────────────────┘
```

*\*Currently mock agents with hardcoded reasoning. See [Connecting Real Agents](#connecting-real-agents) below.*

### Server (`server.js`)

- **Express** serves static files from `public/` and a `/health` endpoint
- **WebSocket** (`ws` library) handles all game coordination — one connection per viewer
- **Per-connection session** — each WebSocket connection gets its own game state (rounds, distances, wins). No shared rooms or global state
- **Agent engine** — currently simulates two agents with hardcoded reasoning text and randomized coordinate guesses. Designed to be swapped with real agent calls

### Client (`public/js/app.js`)

Single JS bundle with three modules:

| Module | Purpose |
|--------|---------|
| `Connection` | WebSocket manager with auto-reconnect (up to 5 attempts with linear backoff) |
| `GameMap` | Leaflet.js wrapper — dark CartoDB tiles, pin markers, dashed distance lines |
| `App` | Game controller — screen management, event binding, DOM updates |

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

| Client → Server | Server → Client | Description |
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

There are no abstract point values. Scoring is purely distance-based:

- Each round: agents are ranked by **haversine distance** (km) from the actual location
- The closer agent wins the round
- Final ranking: **lowest total distance** across all rounds wins
- Tiebreaker display: rounds won shown alongside total distance

## Connecting Real Agents

Currently, `server.js` uses mock agents — hardcoded reasoning text and random coordinate guesses (see `getAgentReasoning()` and `makeAIGuess()`). Here's how to replace them with real AI agents.

### What needs to change

The mock logic lives in two functions inside `simulateDualAI()`:

1. **`getAgentReasoning(agentId, locationName, difficulty)`** — returns an array of text chunks that get streamed to the client. Replace this with actual LLM-generated reasoning.

2. **`makeAIGuess(actual, agentId)`** — returns `{lat, lng}` by adding random offsets to the actual location. Replace this with the agent's real coordinate prediction.

### Option A: Direct LLM calls from the server

The simplest approach — call an LLM (e.g., Claude, GPT-4o) directly from the game server. No AgentEx infrastructure needed.

```js
// server.js — replace simulateDualAI with something like:

const Anthropic = require("@anthropic-ai/sdk");
const client = new Anthropic();

async function callAgent(ws, agentId, imageUrl, roundData) {
  const systemPrompt = agentId === "atlas"
    ? "You are Atlas, a methodical geolocation analyst. Analyze the image systematically..."
    : "You are Nova, an intuitive geolocation expert. Trust your instincts...";

  // Stream reasoning via Claude
  const stream = await client.messages.stream({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "url", url: imageUrl } },
        { type: "text", text: "Where is this? Stream your reasoning, then output your final guess as JSON: {\"lat\": ..., \"lng\": ...}" }
      ]
    }]
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      sendTo(ws, {
        type: "ai_stream",
        agent: agentId,
        text: event.delta.text,
        done: false,
      });
    }
  }

  // Parse the final guess from the response
  const fullText = await stream.finalMessage();
  const jsonMatch = fullText.content[0].text.match(/\{[^}]*"lat"[^}]*\}/);
  const guess = jsonMatch ? JSON.parse(jsonMatch[0]) : makeAIGuess(roundData.location, agentId);

  session.currentGuesses[agentId] = guess;
  sendTo(ws, { type: "ai_stream", agent: agentId, text: "", done: true, guess });
}
```

### Option B: AgentEx agents (ACP protocol)

If you want each agent to be a standalone AgentEx service (useful for the training demo), you'd create two agents that accept image URLs and return location guesses.

#### 1. Create the agent (`acp.py`)

Each agent is a Python FastAPI server using the AgentEx SDK. Here's a minimal sync agent:

```python
# teams/demo/agents/mapmind_atlas/project/acp.py

from agentex.lib.sdk.fastacp.fastacp import FastACP
from agentex.lib.types.acp import SendMessageParams
from agentex.types.task_message_content import TextContent, DataContent
from agentex.types.task_message_update import (
    StreamTaskMessageDelta, StreamTaskMessageDone
)
from agentex.types.text_delta import TextDelta
from agentex.lib import adk
from agentex.lib.types.llm_messages import (
    LLMConfig, SystemMessage, UserMessage,
    ContentPartText, ContentPartImage, ImageURL
)

acp = FastACP.create(acp_type="sync")

SYSTEM_PROMPT = """You are Atlas, a methodical geolocation analyst.
Analyze the image step by step: architecture, vegetation, signage, climate.
End your response with a JSON line: {"lat": <number>, "lng": <number>}"""

@acp.on_message_send
async def handle_message_send(params: SendMessageParams):
    # Extract image URL from incoming DataContent
    image_url = params.content.data["image_url"]

    llm_messages = [
        SystemMessage(content=SYSTEM_PROMPT),
        UserMessage(content=[
            ContentPartImage(
                image_url=ImageURL(url=image_url, detail="high")
            ),
            ContentPartText(text="Where is this location? Analyze and guess."),
        ]),
    ]

    message_index = 0
    async for chunk in adk.providers.litellm.chat_completion_stream(
        llm_config=LLMConfig(
            model="gpt-4o",  # or "claude-sonnet-4-20250514"
            messages=llm_messages,
            stream=True,
        ),
        trace_id=params.task.id,
    ):
        if chunk and chunk.choices and chunk.choices[0].delta.content:
            yield StreamTaskMessageDelta(
                type="delta",
                index=message_index,
                delta=TextDelta(
                    type="text",
                    text_delta=chunk.choices[0].delta.content,
                ),
            )

    yield StreamTaskMessageDone(type="done", index=message_index)
```

#### 2. Configure the manifest (`manifest.yaml`)

```yaml
agent:
  acp_type: sync
  name: mapmind-atlas
  description: "Atlas agent for MapMind — methodical geolocation analyst"
  credentials:
    - env_var_name: OPENAI_API_KEY
      secret_name: openai-api-key
      secret_key: api-key

local_development:
  agent:
    port: 8000
    host_address: host.docker.internal
  paths:
    acp: project/acp.py
```

#### 3. Call agents from the game server

The game server sends JSON-RPC requests to each agent's `/api` endpoint:

```js
// server.js — call an AgentEx agent

async function callAgentExAgent(ws, agentId, imageUrl, session) {
  const agentPorts = { atlas: 8000, nova: 8001 };
  const port = agentPorts[agentId];

  const response = await fetch(`http://localhost:${port}/api`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "message/send",
      params: {
        agent: { id: agentId, name: agentId },
        task: { id: crypto.randomUUID() },
        content: {
          type: "data",
          author: "user",
          data: { image_url: imageUrl },
        },
        stream: true,
      },
      id: 1,
    }),
  });

  // Response is NDJSON (newline-delimited JSON)
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const lines = decoder.decode(value).split("\n").filter(Boolean);
    for (const line of lines) {
      const rpc = JSON.parse(line);
      const update = rpc.result;

      if (update.type === "delta" && update.delta?.text_delta) {
        fullText += update.delta.text_delta;
        sendTo(ws, {
          type: "ai_stream",
          agent: agentId,
          text: update.delta.text_delta,
          done: false,
        });
      }
    }
  }

  // Parse lat/lng from the agent's full response
  const jsonMatch = fullText.match(/\{[^}]*"lat"[^}]*\}/);
  const guess = jsonMatch
    ? JSON.parse(jsonMatch[0])
    : { lat: 0, lng: 0 };

  session.currentGuesses[agentId] = guess;
  sendTo(ws, {
    type: "ai_stream",
    agent: agentId,
    text: "",
    done: true,
    guess,
    confidence: 75,
  });
}
```

#### 4. Wire it into the game loop

Replace `simulateDualAI` to call both agents in parallel:

```js
async function simulateDualAI(ws, session, roundData) {
  session.currentGuesses = {};
  const imageUrl = roundData.image_url;

  // Call both agents in parallel
  await Promise.all([
    callAgentExAgent(ws, "atlas", imageUrl, session),
    callAgentExAgent(ws, "nova", imageUrl, session),
  ]);

  session.pendingRoundData = roundData;
  sendTo(ws, { type: "analysis_complete" });
}
```

### Key protocol details (from the AgentEx SDK source)

| Concept | Detail |
|---------|--------|
| **Transport** | HTTP POST to `/api` with JSON-RPC 2.0 |
| **Streaming** | Response is `application/x-ndjson` — each line is a JSON-RPC response containing a `StreamTaskMessageDelta` or `StreamTaskMessageDone` |
| **Image input** | Send via `DataContent` with `data.image_url`, or use `UserMessage` with `ContentPartImage` for LLM calls |
| **Agent types** | `sync` (request-response), `agentic` (async with task lifecycle), `async` (Temporal workflows) |
| **SDK entry point** | `FastACP.create(acp_type="sync")` with `@acp.on_message_send` handler |

## Docker

```bash
docker build -t mapmind .
docker run -p 4567:4567 mapmind
```
