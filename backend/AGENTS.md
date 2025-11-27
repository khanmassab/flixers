# Repository Guidelines

## Project Structure & Module Organization
- Backend entrypoint `server.js` wires Express routes (`/rooms` create/join) and a WebSocket hub for presence, chat/state, key exchange, and encrypted relays.
- Tests live in `tests/` (Jest + supertest + socket stubs); add feature-specific helpers near usage.
- Dependencies/scripts are in `package.json`; lockfile is `package-lock.json`; Docker builds use the root `Dockerfile`.

## Build, Test, and Development Commands
- `npm install` — install dependencies.
- `npm start` or `node server.js` — run API/WS server on `PORT` (default `4000`).
- `npm test` — run Jest suite.
- `npm run lint` — run ESLint.
- `docker build -t flixers-backend .` then `docker run -p 4000:4000 -e PORT=4000 flixers-backend` — containerized run.
- Set `REQUIRE_ENCRYPTION=true` to force encrypted WebSocket payloads; `/rooms` accepts `{"encryptionRequired": true}` to enforce per-room.

## Coding Style & Naming Conventions
- 2-space indentation; keep CommonJS `require`/`module.exports`.
- Name WebSocket message types descriptively (`presence`, `chat`, `state`, `key-exchange`, `encrypted`); prefer explicit variable names over abbreviations.
- Run ESLint/Prettier before PRs; avoid unused params unless prefixed with `_`.

## Testing Guidelines
- Use Jest with `tests/*.test.js`; supertest for HTTP handlers, lightweight socket stubs for broadcast logic.
- Cover room lifecycle, presence fan-out, key exchange relay, encrypted payload passthrough, and plaintext rejection when encryption is required.
- Keep tests deterministic; clear shared maps between cases.

## End-to-End Encryption
- Server is a blind relay: it forwards `key-exchange` and `encrypted` payloads and drops plaintext when a room requires encryption.
- Key exchange example: `{"type":"key-exchange","publicKey":"<base64>","curve":"secp256k1"}` (broadcast to others).
- Encrypted payload example: `{"type":"encrypted","ciphertext":"<b64>","iv":"<b64>","tag":"<b64>","alg":"aes-256-gcm"}`; server adds `from` and `ts`.
- Client flow: derive a shared secret with ECDH (e.g., `secp256k1`), HKDF it into an AES-GCM key, encrypt message JSON, send as `encrypted`; decrypt on receipt using the same IV/tag.
- Optional helper: `client/e2e-crypto.js` exposes `generateKeyPair`, `buildEncryptedEnvelope`, and `openEncryptedEnvelope` to produce payloads ready for the `encrypted` message type.

## Commit & Pull Request Guidelines
- Use imperative, scoped commits (e.g., `Enforce encrypted rooms`); keep diffs minimal.
- PRs should state intent, behavior changes, tests run, and env vars touched (`PORT`, `REQUIRE_ENCRYPTION`); include curl/WebSocket reproduction steps for bug fixes.

## Auth & Identity
- Google-only sign-in: configure `GOOGLE_CLIENT_ID` (OAuth client for extension redirect `https://<EXT_ID>.chromiumapp.org/`) and `JWT_SECRET` on the backend.
- Exchange flow: popup obtains Google ID token, posts to `/auth/google`, then reuses the returned session JWT for `/rooms` and WebSocket `token` query param. Names displayed in chat/presence come from the verified profile.
- Dev mode: if `GOOGLE_CLIENT_ID` is empty, `/auth/google` accepts any token and warns (use only for local/dev).
- Sharing/join: rooms are joined via share links (`chrome-extension://<EXT_ID>/popup.html?room=<id>`); the popup auto-joins when opened from a link after sign-in. Copy link from the share row in the popup; manual room codes are not required.
