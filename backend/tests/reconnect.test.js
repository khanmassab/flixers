const { sign } = require("jsonwebtoken");
const WebSocket = require("ws");
const { start, stop } = require("../server");

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";
jest.setTimeout(60000);

function makeToken(sub, name) {
  return sign({ sub, name }, JWT_SECRET, { expiresIn: "1h" });
}

async function createRoom(baseHttp, token) {
  const res = await fetchJson(`${baseHttp}/rooms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ encryptionRequired: false }),
  });
  return res;
}

describe("WebSocket reconnect edge cases", () => {
  let server;
  let baseHttp;
  let baseWs;

  beforeAll((done) => {
    server = start(0);
    server.on("listening", () => {
      const { port } = server.address();
      baseHttp = `http://localhost:${port}`;
      baseWs = `ws://localhost:${port}/ws`;
      done();
    });
  });

  afterAll((done) => {
    stop(() => done());
  });

  test(
    "server terminates when client stops responding to pings (half-open simulation)",
    async () => {
      const token = makeToken("pingless", "Pingless Client");
      const room = await createRoom(baseHttp, token);
      const wsUrl = `${baseWs}?roomId=${room.roomId}&token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(wsUrl);

      await new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });

      // Disable automatic pong replies to simulate a one-way half-open.
      if (ws._receiver && typeof ws._receiver._handlePing === "function") {
        ws._receiver._handlePing = () => {};
      }

      const closeEvent = await new Promise((resolve, reject) => {
        ws.once("close", (code, reason) => resolve({ code, reason }));
        ws.once("error", reject);
      });

      expect(closeEvent.code).toBe(1006);
    }
  );

  test("preview endpoint rejects expired/invalid token", async () => {
    const badToken = `${makeToken("user", "User")}.tamper`;
    const res = await fetchRaw(`${baseHttp}/rooms/doesnotmatter/preview`, {
      headers: { Authorization: `Bearer ${badToken}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

function fetchJson(urlStr, opts = {}) {
  return fetchRaw(urlStr, opts).then((res) => {
    const body = res.body || {};
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`HTTP ${res.statusCode}: ${JSON.stringify(body)}`);
    }
    return body;
  });
}

function fetchRaw(urlStr, opts = {}) {
  // Prefer global fetch if available
  if (typeof fetch === "function") {
    return fetch(urlStr, opts).then(async (res) => {
      const bodyText = await res.text();
      let parsed = {};
      try {
        parsed = JSON.parse(bodyText || "{}");
      } catch (_) {
        parsed = {};
      }
      return { statusCode: res.status, body: parsed };
    });
  }
  const { URL } = require("node:url");
  const http = require("node:http");
  const https = require("node:https");
  const url = new URL(urlStr);
  const lib = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
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
          let parsed = {};
          try {
            parsed = JSON.parse(data || "{}");
          } catch (_) {
            parsed = {};
          }
          resolve({ statusCode: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (opts.body) {
      req.write(typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body));
    }
    req.end();
  });
}
