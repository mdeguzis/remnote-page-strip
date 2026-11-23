import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PORT, resolvePort, resolvePortSpec, stripPortArgs } from '../scripts/port.mjs';

/*
 * Two things resolve this port: webpack, and the script that frees the port
 * before webpack starts. If they ever disagree, the freeing step stops a server
 * on one port while webpack binds another, and on this machine the casualty is
 * usually a sibling RemNote plugin's dev server. So the resolution rule is
 * tested rather than assumed.
 */

test('with nothing given, this plugin defaults to its own port', () => {
  // 8082, not the template's 8080: remnote-laps has 8080, margins 8081, and a plain
  // `npm run dev` claims its default port from a sibling project.
  assert.equal(resolvePort([], {}), DEFAULT_PORT);
  assert.equal(DEFAULT_PORT, 8082);
});

test('both --port spellings are accepted', () => {
  assert.equal(resolvePort(['--port', '8090'], {}), 8090);
  assert.equal(resolvePort(['--port=8090'], {}), 8090);
});

test('the flag wins over the environment', () => {
  // An explicit flag on the command you just typed should beat a PORT you may
  // have exported an hour ago.
  assert.equal(resolvePort(['--port', '8090'], { PORT: '9000' }), 8090);
});

test('PORT is used when there is no flag', () => {
  assert.equal(resolvePort([], { PORT: '9000' }), 9000);
});

test('an empty PORT is ignored rather than read as 0', () => {
  // Number('') is 0, which is not a port and would fail somewhere much later.
  assert.equal(resolvePort([], { PORT: '' }), DEFAULT_PORT);
});

test('the flag is found among other arguments', () => {
  assert.equal(resolvePort(['--hot', '--port', '8082', '--progress'], {}), 8082);
});

test('a port that is not a port is refused up front', () => {
  assert.throws(() => resolvePort(['--port', '80x'], {}), /--port/);
  assert.throws(() => resolvePort(['--port', '0'], {}), /--port/);
  assert.throws(() => resolvePort(['--port', '70000'], {}), /--port/);
  assert.throws(() => resolvePort(['--port'], {}), /needs a number/);
  assert.throws(() => resolvePort([], { PORT: 'nope' }), /PORT/);
});

test('stripPortArgs removes the flag and its value, leaving the rest', () => {
  assert.deepEqual(stripPortArgs(['--hot', '--port', '8090', '--progress']), ['--hot', '--progress']);
  assert.deepEqual(stripPortArgs(['--port=8090', '--hot']), ['--hot']);
  assert.deepEqual(stripPortArgs(['--hot']), ['--hot']);
});

test('stripPortArgs does not eat an argument that merely starts with --port', () => {
  assert.deepEqual(stripPortArgs(['--portal', '--hot']), ['--portal', '--hot']);
});

/*
 * `explicit` decides whether the freeing step is allowed to stop a sibling
 * remnote-* project's dev server. Naming a port means "run alongside", so a
 * named port must never be taken by force. Getting this backwards silently
 * kills the server in the other terminal, which is why it is tested.
 */

test('a named port is explicit, whichever way it was named', () => {
  assert.deepEqual(resolvePortSpec(['--port', '8090'], {}), { port: 8090, explicit: true, source: '--port' });
  assert.deepEqual(resolvePortSpec(['--port=8090'], {}), { port: 8090, explicit: true, source: '--port' });
});

test('PORT in the environment counts as asking for it too', () => {
  assert.deepEqual(resolvePortSpec([], { PORT: '9000' }), { port: 9000, explicit: true, source: 'PORT' });
});

test('falling back to 8080 is NOT explicit, so the default may claim the port', () => {
  assert.deepEqual(resolvePortSpec([], {}), { port: DEFAULT_PORT, explicit: false, source: 'default' });
  assert.deepEqual(resolvePortSpec([], { PORT: '' }), { port: DEFAULT_PORT, explicit: false, source: 'default' });
});
