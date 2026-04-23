# video-api

Production-ready Node.js + Express API for listing vendor pickup records and streaming video blobs from Microsoft SQL Server.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create your `.env` file and set all required variables:
   ```env
   DB_SERVER=
   DB_DATABASE=
   DB_USER=
   DB_PASSWORD=
   JWT_SECRET=
   ```
3. Start the API:
   ```bash
   npm start
   ```

## Endpoints

### `GET /health`
Liveness check — returns `{ "status": "ok" }`.

### `POST /auth/login`
Authenticates a vendor and returns a session JWT (8h by default).

Request body:
```json
{ "username": "vendor1", "password": "secret" }
```

Response:
```json
{ "token": "<jwt>", "user": { "username": "vendor1" } }
```

### `POST /auth/video-token`
Requires session token. Returns a short-lived signed URL (20 min) for a specific video.

Request body:
```json
{ "invoiceNumber": "INV-12345" }
```

Response:
```json
{ "videoUrl": "https://your-api.com/video/INV-12345?vt=<video_token>" }
```

### `GET /pickup`
Requires session token. Returns paginated pickup confirmation records for the authenticated vendor's store.

Pagination query params:
- `page` (default `1`)
- `pageSize` (default `50`, max `200`)
- `days` (default `60`) — look-back window

Response shape:
- `items`: paginated records, each including a `videoTokenEndpoint` field
- `pagination`: `{ page, pageSize, total, totalPages, hasNextPage, hasPreviousPage }`

### `GET /video/:invoiceNumber?vt=<video_token>`
Streams the video for the given invoice as fragmented MP4. Token must be obtained from `/auth/video-token` first and is validated against the specific invoice.

## Example requests

Login:
```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"vendor1","password":"secret"}'
```

List pickup records:
```bash
curl "http://localhost:3000/pickup?page=1&pageSize=50" \
  -H "Authorization: Bearer <session_token>"
```

Get a video URL:
```bash
curl -X POST http://localhost:3000/auth/video-token \
  -H "Authorization: Bearer <session_token>" \
  -H "Content-Type: application/json" \
  -d '{"invoiceNumber":"INV-12345"}'
```

Inline frontend usage:
```html
<video controls src="http://localhost:3000/video/INV-12345?vt=<video_token>"></video>
```

## Auth & security

- Login is rate-limited per IP (default: 10 attempts per 15 min, configurable via `LOGIN_MAX_ATTEMPTS` and `LOGIN_WINDOW_MS`).
- Session tokens and video tokens are separate JWT types — a video token cannot be used to access the pickup list or generate new tokens.
- Video tokens are scoped to a specific invoice and store, preventing reuse across resources.
- Passwords are stored as bcrypt hashes. Run the one-time migration script if upgrading from plain-text passwords:
  ```bash
  node scripts/migrate-passwords.js
  ```

## Video streaming

- Video blobs are read from SQL in fixed-size chunks (`STREAM_CHUNK_SIZE_BYTES`, default `4MB`) using `SUBSTRING(...)` — full blobs are never loaded into Node memory.
- Chunks are piped directly into `ffmpeg` stdin and transcoded on-the-fly to fragmented MP4 (`frag_keyframe+empty_moov`) for broad browser compatibility.
- ffmpeg path is configurable via `FFMPEG_PATH` (defaults to system `ffmpeg`).
- Fragment size is configurable via `MP4_FRAG_SIZE_BYTES` (default `256KB`).