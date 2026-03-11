/**
 * MapMind — WebSocket Game Server
 *
 * Atlas  → calls through AgentEx (agent-shehab-3) with traces to SGP
 * Nova   → calls OpenAI GPT-4o directly (no traces)
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
const AGENTEX_AGENT_NAME = process.env.AGENTEX_AGENT_NAME || "agent-shehab-3";
let agentexAgentId = null; // Resolved at startup from agent name → UUID

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

const AGENTS = {
  atlas: {
    id: "atlas",
    name: "Atlas",
    color: "#6c5ce7",
    mode: "agentex", // Routes through AgentEx → traces to SGP
  },
  nova: {
    id: "nova",
    name: "Nova",
    color: "#ff6b6b",
    mode: "direct", // Calls OpenAI directly → no traces
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

const TOTAL_ROUNDS = 5;

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
  return data.sort(() => Math.random() - 0.5);
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
  const spreadRanges = { atlas: [3, 18], nova: [5, 22] };
  const [min, max] = spreadRanges[agentId] || [5, 20];
  const spread = min + Math.random() * (max - min);
  return {
    lat: Math.max(-85, Math.min(85, actual.lat + (Math.random() - 0.5) * spread)),
    lng: actual.lng + (Math.random() - 0.5) * spread * 1.5,
  };
}

function parseCoordinateGuess(text) {
  const jsonMatch = text.match(/\{\s*"lat"\s*:\s*(-?[\d.]+)\s*,\s*"lng"\s*:\s*(-?[\d.]+)\s*\}/);
  if (jsonMatch) {
    return { lat: parseFloat(jsonMatch[1]), lng: parseFloat(jsonMatch[2]) };
  }
  const lonMatch = text.match(/\{\s*"lat"\s*:\s*(-?[\d.]+)\s*,\s*"lon"\s*:\s*(-?[\d.]+)\s*\}/);
  if (lonMatch) {
    return { lat: parseFloat(lonMatch[1]), lng: parseFloat(lonMatch[2]) };
  }
  const latPattern = /lat(?:itude)?\s*[:=]?\s*(-?[\d.]+)/i;
  const lngPattern = /(?:lng|lon(?:gitude)?)\s*[:=]?\s*(-?[\d.]+)/i;
  const latM = text.match(latPattern);
  const lngM = text.match(lngPattern);
  if (latM && lngM) {
    return { lat: parseFloat(latM[1]), lng: parseFloat(lngM[1]) };
  }
  return null;
}

// ============================================
// AgentEx RPC Helper
// ============================================

async function agentexRPC(method, params) {
  // Use the /agents/name/ route (no need to resolve UUID)
  const url = `${AGENTEX_URL}/agents/name/${AGENTEX_AGENT_NAME}/rpc`;
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
// Atlas — AgentEx Agent (with SSE streaming)
// ============================================

async function callAtlasViaAgentEx(ws, session, imageUrl, roundData) {
  try {
    // 1. Create a NEW task for each round (clean slate, avoids stale SSE state)
    console.log("[Atlas/AgentEx] Creating task...");
    const task = await agentexRPC("task/create", {
      name: `mapmind-atlas-${crypto.randomUUID().slice(0, 8)}`,
      params: {},
    });
    const taskId = task.id;
    console.log(`[Atlas/AgentEx] Task created: ${taskId}`);

    // 2. Connect to SSE stream BEFORE sending the event (so we don't miss deltas)
    const streamUrl = `${AGENTEX_URL}/tasks/${taskId}/stream`;
    console.log(`[Atlas/AgentEx] Connecting to SSE: ${streamUrl}`);
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

    // 3. Now send the image URL as an event (SSE is already listening)
    console.log(`[Atlas/AgentEx] Sending image URL event...`);
    await agentexRPC("event/send", {
      task_id: taskId,
      content: {
        type: "text",
        author: "user",
        content: imageUrl,
      },
    });
    console.log(`[Atlas/AgentEx] Event sent, waiting for agent response...`);

    // 4. Read SSE stream — collect reasoning text from the agent
    let fullText = "";
    let buffer = "";
    let receivedAgentContent = false; // True once we start getting agent reasoning
    let doneCount = 0; // Track how many "done" events we see
    const startTime = Date.now();
    const TIMEOUT_MS = 90000; // 90s timeout

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

        // Stream text deltas to the game client
        if (eventData.type === "delta" && eventData.delta?.text_delta) {
          const textDelta = eventData.delta.text_delta;
          fullText += textDelta;
          receivedAgentContent = true;
          sendTo(ws, {
            type: "ai_stream",
            agent: "atlas",
            text: textDelta,
            done: false,
          });
        }

        // "done" signals end of a message. We care about the one AFTER we started
        // receiving agent content (skip the welcome message's done)
        if (eventData.type === "done") {
          doneCount++;
          // The first "done" might be for welcome message, the second for our analysis
          // But if we already received content, this done is ours
          if (receivedAgentContent) {
            console.log(`[Atlas/AgentEx] Stream complete (${fullText.length} chars)`);
            shouldBreak = true;
            break;
          }
        }

        // "full" events deliver complete messages (non-streaming fallback)
        if (eventData.type === "full" && eventData.content) {
          const content = eventData.content;
          if (content.type === "text" && content.author === "agent" && content.content) {
            // Skip the welcome message
            if (content.content.includes("Welcome to MapMind") || content.content.includes("geolocation expert")) {
              continue;
            }
            // This is the agent's analysis — use it if we didn't get deltas
            if (!receivedAgentContent) {
              fullText = content.content;
              receivedAgentContent = true;
              sendTo(ws, {
                type: "ai_stream",
                agent: "atlas",
                text: content.content,
                done: false,
              });
              console.log(`[Atlas/AgentEx] Got full message (${fullText.length} chars)`);
              shouldBreak = true;
              break;
            }
          }
        }
      }

      if (shouldBreak) break;
    }

    // Cleanup SSE reader
    try { reader.cancel(); } catch {}

    if (!receivedAgentContent) {
      // SSE didn't give us content — poll messages as fallback
      console.log("[Atlas/AgentEx] No streaming content, polling messages...");
      await pollForAtlasResponse(ws, taskId, roundData, session);
      return;
    }

    // Parse coordinates from the agent's response
    let guess = parseCoordinateGuess(fullText);
    if (!guess) {
      console.warn("[Atlas/AgentEx] Could not parse coordinates, using fallback");
      guess = makeRandomGuess(roundData.location, "atlas");
    }

    session.currentGuesses.atlas = guess;
    sendTo(ws, {
      type: "ai_stream",
      agent: "atlas",
      text: "",
      done: true,
      guess,
      confidence: guess ? 85 : 30,
    });

    console.log(`[Atlas/AgentEx] Guessed: ${JSON.stringify(guess)} (via AgentEx → traces in SGP)`);
  } catch (error) {
    console.error("[Atlas/AgentEx] Error:", error.message);
    console.log("[Atlas/AgentEx] Falling back to direct OpenAI call...");
    await callNovaDirectOpenAI(ws, "atlas", imageUrl, session, roundData);
  }
}

// Fallback: poll messages if SSE streaming didn't work
async function pollForAtlasResponse(ws, taskId, roundData, session) {
  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 2000)); // Wait 2s between polls

    try {
      const res = await fetch(
        `${AGENTEX_URL}/messages?task_id=${taskId}&limit=10&order_by=created_at&order_direction=desc`
      );
      const data = await res.json();
      const messages = data.data || data;

      // Find the latest agent message that's not the welcome message
      for (const msg of messages) {
        if (
          msg.content?.type === "text" &&
          msg.content?.author === "agent" &&
          msg.content?.content &&
          !msg.content.content.includes("Welcome to MapMind") &&
          !msg.content.content.includes("geolocation expert") &&
          msg.streaming_status === "DONE"
        ) {
          const fullText = msg.content.content;
          console.log(`[Atlas/AgentEx] Poll found response (${fullText.length} chars)`);

          sendTo(ws, {
            type: "ai_stream",
            agent: "atlas",
            text: fullText,
            done: false,
          });

          let guess = parseCoordinateGuess(fullText);
          if (!guess) guess = makeRandomGuess(roundData.location, "atlas");

          session.currentGuesses.atlas = guess;
          sendTo(ws, {
            type: "ai_stream",
            agent: "atlas",
            text: "",
            done: true,
            guess,
            confidence: guess ? 85 : 30,
          });
          return;
        }
      }
    } catch (e) {
      console.warn(`[Atlas/AgentEx] Poll error: ${e.message}`);
    }
  }

  // Total fallback
  console.warn("[Atlas/AgentEx] Polling exhausted, using random guess");
  const guess = makeRandomGuess(roundData.location, "atlas");
  session.currentGuesses.atlas = guess;
  sendTo(ws, { type: "ai_stream", agent: "atlas", text: "[AgentEx timeout]\n", done: false });
  sendTo(ws, { type: "ai_stream", agent: "atlas", text: "", done: true, guess, confidence: 10 });
}

// ============================================
// Nova — Direct OpenAI (no AgentEx, no traces)
// ============================================

async function callNovaDirectOpenAI(ws, agentId, imageUrl, session, roundData) {
  const agent = AGENTS[agentId];
  const systemPrompt = agent.system || AGENTS.nova.system;

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

    let guess = parseCoordinateGuess(fullText);
    if (!guess) {
      console.warn(`[${agent.name}/Direct] Could not parse coordinates, using fallback`);
      guess = makeRandomGuess(roundData.location, agentId);
    }

    session.currentGuesses[agentId] = guess;
    sendTo(ws, {
      type: "ai_stream",
      agent: agentId,
      text: "",
      done: true,
      guess,
      confidence: guess ? 80 : 30,
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
// Game Flow
// ============================================

function playRound(ws, session) {
  const roundData = session.rounds[session.currentRound];
  session.currentRound++;

  sendTo(ws, {
    type: "round_start",
    round: session.currentRound,
    totalRounds: session.totalRounds,
    photo: roundData.image_url,
    locationName: roundData.name,
  });

  setTimeout(async () => {
    await simulateDualAI(ws, session, roundData);
  }, 500);
}

async function simulateDualAI(ws, session, roundData) {
  session.currentGuesses = {};
  const imageUrl = roundData.image_url;

  // Atlas → AgentEx (traces to SGP)
  // Nova  → Direct OpenAI (no traces)
  await Promise.all([
    callAtlasViaAgentEx(ws, session, imageUrl, roundData),
    callNovaDirectOpenAI(ws, "nova", imageUrl, session, roundData),
  ]);

  session.pendingRoundData = roundData;
  sendTo(ws, { type: "analysis_complete" });
}

function finishRound(ws, session, roundData) {
  const actual = roundData.location;

  const results = Object.keys(AGENTS).map((agentId) => {
    const guess = session.currentGuesses[agentId];
    const dist = haversineDistance(guess.lat, guess.lng, actual.lat, actual.lng);
    const roundedDist = Math.round(dist);
    session.agentDistances[agentId] += roundedDist;
    session.roundWins[agentId] = session.roundWins[agentId] || 0;
    return {
      agentId,
      name: AGENTS[agentId].name,
      color: AGENTS[agentId].color,
      guess,
      distance: roundedDist,
    };
  });

  results.sort((a, b) => a.distance - b.distance);
  if (results.length >= 2 && results[0].distance < results[1].distance) {
    session.roundWins[results[0].agentId]++;
  }

  const isLastRound = session.currentRound >= session.totalRounds;
  const leaderboard = Object.keys(AGENTS)
    .map((id) => ({
      id,
      name: AGENTS[id].name,
      color: AGENTS[id].color,
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
        const rounds = loadRounds();
        session = {
          rounds,
          currentRound: 0,
          totalRounds: Math.min(TOTAL_ROUNDS, rounds.length),
          agentDistances: { atlas: 0, nova: 0 },
          roundWins: { atlas: 0, nova: 0 },
          currentGuesses: {},
          atlasTaskId: null, // AgentEx task ID for Atlas (created on first round)
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
        const leaderboard = Object.keys(AGENTS)
          .map((id) => ({
            id,
            name: AGENTS[id].name,
            color: AGENTS[id].color,
            totalDistance: session.agentDistances[id],
            roundWins: session.roundWins[id] || 0,
          }))
          .sort((a, b) => a.totalDistance - b.totalDistance);

        sendTo(ws, { type: "final_scoreboard", leaderboard });
        break;
      }

      case "play_again": {
        const rounds = loadRounds();
        session = {
          rounds,
          currentRound: 0,
          totalRounds: Math.min(TOTAL_ROUNDS, rounds.length),
          agentDistances: { atlas: 0, nova: 0 },
          roundWins: { atlas: 0, nova: 0 },
          currentGuesses: {},
          atlasTaskId: null,
        };
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
  console.log(`\n  MapMind Server`);
  console.log(`  ──────────────────────────────────────────`);
  console.log(`  Local:      http://localhost:${PORT}`);
  console.log(`  Network:    http://${getLocalIP()}:${PORT}`);
  console.log(`  OpenAI Key: ${hasKey ? "Set" : "MISSING!"}`);
  console.log(`  AgentEx:    ${AGENTEX_URL}`);
  console.log(`  ──────────────────────────────────────────`);
  console.log(`  Atlas: AgentEx (agent-shehab-3) → traces to SGP`);
  console.log(`  Nova:  Direct OpenAI → no traces`);
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
