/**
 * MapMind — All-in-one client bundle
 *
 * Sections:
 *   1. Connection (WebSocket manager)
 *   2. GameMap    (Leaflet wrapper)
 *   3. App        (Game controller)
 */

// ============================================
// 1. CONNECTION
// ============================================

class Connection {
  constructor() {
    this.ws = null;
    this.handlers = {};
    this.reconnectAttempts = 0;
    this.maxReconnects = 5;
    this.reconnectDelay = 1000;
  }

  connect() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this._emit("connected");
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this._emit(msg.type, msg);
      } catch (e) {
        console.error("Failed to parse message:", e);
      }
    };

    this.ws.onclose = () => {
      this._emit("disconnected");
      this._tryReconnect();
    };

    this.ws.onerror = () => {};
  }

  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  on(event, handler) {
    if (!this.handlers[event]) this.handlers[event] = [];
    this.handlers[event].push(handler);
  }

  off(event, handler) {
    if (!this.handlers[event]) return;
    this.handlers[event] = this.handlers[event].filter((h) => h !== handler);
  }

  _emit(event, data) {
    const list = this.handlers[event];
    if (list) list.forEach((h) => h(data));
  }

  _tryReconnect() {
    if (this.reconnectAttempts >= this.maxReconnects) return;
    this.reconnectAttempts++;
    setTimeout(() => this.connect(), this.reconnectDelay * this.reconnectAttempts);
  }

  disconnect() {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }
}

// ============================================
// 2. GAME MAP (Leaflet wrapper)
// ============================================

class GameMap {
  constructor(containerId) {
    this.containerId = containerId;
    this.map = null;
    this.markers = [];
    this.lines = [];
  }

  init() {
    if (this.map) this.map.remove();

    this.map = L.map(this.containerId, {
      center: [20, 0],
      zoom: 2,
      minZoom: 2,
      maxZoom: 18,
      zoomControl: true,
      attributionControl: false,
    });

    L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      { maxZoom: 19, subdomains: "abcd" }
    ).addTo(this.map);

    setTimeout(() => this.map.invalidateSize(), 100);
    return this;
  }

  invalidateSize() {
    if (this.map) this.map.invalidateSize();
  }

  addResultPin(lat, lng, color, label, animate = true) {
    const icon = this._createPinIcon(color, animate);
    const marker = L.marker([lat, lng], { icon }).addTo(this.map);
    if (label) {
      marker.bindTooltip(label, {
        permanent: true,
        direction: "top",
        offset: [0, -45],
        className: "pin-tooltip",
      });
    }
    this.markers.push(marker);
    return marker;
  }

  addActualLocationMarker(lat, lng) {
    const icon = L.divIcon({
      className: "actual-marker-wrapper",
      html: '<div class="actual-marker"></div>',
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });
    const marker = L.marker([lat, lng], { icon }).addTo(this.map);
    marker.bindTooltip("Actual Location", {
      permanent: true,
      direction: "top",
      offset: [0, -12],
      className: "pin-tooltip actual-tooltip",
    });
    this.markers.push(marker);
    return marker;
  }

  drawLine(fromLat, fromLng, toLat, toLng, color = "#ffffff33") {
    const line = L.polyline(
      [[fromLat, fromLng], [toLat, toLng]],
      { color, weight: 2, dashArray: "6, 8", opacity: 0.6 }
    ).addTo(this.map);
    this.lines.push(line);
    return line;
  }

  fitAllMarkers(padding = 50) {
    if (this.markers.length === 0) return;
    const group = L.featureGroup(this.markers);
    this.map.fitBounds(group.getBounds(), { padding: [padding, padding] });
  }

  clearAll() {
    this.markers.forEach((m) => m.remove());
    this.lines.forEach((l) => l.remove());
    this.markers = [];
    this.lines = [];
  }

  reset() {
    this.clearAll();
    if (this.map) this.map.setView([20, 0], 2);
  }

  _createPinIcon(color, animate = false) {
    const svg = `
      <svg width="32" height="42" viewBox="0 0 32 42" xmlns="http://www.w3.org/2000/svg">
        <path d="M16 0C7.16 0 0 7.16 0 16c0 12 16 26 16 26s16-14 16-26C32 7.16 24.84 0 16 0z"
          fill="${color}" stroke="#fff" stroke-width="2"/>
        <circle cx="16" cy="15" r="6" fill="#fff" opacity="0.9"/>
      </svg>
    `;
    return L.divIcon({
      className: `pin-marker${animate ? " animate" : ""}`,
      html: svg,
      iconSize: [32, 42],
      iconAnchor: [16, 42],
      tooltipAnchor: [0, -42],
    });
  }
}

// Inject tooltip styles
(function () {
  const style = document.createElement("style");
  style.textContent = `
    .pin-tooltip {
      background: rgba(20, 27, 45, 0.95) !important;
      color: #f1f5f9 !important;
      border: 1px solid rgba(255,255,255,0.1) !important;
      border-radius: 8px !important;
      padding: 4px 10px !important;
      font-size: 0.8rem !important;
      font-weight: 600 !important;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4) !important;
      white-space: nowrap !important;
    }
    .pin-tooltip::before {
      border-top-color: rgba(20, 27, 45, 0.95) !important;
    }
    .actual-tooltip {
      border-color: rgba(0, 212, 170, 0.4) !important;
      color: #00d4aa !important;
    }
    .actual-marker-wrapper {
      background: none !important;
      border: none !important;
    }
  `;
  document.head.appendChild(style);
})();

// ============================================
// 3. APP (Game controller)
// ============================================

(function () {
  "use strict";

  const state = {
    currentScreen: "landing",
    resultsMap: null,
    currentRound: 0,
    totalRounds: 5,
    currentPhoto: null,
    lastLeaderboard: null,
    availableAgents: [],
    selectedAgents: [],
    streamTexts: {},
  };

  const conn = new Connection();

  // --- Screen Management ---

  function showScreen(name, callback) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
    const screen = document.getElementById(`screen-${name}`);
    if (screen) screen.classList.add("active");
    state.currentScreen = name;

    if (name === "results") {
      setTimeout(() => {
        if (!state.resultsMap) {
          state.resultsMap = new GameMap("results-map").init();
        } else {
          state.resultsMap.invalidateSize();
        }
        if (callback) callback();
      }, 150);
    } else {
      if (callback) callback();
    }
  }

  // --- Agent Selection ---

  async function loadAgents() {
    try {
      const res = await fetch("/api/agents");
      state.availableAgents = await res.json();
    } catch {
      // Fallback if API fails
      state.availableAgents = [
        { id: "atlas", name: "Atlas VS", color: "#6c5ce7", style: "Methodical", initial: "A" },
        { id: "shehab", name: "Atlas Shehab", color: "#fdcb6e", style: "Strategic", initial: "S" },
        { id: "nova", name: "Nova", color: "#ff6b6b", style: "Intuitive", initial: "N" },
      ];
    }
    populateSelectors();
  }

  function populateSelectors() {
    const sel1 = document.getElementById("select-agent-1");
    const sel2 = document.getElementById("select-agent-2");
    sel1.innerHTML = "";
    sel2.innerHTML = "";

    state.availableAgents.forEach((agent) => {
      sel1.appendChild(new Option(agent.name, agent.id));
      sel2.appendChild(new Option(agent.name, agent.id));
    });

    // Default: first and last agent
    if (state.availableAgents.length >= 2) {
      sel1.value = state.availableAgents[0].id;
      sel2.value = state.availableAgents[state.availableAgents.length - 1].id;
    }

    sel1.addEventListener("change", updateMatchupPreview);
    sel2.addEventListener("change", updateMatchupPreview);
    updateMatchupPreview();
  }

  function getAgentById(id) {
    return state.availableAgents.find((a) => a.id === id);
  }

  function updateMatchupPreview() {
    const sel1 = document.getElementById("select-agent-1");
    const sel2 = document.getElementById("select-agent-2");
    const a1 = getAgentById(sel1.value);
    const a2 = getAgentById(sel2.value);
    const container = document.getElementById("agent-matchup");
    const errorEl = document.getElementById("agent-select-error");

    if (!a1 || !a2) return;

    if (a1.id === a2.id) {
      errorEl.textContent = "Please select two different agents.";
      errorEl.classList.remove("hidden");
    } else {
      errorEl.classList.add("hidden");
    }

    container.innerHTML = `
      <div class="agent-card" style="border-color: ${a1.color}22;">
        <div class="agent-avatar" style="background: ${a1.color}15; color: ${a1.color}; border: 2px solid ${a1.color}; box-shadow: 0 0 20px ${a1.color}33;">${a1.initial}</div>
        <span class="agent-label">${escapeHtml(a1.name)}</span>
        <span class="agent-style">${escapeHtml(a1.style)}</span>
      </div>
      <span class="vs-badge">VS</span>
      <div class="agent-card" style="border-color: ${a2.color}22;">
        <div class="agent-avatar" style="background: ${a2.color}15; color: ${a2.color}; border: 2px solid ${a2.color}; box-shadow: 0 0 20px ${a2.color}33;">${a2.initial}</div>
        <span class="agent-label">${escapeHtml(a2.name)}</span>
        <span class="agent-style">${escapeHtml(a2.style)}</span>
      </div>
    `;
  }

  // --- Landing ---

  function initLanding() {
    document.getElementById("btn-start").addEventListener("click", () => {
      const sel1 = document.getElementById("select-agent-1");
      const sel2 = document.getElementById("select-agent-2");
      const a1 = sel1.value;
      const a2 = sel2.value;

      if (a1 === a2) {
        const errorEl = document.getElementById("agent-select-error");
        errorEl.textContent = "Please select two different agents.";
        errorEl.classList.remove("hidden");
        return;
      }

      state.selectedAgents = [a1, a2];
      conn.send({ type: "start_game", agents: [a1, a2] });
      document.getElementById("btn-start").disabled = true;
      document.getElementById("btn-start").textContent = "Starting...";
    });
  }

  // --- Dual AI Analysis ---

  function buildAnalysisPanels(agents) {
    const container = document.getElementById("analysis-agents");
    container.innerHTML = agents
      .map((agentId, i) => {
        const agent = getAgentById(agentId);
        if (!agent) return "";
        const isFirst = i === 0;
        return `
          <div class="analysis-panel" data-agent="${agent.id}" style="${isFirst ? "border-right: 1px solid var(--glass-border);" : ""}">
            <div class="analysis-header">
              <div class="ai-thinking-icon" style="background: linear-gradient(135deg, ${agent.color}, ${agent.color}aa); box-shadow: 0 0 40px ${agent.color}33;">
                <div class="pulse-ring" style="border-color: ${agent.color};"></div>
                <span class="ai-icon-text">${agent.initial}</span>
              </div>
              <h3 id="${agent.id}-title" class="analysis-title">${escapeHtml(agent.name)} is analyzing...</h3>
            </div>
            <div id="${agent.id}-stream" class="analysis-stream">
              <div class="analysis-cursor" style="background: ${agent.color}; box-shadow: 0 0 6px ${agent.color}cc;"></div>
            </div>
            <div id="${agent.id}-confidence" class="ai-confidence hidden">
              <span class="confidence-label">Confidence</span>
              <div class="confidence-bar">
                <div id="${agent.id}-confidence-fill" class="confidence-fill" style="background: linear-gradient(90deg, ${agent.color}, ${agent.color}cc); box-shadow: 0 0 8px ${agent.color}66;"></div>
              </div>
              <span id="${agent.id}-confidence-value" class="confidence-value" style="color: ${agent.color};">0%</span>
            </div>
          </div>
        `;
      })
      .join("");
  }

  function showDualAnalysis(data) {
    state.currentRound = data.round;
    state.totalRounds = data.totalRounds;
    state.currentPhoto = data.photo;
    state.streamTexts = {};

    const agents = data.agents || state.selectedAgents;
    state.selectedAgents = agents;

    document.getElementById("round-indicator").textContent =
      `Round ${data.round} / ${data.totalRounds}`;
    document.getElementById("analysis-photo-img").src = data.photo || "";

    buildAnalysisPanels(agents);

    agents.forEach((agentId) => {
      state.streamTexts[agentId] = "";
    });

    document.getElementById("analysis-actions").classList.add("hidden");
    showScreen("analysis");
  }

  function appendAgentStream(data) {
    const agentId = data.agent;
    const stream = document.getElementById(`${agentId}-stream`);
    if (!stream) return;

    const agent = getAgentById(agentId);

    if (data.done) {
      const cursor = stream.querySelector(".analysis-cursor");
      if (cursor) cursor.remove();

      const titleEl = document.getElementById(`${agentId}-title`);
      if (titleEl) {
        titleEl.textContent = `${agent ? agent.name : agentId} — done!`;
      }

      if (data.confidence) {
        const confSection = document.getElementById(`${agentId}-confidence`);
        if (confSection) {
          confSection.classList.remove("hidden");
          const fill = document.getElementById(`${agentId}-confidence-fill`);
          const value = document.getElementById(`${agentId}-confidence-value`);
          setTimeout(() => {
            if (fill) fill.style.width = `${data.confidence}%`;
            if (value) value.textContent = `${data.confidence}%`;
          }, 100);
        }
      }
      return;
    }

    if (!state.streamTexts[agentId]) state.streamTexts[agentId] = "";
    state.streamTexts[agentId] += data.text;

    let formatted = escapeHtml(state.streamTexts[agentId]);
    formatted = formatted.replace(
      /\b(Europe|Asia|Africa|America|Australia|Oceania|Middle East|Mediterranean|Pacific|Atlantic)\b/gi,
      '<span class="location-highlight">$1</span>'
    );

    const cursorColor = agent ? agent.color : "#00d4aa";
    stream.innerHTML = formatted + `<div class="analysis-cursor" style="background: ${cursorColor}; box-shadow: 0 0 6px ${cursorColor}cc;"></div>`;
    stream.scrollTop = stream.scrollHeight;
  }

  // --- Results ---

  function showRoundResults(data) {
    state.lastLeaderboard = data.leaderboard;

    document.getElementById("actual-location-name").textContent =
      data.locationName || "Unknown Location";

    const list = document.getElementById("results-list");
    list.innerHTML = data.results
      .map((r, i) => {
        const rankClass = i === 0 ? "gold" : "silver";
        const winner = i === 0;
        return `
          <li>
            <span class="result-rank ${rankClass}">${i + 1}</span>
            <div class="agent-dot" style="background: ${r.color};"></div>
            <div class="result-info">
              <div class="result-name">${escapeHtml(r.name)}</div>
              <div class="result-distance">${r.distance != null ? formatDistance(r.distance) + " away" : "No guess"}</div>
            </div>
            ${winner ? '<span class="round-winner-badge">Winner</span>' : ""}
          </li>
        `;
      })
      .join("");

    const nextBtn = document.getElementById("btn-next-round");
    const scoreBtn = document.getElementById("btn-show-scoreboard");

    if (data.isLastRound) {
      nextBtn.classList.add("hidden");
      scoreBtn.classList.remove("hidden");
    } else {
      nextBtn.classList.remove("hidden");
      scoreBtn.classList.add("hidden");
    }

    // Show screen first, THEN add markers once the map is ready
    showScreen("results", () => {
      state.resultsMap.clearAll();

      if (data.actualLocation) {
        state.resultsMap.addActualLocationMarker(
          data.actualLocation.lat,
          data.actualLocation.lng
        );
      }

      data.results.forEach((r, i) => {
        if (!r.guess) return;
        setTimeout(() => {
          state.resultsMap.addResultPin(r.guess.lat, r.guess.lng, r.color, r.name, true);
          if (data.actualLocation) {
            state.resultsMap.drawLine(
              r.guess.lat, r.guess.lng,
              data.actualLocation.lat, data.actualLocation.lng,
              r.color + "66"
            );
          }
        }, i * 400);
      });

      setTimeout(() => state.resultsMap.fitAllMarkers(), data.results.length * 400 + 200);
    });
  }

  function initAnalysisControls() {
    document.getElementById("btn-see-results").addEventListener("click", () => {
      conn.send({ type: "request_results" });
    });
  }

  function initResultsControls() {
    document.getElementById("btn-next-round").addEventListener("click", () => {
      conn.send({ type: "next_round" });
    });

    document.getElementById("btn-show-scoreboard").addEventListener("click", () => {
      conn.send({ type: "show_scoreboard" });
    });
  }

  // --- Scoreboard ---

  function showFinalScoreboard(leaderboard, draws) {
    const first = leaderboard[0];
    const second = leaderboard[1];

    if (first) {
      const p1 = document.getElementById("podium-1");
      p1.querySelector(".podium-avatar").textContent = first.name.charAt(0);
      p1.querySelector(".podium-avatar").style.background = first.color + "22";
      p1.querySelector(".podium-avatar").style.color = first.color;
      p1.querySelector(".podium-avatar").style.border = `3px solid ${first.color}`;
      p1.querySelector(".podium-name").textContent = first.name;
      p1.querySelector(".podium-score").textContent = formatDistance(first.totalDistance) + " total";
      p1.querySelector(".podium-wins").textContent = first.roundWins + " round" + (first.roundWins !== 1 ? "s" : "") + " won";
    }

    if (second) {
      const p2 = document.getElementById("podium-2");
      p2.querySelector(".podium-avatar").textContent = second.name.charAt(0);
      p2.querySelector(".podium-avatar").style.background = second.color + "22";
      p2.querySelector(".podium-avatar").style.color = second.color;
      p2.querySelector(".podium-avatar").style.border = `3px solid ${second.color}`;
      p2.querySelector(".podium-name").textContent = second.name;
      p2.querySelector(".podium-score").textContent = formatDistance(second.totalDistance) + " total";
      p2.querySelector(".podium-wins").textContent = second.roundWins + " round" + (second.roundWins !== 1 ? "s" : "") + " won";
    }

    const drawsEl = document.getElementById("draws-summary");
    if (draws > 0) {
      drawsEl.textContent = draws + " round" + (draws !== 1 ? "s" : "") + " drawn";
      drawsEl.classList.remove("hidden");
    } else {
      drawsEl.classList.add("hidden");
    }

    showScreen("scoreboard");
  }

  function initScoreboardControls() {
    document.getElementById("btn-play-again").addEventListener("click", () => {
      conn.send({ type: "play_again" });
    });
  }

  // --- Countdown ---

  function showCountdown(count) {
    let overlay = document.querySelector(".countdown-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "countdown-overlay";
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `<div class="countdown-number">${count}</div>`;
    overlay.style.display = "flex";
  }

  function hideCountdown() {
    const overlay = document.querySelector(".countdown-overlay");
    if (overlay) overlay.style.display = "none";
  }

  // --- Toast ---

  function showToast(message, duration = 3000) {
    let toast = document.querySelector(".toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "toast";
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), duration);
  }

  // --- Utilities ---

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function formatDistance(km) {
    if (km < 1) return `${Math.round(km * 1000)} m`;
    if (km < 100) return `${km.toFixed(1)} km`;
    return `${Math.round(km).toLocaleString()} km`;
  }

  // --- WebSocket Events ---

  function bindConnectionEvents() {
    conn.on("connected", () => {});
    conn.on("disconnected", () => showToast("Disconnected from server"));
    conn.on("error", (msg) => showToast(msg.message || "An error occurred"));
    conn.on("game_starting", () => showToast("Game starting..."));
    conn.on("countdown", (msg) => showCountdown(msg.count));

    conn.on("round_start", (msg) => {
      hideCountdown();
      showDualAnalysis(msg);
    });

    conn.on("ai_stream", (msg) => appendAgentStream(msg));

    conn.on("analysis_complete", () => {
      document.getElementById("analysis-actions").classList.remove("hidden");
    });

    conn.on("round_results", (msg) => showRoundResults(msg));
    conn.on("final_scoreboard", (msg) => showFinalScoreboard(msg.leaderboard, msg.draws || 0));

    conn.on("game_reset", () => {
      state.currentRound = 0;
      state.lastLeaderboard = null;
      state.streamTexts = {};
      if (state.resultsMap) state.resultsMap.clearAll();
      const btn = document.getElementById("btn-start");
      btn.disabled = false;
      btn.textContent = "Start Game";
      showScreen("landing");
    });
  }

  // --- Init ---

  function init() {
    initLanding();
    initAnalysisControls();
    initResultsControls();
    initScoreboardControls();
    bindConnectionEvents();
    loadAgents();
    conn.connect();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
