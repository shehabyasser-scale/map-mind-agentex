/**
 * MapMind — WebSocket Game Server
 *
 * Atlas VS   → calls through AgentEx (atlas-vs) with traces to SGP
 * Atlas Shehab → calls through AgentEx (atlas-shehab) with traces to SGP
 * Nova       → calls OpenAI GPT-4o directly (no traces)
 */

require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const OpenAI = require("openai");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 4567;
const AGENTEX_URL = process.env.AGENTEX_URL || "http://localhost:5003";

// OpenAI client for Nova (direct calls)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Serve static files
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

// Health check
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Sample rounds API
app.get("/api/sample-rounds", (_req, res) => {
  const dataPath = path.join(__dirname, "data", "sample_rounds.json");
  if (fs.existsSync(dataPath)) {
    res.json(JSON.parse(fs.readFileSync(dataPath, "utf-8")));
  } else {
    res.json([]);
  }
});

// ============================================
// AI Agent Definitions
// ============================================

const ALL_AGENTS = {
  atlas: {
    id: "atlas",
    name: "Atlas VS",
    color: "#6c5ce7",
    mode: "agentex",
    agentexName: process.env.AGENTEX_AGENT_NAME || "atlas-vs",
    style: "Methodical",
    initial: "A",
  },
  shehab: {
    id: "shehab",
    name: "Atlas Shehab",
    color: "#fdcb6e",
    mode: "agentex",
    agentexName: process.env.AGENTEX_AGENT_NAME_SHEHAB || "atlas-shehab",
    style: "Strategic",
    initial: "S",
  },
  nova: {
    id: "nova",
    name: "Nova",
    color: "#ff6b6b",
    mode: "direct",
    style: "Intuitive",
    initial: "N",
    system: `You are Nova, an intuitive geolocation expert competing in MapMind.

Trust your visual instincts and pattern recognition:
1. What's your immediate gut feeling about the region?
2. Note the overall vibe — urban density, cultural energy, crowd behavior
3. Pick up on subtle cultural cues — clothing, vehicles, street life
4. Sense the quality of light and atmospheric mood
5. Match the scene against your vast visual memory of world locations
6. Refine your intuition with any concrete evidence you spot

Be expressive and confident. Share your thought process naturally.

CRITICAL: End your response with your coordinate guess as JSON on its own line:
{"lat": <number>, "lng": <number>}`,
  },
};

// Agents list endpoint (for client UI)
app.get("/api/agents", (_req, res) => {
  const agents = Object.values(ALL_AGENTS).map((a) => ({
    id: a.id,
    name: a.name,
    color: a.color,
    style: a.style,
    initial: a.initial,
  }));
  res.json(agents);
});

const TOTAL_ROUNDS = 20;

// ============================================
// Scoring
// ============================================

function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ============================================
// Round Data
// ============================================

function loadRounds() {
  const dataPath = path.join(__dirname, "data", "sample_rounds.json");
  let data = [];
  if (fs.existsSync(dataPath)) {
    data = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
  }
  return data.sort((a, b) => a.id - b.id);
}

// ============================================
// Helpers
// ============================================

function sendTo(ws, message) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(message));
  }
}

function makeRandomGuess(actual, agentId) {
  const spreadRanges = { atlas: [3, 18], shehab: [3, 18], nova: [5, 22] };
  const [min, max] = spreadRanges[agentId] || [5, 20];
  const spread = min + Math.random() * (max - min);
  return {
    lat: Math.max(-85, Math.min(85, actual.lat + (Math.random() - 0.5) * spread)),
    lng: actual.lng + (Math.random() - 0.5) * spread * 1.5,
  };
}

function parseCoordinateGuess(text) {
  // Pattern 1: JSON object containing "lat" and "lng"/"lon" (with any extra fields like "confidence")
  const jsonBlocks = text.match(/\{[^{}]*"lat"\s*:[^{}]*\}/g);
  if (jsonBlocks) {
    // Take the last JSON block (the final/refined guess)
    for (let i = jsonBlocks.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(jsonBlocks[i]);
        if (typeof parsed.lat === "number" && (typeof parsed.lng === "number" || typeof parsed.lon === "number")) {
          return {
            lat: parsed.lat,
            lng: parsed.lng ?? parsed.lon,
            confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
          };
        }
      } catch {}
    }
  }
  // Pattern 2: Flexible regex fallback for "latitude"/"lat" and "longitude"/"lng"/"lon"
  const latPattern = /lat(?:itude)?\s*[:=]?\s*(-?[\d.]+)/i;
  const lngPattern = /(?:lng|lon(?:gitude)?)\s*[:=]?\s*(-?[\d.]+)/i;
  const latM = text.match(latPattern);
  const lngM = text.match(lngPattern);
  if (latM && lngM) {
    return { lat: parseFloat(latM[1]), lng: parseFloat(lngM[1]), confidence: null };
  }
  return null;
}

// ============================================
// AgentEx RPC Helper
// ============================================

async function agentexRPC(method, params, agentexName) {
  const url = `${AGENTEX_URL}/agents/name/${agentexName}/rpc`;
  const body = {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method,
    params,
  };

  console.log(`[AgentEx RPC] ${method} → ${url}`);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`AgentEx RPC ${method} failed (${response.status}): ${text}`);
  }

  const rpc = await response.json();
  if (rpc.error) {
    throw new Error(`AgentEx RPC error: ${JSON.stringify(rpc.error)}`);
  }

  return rpc.result;
}

// ============================================
// AgentEx Agent (with SSE streaming)
// ============================================

async function callAgentexAgent(ws, session, agentId, imageUrl, roundData) {
  const agent = ALL_AGENTS[agentId];
  const agentexName = agent.agentexName;

  try {
    console.log(`[${agent.name}/AgentEx] Creating task...`);
    const task = await agentexRPC("task/create", {
      name: `mapmind-${agentId}-${crypto.randomUUID().slice(0, 8)}`,
      params: {},
    }, agentexName);
    const taskId = task.id;
    console.log(`[${agent.name}/AgentEx] Task created: ${taskId}`);

    const streamUrl = `${AGENTEX_URL}/tasks/${taskId}/stream`;
    console.log(`[${agent.name}/AgentEx] Connecting to SSE: ${streamUrl}`);
    const sseResponse = await fetch(streamUrl, {
      headers: {
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });

    if (!sseResponse.ok) {
      throw new Error(`SSE stream failed (${sseResponse.status})`);
    }

    const reader = sseResponse.body.getReader();
    const decoder = new TextDecoder();

    console.log(`[${agent.name}/AgentEx] Sending image URL event...`);
    await agentexRPC("event/send", {
      task_id: taskId,
      content: {
        type: "text",
        author: "user",
        content: imageUrl,
      },
    }, agentexName);
    console.log(`[${agent.name}/AgentEx] Event sent, waiting for agent response...`);

    let fullText = "";
    let buffer = "";
    let receivedAgentContent = false;
    let doneCount = 0;
    const startTime = Date.now();
    const TIMEOUT_MS = 90000;

    while (Date.now() - startTime < TIMEOUT_MS) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let shouldBreak = false;

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;

        let eventData;
        try {
          eventData = JSON.parse(line.slice(6));
        } catch {
          continue;
        }

        if (eventData.type === "delta" && eventData.delta?.text_delta) {
          const textDelta = eventData.delta.text_delta;
          fullText += textDelta;
          receivedAgentContent = true;
          sendTo(ws, {
            type: "ai_stream",
            agent: agentId,
            text: textDelta,
            done: false,
          });
        }

        if (eventData.type === "done") {
          doneCount++;
          if (receivedAgentContent) {
            console.log(`[${agent.name}/AgentEx] Stream complete (${fullText.length} chars)`);
            shouldBreak = true;
            break;
          }
        }

        if (eventData.type === "full" && eventData.content) {
          const content = eventData.content;
          if (content.type === "text" && content.author === "agent" && content.content) {
            if (content.content.includes("Welcome to MapMind") || content.content.includes("geolocation expert")) {
              continue;
            }
            if (!receivedAgentContent) {
              fullText = content.content;
              receivedAgentContent = true;
              sendTo(ws, {
                type: "ai_stream",
                agent: agentId,
                text: content.content,
                done: false,
              });
              console.log(`[${agent.name}/AgentEx] Got full message (${fullText.length} chars)`);
              shouldBreak = true;
              break;
            }
          }
        }
      }

      if (shouldBreak) break;
    }

    try { reader.cancel(); } catch {}

    if (!receivedAgentContent) {
      throw new Error("No streaming content received from AgentEx within timeout");
    }

    let parsed = parseCoordinateGuess(fullText);
    let guess;
    let confidence;
    if (parsed) {
      confidence = parsed.confidence ?? 85;
      guess = { lat: parsed.lat, lng: parsed.lng };
    } else {
      console.warn(`[${agent.name}/AgentEx] Could not parse coordinates, using fallback`);
      guess = makeRandomGuess(roundData.location, agentId);
      confidence = 30;
    }

    session.currentGuesses[agentId] = guess;
    sendTo(ws, {
      type: "ai_stream",
      agent: agentId,
      text: "",
      done: true,
      guess,
      confidence,
    });

    console.log(`[${agent.name}/AgentEx] Guessed: ${JSON.stringify(guess)} (via AgentEx → traces in SGP)`);
  } catch (error) {
    console.error(`[${agent.name}/AgentEx] Error:`, error.message);
    sendTo(ws, { type: "ai_stream", agent: agentId, text: `[AgentEx error: ${error.message}]\n`, done: false });
    throw error;
  }
}

// ============================================
// Nova — Direct OpenAI (no AgentEx, no traces)
// ============================================

async function callDirectAgent(ws, session, agentId, imageUrl, roundData) {
  const agent = ALL_AGENTS[agentId];
  const systemPrompt = agent.system || ALL_AGENTS.nova.system;

  try {
    console.log(`[${agent.name}/Direct] Analyzing image: ${imageUrl}`);

    const stream = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 1024,
      stream: true,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
            { type: "text", text: "Where is this location? Analyze and make your best coordinate guess." },
          ],
        },
      ],
    });

    let fullText = "";

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        fullText += delta;
        sendTo(ws, {
          type: "ai_stream",
          agent: agentId,
          text: delta,
          done: false,
        });
      }
    }

    let parsed = parseCoordinateGuess(fullText);
    let guess;
    let confidence;
    if (parsed) {
      confidence = parsed.confidence ?? 80;
      guess = { lat: parsed.lat, lng: parsed.lng };
    } else {
      console.warn(`[${agent.name}/Direct] Could not parse coordinates, using fallback`);
      guess = makeRandomGuess(roundData.location, agentId);
      confidence = 30;
    }

    session.currentGuesses[agentId] = guess;
    sendTo(ws, {
      type: "ai_stream",
      agent: agentId,
      text: "",
      done: true,
      guess,
      confidence,
    });

    console.log(`[${agent.name}/Direct] Guessed: ${JSON.stringify(guess)} (direct OpenAI, no traces)`);
  } catch (error) {
    console.error(`[${agent.name}/Direct] Error:`, error.message);

    sendTo(ws, {
      type: "ai_stream",
      agent: agentId,
      text: `[AI error: ${error.message}]\n`,
      done: false,
    });

    const guess = makeRandomGuess(roundData.location, agentId);
    session.currentGuesses[agentId] = guess;
    sendTo(ws, {
      type: "ai_stream",
      agent: agentId,
      text: "",
      done: true,
      guess,
      confidence: 20,
    });
  }
}

// ============================================
// Agent Dispatcher
// ============================================

function callAgent(ws, session, agentId, imageUrl, roundData) {
  const agent = ALL_AGENTS[agentId];
  if (agent.mode === "agentex") {
    return callAgentexAgent(ws, session, agentId, imageUrl, roundData);
  }
  return callDirectAgent(ws, session, agentId, imageUrl, roundData);
}

// ============================================
// Game Flow
// ============================================

function playRound(ws, session) {
  const roundData = session.rounds[session.currentRound];
  if (!roundData) {
    console.error(`[Game] No round data at index ${session.currentRound}`);
    return;
  }
  session.currentRound++;

  sendTo(ws, {
    type: "round_start",
    round: session.currentRound,
    totalRounds: session.totalRounds,
    photo: roundData.image_url,
    locationName: roundData.name,
    agents: session.agents,
  });

  setTimeout(async () => {
    try {
      await simulateDualAI(ws, session, roundData);
    } catch (err) {
      console.error("[Game] Fatal error in playRound:", err);
      session.pendingRoundData = roundData;
      sendTo(ws, { type: "analysis_complete" });
    }
  }, 500);
}

async function simulateDualAI(ws, session, roundData) {
  session.currentGuesses = {};
  const imageUrl = roundData.image_url;

  try {
    await Promise.all(
      session.agents.map((agentId) =>
        callAgent(ws, session, agentId, imageUrl, roundData).catch((err) => {
          console.error(`[${ALL_AGENTS[agentId].name}] Unhandled error:`, err.message);
          const guess = makeRandomGuess(roundData.location, agentId);
          session.currentGuesses[agentId] = guess;
          sendTo(ws, { type: "ai_stream", agent: agentId, text: "[Error — using fallback]\n", done: false });
          sendTo(ws, { type: "ai_stream", agent: agentId, text: "", done: true, guess, confidence: 10 });
        })
      )
    );
  } catch (err) {
    console.error("[Game] Critical error in dual AI:", err.message);
    for (const agentId of session.agents) {
      if (!session.currentGuesses[agentId]) {
        const guess = makeRandomGuess(roundData.location, agentId);
        session.currentGuesses[agentId] = guess;
        sendTo(ws, { type: "ai_stream", agent: agentId, text: "", done: true, guess, confidence: 10 });
      }
    }
  }

  session.pendingRoundData = roundData;
  sendTo(ws, { type: "analysis_complete" });
}

function finishRound(ws, session, roundData) {
  const actual = roundData.location;

  const results = session.agents.map((agentId) => {
    const agent = ALL_AGENTS[agentId];
    const guess = session.currentGuesses[agentId];
    const dist = haversineDistance(guess.lat, guess.lng, actual.lat, actual.lng);
    const roundedDist = Math.round(dist);
    session.agentDistances[agentId] += roundedDist;
    session.roundWins[agentId] = session.roundWins[agentId] || 0;
    return {
      agentId,
      name: agent.name,
      color: agent.color,
      guess,
      distance: roundedDist,
    };
  });

  results.sort((a, b) => a.distance - b.distance);
  if (results.length >= 2) {
    if (results[0].distance < results[1].distance) {
      session.roundWins[results[0].agentId]++;
    } else if (results[0].distance === results[1].distance) {
      session.draws++;
    }
  }

  const isLastRound = session.currentRound >= session.totalRounds;
  const leaderboard = session.agents
    .map((id) => ({
      id,
      name: ALL_AGENTS[id].name,
      color: ALL_AGENTS[id].color,
      totalDistance: session.agentDistances[id],
      roundWins: session.roundWins[id] || 0,
    }))
    .sort((a, b) => a.totalDistance - b.totalDistance);

  sendTo(ws, {
    type: "round_results",
    round: session.currentRound,
    totalRounds: session.totalRounds,
    results,
    actualLocation: actual,
    locationName: roundData.name,
    isLastRound,
    leaderboard,
    draws: session.draws,
  });
}

// ============================================
// WebSocket Handling
// ============================================

wss.on("connection", (ws) => {
  let session = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case "start_game": {
        const selectedAgents = msg.agents || ["atlas", "nova"];

        if (selectedAgents.length !== 2 || selectedAgents[0] === selectedAgents[1]) {
          sendTo(ws, { type: "error", message: "Please select two different agents." });
          break;
        }
        if (!selectedAgents.every((id) => ALL_AGENTS[id])) {
          sendTo(ws, { type: "error", message: "Invalid agent selection." });
          break;
        }

        const rounds = loadRounds();
        const distances = {};
        const wins = {};
        selectedAgents.forEach((id) => { distances[id] = 0; wins[id] = 0; });

        session = {
          rounds,
          currentRound: 0,
          totalRounds: Math.min(TOTAL_ROUNDS, rounds.length),
          agentDistances: distances,
          roundWins: wins,
          draws: 0,
          currentGuesses: {},
          agents: selectedAgents,
        };

        sendTo(ws, { type: "game_starting" });

        let count = 3;
        const countInterval = setInterval(() => {
          sendTo(ws, { type: "countdown", count });
          count--;
          if (count === 0) {
            clearInterval(countInterval);
            setTimeout(() => playRound(ws, session), 1000);
          }
        }, 1000);
        break;
      }

      case "request_results": {
        if (!session || !session.pendingRoundData) return;
        const roundData = session.pendingRoundData;
        session.pendingRoundData = null;
        finishRound(ws, session, roundData);
        break;
      }

      case "next_round": {
        if (!session) return;
        if (session.currentRound >= session.totalRounds) return;
        playRound(ws, session);
        break;
      }

      case "show_scoreboard": {
        if (!session) return;
        const leaderboard = session.agents
          .map((id) => ({
            id,
            name: ALL_AGENTS[id].name,
            color: ALL_AGENTS[id].color,
            totalDistance: session.agentDistances[id],
            roundWins: session.roundWins[id] || 0,
          }))
          .sort((a, b) => a.totalDistance - b.totalDistance);

        sendTo(ws, { type: "final_scoreboard", leaderboard, draws: session.draws });
        break;
      }

      case "play_again": {
        session = null;
        sendTo(ws, { type: "game_reset" });
        break;
      }
    }
  });

  ws.on("close", () => {
    session = null;
  });
  ws.on("error", () => {
    session = null;
  });
});

// ============================================
// Start Server
// ============================================

server.listen(PORT, () => {
  const hasKey = !!process.env.OPENAI_API_KEY;
  const agentList = Object.values(ALL_AGENTS)
    .map((a) => `${a.name} (${a.mode}${a.agentexName ? ": " + a.agentexName : ""})`)
    .join(", ");
  console.log(`\n  MapMind Server`);
  console.log(`  ──────────────────────────────────────────`);
  console.log(`  Local:      http://localhost:${PORT}`);
  console.log(`  Network:    http://${getLocalIP()}:${PORT}`);
  console.log(`  OpenAI Key: ${hasKey ? "Set" : "MISSING!"}`);
  console.log(`  AgentEx:    ${AGENTEX_URL}`);
  console.log(`  Agents:     ${agentList}`);
  console.log(`  ──────────────────────────────────────────`);
  if (!hasKey) {
    console.log(`\n  Set OPENAI_API_KEY in .env to enable AI`);
  }
  console.log();
});

function getLocalIP() {
  const nets = require("os").networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "localhost";
}
