FROM node:24-bookworm-slim

RUN npm install --global @earendil-works/pi-coding-agent@0.84.0 \
  && mkdir -p /workspace /home/learner/.pi/agent

WORKDIR /workspace
ENV HOME=/home/learner
