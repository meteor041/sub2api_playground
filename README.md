# Sub2API Image Playground

[中文说明](./README_CN.md)

`sub2api_playground` is a standalone Vue 3 + Vite web playground for `sub2api`.

GitHub repository:

- https://github.com/meteor041/sub2api_playground.git

This project runs on a separate port, but it still relies on the existing `sub2api` backend for authentication, balance, API keys, usage logging, billing, concurrency control, and upstream routing.

## Features

- Login with an existing `sub2api` account.
- Show the current account balance.
- Select or create an OpenAI group API key.
- Chat with text models such as `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`, and `gpt-5.2`.
- Paste screenshots directly into chat or attach local image files before sending a message.
- Let the text model automatically call the image generation tool when the user explicitly asks to create an image.
- Generate images manually with `gpt-image-2`.

## Quick Start

```bash
git clone https://github.com/meteor041/sub2api_playground.git
cd sub2api_playground
npm install
npm run dev:server
npm run dev
```

The frontend dev server listens on port `5174`.
The local task/proxy server listens on port `8081`.

By default, Vite proxies these paths:

- `/api/playground` -> `http://localhost:8081`
- `/api/v1` -> `http://localhost:8080`
- `/v1` -> `http://localhost:8080`
- `/images` -> `http://localhost:8080`

If your backend or local task server runs elsewhere, override the proxy target:

```bash
VITE_SUB2API_PROXY_TARGET=http://127.0.0.1:8080 npm run dev
VITE_PLAYGROUND_SERVER_TARGET=http://127.0.0.1:8081 npm run dev
```

For production, set `VITE_SUB2API_BASE_URL` to the public `sub2api` origin, or serve this app behind the same reverse proxy as `sub2api`.

## Request Flow

```text
browser -> image-playground Node BFF -> sub2api backend
                              |-> local PostgreSQL
                              |-> mounted playground data directory
```

The browser does not connect to PostgreSQL directly. Conversation metadata is stored in the local PostgreSQL you provide through `DATABASE_URL`, while large payloads are written to the mounted playground data directory.

If `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` are all configured, uploaded images and generated images are also written to Cloudflare R2. The object key is the asset `public_token`, and `PLAYGROUND_IMAGE_CDN_BASE` should point to the public CDN prefix for that bucket.

## Async Image Tasks

Manual image generation and tool-triggered image generation now run through a lightweight Node BFF inside this repository:

```text
browser -> image-playground task server -> sub2api /v1/images/generations
```

The browser no longer holds one long Cloudflare-facing image request open. It now:

1. Creates a task
2. Receives `task_id` immediately
3. Polls task status
4. Reads image URLs or data URLs after completion

## Persistence Model

- Conversation metadata is stored in local PostgreSQL.
- Conversation snapshots are stored as JSON files under `PLAYGROUND_DATA_DIR`.
- Uploaded images and generated images are written to Cloudflare R2 when `R2_*` is configured.
- `PLAYGROUND_DATA_DIR` still stores conversation JSON files, and it can optionally keep a local asset fallback copy when `PLAYGROUND_KEEP_LOCAL_ASSETS=true`.
- Rebuilding the Docker image does not wipe data as long as PostgreSQL data and `./data/playground` are preserved.

## Docker Deployment

The Docker image builds the static frontend and serves it with the built-in Node task/proxy server on port `8081`.

It proxies these paths to the existing `sub2api` service:

- `/api/playground`
- `/api/v1`
- `/v1`
- `/images`

### Host Network Deployment

Use this mode if your existing `sub2api` container is already running with Docker host networking.

Check that `sub2api` is reachable from the host:

```bash
curl -fsS http://127.0.0.1:8080/health
```

Prepare a local PostgreSQL database first, for example `sub2api_playground`, then clone and start the playground:

```bash
git clone https://github.com/meteor041/sub2api_playground.git
cd sub2api_playground
SUB2API_UPSTREAM=http://127.0.0.1:8080 \
PLAYGROUND_IMAGE_CDN_BASE=https://img.meteor041.com/meteor-images \
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com \
R2_BUCKET=meteor-images \
R2_ACCESS_KEY_ID=your-access-key-id \
R2_SECRET_ACCESS_KEY=your-secret-access-key \
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/sub2api_playground?sslmode=disable \
docker compose -f docker-compose.host.example.yml up -d --build
```

Verify:

```bash
curl -fsS http://127.0.0.1:8081/health
```

### Bridge Network Deployment

Use this mode only if `sub2api` and `sub2api_playground` share the same Docker bridge network.

Find the Docker network used by your existing `sub2api` deployment:

```bash
docker network ls
```

If you deployed `sub2api` from its `deploy/` folder, the network is commonly named `deploy_sub2api-network`.

Prepare a local PostgreSQL database first, then clone and start the playground:

```bash
git clone https://github.com/meteor041/sub2api_playground.git
cd sub2api_playground
SUB2API_DOCKER_NETWORK=deploy_sub2api-network \
PLAYGROUND_IMAGE_CDN_BASE=https://img.meteor041.com/meteor-images \
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com \
R2_BUCKET=meteor-images \
R2_ACCESS_KEY_ID=your-access-key-id \
R2_SECRET_ACCESS_KEY=your-secret-access-key \
DATABASE_URL=postgres://postgres:postgres@host.docker.internal:5432/sub2api_playground?sslmode=disable \
docker compose -f docker-compose.example.yml up -d --build
```

Then open:

```text
http://your-server-ip:8081
```

If your `sub2api` container uses a different hostname or upstream URL, override it:

```bash
SUB2API_UPSTREAM=http://sub2api:8080 \
PLAYGROUND_IMAGE_CDN_BASE=https://img.meteor041.com/meteor-images \
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com \
R2_BUCKET=meteor-images \
R2_ACCESS_KEY_ID=your-access-key-id \
R2_SECRET_ACCESS_KEY=your-secret-access-key \
DATABASE_URL=postgres://postgres:postgres@host.docker.internal:5432/sub2api_playground?sslmode=disable \
docker compose -f docker-compose.example.yml up -d --build
```

The mounted `./data/playground` directory now contains:

- conversation snapshot JSON files
- optional local asset fallback copies when `PLAYGROUND_KEEP_LOCAL_ASSETS=true`

## R2 Configuration

Set these environment variables on the Node server container:

- `PLAYGROUND_IMAGE_CDN_BASE=https://img.meteor041.com/meteor-images`
- `R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com`
- `R2_BUCKET=meteor-images`
- `R2_REGION=auto`
- `R2_ACCESS_KEY_ID=...`
- `R2_SECRET_ACCESS_KEY=...`
- `PLAYGROUND_KEEP_LOCAL_ASSETS=false`

When `R2_*` is complete, the service uploads asset bytes to R2 during `persistAsset()`. The old `/api/playground/assets/:token` route still works: it serves the local copy when present and otherwise redirects to the CDN URL.

For historical local assets, run the one-time migration script:

```bash
npm run migrate:r2 -- --dry-run
npm run migrate:r2 -- --concurrency=8
```

## Domain Proxy

For `playground.example.com`, point the domain to `http://127.0.0.1:8081` through your reverse proxy or Cloudflare Tunnel.

If you use Cloudflare Tunnel, add a public hostname:

- Hostname: `playground.example.com`
- Service: `http://127.0.0.1:8081`

With Cloudflare Tunnel, you usually do not need to open an inbound firewall port for `8081`.

If you expose `8081` directly, open TCP `8081` in both the server firewall and the cloud provider security group.

## Notes

- The current backend image model name is `gpt-image-2`. If you want to display `image-gpt-2` in the UI, keep it as a display alias and still send `gpt-image-2` to the backend.
- The current MVP lets the browser call the gateway with a selected user API key. For production hardening, add a JWT-authenticated BFF so the browser never sees API keys.
- This repository is published separately, but it is designed to work with an existing `sub2api` deployment instead of replacing it.

## Try It Online

If you want to try a live deployment, you are welcome to visit:

- https://playground.meteor041.com
