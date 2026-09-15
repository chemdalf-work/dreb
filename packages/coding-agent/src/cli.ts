#!/usr/bin/env node
/**
 * CLI entry point for the coding agent.
 * Uses main.ts with AgentSession and mode modules.
 *
 * Test with: npx tsx src/cli.ts [args...]
 */
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { CLI_NAME } from "./config.js";
import { main } from "./main.js";

process.title = CLI_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;

setGlobalDispatcher(new EnvHttpProxyAgent());

main(process.argv.slice(2));
