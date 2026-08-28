# EBARTNET-UI — web preview, Docker/Linux target (Phase E3).
#
# This image runs only src/server/index.js, the http+ws bridge from Phase
# E1/E2. Electron itself is never installed here — everything in
# package.json's devDependencies (electron, electron-builder, eslint) is
# skipped by --omit=dev, and LocalCliBridge (the `search --lms` shortcut
# wired into Electron's terminal PTY) has no web equivalent and was already
# left out server-side in Phase E2.
#
# Two stages: node-pty's native build needs a real C/C++ toolchain
# (build-essential/python3/make/g++, ~700MB installed), but that toolchain
# is never touched again once node_modules/node-pty/build exists — only the
# compiled .node binary matters at runtime. Building it in a throwaway
# `builder` stage and copying just node_modules into a clean node:22-slim
# final stage keeps that ~700MB out of the image that actually ships.
FROM node:22-slim AS builder

# python3/make/g++ are node-gyp's actual toolchain requirements, not
# node-pty-specific.
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
# --ignore-scripts: package.json's own "postinstall" runs
# `electron-builder install-app-deps --arch=arm64` — Electron/macOS-only,
# hardcoded to arm64, and electron-builder isn't even installed here
# (--omit=dev skips devDependencies) — it would fail the build outright.
# node-pty's own native build happens explicitly right after instead,
# scoped to just that one package, for whatever arch this image is on.
RUN npm ci --omit=dev --ignore-scripts \
  && npm rebuild node-pty

FROM node:22-slim

# `systeminformation`'s process list (TOP PROCESSES) shells out to `ps` on
# Linux — node:22-slim doesn't ship procps at all, so without this the panel
# is silently empty forever, not just missing the macOS-only bits (GPU,
# energy impact) Phase E3 is actually about. Found by testing in this same
# container, not called out in the original brief.
RUN apt-get update \
  && apt-get install -y --no-install-recommends procps \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
# Only what src/server/index.js actually serves or requires — no dist/,
# docs/, test/, session-logs/ (see .dockerignore for the full exclusion
# list). resources/ ships the local-CLI-bridge binaries; the web server
# doesn't wire them in today (Electron-only, see above) but costs nothing
# to have on hand.
COPY src/ ./src/
COPY resources/ ./resources/

# /data is the mount point docker-compose.yml's named volume targets.
# Pre-creating and owning it here (as root, before USER node below) is what
# lets that volume work under a non-root user — Docker seeds a fresh named
# volume's initial content from whatever already exists at the mount point
# in the image, permissions included.
RUN mkdir -p /data && chown -R node:node /data
ENV EDEX_WEB_DATA=/data

EXPOSE 3040

# 0.0.0.0: required for the container's own network namespace — 127.0.0.1
# inside a container is unreachable from the host or from a published port.
# docker-compose.yml's `127.0.0.1:3040:3040` port mapping is what keeps this
# loopback-only from the *host's* point of view; nothing here is meant to be
# exposed straight to the internet (Cloudflare Tunnel or an SSH tunnel goes
# in front of it instead — see docker-compose.yml).
ENV EDEX_WEB_BIND=0.0.0.0
ENV EDEX_WEB_PORT=3040

USER node

CMD ["node", "src/server/index.js"]
