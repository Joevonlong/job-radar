#!/usr/bin/env node
// The launchctl of the service-manager simulator (tests/ops/sim/sim.mjs); never the real one.
import { launchctl } from "./sim.mjs";

process.exitCode = await launchctl(process.argv.slice(2));
