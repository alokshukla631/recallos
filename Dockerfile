# RecallOS - multi-stage Docker build
# Runs both backend (port 3001) and frontend (port 5173) in one container.

FROM node:20-slim AS base
WORKDIR /app
RUN corepack enable

# ── Install dependencies ─────────────────────────────────────────────────────

FROM base AS deps

# Root
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Backend
COPY backend/package.json backend/package-lock.json* ./backend/
RUN cd backend && npm ci --ignore-scripts

# Frontend
COPY frontend/package.json frontend/package-lock.json* ./frontend/
RUN cd frontend && npm ci --ignore-scripts

# ── Build frontend ───────────────────────────────────────────────────────────

FROM deps AS build-frontend
COPY frontend/ ./frontend/
RUN cd frontend && npx vite build

# ── Build backend ────────────────────────────────────────────────────────────

FROM deps AS build-backend
COPY backend/ ./backend/
RUN cd backend && npx tsc

# ── Production image ─────────────────────────────────────────────────────────

FROM base AS production

# Copy built backend
COPY --from=build-backend /app/backend/dist ./backend/dist
COPY --from=build-backend /app/backend/package.json ./backend/
COPY --from=deps /app/backend/node_modules ./backend/node_modules

# Copy built frontend (static files served by express in production)
COPY --from=build-frontend /app/frontend/dist ./frontend/dist

# Copy root package files
COPY package.json ./

# Production express static-serve wrapper
COPY docker-entrypoint.js ./

ENV NODE_ENV=production
ENV PORT=3001
ENV DB_PATH=/data/recallos.db

VOLUME ["/data"]
EXPOSE 3001

CMD ["node", "docker-entrypoint.js"]
