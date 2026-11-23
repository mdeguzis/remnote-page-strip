#!/usr/bin/env node
/**
 * Free the dev server port, but only from our own server.
 *
 * webpack-dev-server dies with EADDRINUSE if anything already holds the port,
 * and the usual cause is a previous run of this project that was never stopped,
 * or was stopped in a way that left the listener behind. Restarting then fails
 * for a reason that has nothing to do with the change you just made.
 *
 * The important restriction is in the name: only OUR server. Blindly killing
 * whatever holds port 8080 would take out someone else's unrelated dev server,
 * which is a far worse failure than the one being fixed. So every candidate is
 * checked first, and anything foreign is reported and left alone.
 *
 * "Ours" means this repo OR a sibling RemNote theme. The themes share a port and
 * only one can be developed at a time, so hitting the other one's server is the
 * normal case when switching between them, not an accident. Refusing there just
 * meant reading a pid out of an error message and killing it by hand every time.
 * A sibling is identified by the `name` in the package.json above its working
 * directory, which is a much narrower signal than "something on port 8080".
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { resolvePortSpec } from './port.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** How long to wait for a terminated process to actually release the port. */
const GRACE_MS = 3000;
const POLL_MS = 100;

/**
 * PIDs listening on the port.
 *
 * lsof is the portable option and covers macOS. ss is the fallback, since many
 * Linux installs no longer ship lsof by default.
 */
function listenersOn(port) {
  const pids = new Set();

  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of out.split('\n')) {
      const pid = Number.parseInt(line.trim(), 10);
      if (Number.isInteger(pid)) pids.add(pid);
    }
    return pids;
  } catch (err) {
    if (err.code !== 'ENOENT' && err.status !== 1) throw err;
    // status 1 from lsof means "nothing matched", which is not an error here.
    if (err.status === 1) return pids;
  }

  try {
    const out = execFileSync('ss', ['-tlnp'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of out.split('\n')) {
      if (!new RegExp(`[:.]${port}\\s`).test(line)) continue;
      for (const match of line.matchAll(/pid=(\d+)/g)) {
        pids.add(Number.parseInt(match[1], 10));
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    console.warn(`[free-port] neither lsof nor ss is available, cannot check port ${port}`);
  }

  return pids;
}

/**
 * Decide whether a process belongs to this project.
 *
 * Two independent signals, either of which is enough:
 *   - its working directory is inside this repo
 *   - its command line mentions this repo's path
 *
 * The command line matters because npm spawns the server as a child, and the
 * child can end up with a different cwd than the one npm was started in.
 */
function belongsToThisProject(pid) {
  const readProc = (name) => {
    try {
      return fs.readFileSync(`/proc/${pid}/${name}`, 'utf8');
    } catch {
      return null;
    }
  };

  try {
    const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    if (cwd === ROOT || cwd.startsWith(ROOT + path.sep)) return true;
  } catch {
    // Not Linux, or the process is gone, or it is not ours to inspect.
  }

  const cmdline = readProc('cmdline');
  if (cmdline && cmdline.split('\0').join(' ').includes(ROOT)) return true;

  // On platforms without /proc, fall back to asking ps for the command line.
  if (!cmdline) {
    try {
      const out = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (out.includes(ROOT)) return true;
    } catch {
      // Nothing more to go on. Treated as foreign, which is the safe default.
    }
  }

  return false;
}

/**
 * Is this the package name of one of our RemNote projects?
 *
 * The themes and this plugin all serve on 8080 and only one can be developed at
 * a time, so hitting a sibling's server is the normal case when switching
 * between them, not an accident. Refusing there just meant reading a pid out of
 * an error message and killing it by hand every time.
 *
 * Still deliberately narrow: matching on "any node process" or "anything under
 * ~/src" would bring back exactly the failure this script exists to avoid.
 */
export function isThemeProjectName(name) {
  return typeof name === 'string' && /^remnote-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

/**
 * The package name of the project a process is running in, if any.
 *
 * Walks up from the process working directory looking for a package.json. The
 * server is started from the repo root in practice, but a couple of levels of
 * tolerance costs nothing and covers being launched from a subdirectory.
 */
function projectNameOf(pid) {
  let dir;
  try {
    dir = fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }

  for (let depth = 0; depth < 6 && dir && dir !== path.parse(dir).root; depth++) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      try {
        return JSON.parse(fs.readFileSync(manifest, 'utf8')).name ?? null;
      } catch {
        return null;
      }
    }
    dir = path.dirname(dir);
  }

  return null;
}

/** A dev server from one of our other themes, rather than from this repo. */
function belongsToSiblingTheme(pid) {
  const name = projectNameOf(pid);
  return isThemeProjectName(name) ? name : null;
}

/**
 * Every TCP listener on this machine, as { pid, port }.
 *
 * Unlike `listenersOn`, this does not take a port: the question it answers is
 * "is this project already serving ANYWHERE", which is the one that matters for
 * refusing to start a second copy.
 */
function allListeners() {
  const found = [];

  const addFromSs = (out) => {
    for (const line of out.split('\n')) {
      // Local address is the fourth column, "addr:port" with IPv6 in brackets.
      const cols = line.trim().split(/\s+/);
      if (cols.length < 5) continue;
      const local = cols[3];
      const portMatch = local.match(/:(\d+)$/);
      if (!portMatch) continue;
      const port = Number(portMatch[1]);
      for (const m of line.matchAll(/pid=(\d+)/g)) {
        found.push({ pid: Number.parseInt(m[1], 10), port });
      }
    }
  };

  try {
    addFromSs(execFileSync('ss', ['-tlnp'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    return found;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  try {
    const out = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of out.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 9) continue;
      const pid = Number.parseInt(cols[1], 10);
      const portMatch = cols[8].match(/:(\d+)$/);
      if (!Number.isInteger(pid) || !portMatch) continue;
      found.push({ pid, port: Number(portMatch[1]) });
    }
  } catch (err) {
    if (err.code !== 'ENOENT' && err.status !== 1) throw err;
  }

  return found;
}

/**
 * Dev servers already running for THIS repo, on any port.
 *
 * One plugin must have exactly one dev server. Two of them means RemNote loads
 * the plugin twice and you get two of every button and two sidebar tabs, which
 * reads as a bug in the plugin rather than as two servers. It is easy to cause:
 * start on 8080, later start on 8081, and now both are up.
 */
export function ourDevServers() {
  const seen = new Map();
  for (const { pid, port } of allListeners()) {
    if (!belongsToThisProject(pid)) continue;
    if (!seen.has(pid)) seen.set(pid, { pid, port });
  }
  return [...seen.values()];
}

/**
 * Stop any dev server this repo already has running, whatever port it is on.
 *
 * Stopping is the right move rather than refusing: the server is ours, nobody
 * else is using it, and two copies of the same plugin is never what anybody
 * wanted. Reported by port so it is obvious what happened.
 */
export async function stopDuplicateServers(keepPort) {
  const duplicates = ourDevServers().filter((s) => s.port !== keepPort);
  if (duplicates.length === 0) return [];

  for (const { pid, port } of duplicates) {
    console.log(`[free-port] this project is already serving on ${port}; stopping it so RemNote only loads one copy`);
    console.log(`[free-port]   ${pid}  ${describe(pid)}`);
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      if (err.code !== 'ESRCH') throw err;
    }
  }

  const deadline = Date.now() + GRACE_MS;
  while (Date.now() < deadline) {
    if (duplicates.every(({ port }) => listenersOn(port).size === 0)) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  for (const { pid } of duplicates) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (err) {
      if (err.code !== 'ESRCH') throw err;
    }
  }

  return duplicates;
}

function describe(pid) {
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
    return cmd.slice(0, 90) || `pid ${pid}`;
  } catch {
    return `pid ${pid}`;
  }
}

function stillListening(port) {
  return listenersOn(port).size > 0;
}

/**
 * Free `port`, or throw explaining why it could not be.
 *
 * Throws rather than calling process.exit, because `scripts/dev.mjs` awaits
 * this and needs the chance to report the failure as its own. The port is a
 * parameter and not read from the environment here for the reason set out in
 * `port.mjs`: two readers of the same setting eventually disagree, and the way
 * that surfaces is a sibling plugin's dev server being killed.
 *
 * `adoptSiblings` is what makes a named port behave the way naming a port
 * implies. On the DEFAULT port, a sibling `remnote-*` server is in the way by
 * accident and stopping it is a courtesy, because only one plugin can have 8080.
 * On a port you asked for, stopping a sibling would defeat the entire reason you
 * asked: `--port 8082` means "run this one as well as that one". So an explicit
 * port never reaches across. It binds, or it says who is in the way.
 */
export async function freePort(port, { adoptSiblings = true } = {}) {
  const PORT = port;
  const pids = listenersOn(PORT);
  if (pids.size === 0) return;

  const ours = [...pids].filter(belongsToThisProject);
  const allSiblings = [...pids]
    .filter((pid) => !ours.includes(pid))
    .map((pid) => ({ pid, project: belongsToSiblingTheme(pid) }))
    .filter((entry) => entry.project !== null);

  // On a named port a sibling is treated exactly like any other stranger: left
  // alone, and reported as the thing standing in the way.
  const siblings = adoptSiblings ? allSiblings : [];
  const blockers = [...pids].filter(
    (pid) => !ours.includes(pid) && !siblings.some((entry) => entry.pid === pid)
  );

  if (blockers.length > 0) {
    // Deliberately not killed. Something else is using the port, and on a port
    // that was asked for by name that is very likely on purpose.
    console.error(`[free-port] port ${PORT} is already in use:`);
    for (const pid of blockers) {
      const project = allSiblings.find((entry) => entry.pid === pid)?.project;
      console.error(`             ${pid}  ${project ? `${project}: ` : ''}${describe(pid)}`);
    }
    console.error(`[free-port] stop it yourself, or pick another port: npm run dev -- --port 8082`);
    throw new Error(`port ${PORT} is already in use`);
  }

  // Stopping another project's server is a real side effect, so it is reported
  // by name rather than folded in silently with our own leftovers.
  for (const { pid, project } of siblings) {
    console.log(`[free-port] port ${PORT} is held by ${project}; stopping it to take over`);
    console.log(`[free-port]   ${pid}  ${describe(pid)}`);
  }

  const toStop = [...ours, ...siblings.map((entry) => entry.pid)];

  for (const pid of ours) {
    console.log(`[free-port] stopping previous dev server ${pid} (${describe(pid)})`);
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      if (err.code !== 'ESRCH') throw err;
    }
  }

  for (const { pid } of siblings) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      if (err.code !== 'ESRCH') throw err;
    }
  }

  // Wait for the port to actually come free. Exiting early just moves the
  // EADDRINUSE to the next command.
  const deadline = Date.now() + GRACE_MS;
  while (Date.now() < deadline) {
    if (!stillListening(PORT)) {
      console.log(`[free-port] port ${PORT} released`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  console.warn(`[free-port] still held after ${GRACE_MS}ms, sending SIGKILL`);
  for (const pid of toStop) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (err) {
      if (err.code !== 'ESRCH') throw err;
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 300));
  if (stillListening(PORT)) {
    throw new Error(`could not free port ${PORT}`);
  }
  console.log(`[free-port] port ${PORT} released`);
}

// Only when run as a command. This module exports helpers that tests import,
// and an unguarded call meant importing it KILLED whatever dev server happened
// to be running -- found exactly that way.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  // Usable on its own: `node scripts/free-port.mjs --port 8082`.
  const spec = resolvePortSpec(process.argv.slice(2), process.env);
  freePort(spec.port, { adoptSiblings: !spec.explicit }).catch((err) => {
    console.error(`[free-port] ${err.message}`);
    process.exit(1);
  });
}
