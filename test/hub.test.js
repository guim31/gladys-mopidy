// -----------------------------------------------------------------------------
// The integration end to end: the SDK's fake Gladys on one side, fake Mopidy
// servers on real HTTP and WebSocket sockets on the other — discovery, states
// pushed by the events, the container's own refresh, commands, reconnection,
// configuration changes, scene events.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_KEYS } from '../src/devices.js';
import {
  FakeMopidy,
  LIBRARY,
  createAll,
  createWorld,
  deviceId,
  eventually,
  featureId,
  featureOf,
  settle,
} from './helpers/world.js';

async function world(t, options) {
  const w = await createWorld(options);
  t.after(() => w.stop());
  return w;
}

const lastText = (w, key, slot = 1) =>
  w.fake.states
    .filter((s) => s.device_feature_external_id === featureId(w.gladys, key, slot))
    .at(-1)?.text;

test('one device per configured server, published at start', async (t) => {
  const w = await world(t, {
    servers: [new FakeMopidy(), new FakeMopidy({ mixer: false, version: '4.0.5' })],
  });
  const devices = w.fake.discoveredDevices;
  assert.deepEqual(
    devices.map((device) => [device.name, device.model]),
    [
      ['Salon', 'Mopidy 3.4.2'],
      ['Cuisine', 'Mopidy 4.0.5'],
    ],
  );
  assert.equal(devices[0].external_id, deviceId(w.gladys, 1));
  assert.equal(w.fake.connectionStatus.connected, true);
  // The playlist select: value the URI, label the name, sorted by name.
  const playlist = devices[0].features.find(
    (f) => f.external_id === featureId(w.gladys, FEATURE_KEYS.PLAYLIST),
  );
  assert.deepEqual(playlist.supported_options, [
    { value: 'm3u:Ap%C3%A9ro.m3u8', label: 'Apéro' },
    { value: 'm3u:Empty.m3u8', label: 'Empty' },
    { value: 'm3u:Morning.m3u8', label: 'Morning' },
  ]);
});

test('the states of an added device follow Mopidy through its events, without any poll', async (t) => {
  const w = await world(t);
  await createAll(w);
  const volume = featureId(w.gladys, FEATURE_KEYS.VOLUME);
  const playback = featureId(w.gladys, FEATURE_KEYS.PLAYBACK_STATE);
  const mute = featureId(w.gladys, FEATURE_KEYS.MUTE);
  assert.equal(w.fake.lastState(volume), 40);
  // Stopped: IDLE (2) since 1.1.0, PAUSED (0) before.
  assert.equal(w.fake.lastState(playback), 2);
  assert.equal(w.fake.lastState(mute), 0);
  assert.equal(lastText(w, FEATURE_KEYS.NOW_PLAYING), 'Stopped');

  // Another client (Iris, a phone app) plays a track and turns the volume up.
  const [first] = w.mopidy.enqueue('oneMoreTime', 'aerodynamic');
  w.mopidy.play({ tlid: first });
  w.mopidy.handlers()['core.mixer.set_volume']({ volume: 65 });
  w.mopidy.handlers()['core.mixer.set_mute']({ mute: true });
  await eventually(
    () =>
      w.fake.lastState(playback) === 1 &&
      w.fake.lastState(volume) === 65 &&
      w.fake.lastState(mute) === 1,
  );
  assert.equal(lastText(w, FEATURE_KEYS.NOW_PLAYING), 'One More Time — Daft Punk');
  w.mopidy.handlers()['core.playback.pause']();
  await eventually(
    () => lastText(w, FEATURE_KEYS.NOW_PLAYING) === 'Paused · One More Time — Daft Punk',
  );
});

test('the container refreshes on its own timer when there is no event socket', async (t) => {
  const w = await world(t, {
    servers: [new FakeMopidy({ websocket: false })],
    timers: true,
    timings: { refreshMs: 100 },
  });
  await createAll(w);
  assert.equal(w.hub.records.get(1).player.eventsOpen, false);
  const volume = featureId(w.gladys, FEATURE_KEYS.VOLUME);
  w.mopidy.setVolumeSilently(12);
  await eventually(() => w.fake.lastState(volume) === 12);
  assert.ok(
    !w.fake.wsMessages.some((message) => message.type?.includes('poll')),
    'no poll was needed',
  );
});

test('the event socket is opened again at the next reading', async (t) => {
  const w = await world(t);
  const { player } = w.hub.records.get(1);
  assert.equal(player.eventsOpen, true);
  w.mopidy.dropEventSockets();
  await eventually(() => player.eventsOpen === false);
  assert.equal(player.connected, true, 'the API still answers');
  await w.hub.tick();
  assert.equal(player.eventsOpen, true);
});

test('the core onPoll is a fallback, skipped right after a reading', async (t) => {
  const w = await world(t);
  await createAll(w);
  const count = () => w.mopidy.methods().filter((m) => m === 'core.playback.get_state').length;
  const before = count();
  const { device } = featureOf(w, FEATURE_KEYS.VOLUME);
  assert.equal((await w.fake.poll(device)).success, true);
  await settle();
  assert.equal(count(), before, 'read less than half a period ago: skipped');
});

test('play, pause, next, previous, volume and mute reach Mopidy', async (t) => {
  const w = await world(t);
  await createAll(w);
  w.mopidy.enqueue('oneMoreTime', 'aerodynamic');
  const set = async (key, value) => {
    const { device, feature } = featureOf(w, key);
    const ack = await w.fake.setValue(device, feature, value);
    assert.equal(ack.success, true, ack.error);
  };
  await set(FEATURE_KEYS.PLAY, 1);
  assert.equal(w.mopidy.state, 'playing');
  await set(FEATURE_KEYS.NEXT, 1);
  assert.equal(w.mopidy.current, 2);
  await set(FEATURE_KEYS.PREVIOUS, 1);
  assert.equal(w.mopidy.current, 1);
  w.mopidy.advance(30_000);
  await set(FEATURE_KEYS.PAUSE, 1);
  assert.equal(w.mopidy.state, 'paused');
  // Play after pause resumes, it does not restart the track.
  await set(FEATURE_KEYS.PLAY, 1);
  assert.equal(w.mopidy.state, 'playing');
  assert.equal(w.mopidy.position, 30_000);
  assert.ok(w.mopidy.methods().includes('core.playback.resume'));
  await set(FEATURE_KEYS.VOLUME, 72);
  assert.equal(w.mopidy.volume, 72);
  await set(FEATURE_KEYS.MUTE, 1);
  assert.equal(w.mopidy.mute, true);
  await set(FEATURE_KEYS.MUTE, 0);
  assert.equal(w.mopidy.mute, false);
  await eventually(() => w.fake.lastState(featureId(w.gladys, FEATURE_KEYS.VOLUME)) === 72);
});

test('picking a playlist in the select replaces the queue and plays it', async (t) => {
  const w = await world(t);
  await createAll(w);
  w.mopidy.enqueue('mi');
  const { device, feature } = featureOf(w, FEATURE_KEYS.PLAYLIST);
  const ack = await w.fake.setValue(device, feature, 'm3u:Ap%C3%A9ro.m3u8');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(
    w.mopidy.tracklist.map((item) => item.track.name),
    ['One More Time', 'Aerodynamic'],
  );
  assert.equal(w.mopidy.state, 'playing');
});

test('a server without mixer has no volume state, and a clear refusal', async (t) => {
  const w = await world(t, { servers: [new FakeMopidy({ mixer: false })] });
  await createAll(w);
  assert.equal(w.fake.lastState(featureId(w.gladys, FEATURE_KEYS.VOLUME)), undefined);
  assert.equal(w.fake.lastState(featureId(w.gladys, FEATURE_KEYS.MUTE)), undefined);
  const { device, feature } = featureOf(w, FEATURE_KEYS.VOLUME);
  const ack = await w.fake.setValue(device, feature, 50);
  assert.equal(ack.success, false);
  assert.match(ack.error, /no volume control/);
});

test('a new playlist updates the options of the select', async (t) => {
  const w = await world(t);
  await createAll(w);
  w.mopidy.playlists.push({ uri: 'm3u:Soiree.m3u8', name: 'Soirée', items: ['la'] });
  w.mopidy.emit('playlists_loaded');
  await eventually(() => {
    const { feature } = featureOf(w, FEATURE_KEYS.PLAYLIST);
    return feature.supported_options.some((option) => option.value === 'm3u:Soiree.m3u8');
  });
});

test('something that is not Mopidy is reported as such', async (t) => {
  // Another web server on the port: a 404 on /mopidy/rpc.
  const other = new FakeMopidy();
  await other.listen();
  other.server.removeAllListeners('request');
  other.server.on('request', (req, res) => res.writeHead(404).end());
  const w = await world(t, { servers: [other] });
  assert.equal(w.fake.connectionStatus.connected, false);
  assert.match(w.fake.connectionStatus.message.en, /no Mopidy-HTTP at this address/);
});

test('a lost server comes back on its own, and its device follows', async (t) => {
  const w = await world(t, { timers: true, timings: { refreshMs: 100 } });
  await createAll(w);
  const id = deviceId(w.gladys);
  const transport = () =>
    w.fake.transports.filter((e) => e.device_external_id === id).at(-1)?.transport;
  assert.equal(transport(), 'local');
  w.mopidy.goOffline();
  await eventually(() => w.fake.connectionStatus.connected === false);
  assert.equal(transport(), 'unreachable');
  assert.deepEqual(w.fake.sceneEvents.at(-1), {
    key: 'connection_lost',
    data: { device: id, name: 'Salon' },
  });
  w.mopidy.goOnline();
  await eventually(() => w.fake.connectionStatus.connected === true, 3_000);
  assert.equal(transport(), 'local');
  w.mopidy.handlers()['core.mixer.set_volume']({ volume: 33 });
  await eventually(() => w.fake.lastState(featureId(w.gladys, FEATURE_KEYS.VOLUME)) === 33);
});

test('a track started fires the scene event, with what it plays', async (t) => {
  const w = await world(t);
  const [first] = w.mopidy.enqueue('oneMoreTime');
  w.mopidy.play({ tlid: first });
  await eventually(() => w.fake.sceneEvents.some((e) => e.key === 'track_started'));
  assert.deepEqual(w.fake.sceneEvents.find((e) => e.key === 'track_started').data, {
    device: deviceId(w.gladys),
    title: 'One More Time',
    artist: 'Daft Punk',
    album: 'Discovery',
    uri: LIBRARY.oneMoreTime.uri,
    description: 'Daft Punk · Discovery',
  });
});

test('removing a server from the configuration closes its event socket', async (t) => {
  const w = await world(t, { servers: [new FakeMopidy(), new FakeMopidy()] });
  assert.equal(w.mopidys[1].eventClients, 1);
  await w.fake.configUpdated({ ...w.fake.config, player_2_address: '' });
  await eventually(() => w.mopidys[1].eventClients === 0);
  assert.deepEqual(
    w.fake.discoveredDevices.map((device) => device.name),
    ['Salon'],
  );
});

test('the "Test the connection" button reports every server', async (t) => {
  const w = await world(t, {
    servers: [new FakeMopidy()],
    config: { player_2_address: '127.0.0.1:1' },
  });
  const ack = await w.fake.action('test_connection', {});
  assert.equal(ack.success, true, ack.error);
  const lines = ack.data.message.en.split('\n');
  assert.match(
    lines[0],
    /^Salon \(127\.0\.0\.1:\d+\): Mopidy 3\.4\.2, stopped, volume 40 %, 3 playlist\(s\)$/,
  );
  assert.match(lines[1], /does not answer/);
});

test('a device updated in Gladys gets its states again', async (t) => {
  const w = await world(t);
  await createAll(w);
  const volume = featureId(w.gladys, FEATURE_KEYS.VOLUME);
  const before = w.fake.states.filter((s) => s.device_feature_external_id === volume).length;
  await w.fake.deviceUpdated(w.fake.discoveredDevices[0]);
  const after = w.fake.states.filter((s) => s.device_feature_external_id === volume).length;
  assert.equal(after, before + 1);
});
