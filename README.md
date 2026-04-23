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
sub2api_playground -> sub2api backend -> PostgreSQL / Redis
```

The playground does not connect to PostgreSQL or Redis directly.

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

Clone and start the playground:

```bash
git clone https://github.com/meteor041/sub2api_playground.git
cd sub2api_playground
SUB2API_UPSTREAM=http://127.0.0.1:8080 docker compose -f docker-compose.host.example.yml up -d --build
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

Clone and start the playground:

```bash
git clone https://github.com/meteor041/sub2api_playground.git
cd sub2api_playground
SUB2API_DOCKER_NETWORK=deploy_sub2api-network docker compose -f docker-compose.example.yml up -d --build
```

Then open:

```text
http://your-server-ip:8081
```

If your `sub2api` container uses a different hostname or upstream URL, override it:

```bash
SUB2API_UPSTREAM=http://sub2api:8080 docker compose -f docker-compose.example.yml up -d --build
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
