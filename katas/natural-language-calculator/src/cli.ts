#!/usr/bin/env node

import { runCli } from "./index.js";

const status = runCli(
  process.argv.slice(2),
  (line) => console.log(line),
  (line) => console.error(line),
);

process.exitCode = status;
