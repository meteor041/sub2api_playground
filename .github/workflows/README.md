# GitHub Actions

This repository ships with:

- `ci.yml`: runs `npm ci`, `npm run typecheck`, `npm run build`, and `docker build .`
- `deploy.yml`: manual production deploy over SSH

## Required GitHub Secrets

Set these repository or environment secrets before running `Deploy`:

- `DEPLOY_HOST`
- `DEPLOY_USER`
- `DEPLOY_PATH`
- `DEPLOY_SSH_KEY`

## Recommended Server Setup

Keep runtime secrets on the server, not in GitHub Actions:

- `DATABASE_URL`
- `SUB2API_UPSTREAM`
- `PLAYGROUND_PUBLIC_ORIGIN`
- `PLAYGROUND_IMAGE_CDN_BASE`
- `R2_ENDPOINT`
- `R2_BUCKET`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

The deploy workflow assumes `docker compose -f docker-compose.host.example.yml up -d --build --force-recreate`
works when run inside the checked-out repo on the server.
