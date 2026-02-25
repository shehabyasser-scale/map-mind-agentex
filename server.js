/**
 * MapMind — WebSocket Game Server
 *
 * Two AI agents (Atlas & Nova) compete head-to-head
 * to identify locations from photos. The viewer just
 * clicks Start and watches them battle it out.
 */

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

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
    spreadRange: [3, 18], // degrees offset range (varies per round)
  },
  nova: {
    id: "nova",
    name: "Nova",
    color: "#ff6b6b",
    spreadRange: [5, 22],
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

function makeAIGuess(actual, agentId) {
  const [min, max] = AGENTS[agentId].spreadRange;
  const spread = min + Math.random() * (max - min);
  return {
    lat: Math.max(-85, Math.min(85, actual.lat + (Math.random() - 0.5) * spread)),
    lng: actual.lng + (Math.random() - 0.5) * spread * 1.5,
  };
}

// ============================================
// Mock AI Reasoning (per location)
// ============================================

function getAgentReasoning(agentId, locationName, difficulty) {
  const atlasClues = {
    easy: [
      "Scanning architectural features and structural geometry...\n\n",
      "I can identify distinctive construction patterns consistent with a well-known landmark. ",
      "The building materials and surrounding urban layout narrow this to a specific region.\n\n",
      "Cross-referencing skyline silhouette with global landmark database...\n\n",
      `High confidence match. The structural signature and surrounding context point clearly to ${locationName.split(",")[1] || "this region"}.`,
    ],
    medium: [
      "Analyzing urban density and infrastructure patterns...\n\n",
      "Street layout and signage style suggest a specific cultural region. ",
      "Vegetation type and climate indicators help narrow the latitude band.\n\n",
      "Checking road markings, vehicle types, and pedestrian behavior patterns...\n\n",
      "Multiple converging clues point to a specific metropolitan area. Moderately confident in my assessment.",
    ],
    hard: [
      "Limited distinctive features visible. Running deep pattern analysis...\n\n",
      "Color palette of buildings and rooftops may indicate a regional style. ",
      "Attempting to identify vegetation species for climate zone placement.\n\n",
      "This is challenging. Few globally-unique markers present. Considering multiple candidate regions...\n\n",
      "Best estimate based on a combination of subtle architectural and environmental cues.",
    ],
  };

  const novaClues = {
    easy: [
      "First instinct: this looks immediately recognizable...\n\n",
      "The overall vibe, crowd density, and tourist infrastructure are distinctive. ",
      "I've seen thousands of images from this angle — the proportions are unmistakable.\n\n",
      "Confirming against my visual memory of global landmarks...\n\n",
      `Strong gut feeling confirmed by visual analysis. This is almost certainly in ${locationName.split(",")[1] || "this area"}.`,
    ],
    medium: [
      "Interesting scene. The energy and activity level tell me a lot...\n\n",
      "Typography on visible signs and the style of street furniture are culturally specific. ",
      "The quality of light and atmospheric haze help narrow the geographic zone.\n\n",
      "Weighing several possibilities based on the overall aesthetic...\n\n",
      "My intuition points to a specific city. Reasonably confident based on accumulated visual cues.",
    ],
    hard: [
      "Hmm, this one is tricky. My initial impression is uncertain...\n\n",
      "Searching for any text, symbols, or brand logos that might reveal the region. ",
      "The color of the soil and type of vegetation might be my best clue here.\n\n",
      "Running through less common possibilities — this doesn't match typical tourist spots...\n\n",
      "Going with my best guess. Low certainty but the subtle details push me toward one region.",
    ],
  };

  const clueSet = agentId === "atlas" ? atlasClues : novaClues;
  // Note: when real agents are connected, this function is replaced
  // by actual LLM-generated reasoning from each agent.
  return clueSet[difficulty] || clueSet.medium;
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

  // Start dual AI analysis after a brief pause
  setTimeout(() => simulateDualAI(ws, session, roundData), 500);
}

function simulateDualAI(ws, session, roundData) {
  const actual = roundData.location;
  const difficulty = roundData.difficulty || "medium";
  session.currentGuesses = {};

  const atlasClues = getAgentReasoning("atlas", roundData.name, difficulty);
  const novaClues = getAgentReasoning("nova", roundData.name, difficulty);

  let atlasIdx = 0;
  let novaIdx = 0;
  let atlasDone = false;
  let novaDone = false;

  // Stream Atlas reasoning (every 450ms)
  const atlasInterval = setInterval(() => {
    if (atlasIdx < atlasClues.length) {
      sendTo(ws, {
        type: "ai_stream",
        agent: "atlas",
        text: atlasClues[atlasIdx],
        done: false,
      });
      atlasIdx++;
    } else {
      clearInterval(atlasInterval);
      const guess = makeAIGuess(actual, "atlas");
      session.currentGuesses.atlas = guess;
      sendTo(ws, {
        type: "ai_stream",
        agent: "atlas",
        text: "",
        done: true,
        guess,
        confidence: Math.floor(55 + Math.random() * 35),
      });
      atlasDone = true;
      if (novaDone) {
        session.pendingRoundData = roundData;
        sendTo(ws, { type: "analysis_complete" });
      }
    }
  }, 450);

  // Stream Nova reasoning (every 500ms, staggered by 200ms)
  setTimeout(() => {
    const novaInterval = setInterval(() => {
      if (novaIdx < novaClues.length) {
        sendTo(ws, {
          type: "ai_stream",
          agent: "nova",
          text: novaClues[novaIdx],
          done: false,
        });
        novaIdx++;
      } else {
        clearInterval(novaInterval);
        const guess = makeAIGuess(actual, "nova");
        session.currentGuesses.nova = guess;
        sendTo(ws, {
          type: "ai_stream",
          agent: "nova",
          text: "",
          done: true,
          guess,
          confidence: Math.floor(45 + Math.random() * 45),
        });
        novaDone = true;
        if (atlasDone) {
          session.pendingRoundData = roundData;
          sendTo(ws, { type: "analysis_complete" });
        }
      }
    }, 500);
  }, 200);
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

  // Sort by closest (lowest distance wins)
  results.sort((a, b) => a.distance - b.distance);
  // Track round wins
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
        };

        sendTo(ws, { type: "game_starting" });

        // Countdown 3, 2, 1
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
  console.log(`\n  MapMind Server`);
  console.log(`  ──────────────`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://${getLocalIP()}:${PORT}`);
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
