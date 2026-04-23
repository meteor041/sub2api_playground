# Image Playground

`image-playground` is a standalone web playground that runs beside `sub2api` on a separate port.

It does not connect to PostgreSQL or Redis directly. Login, balance, API keys, usage recording, billing, concurrency, and upstream routing all go through the existing `sub2api` backend.

## Features In This MVP

- Login with an existing `sub2api` user account.
- Show current balance.
- Select or create an OpenAI group API key.
- Chat with text models such as `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, and `gpt-5.3-codex-spark`.
- Generate images manually with `gpt-image-2`.

## Development

```bash
cd image-playground
npm install
npm run dev
```

The dev server listens on port `5174`.

By default, Vite proxies these paths to `http://localhost:8080`:

- `/api/v1`
- `/v1`
- `/images`

Override the backend URL if needed:

```bash
VITE_SUB2API_PROXY_TARGET=http://127.0.0.1:8080 npm run dev
```

For production, set `VITE_SUB2API_BASE_URL` to the public `sub2api` origin, or serve this app behind the same reverse proxy as `sub2api`.

## Docker Deployment

The Docker image builds the static frontend and serves it with Nginx on port `8081`.

It also proxies these paths to the existing `sub2api` container:

- `/api/v1`
- `/v1`
- `/images`

No PostgreSQL or Redis settings are needed here. The request flow is:

```text
image-playground -> sub2api backend -> PostgreSQL / Redis
```

### Host Network Deployment

Use this mode if your existing `sub2api` container is running with Docker host networking.

Check that `sub2api` is reachable from the host:

```bash
curl -fsS http://127.0.0.1:8080/health
```

Check that the playground port is free:

```bash
ss -ltnp | grep ':8081' || true
```

Deploy:

```bash
git clone <your-image-playground-repo-url>
cd image-playground
SUB2API_UPSTREAM=http://127.0.0.1:8080 docker compose -f docker-compose.host.example.yml up -d --build
```

Verify:

```bash
curl -fsS http://127.0.0.1:8081/health
```

### Bridge Network Deployment

Use this mode only if `sub2api` and `image-playground` share a Docker bridge network.

Find the Docker network used by your existing `sub2api` deployment:

```bash
docker network ls
```

If you deployed `sub2api` from its `deploy/` folder, the network is commonly named `deploy_sub2api-network`.

Deploy this playground on the server:

```bash
git clone <your-image-playground-repo-url>
cd image-playground
SUB2API_DOCKER_NETWORK=deploy_sub2api-network docker compose -f docker-compose.example.yml up -d --build
```

Then open:

```text
http://your-server-ip:8081
```

If your `sub2api` container has a different name or URL, override the upstream:

```bash
SUB2API_UPSTREAM=http://sub2api:8080 docker compose -f docker-compose.example.yml up -d --build
```

## Domain Proxy

For `playground.meteor041.com`, point the domain to `http://127.0.0.1:8081` in your reverse proxy or Cloudflare Tunnel.

If you use Cloudflare Tunnel, add a public hostname:

- Hostname: `playground.meteor041.com`
- Service: `http://127.0.0.1:8081`

With Cloudflare Tunnel, you usually do not need to open an inbound firewall port for `8081`.

If you expose `8081` directly, open TCP `8081` in both the server firewall and the cloud provider security group.

## Notes

- The current backend image model is `gpt-image-2`. If the product name should be `image-gpt-2`, keep that as a display alias and send `gpt-image-2` to the backend.
- This MVP lets the browser call the gateway with a selected user API key. For production hardening, add a JWT-authenticated BFF so the browser never sees API keys.
