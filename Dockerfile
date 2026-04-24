# syntax=docker/dockerfile:1.7

FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
ARG VITE_SUB2API_BASE_URL=
ENV VITE_SUB2API_BASE_URL=${VITE_SUB2API_BASE_URL}
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV SUB2API_UPSTREAM=http://sub2api:8080
ENV PLAYGROUND_ENABLE_CF_IMAGE_RESIZING=false
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY server.mjs ./server.mjs
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -q -T 5 -O /dev/null http://127.0.0.1:8081/health || exit 1
CMD ["node", "server.mjs"]
