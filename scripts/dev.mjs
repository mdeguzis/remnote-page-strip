#!/usr/bin/env node
/**
 * Start the dev server on a port chosen at the command line.
 *
 *   npm run dev                  # 8080, and claims it from a sibling if need be
 *   npm run dev -- --port 8081   # binds 8081 or explains who has it
 *   npm run dev -- --port=8081
 *   PORT=8081 npm run dev
 *
 * This exists instead of a `predev` hook. npm passes the arguments after `--`
 * to the named script ONLY, so a `predev` hook would free the default port
 * while webpack bound the one you asked for. Freeing the wrong port is not a
 * harmless no-op here: free-port stops a sibling RemNote plugin's dev server on
 * purpose when it holds the port, so the mismatch takes out the server you were
 * running in the other window.
 *
 * Two DIFFERENT RemNote plugins can be developed side by side, one per port,
 * which is the reason for all of this. Two servers for the SAME plugin is never
 * wanted and is stopped automatically, because RemNote then loads it twice and
 * every button appears twice. Point RemNote's "Develop from localhost" at
 * whichever port each one prints.
 */

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { resolvePortSpec, stripPortArgs } from './port.mjs';
import { freePort, stopDuplicateServers } from './free-port.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

let spec;
try {
  spec = resolvePortSpec(args, process.env);
} catch (err) {
  console.error(`[dev] ${err.message}`);
  process.exit(1);
}
const { port } = spec;

// One dev server per project, always. Two of them means RemNote loads the
// plugin twice and shows two of every button and two sidebar tabs, which looks
// like a bug in the plugin rather than like two servers. Ours, so it is stopped
// rather than reported.
await stopDuplicateServers(port);

// A port you asked for is bound or refused; it is never taken off another
// project. Only the default port stops a sibling `remnote-*` server to claim it.
try {
  await freePort(port, { adoptSiblings: !spec.explicit });
} catch (err) {
  console.error(`[dev] ${err.message}`);
  process.exit(1);
}

const passthrough = stripPortArgs(args);
console.log(`[dev] serving on http://localhost:${port} (RemNote: Develop from localhost)`);

const child = spawn(
  process.execPath,
  [
    path.join(ROOT, 'node_modules', 'webpack-cli', 'bin', 'cli.js'),
    'serve',
    '--color',
    '--progress',
    '--port',
    String(port),
    ...passthrough,
  ],
  {
    cwd: ROOT,
    stdio: 'inherit',
    // PORT is set as well as the flag so webpack.config.cjs agrees with the
    // command line no matter which one it happens to read.
    env: { ...process.env, NODE_ENV: 'development', PORT: String(port) },
  },
);

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
