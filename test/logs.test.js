// -----------------------------------------------------------------------------
// What the integration writes at the default level (info): the lifecycle
// only. A normal cycle (events, readings, states) writes nothing, a server
// that stays away is logged once, and its return once. Never credentials of
// an address.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_KEYS } from '../src/devices.js';
import {
  createAll,
  createWorld,
  deviceId,
  eventually,
  featureOf,
  settle,
} from './helpers/world.js';

/** Capture the lines of the SDK logger at LOG_LEVEL=info (or another level). */
function captureLogs(t, level = 'info') {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = level;
  t.after(() => {
    process.env.LOG_LEVEL = previous;
  });
  const lines = [];
  const record =
    (stream) =>
    (...args) =>
      lines.push({
        stream,
        text: args.map((arg) => (arg instanceof Error ? arg.stack : String(arg))).join(' '),
      });
  t.mock.method(console, 'log', record('out'));
  t.mock.method(console, 'error', record('err'));
  t.mock.method(console, 'warn', record('err'));
  t.mock.method(console, 'info', record('out'));
  t.mock.method(console, 'debug', record('out'));
  return {
    lines,
    clear: () => lines.splice(0),
    texts: () => lines.map((line) => line.text),
  };
}

async function world(t, options = {}) {
  const w = await createWorld({ timers: true, timings: { refreshMs: 50 }, ...options });
  t.after(() => w.stop());
  return w;
}

test('a normal cycle writes nothing at info', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t);
  assert.ok(
    logs.texts().some((text) => /Player 1 \(Salon\): connected \(Mopidy 3\.4\.2\)/.test(text)),
    `the start is logged: ${logs.texts().join('\n')}`,
  );
  await createAll(w);
  logs.clear();

  // Tracks change, the volume moves, the timer reads the server, the widget is drawn.
  const [first] = w.mopidy.enqueue('la', 'mi', 'oneMoreTime');
  w.mopidy.play({ tlid: first });
  for (let i = 0; i < 3; i += 1) {
    w.mopidy.advance(10_000);
    w.mopidy.handlers()['core.mixer.set_volume']({ volume: 50 + i });
    w.mopidy.finishTrack();
    await settle(80);
  }
  await w.fake.widgetGet('player', { settings: {}, language: 'en' });
  await eventually(
    () => w.fake.lastState(w.gladys.externalIds('mopidy', '1').feature('volume')) === 52,
  );
  assert.deepEqual(logs.texts(), []);
});

test('a server that stays away is logged once, and once when it is back', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t);
  logs.clear();
  w.mopidy.goOffline();
  // Several reconnection attempts and timer ticks.
  await settle(400);
  const down = logs.lines.filter((line) => line.stream === 'err');
  assert.equal(down.length, 1, logs.texts().join('\n'));
  assert.match(down[0].text, /connection lost/);
  assert.equal(logs.lines.length, 1, logs.texts().join('\n'));

  logs.clear();
  w.mopidy.goOnline();
  await eventually(() => logs.lines.length > 0, 3_000);
  await settle(200);
  assert.equal(logs.lines.length, 1, logs.texts().join('\n'));
  assert.match(logs.lines[0].text, /connection restored/);
});

test('one info line per command of the user, and never the credentials of an address', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t, { timings: { refreshMs: 60_000 } });
  await createAll(w);
  logs.clear();
  const { device, feature } = featureOf(w, FEATURE_KEYS.PLAY);
  await w.fake.setValue(device, feature, 1);
  await w.fake.sceneAction('play_url', {
    device: deviceId(w.gladys),
    url: 'http://user:secret-token@radio.example.com/stream.mp3',
    after: 'keep',
  });
  const texts = logs.texts();
  assert.equal(texts.length, 2, texts.join('\n'));
  assert.match(texts[0], /Player 1 \(Salon\): play$/);
  assert.match(texts[1], /play http:\/\/radio\.example\.com\/stream\.mp3/);
  assert.ok(!texts.join('\n').includes('secret-token'));
});

test('LOG_LEVEL=debug shows the events of Mopidy', async (t) => {
  const logs = captureLogs(t, 'debug');
  const w = await world(t, { timings: { refreshMs: 60_000 } });
  logs.clear();
  w.mopidy.handlers()['core.mixer.set_volume']({ volume: 61 });
  await eventually(() => logs.texts().some((text) => /\[DEBUG\].*event volume_changed/.test(text)));
  await w.fake.widgetGet('player', { settings: {}, language: 'en' });
});
