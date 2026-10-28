# Build context: repository root  (docker build -f frontend/Dockerfile .)
# Pinned images; the build stage needs the npm registry, the runtime image does not.

FROM node:24.18.1-alpine AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm test && npm run build

FROM nginx:1.28.3-alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
COPY docs /usr/share/nginx/docs
# Authoritative handoff and the approved prototype, served offline under /docs/handoff/
COPY handoff /usr/share/nginx/docs/handoff
COPY dist/prototype.html /usr/share/nginx/docs/handoff/prototype.html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1/healthz || exit 1
