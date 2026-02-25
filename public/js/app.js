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
