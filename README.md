# video-api

Production-ready Node.js + Express API for listing pickup metadata and streaming video blobs from Microsoft SQL Server.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy env file:
   ```bash
   cp .env.example .env
   ```
3. Set all DB variables in `.env` (`DB_SERVER`, `DB_DATABASE`, `DB_USER`, `DB_PASSWORD`).


4. Start API:
   ```bash
   npm start
   ```

## Endpoints

### `GET /health`
Liveness endpoint for quick service checks.

### `GET /health/ready`
Readiness endpoint that verifies SQL connectivity (`200` when ready, `503` otherwise).

### `GET /pickup/list`
Returns pickup metadata with dynamically generated `videoUrl` values (no video blob in response).

Pagination query params:
- `page` (default `1`)
- `pageSize` (default `50`, max `200`)

Response shape:
- `items`: paginated records
- `pagination`: `{ page, pageSize, total, totalPages, hasNextPage, hasPreviousPage }`

### `GET /video/:invoiceNumber`
Streams video blob with HTTP range support for HTML5 player seeking.

### `GET /video/:invoiceNumber/download`
Optional download endpoint with `Content-Disposition: attachment`.

## Example requests

List metadata:
```bash
curl "http://localhost:3000/pickup/list?page=1&pageSize=50"
```

Stream first chunk with a range request:
```bash
curl -i \
  -H "Range: bytes=0-1048575" \
  http://localhost:3000/video/INV-1001
```

Inline frontend usage:
```html
<video controls src="http://localhost:3000/video/INV-1001"></video>
```

## Streaming memory optimization

- Video is streamed in DB-backed chunks (default `1MB`) using SQL `SUBSTRING(...)` to avoid loading full blobs into Node memory.
- Configure chunk size via `STREAM_CHUNK_SIZE_BYTES`.
- Works for both normal streaming and download endpoint while preserving HTTP range behavior.

- Video endpoint sets `Content-Type` to `video/mp4` for broad player compatibility.

- Video endpoint streams directly from SQL in fixed-size chunks without caching full files in memory or on disk.

- CORS headers are enabled (`Access-Control-Allow-Origin: *`) and range headers are exposed so HTML `<video>` and third-party players can stream cross-origin.

- If source video is not MP4, endpoint attempts live-transcode to MP4 via `ffmpeg`; if ffmpeg is unavailable it still responds with MP4 headers to preserve browser inline behavior.
- If `ffmpeg` is unavailable at runtime, endpoint falls back to direct source-format streaming instead of crashing.
