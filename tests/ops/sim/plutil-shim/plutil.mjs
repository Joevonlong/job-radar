#!/usr/bin/env node
// plutil for Linux test runs (tests/ops/sim/sim.mjs): -lint, -extract <key.path> raw -o -, -convert xml1 -o -.
import { plutil } from "../sim.mjs";

process.exitCode = plutil(process.argv.slice(2));
