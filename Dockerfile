# Stage 1: Build static frontend bundle (main app + /docs)
FROM node:20-bookworm-slim AS frontend
WORKDIR /src/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Build Rust server binary on Debian Bookworm (matches target runtime)
FROM rust:bookworm AS backend
RUN apt-get update \
    && apt-get install -y --no-install-recommends clang libclang-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src/backend
COPY backend/ ./
RUN cargo build --release -p meridian-server --locked

# Stage 3: Minimal Debian Bookworm runtime
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=backend /src/backend/target/release/meridian-server /usr/local/bin/meridian-server
COPY data/production.json /app/production.json
COPY --from=frontend /src/frontend/dist /app/dist
RUN mkdir -p /app/data

ENV MERIDIAN_ADDR=0.0.0.0:18420 \
    MERIDIAN_DATA_PATH=/app/production.json \
    MERIDIAN_DB_PATH=/app/data/meridian.db \
    MERIDIAN_DIST_DIR=/app/dist \
    MERIDIAN_TICK_MS=1000

EXPOSE 18420
CMD ["meridian-server"]
