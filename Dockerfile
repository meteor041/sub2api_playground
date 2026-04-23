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

FROM nginx:1.27-alpine
ENV SUB2API_UPSTREAM=http://sub2api:8080
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -q -T 5 -O /dev/null http://127.0.0.1:8081/health || exit 1
