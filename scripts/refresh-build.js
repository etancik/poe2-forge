#!/usr/bin/env node
"use strict";

const core = require("./refresh-build-core");

const USAGE = `Usage: node scripts/refresh-build.js --build <build.xml> [options]

Options:
  --baseline <artifact.json>       Compare against an explicit prior artifact
  --goals <goal,...>               Review goals (default: survival)
  --act <1-6>                      Confirm campaign act near a level boundary
  --area-level <level>             Prefer current area level over character level
  --enemy-level <level>            Override derived enemy level
  --enemy-distance <distance>      Enemy distance (default: 20)
  --resistance-penalty <percent>   Override campaign-derived resistance penalty
  --current-runtime <current.json> Runtime manifest pointer
  --output <artifact.json>         Full artifact destination
  --full-stdout                    Print the full artifact
  --quiet                          Suppress stdout
  --help                           Show this help`;

async function cli(argv = process.argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  await core.main();
}

if (require.main === module) {
  cli().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { ...core, USAGE, cli };
