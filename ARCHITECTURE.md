# MapMind Architecture

## System Overview

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
│  atlas_vs_queue               │
│                               │
│  Workflow: atlas-vs           │
└──────────────┬────────────────┘
               │ Poll for tasks
               │
┌──────────────▼────────────────────────────────────────────────────────┐
│              YOUR WORKER (local Python process)                       │
│              project/run_worker.py                                     │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  AtlasVsWorkflow (project/workflow.py)                           │  │
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

## Communication Protocols

| Leg | Protocol | Direction |
|-----|----------|-----------|
| Browser <-> Game Server | WebSocket | Bidirectional |
| Game Server -> AgentEx | HTTP POST (JSON-RPC 2.0) | Request/Response |
| Game Server <- AgentEx | SSE (GET, long-lived) | Server → Client stream |
| AgentEx <-> Temporal | gRPC | Bidirectional |
| Worker -> OpenAI | HTTPS | Request/Response |
| Worker -> SGP | HTTPS | Push traces |

## SSE Event Types

Server-Sent Events flow from AgentEx (`GET /tasks/{id}/stream`) to the game server:

```
connected    → SSE connection established
delta        → Token-by-token text from the agent  {"delta": {"text_delta": "..."}}
full         → Complete message (fallback)          {"content": {"author": "agent", ...}}
done         → End of a message
```

## Key Environment Variables

### Game Server (.env)
- `OPENAI_API_KEY` — For Nova's direct OpenAI calls
- `AGENTEX_URL` — AgentEx backend (default: http://localhost:5003)
- `AGENTEX_AGENT_NAME` — Agent name (default: atlas-vs)

### Worker (set when running)
- `WORKFLOW_TASK_QUEUE=atlas_vs_queue`
- `WORKFLOW_NAME=atlas-vs`
- `ACP_URL=http://host.docker.internal` / `ACP_PORT=8000`
- `OPENAI_API_KEY` — For GPT-4o vision calls
- `SGP_API_KEY` / `SGP_ACCOUNT_ID` — For trace export
