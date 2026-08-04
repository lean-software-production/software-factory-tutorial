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
# package.json requires node >=22.19.0. Same pin as the projects image.
ARG NODE_VERSION=22.22.3
# Node 22 bundles npm 10, which silently strips the `libc` field this
# repository's lockfile uses. The README tells participants to upgrade; the
# image does it for them.
ARG NPM_VERSION=11.19.0
# Pinned to the version this repository depends on, so the globally installed
# `pi` the lessons call matches the SDK the tutor engine imports.
ARG PI_VERSION=0.83.0

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
      amd64) node_arch=x64; node_sha=2e5d13569282d016861fae7c8f935e741693c269101a5bebcf761a5376d1f99f ;; \
      arm64) node_arch=arm64; node_sha=1c4a9933a5e45bc88f54f70b5f91232c127ec49f1a5989d23fb85824c7adf9b7 ;; \
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
# Layer 4: state-volume mount point
# -----------------------------------------------------------------------------
# Created here, owned by vscode, so the named volume Docker initialises from it
# inherits that ownership. Without this the fresh volume is root-owned and
# post-create.sh cannot create the config dirs inside it.
RUN install -d -o vscode -g vscode /home/vscode/.tutorial-state

# -----------------------------------------------------------------------------
# Layer 5: Environment defaults
# -----------------------------------------------------------------------------
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TERM=xterm-256color \
    COLORTERM=truecolor \
    DISABLE_AUTOUPDATER=1

USER vscode
