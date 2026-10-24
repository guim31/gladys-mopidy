// -----------------------------------------------------------------------------
// Notifications (music/play_notification, the "Play an address" scene
// action): the address plays, then what was playing comes back where it was,
// with its options and its volume. Against the fake Mopidy, which switches
// tracks after answering `play` when asked (as the real one does).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_KEYS } from '../src/devices.js';
import {
  BROKEN,
  FakeMopidy,
  LIBRARY,
  createAll,
  createWorld,
  eventually,
  featureOf,
  settle,
} from './helpers/world.js';

const DING = LIBRARY.ding.uri;

async function world(t, options = {}) {
  const w = await createWorld({ config: { notification_volume: '70' }, ...options });
  t.after(() => w.stop());
  await createAll(w);
  return w;
}

/** Music playing (or paused) on the first of two tracks, at 42 s. */
function music(w, { paused = false } = {}) {
  const [first] = w.mopidy.enqueue('oneMoreTime', 'aerodynamic');
  w.mopidy.play({ tlid: first });
  w.mopidy.advance(42_000);
  if (paused) {
    w.mopidy.handlers()['core.playback.pause']();
  }
  return first;
}

async function notify(w, uri = DING) {
  const { device, feature } = featureOf(w, FEATURE_KEYS.NOTIFICATION);
  const ack = await w.fake.setValue(device, feature, uri);
  assert.equal(ack.success, true, ack.error);
}

const notificationOf = (w) => w.hub.records.get(1).player.notification;

test('a doorbell sound plays at the notification volume, then the track resumes where it was', async (t) => {
  const w = await world(t);
  const first = music(w);
  w.mopidy.playLagMs = 20;
  await w.hub.records.get(1).player.refresh();
  await notify(w);
  await eventually(() => w.mopidy.currentTlTrack()?.track.uri === DING);
  assert.equal(w.mopidy.volume, 70);
  assert.equal(w.mopidy.single, true);
  w.mopidy.finishTrack();
  await eventually(
    () =>
      w.mopidy.current === first && w.mopidy.state === 'playing' && w.mopidy.position === 42_000,
  );
  assert.equal(w.mopidy.volume, 40);
  assert.equal(w.mopidy.single, false);
  assert.deepEqual(
    w.mopidy.tracklist.map((item) => item.track.name),
    ['One More Time', 'Aerodynamic'],
    'the notification left the queue',
  );
  // The resumed track is not news: no scene event for it, none for the sound.
  await settle();
  assert.deepEqual(
    w.fake.sceneEvents.filter((e) => e.key === 'track_started').map((e) => e.data.title),
    ['One More Time'],
  );
});

test('paused music stays paused, at its position', async (t) => {
  const w = await world(t);
  const first = music(w, { paused: true });
  w.mopidy.playLagMs = 20;
  await w.hub.records.get(1).player.refresh();
  await notify(w);
  await eventually(() => w.mopidy.currentTlTrack()?.track.uri === DING);
  w.mopidy.finishTrack();
  await eventually(
    () => w.mopidy.current === first && w.mopidy.state === 'paused' && w.mopidy.position === 42_000,
  );
});

test('on a stopped server with an empty queue, nothing is left behind', async (t) => {
  const w = await world(t);
  await notify(w);
  await eventually(() => w.mopidy.state === 'playing');
  w.mopidy.finishTrack();
  await eventually(() => w.mopidy.tracklist.length === 0 && notificationOf(w) === null);
  assert.equal(w.mopidy.state, 'stopped');
  assert.equal(w.mopidy.single, false);
});

test('consume, repeat and random are put back, and the interrupted track is not consumed', async (t) => {
  const w = await world(t);
  const first = music(w);
  Object.assign(w.mopidy, { consume: true, repeat: true, random: true });
  await w.hub.records.get(1).player.refresh();
  await notify(w);
  await eventually(() => w.mopidy.currentTlTrack()?.track.uri === DING);
  assert.deepEqual([w.mopidy.consume, w.mopidy.repeat, w.mopidy.random], [false, false, false]);
  w.mopidy.finishTrack();
  await eventually(() => w.mopidy.current === first && w.mopidy.state === 'playing');
  assert.deepEqual([w.mopidy.consume, w.mopidy.repeat, w.mopidy.random], [true, true, true]);
  assert.equal(w.mopidy.tracklist.length, 2);
});

test('a second notification replaces the first, and the music comes back once', async (t) => {
  const w = await world(t);
  const first = music(w);
  await w.hub.records.get(1).player.refresh();
  await notify(w);
  await eventually(() => w.mopidy.currentTlTrack()?.track.uri === DING);
  await notify(w, LIBRARY.la.uri);
  await eventually(() => w.mopidy.currentTlTrack()?.track.uri === LIBRARY.la.uri);
  assert.equal(w.mopidy.tracklist.filter((item) => item.track.uri === DING).length, 0);
  w.mopidy.finishTrack();
  await eventually(() => w.mopidy.current === first && w.mopidy.position === 42_000);
  assert.equal(w.mopidy.tracklist.length, 2);
  assert.equal(w.mopidy.volume, 40);
});

test('someone taking over the server ends the notification without touching the playback', async (t) => {
  const w = await world(t);
  music(w);
  await w.hub.records.get(1).player.refresh();
  await notify(w);
  await eventually(() => w.mopidy.currentTlTrack()?.track.uri === DING);
  // Iris: someone plays the second track.
  w.mopidy.startTrack(2);
  await eventually(() => notificationOf(w) === null);
  await settle();
  assert.equal(w.mopidy.current, 2);
  assert.equal(w.mopidy.state, 'playing');
  assert.equal(w.mopidy.tracklist.length, 2);
});

test('a web radio sent as a notification keeps playing', async (t) => {
  const w = await world(t);
  music(w);
  await w.hub.records.get(1).player.refresh();
  await notify(w, LIBRARY.radio.uri);
  await eventually(() => w.mopidy.currentTlTrack()?.track.uri === LIBRARY.radio.uri);
  w.mopidy.advance(1_000);
  await w.hub.records.get(1).player.refresh();
  await eventually(async () => {
    await w.hub.records.get(1).player.refresh();
    return notificationOf(w) === null;
  });
  await eventually(() => w.mopidy.single === false);
  assert.equal(w.mopidy.currentTlTrack()?.track.uri, LIBRARY.radio.uri);
  assert.equal(w.mopidy.state, 'playing');
});

test('a notification paused by someone ends after the longest wait', async (t) => {
  const w = await world(t, { timers: true, playerTimings: { notificationMaxMs: 150 } });
  const first = music(w);
  await w.hub.records.get(1).player.refresh();
  await notify(w);
  await eventually(() => w.mopidy.currentTlTrack()?.track.uri === DING);
  w.mopidy.handlers()['core.playback.pause']();
  await eventually(() => w.mopidy.current === first && w.mopidy.state === 'playing', 3_000);
});

test('the "Play an address" scene action reports an address Mopidy cannot read, and puts the music back', async (t) => {
  const w = await world(t);
  const first = music(w);
  await w.hub.records.get(1).player.refresh();
  const ack = await w.fake.sceneAction('play_url', { url: BROKEN, after: 'resume' });
  assert.equal(ack.success, false);
  assert.match(ack.error, /could not play this address/);
  await eventually(() => w.mopidy.tracklist.length === 2);
  assert.equal(w.mopidy.current, first);
  assert.equal(w.mopidy.state, 'playing');
});

test('an address no Mopidy extension knows changes nothing', async (t) => {
  const w = await world(t);
  music(w);
  const ack = await w.fake.sceneAction('play_url', { url: 'spotify:track:x' });
  assert.equal(ack.success, false);
  assert.match(ack.error, /No Mopidy extension can play this address/);
  const bad = await w.fake.sceneAction('play_url', { url: 'sounds/doorbell.mp3' });
  assert.equal(bad.success, false);
  assert.match(bad.error, /Mopidy URI/);
  assert.equal(w.mopidy.tracklist.length, 2);
  assert.equal(w.mopidy.single, false);
});

test('the scene action waits for the address to play, with its own volume', async (t) => {
  const w = await world(t);
  music(w);
  w.mopidy.playLagMs = 30;
  await w.hub.records.get(1).player.refresh();
  const ack = await w.fake.sceneAction('play_url', { url: DING, volume: 25 });
  assert.equal(ack.success, true, ack.error);
  assert.equal(w.mopidy.currentTlTrack()?.track.uri, DING);
  assert.equal(w.mopidy.volume, 25);
});

test('"Keep playing it" replaces the queue with the address', async (t) => {
  const w = await world(t);
  music(w);
  const ack = await w.fake.sceneAction('play_url', {
    url: LIBRARY.radio.uri,
    after: 'keep',
    volume: 30,
  });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(
    w.mopidy.tracklist.map((item) => item.track.uri),
    [LIBRARY.radio.uri],
  );
  assert.equal(w.mopidy.state, 'playing');
  assert.equal(w.mopidy.volume, 30);
  assert.equal(notificationOf(w), null);
});

test('two notifications sent at the same instant: the music still comes back', async (t) => {
  const w = await world(t);
  const first = music(w);
  await w.hub.records.get(1).player.refresh();
  const { device, feature } = featureOf(w, FEATURE_KEYS.NOTIFICATION);
  await Promise.all([
    w.fake.setValue(device, feature, DING),
    w.fake.setValue(device, feature, LIBRARY.la.uri),
  ]);
  await eventually(() => w.mopidy.currentTlTrack()?.track.uri === LIBRARY.la.uri);
  w.mopidy.finishTrack();
  await eventually(() => w.mopidy.current === first && w.mopidy.position === 42_000);
  assert.equal(w.mopidy.tracklist.length, 2);
});

test('a server without mixer plays the notification at its volume', async (t) => {
  const w = await world(t, { servers: [new FakeMopidy({ mixer: false })] });
  await notify(w);
  await eventually(() => w.mopidy.state === 'playing');
  assert.equal(w.mopidy.volume, null);
  assert.ok(!w.mopidy.methods().includes('core.mixer.set_volume'));
});
