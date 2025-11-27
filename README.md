# Flixers (Chrome-only MVP)

Minimal scaffold for a Netflix watch-party Chrome extension and a lightweight WebSocket backend. No Firefox code is included.

## Layout
- `extension/` – Manifest v3 Chrome extension with service worker, content script, and popup UI.
- `backend/` – Node WebSocket + REST server for rooms, chat, and playback sync.
- `docker-compose.yml` – Build/run backend via Docker.

## Quick start
### Backend
```bash
cd backend
npm install
npm start   # defaults to http/ws on :4000
```
Or with Docker:
```bash
docker compose up --build backend
```

### Extension
1. Go to `chrome://extensions`.
2. Toggle **Developer mode**.
3. **Load unpacked** and choose the `extension/` folder.
4. Open Netflix, create/join a room from the popup, and start playback to see sync events.

## Notes
- The extension uses native `WebSocket` in the background service worker; the server exposes `/ws` and REST endpoints `/rooms` and `/rooms/:id/join`.
- Content script listens to Netflix's `<video>` for play/pause/seek/time updates and mirrors remote state when received.
- Chat messages and presence are surfaced both in the popup and via an in-page overlay in Netflix with a toggle/hide control.

## Next steps
- Add persistence (Redis/Postgres) for rooms.
- Harden reconnection/host election logic, buffering awareness, and auth tokens.
- Polish overlay UX (reactions, media titles, per-room settings).
