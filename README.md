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

## Notes

- The current backend image model is `gpt-image-2`. If the product name should be `image-gpt-2`, keep that as a display alias and send `gpt-image-2` to the backend.
- This MVP lets the browser call the gateway with a selected user API key. For production hardening, add a JWT-authenticated BFF so the browser never sees API keys.
