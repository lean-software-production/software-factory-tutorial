FROM mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm

RUN apt-get update \
    && apt-get install --yes --no-install-recommends graphviz \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global pnpm@10.6.5 @earendil-works/pi-coding-agent@0.83.0
