FROM node:24-bookworm-slim

RUN useradd --create-home --uid 10001 learner \
  && npm install --global @earendil-works/pi-coding-agent@0.84.0 \
  && mkdir -p /workspace /home/learner/.pi/agent \
  && chown -R learner:learner /workspace /home/learner

USER learner
WORKDIR /workspace
ENV HOME=/home/learner
