// harness/server.js - Engine.IO v3 Test Server (HTTP & WebSocket)

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");

const app = express();
const port = 8080;

app.use(express.static(path.join(__dirname)));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/socket.io/" });

console.log(`[Test Server] Initializing Engine.IO v3 Server on port ${port}...`);

wss.on("connection", (ws, req) => {
  console.log(`[Test Server] Client connected from ${req.socket.remoteAddress} (URL: ${req.url})`);

  // 1. Send EIO v3 Handshake Open packet (0)
  const handshake = {
    sid: "test_session_" + Math.random().toString(36).substring(7),
    pingInterval: 10000,
    pingTimeout: 25000
  };
  ws.send("0" + JSON.stringify(handshake));

  // 2. Handle Client Ping (2) -> Server Pong (3)
  ws.on("message", (msg) => {
    const str = msg.toString();
    if (str === "2") {
      // EIO v3 Client Ping received -> Respond with Pong (3)
      ws.send("3");
    }
  });

  // 3. Stream Test Feeds
  // Feed A: String Event 42["quote", ...] every 250ms
  const stringInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      const payload = `42["quote",{"asset":"EURUSD_otc","bid":${(1.08500 + Math.random() * 0.001).toFixed(5)},"time":${Date.now()}}]`;
      ws.send(payload);
    }
  }, 250);

  // Feed B: QXBroker Format Binary Event ["quotes/stream"] every 400ms
  const binaryInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      // Step 1: Text Placeholder Header
      const headerPayload = `451-["quotes/stream",{"_placeholder":true,"num":0}]`;
      ws.send(headerPayload);

      // Step 2: Binary Frame Attachment starting with byte 0x04
      const binaryDataStr = `[["EURCHF",${(Date.now() / 1000).toFixed(3)},${(0.94200 + Math.random() * 0.001).toFixed(5)},1]]`;
      const binaryBuffer = Buffer.concat([
        Buffer.from([0x04]),
        Buffer.from(binaryDataStr, "utf-8")
      ]);
      ws.send(binaryBuffer);
    }
  }, 400);

  // Feed C: Binary Event ["depth/change"] every 600ms
  const depthInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      const headerPayload = `451-["depth/change",{"_placeholder":true,"num":0}]`;
      ws.send(headerPayload);

      const binaryDataStr = `[["EURCHF",${Math.floor(Math.random() * 100)}]]`;
      const binaryBuffer = Buffer.concat([
        Buffer.from([0x04]),
        Buffer.from(binaryDataStr, "utf-8")
      ]);
      ws.send(binaryBuffer);
    }
  }, 600);

  ws.on("close", () => {
    console.log("[Test Server] Client disconnected.");
    clearInterval(stringInterval);
    clearInterval(binaryInterval);
    clearInterval(depthInterval);
  });
});

server.listen(port, () => {
  console.log(`[Test Server] Live test harness running at http://localhost:${port}`);
});
