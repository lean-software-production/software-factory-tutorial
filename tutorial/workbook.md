---
parts:
  - id: what-is-a-factory
    lessons:
      - what-is-a-factory
      - tetris
  - id: validation-loop
    lessons:
      - 001-run-an-agent-headlessly
      - 002-build-a-doer
      - 003-build-a-validator
      - 004-feed-the-findings-back
  - id: build-the-factory
    lessons:
      - 005-join-them-into-a-line
      - 006-read-only-validator
      - 007-compose-and-branch
      - 008-take-the-pause-off
      - 009-record-what-happened
      - 010-watch-it-while-it-runs
      - 011-ask-what-happened
      - 012-talk-to-a-station
      - 013-oversee-the-orchestrator
---

# Software Factory Tutorial

Welcome! 👋

In this tutorial, we're going to build our own little software factory, step by step,
from fundamental building blocks.

Software factories can take on many forms, and deliver a variety of products. The most
obvious one is working features, but that is [not the place to start](https://web.navan.dev/posts/2026-05-06-how-to-build-your-own-software-factory.html#what-are-you-manufacturing).

Here are some other examples of things you can build software factories to produce:

* automatically upgrade dependencies and frameworks in your codebase
* proactively seek security vulnerabilities and patch them
* port a library from Go to Rust
* discover, triage and fix flickering tests

Here, we're going to build a factory that refactors a codebase
that's got into a bit of a mess.

But I'm getting ahead of myself. Let's start by getting on the same page about what a factory is.
