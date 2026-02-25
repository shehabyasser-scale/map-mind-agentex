const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);

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
