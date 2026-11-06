#!/usr/bin/env bun
import { run } from "./cli.js";

const code = await run(process.argv.slice(2), (line) => process.stdout.write(`${line}\n`), (line) => process.stderr.write(`${line}\n`));
process.exit(code);
