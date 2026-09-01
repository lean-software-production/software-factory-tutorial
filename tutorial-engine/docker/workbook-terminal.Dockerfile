FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install --yes --no-install-recommends git jq \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global @earendil-works/pi-coding-agent@0.84.0 \
  && mkdir -p /workspace /home/learner/.pi/agent

WORKDIR /workspace
ENV HOME=/home/learner
ENV GIT_CONFIG_NOSYSTEM=1
ENV GIT_CONFIG_GLOBAL=/dev/null
ENV GIT_TERMINAL_PROMPT=0
