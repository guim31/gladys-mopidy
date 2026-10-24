// -----------------------------------------------------------------------------
// The scene actions (manifest `scene_actions`), as the scene engine of Gladys
// calls them: resolved fields, a device external id from `source: "devices"`.
// The address one (play_url) is tested with the notifications.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeMopidy, createWorld, deviceId } from './helpers/world.js';

async function world(t, options) {
  const w = await createWorld(options);
  t.after(() => w.stop());
  return w;
}

const names = (w) => w.mopidy.tracklist.map((item) => item.track.name);

test('play_playlist: the name is found without case nor accents, the queue is replaced', async (t) => {
  const w = await world(t);
  w.mopidy.enqueue('la');
  const ack = await w.fake.sceneAction('play_playlist', {
    device: deviceId(w.gladys),
    playlist: '  APERO ',
  });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ack.data.outputs, { tracks: 2 });
  assert.equal(w.mopidy.state, 'playing');
  assert.deepEqual(names(w), ['One More Time', 'Aerodynamic']);
});

test('play_playlist: the URI works too, an empty playlist is said', async (t) => {
  const w = await world(t);
  const ack = await w.fake.sceneAction('play_playlist', { playlist: 'm3u:Morning.m3u8' });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(names(w), ['la-440.ogg', 'mi-660.ogg']);
  const empty = await w.fake.sceneAction('play_playlist', { playlist: 'Empty' });
  assert.equal(empty.success, false);
  assert.match(empty.error, /no track Mopidy can play/);
});

test('play_playlist: an unknown name lists the playlists, in the configured language', async (t) => {
  const w = await world(t, { config: { language: 'fr' } });
  const ack = await w.fake.sceneAction('play_playlist', {
    device: deviceId(w.gladys),
    playlist: 'Nope',
  });
  assert.equal(ack.success, false);
  assert.equal(
    ack.error,
    'Aucune playlist « Nope » dans Mopidy. Playlists : Apéro, Empty, Morning',
  );
});

test('play_search: what the library finds replaces the queue', async (t) => {
  const w = await world(t);
  const ack = await w.fake.sceneAction('play_search', {
    device: deviceId(w.gladys),
    query: 'daft punk',
  });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ack.data.outputs, { tracks: 2 });
  assert.deepEqual(names(w), ['One More Time', 'Aerodynamic']);
  assert.deepEqual(w.mopidy.calls.find((call) => call.method === 'core.library.search').params, {
    query: { any: ['daft punk'] },
  });
  const none = await w.fake.sceneAction('play_search', { query: 'nothing like this' });
  assert.equal(none.success, false);
  assert.match(none.error, /no track for this search/);
  assert.deepEqual(names(w), ['One More Time', 'Aerodynamic'], 'the queue stays');
});

test('clear_queue stops and empties the queue', async (t) => {
  const w = await world(t);
  const [first] = w.mopidy.enqueue('la');
  w.mopidy.play({ tlid: first });
  const ack = await w.fake.sceneAction('clear_queue', { device: deviceId(w.gladys) });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(w.mopidy.tracklist, []);
  assert.equal(w.mopidy.state, 'stopped');
});

test('set_random: on, off and toggle, with the result as output', async (t) => {
  const w = await world(t);
  const run = async (mode) => {
    const ack = await w.fake.sceneAction('set_random', { device: deviceId(w.gladys), mode });
    assert.equal(ack.success, true, ack.error);
    return ack.data.outputs.random;
  };
  assert.equal(await run('on'), true);
  assert.equal(w.mopidy.random, true);
  assert.equal(await run('toggle'), false);
  assert.equal(w.mopidy.random, false);
  assert.equal(await run('off'), false);
});

test('set_repeat: off, the whole queue, one track', async (t) => {
  const w = await world(t);
  const run = async (mode) => {
    const ack = await w.fake.sceneAction('set_repeat', { device: deviceId(w.gladys), mode });
    assert.equal(ack.success, true, ack.error);
    return [w.mopidy.repeat, w.mopidy.single];
  };
  assert.deepEqual(await run('one'), [true, true]);
  assert.deepEqual(await run('all'), [true, false]);
  assert.deepEqual(await run('off'), [false, false]);
});

test('a server that does not answer fails the action with a sentence, the scene goes on', async (t) => {
  const w = await world(t);
  w.mopidy.goOffline();
  const ack = await w.fake.sceneAction('clear_queue', { device: deviceId(w.gladys) });
  assert.equal(ack.success, false);
  assert.equal(ack.error, 'The Mopidy server does not answer.');
});

test('a device of a slot no longer configured is refused', async (t) => {
  const w = await world(t, { servers: [new FakeMopidy()] });
  const ack = await w.fake.sceneAction('clear_queue', { device: deviceId(w.gladys, 3) });
  assert.equal(ack.success, false);
  assert.match(ack.error, /no longer in the configuration/);
});
