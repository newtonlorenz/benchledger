#!/usr/bin/env node
import { runImportCommand, usageText } from "./import-command.js";

const output = await runImportCommand(process.argv.slice(2));
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(`${usageText()}\n`);
  process.exitCode = 0;
} else {
  process.stdout.write(output.stdout);
  process.stderr.write(output.stderr);
  process.exitCode = output.exitCode;
}
