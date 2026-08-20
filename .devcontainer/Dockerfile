# syntax=docker/dockerfile:1
#
# Devcontainer image for lean-software-production/software-factory-tutorial.
#
# Shape and pinning style follow lean-software-production/projects'
# .devcontainer/Dockerfile — pinned versions, sha-verified downloads, one
# concern per layer — trimmed to what this tutorial actually needs: Node.js,
# npm 11, and the Pi CLI. No Python, no Bun, no second coding agent: the
# lessons drive `pi -p` and the tutor is a Node process.

FROM mcr.microsoft.com/devcontainers/base:bookworm

ARG TARGETARCH
# package.json requires node >=24.2.0 <25. Below 24.2 the `npm run setup`
# preflight silently no-ops, and Node 23 emits an experimental-feature warning
# on stderr that fails the calculator's own test suite.
ARG NODE_VERSION=24.19.0
# Node 24 already bundles npm 11; pinning it keeps the image reproducible rather
# than inheriting whatever the Node tarball happened to ship.
ARG NPM_VERSION=11.19.0
# Pinned to the version this repository depends on, so the globally installed
# `pi` the lessons call matches the SDK the tutor engine imports.
ARG PI_VERSION=0.83.0
# Go release installed below; pin it with its matching SHA-256 per architecture.
ARG ADRGEN_VERSION=0.4.1-beta

# -----------------------------------------------------------------------------
# Layer 1: OS utilities
# -----------------------------------------------------------------------------
# The base image already ships git, curl and the vscode user; xz-utils is what
# the Node tarball needs and ca-certificates keeps the download verifiable.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    ca-certificates curl xz-utils \
    && rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# Layer 2: Node.js (sha-verified tarball)
# -----------------------------------------------------------------------------
RUN case "${TARGETARCH}" in \
      amd64) node_arch=x64; node_sha=14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647 ;; \
      arm64) node_arch=arm64; node_sha=01443c1e1a29e531ccad5a46fefa6df490d2189c49f7955904aecdbb0fe86fdc ;; \
      *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && archive="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${archive}" -o "/tmp/${archive}" \
    && echo "${node_sha}  /tmp/${archive}" | sha256sum -c - \
    && tar -xJf "/tmp/${archive}" -C /usr/local --strip-components=1 \
    && rm "/tmp/${archive}"

# -----------------------------------------------------------------------------
# Layer 3: npm 11 and the Pi CLI
# -----------------------------------------------------------------------------
# npm's update notifier prints a "new major version available" banner on every
# invocation — during this build, during post-create, and in every lesson that
# runs a script. NPM_VERSION is a deliberate pin, so the banner is noise;
# turning it off here rather than in layer 5 keeps the build output quiet too.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

# Installing the CLI ships no credentials — each participant still runs
# `pi` and `/login` themselves, and those credentials land in the state volume
# (see devcontainer.json) rather than the container filesystem, so a rebuild
# doesn't force a re-auth.
RUN npm install -g "npm@${NPM_VERSION}" \
    && npm install -g --include=optional \
    "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    && npm cache clean --force

# -----------------------------------------------------------------------------
# Layer 4: ADR generator
# -----------------------------------------------------------------------------
# The Go release ships a static Linux binary for both devcontainer target
# architectures. Verify the publisher's checksum before putting it on PATH.
RUN case "${TARGETARCH}" in \
      amd64) adrgen_arch=x86_64; adrgen_sha=36b29d5c9d84789d889b722b62c95a0d651473490a865e7bd04b36b09fb57b65 ;; \
      arm64) adrgen_arch=arm64; adrgen_sha=f39cafff77f69805506f3484f8cd0d3617f66a3592da35a6f2b7ccba3257298e ;; \
      *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && archive="adrgen_Linux_${adrgen_arch}.tar.gz" \
    && curl -fsSL "https://github.com/asiermarques/adrgen/releases/download/v${ADRGEN_VERSION}/${archive}" \
        -o "/tmp/${archive}" \
    && echo "${adrgen_sha}  /tmp/${archive}" | sha256sum -c - \
    && tar -xzf "/tmp/${archive}" -C /tmp adrgen \
    && install /tmp/adrgen /usr/local/bin/adrgen \
    && rm "/tmp/${archive}" /tmp/adrgen

# -----------------------------------------------------------------------------
# Layer 5: state-volume mount point
# -----------------------------------------------------------------------------
# Created here, owned by vscode, so the named volume Docker initialises from it
# inherits that ownership. Without this the fresh volume is root-owned and
# post-create.sh cannot create the config dirs inside it.
RUN install -d -o vscode -g vscode /home/vscode/.tutorial-state

# -----------------------------------------------------------------------------
# Layer 6: Environment defaults
# -----------------------------------------------------------------------------
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TERM=xterm-256color \
    COLORTERM=truecolor \
    DISABLE_AUTOUPDATER=1

USER vscode
