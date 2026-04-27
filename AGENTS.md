# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the Vue 3 frontend: `main.ts` boots the app, `App.vue` holds the main UI flow, and shared request/types code lives in `api.ts` and `types.ts`. `server.mjs` is the Node BFF that serves `dist/`, proxies upstream API calls, manages image tasks, and persists playground data. `mock/playgroundMock.ts` powers local mock mode. Static assets live in `asset/`. Runtime conversation data is stored under `data/playground/`. One-off maintenance scripts belong in `scripts/`.

## Build, Test, and Development Commands
Use `npm install` once to install dependencies. `npm run dev` starts the Vite frontend on `5174`. `npm run dev:server` starts the local Node server on `8081`. `npm run dev:mock` runs the frontend in mock mode without a real backend. `npm run typecheck` runs `vue-tsc --noEmit`. `npm run build` performs type-checking and creates the production bundle. `npm run preview` serves the built frontend locally. `npm run migrate:r2 -- --dry-run` previews asset migration work before changing remote storage.

## Coding Style & Naming Conventions
Use TypeScript with strict typing and ES module syntax. Follow the existing 2-space indentation, no-semicolon style, and single-quote strings seen in [`src/App.vue`](/root/sub2api_playground/src/App.vue) and [`server.mjs`](/root/sub2api_playground/server.mjs). Use `camelCase` for variables and functions, `PascalCase` for Vue components, and `SCREAMING_SNAKE_CASE` for persistent keys and env-driven constants. Keep new modules focused; place frontend-only helpers in `src/` and server-only helpers near `server.mjs`.

## Testing Guidelines
There is no dedicated automated test suite checked in yet. Before opening a PR, run `npm run typecheck` and `npm run build`, then smoke-test the affected flow in either `npm run dev` or `npm run dev:mock`. For UI changes, verify login, conversation loading, and image generation or editing paths relevant to the change. If you add automated tests, keep them close to the feature and name them `*.test.ts`.

## Commit & Pull Request Guidelines
Match the current Git history: short, imperative commit subjects such as `Fix gallery pagination refresh timing` or `Add more image aspect ratios`. Keep each commit scoped to one change. PRs should explain the user-visible impact, list verification commands run, reference related issues, and include screenshots or short recordings for UI changes. Call out any required env vars or migration steps clearly.

### Agent Commit Rule
When an agent makes code changes for the user, it should stage and create a git commit by default at the end of the task unless the user explicitly says not to commit. Use a short, imperative commit subject scoped to the change.
