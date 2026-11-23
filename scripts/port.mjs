#!/usr/bin/env node
/**
 * Where the dev server port comes from, in one place.
 *
 * It has to be one place because two different things need the answer and they
 * get their arguments differently: webpack-dev-server, and the script that
 * frees the port before it starts. When those two disagree, the freeing step
 * kills a server on one port while webpack binds another, and on this machine
 * the victim is usually a SIBLING RemNote plugin's dev server, because
 * free-port deliberately stops those to take the port over.
 *
 * That is exactly what npm's lifecycle hooks cause. `npm run dev -- --port 8082`
 * passes the flag to `dev` only; `predev` runs with no arguments at all and
 * happily frees the default. So there is no `predev` any more: `scripts/dev.mjs`
 * resolves the port once and drives both halves itself.
 */

/**
 * This plugin's port.
 *
 * 8082 rather than the 8080 every RemNote template ships with, because
 * `remnote-laps` and the themes live on 8080 and `remnote-in-the-margins` on
 * 8081, and the default port is the one a plain
 * `npm run dev` will take from a sibling project. Giving each plugin its own
 * default is what stops the two of them fighting over one port and, worse, what
 * stops RemNote ending up with a "Develop from localhost" entry for each and
 * loading a plugin twice.
 *
 * One plugin, one default port. Write it down here rather than expecting anyone
 * to remember a flag.
 */
export const DEFAULT_PORT = 8082;

/**
 * The port AND whether the user actually asked for it.
 *
 * The difference matters. On the default port, a leftover server from a sibling
 * `remnote-*` project is in the way by accident and stopping it is a courtesy.
 * On a port you named, it is not in the way by accident: naming a port is how
 * you say "run this one alongside the other one", so taking that port by force
 * would defeat the only reason to pass the flag. `--port 8082` binds 8082 or
 * says why it cannot. It never reaches across and stops somebody else.
 */
export function resolvePortSpec(argv = [], env = {}) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--port') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--port needs a number, for example --port 8082');
      return { port: parsePort(value, '--port'), explicit: true, source: '--port' };
    }

    if (arg.startsWith('--port=')) {
      return { port: parsePort(arg.slice('--port='.length), '--port'), explicit: true, source: '--port' };
    }
  }

  if (env.PORT !== undefined && env.PORT !== '') {
    return { port: parsePort(env.PORT, 'PORT'), explicit: true, source: 'PORT' };
  }

  return { port: DEFAULT_PORT, explicit: false, source: 'default' };
}

/**
 * Just the port number.
 *
 * Accepts `--port 8082` and `--port=8082`, because both are things people type
 * and failing on one of them is a pointless papercut. `PORT=8082 npm run dev`
 * keeps working and is the lower priority of the two: an explicit flag on the
 * command you just typed should beat an environment variable you may have
 * exported an hour ago.
 *
 * Pure, so it can be tested without spawning anything.
 */
export function resolvePort(argv = [], env = {}) {
  return resolvePortSpec(argv, env).port;
}

function parsePort(value, source) {
  const port = Number(value);
  // Number('') is 0 and Number('80x') is NaN; neither is a port, and letting
  // either through gives an error from deep inside the dev server instead.
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${source} must be a whole number between 1 and 65535, got "${value}"`);
  }
  return port;
}

/** Everything except the --port flag, to hand on to whatever runs next. */
export function stripPortArgs(argv = []) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') {
      i++; // also drop its value
      continue;
    }
    if (argv[i].startsWith('--port=')) continue;
    out.push(argv[i]);
  }
  return out;
}
