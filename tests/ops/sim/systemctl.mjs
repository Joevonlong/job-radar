#!/usr/bin/env node
// The systemctl of the service-manager simulator (tests/ops/sim/sim.mjs); never the real one.
import { systemctl } from "./sim.mjs";

process.exitCode = await systemctl(process.argv.slice(2));
