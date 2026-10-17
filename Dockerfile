FROM golang:1.27.2-bookworm AS source
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .

FROM source AS test
RUN test -z "$(gofmt -l cmd internal)" && go vet ./... && go test -race -count=1 -timeout 90s ./...

FROM source AS build
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/kiln ./cmd/kiln

FROM rust:1.99.0-slim-bookworm AS rust
RUN rustup component add rustfmt clippy \
    && mv "$(rustc --print sysroot)" /opt/rust \
    && chmod -R go-w /opt/rust

FROM debian:bookworm-slim AS runtime
# Operating system libraries come from the image; language toolchains follow the
# repository through mise. Rust stays image-owned: direct binaries need neither
# rustup nor a writable home.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates git gh python3 curl xz-utils unzip bash \
        build-essential pkg-config file wget libssl-dev \
        libwebkit2gtk-4.1-dev libxdo-dev libayatana-appindicator3-dev librsvg2-dev \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 kiln
COPY --from=rust /opt/rust /opt/rust
RUN for tool in /opt/rust/bin/*; do ln -s "$tool" "/usr/local/bin/$(basename "$tool")"; done
# ghcr.io/jdx/mise:2026.10.6 multi-platform index, pinned by digest.
COPY --from=ghcr.io/jdx/mise@sha256:43da01dfa58171bbe62bd033b557007b2268d61ec06d24378e6d06307faa6f1e /usr/local/bin/mise /usr/local/bin/mise
COPY deploy/mise.toml /etc/mise/config.toml
COPY deploy/profile.d.sh /etc/profile.d/kiln-toolchains.sh
# Shared, writable caches live on the data volume. The daemon forwards these
# through inherit_env; each run still gets a private HOME and TMPDIR.
ENV MISE_DATA_DIR=/data/cache/mise MISE_CACHE_DIR=/data/cache/mise/cache \
    CARGO_HOME=/data/cache/cargo RUSTUP_HOME=/data/cache/rustup \
    GOMODCACHE=/data/cache/go/mod GOCACHE=/data/cache/go/build \
    COREPACK_HOME=/data/cache/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    npm_config_cache=/data/cache/npm \
    PIP_CACHE_DIR=/data/cache/pip \
    PATH=/data/cache/mise/shims:/usr/local/share/mise/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    PI_TELEMETRY=0 HOME=/data/home
# Read-only system installs of the defaults, so a fresh deployment works offline.
RUN mise install --system node@24.21.0 pnpm@10.33.0 go@1.27.2 \
    && MISE_SHIMS_DIR=/usr/local/share/mise/shims mise reshim \
    && test -x /usr/local/share/mise/shims/node -a -x /usr/local/share/mise/shims/go -a -x /usr/local/share/mise/shims/pnpm \
    && chmod -R go-w /usr/local/share/mise
# Agent runtimes run on their own Node, independent of any repository's pin.
COPY harness/package.json harness/package-lock.json /opt/kiln-agents/
RUN NODE=/usr/local/share/mise/installs/node/24.21.0/bin/node \
    && PATH="$(dirname "$NODE"):$PATH" npm ci --prefix /opt/kiln-agents --omit=dev \
    && rm -rf /root/.npm \
    && for tool in pi codex; do \
         printf '#!/bin/sh\nexec %s /opt/kiln-agents/node_modules/.bin/%s "$@"\n' "$NODE" "$tool" > "/usr/local/bin/$tool" \
         && chmod 0755 "/usr/local/bin/$tool"; \
       done
RUN mkdir -p /data/home /data/cache /etc/kiln && chown -R kiln:kiln /data
COPY --from=build /out/kiln /usr/local/bin/kiln
COPY deploy/container.yaml /etc/kiln/server.yaml
USER kiln
WORKDIR /data
EXPOSE 8741
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD curl --fail --silent http://127.0.0.1:8741/healthz || exit 1
ENTRYPOINT ["kiln"]
CMD ["serve", "-config", "/etc/kiln/server.yaml"]
