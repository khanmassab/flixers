/**
 * Quick regression harness to verify state (playback) messages still flow after a reconnect.
 * Usage: node tests/ws-regression.js
 *
 * Assumes backend is running locally with default JWT secret (or set JWT_SECRET/BASE_HTTP/BASE_WS).
 * Creates a room, connects two clients, sends a state update, reconnects one client to mimic a page
 * refresh, then asserts state updates still deliver.
 */
const { sign } = require("jsonwebtoken");
const WebSocket = require("ws");
const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";
const BASE_HTTP = process.env.BASE_HTTP || "http://localhost:4000";
const BASE_WS = process.env.BASE_WS || "ws://localhost:4000/ws";

async function createRoom(token) {
  const res = await fetchJson(`${BASE_HTTP}/rooms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ encryptionRequired: false }),
  });
  return res;
}

function makeToken(sub, name) {
  return sign({ sub, name }, JWT_SECRET, { expiresIn: "1h" });
}

function connectClient(name, roomId, token) {
  return new Promise((resolve, reject) => {
    const url = `${BASE_WS}?roomId=${roomId}&token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    const stateEvents = [];

    const ready = new Promise((res) => {
      ws.on("open", res);
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "state") {
          stateEvents.push(msg);
        }
      } catch (_) {
        // ignore parse errors
      }
    });

    ws.once("error", (err) => reject(err));

    ready.then(() => {
      resolve({
        name,
        ws,
        getStates() {
          const copy = [...stateEvents];
          stateEvents.length = 0;
          return copy;
        },
      });
    });
  });
}

async function waitForState(client, timeoutMs = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      const states = client.getStates();
      if (states.length > 0) {
        clearInterval(interval);
        resolve(states[0]);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error("Timed out waiting for state"));
      }
    }, 50);
  });
}

async function main() {
  const aliceToken = makeToken("alice", "Alice");
  const bobToken = makeToken("bob", "Bob");

  console.log("Creating room...");
  const room = await createRoom(aliceToken);
  console.log(`Room: ${room.roomId}`);

  console.log("Connecting Alice and Bob...");
  const alice = await connectClient("Alice", room.roomId, aliceToken);
  const bob = await connectClient("Bob", room.roomId, bobToken);

  // Baseline: send a state from Alice, expect Bob receives it
  const baselinePayload = { type: "state", payload: { t: 12, paused: false, url: "https://netflix.com/watch/123" } };
  alice.ws.send(JSON.stringify(baselinePayload));
  await waitForState(bob);
  console.log("Baseline state delivered");

  // Simulate Bob refresh: close and reconnect
  console.log("Simulating Bob refresh...");
  bob.ws.close();
  const bob2 = await connectClient("Bob", room.roomId, bobToken);

  // Send another state and ensure new Bob receives it
  const postRefreshPayload = { type: "state", payload: { t: 25, paused: true, url: "https://netflix.com/watch/123" } };
  alice.ws.send(JSON.stringify(postRefreshPayload));
  await waitForState(bob2);
  console.log("Post-refresh state delivered");

  alice.ws.close();
  bob2.ws.close();
}

function fetchJson(urlStr, opts = {}) {
  // Prefer global fetch if available (Node 18+) for simplicity
  if (typeof fetch === "function") {
    return fetch(urlStr, opts).then(async (res) => {
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      return res.json();
    });
  }

  // Minimal HTTP/HTTPS fallback (Node <18)
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        method: opts.method || "GET",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: opts.headers || {},
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
          try {
            resolve(JSON.parse(data || "{}"));
          } catch (err) {
            reject(err);
          }
        });
      }
    );

    req.on("error", reject);
    if (opts.body) {
      req.write(opts.body);
    }
    req.end();
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
