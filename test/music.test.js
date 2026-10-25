// -----------------------------------------------------------------------------
// The Gladys 5.3 music player: the now-playing features published by
// publishNowPlaying, their commands, and the catalog of the music panel
// (browse, search, play, queue, artwork), against the SDK's fake Gladys and
// the fake Mopidy (shaped after Mopidy 3.4.2 with Mopidy-Local, see
// src/catalog.js for what the real one does).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_FEATURE_CATEGORIES,
  MUSIC_PLAYBACK_STATE,
  MUSIC_REPEAT_MODE,
  validateMediaItems,
} from '@gladysassistant/integration-sdk';
import { PLAYLISTS_ID, mixResults } from '../src/catalog.js';
import { FEATURE_KEYS } from '../src/devices.js';
import { SMALL_JPEG, TREE } from './helpers/fakeMopidy.js';
import {
  ALBUM_URI,
  FakeMopidy,
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
  await createAll(w);
  return w;
}

const state = (w, key) => w.fake.lastState(featureId(w.gladys, key));
const device = (w) => ({ external_id: deviceId(w.gladys), selector: 'salon', params: [] });
const published = (w, key) =>
  w.fake.states.filter((s) => s.device_feature_external_id === featureId(w.gladys, key)).length;
const artworkUrl = (w, path) => `http://127.0.0.1:${w.mopidy.port}${path}`;

test('the device carries the music features of Gladys 5.3, writable ones confirmed by Mopidy', async (t) => {
  const w = await world(t);
  const [player] = w.fake.discoveredDevices;
  const byKey = (key) => player.features.find((f) => f.external_id === featureId(w.gladys, key));
  // The SDK convention `${device}:${type}` for the new ones.
  for (const type of ['title', 'artist', 'album', 'artwork', 'duration', 'position']) {
    assert.equal(byKey(type).external_id, `${deviceId(w.gladys)}:${type}`);
    assert.equal(byKey(type).type, type);
  }
  assert.deepEqual(
    [byKey(FEATURE_KEYS.PLAYBACK_STATE).read_only, byKey(FEATURE_KEYS.PLAYBACK_STATE).max],
    [false, MUSIC_PLAYBACK_STATE.IDLE],
  );
  // The mute switch of 1.0.0 becomes music/mute, same external id.
  assert.equal(byKey(FEATURE_KEYS.MUTE).category, DEVICE_FEATURE_CATEGORIES.MUSIC);
  assert.equal(byKey(FEATURE_KEYS.MUTE).type, 'mute');
  assert.equal(byKey(FEATURE_KEYS.REPEAT).max, MUSIC_REPEAT_MODE.ONE);
  for (const feature of player.features.filter((f) => !f.read_only)) {
    const legacy = ['play', 'pause', 'previous', 'next', 'play_notification', 'select'];
    assert.equal(feature.has_feedback, !legacy.includes(feature.type), feature.external_id);
  }
});

test('what plays is published once per change, cleared when nothing is loaded', async (t) => {
  const w = await world(t);
  assert.equal(state(w, FEATURE_KEYS.PLAYBACK_STATE), MUSIC_PLAYBACK_STATE.IDLE);
  assert.equal(state(w, FEATURE_KEYS.TITLE), '');

  const [first] = w.mopidy.enqueue('oneMoreTime', 'aerodynamic');
  w.mopidy.play({ tlid: first });
  await eventually(() => state(w, FEATURE_KEYS.TITLE) === 'One More Time');
  assert.equal(state(w, FEATURE_KEYS.ARTIST), 'Daft Punk');
  assert.equal(state(w, FEATURE_KEYS.ALBUM), 'Discovery');
  assert.equal(state(w, FEATURE_KEYS.DURATION), 320);
  assert.equal(state(w, FEATURE_KEYS.POSITION), 0);
  assert.equal(state(w, FEATURE_KEYS.PLAYBACK_STATE), MUSIC_PLAYBACK_STATE.PLAYING);
  // The artwork: a key, its URL (a path on the Mopidy server) made absolute.
  const key = state(w, FEATURE_KEYS.ARTWORK);
  assert.equal(key, w.gladys.artworkKey(artworkUrl(w, '/local/discovery-300x300.jpeg')));

  // A reading 1 s later: the position moved as Gladys extrapolates it, nothing sent
  // (the SDK republishes a position only past 3 s of drift, test/music of the SDK).
  const positions = published(w, FEATURE_KEYS.POSITION);
  const titles = published(w, FEATURE_KEYS.TITLE);
  w.mopidy.advance(1_000);
  await w.hub.tick();
  assert.equal(published(w, FEATURE_KEYS.POSITION), positions);
  assert.equal(published(w, FEATURE_KEYS.TITLE), titles);

  // A seek elsewhere (Iris): the new position is published.
  w.mopidy.handlers()['core.playback.seek']({ time_position: 200_000 });
  await eventually(() => state(w, FEATURE_KEYS.POSITION) === 200);

  // Pause, then stop: the track stays shown while Mopidy keeps it loaded.
  w.mopidy.handlers()['core.playback.pause']();
  await eventually(() => state(w, FEATURE_KEYS.PLAYBACK_STATE) === MUSIC_PLAYBACK_STATE.PAUSED);
  w.mopidy.handlers()['core.playback.stop']();
  await eventually(() => state(w, FEATURE_KEYS.PLAYBACK_STATE) === MUSIC_PLAYBACK_STATE.IDLE);
  assert.equal(state(w, FEATURE_KEYS.TITLE), 'One More Time');

  // The queue cleared: every text is emptied explicitly.
  w.mopidy.handlers()['core.tracklist.clear']();
  await eventually(() => state(w, FEATURE_KEYS.TITLE) === '');
  assert.equal(state(w, FEATURE_KEYS.ARTIST), '');
  assert.equal(state(w, FEATURE_KEYS.ALBUM), '');
  assert.equal(state(w, FEATURE_KEYS.ARTWORK), '');
  assert.equal(state(w, FEATURE_KEYS.DURATION), 0);
});

test('a web radio: the song it announces as title, the station as album, live', async (t) => {
  const w = await world(t);
  const [tlid] = w.mopidy.enqueue('radio');
  w.mopidy.play({ tlid });
  w.mopidy.streamTitle = 'Daft Punk - Veridis Quo';
  w.mopidy.emit('stream_title_changed', { title: w.mopidy.streamTitle });
  await eventually(() => state(w, FEATURE_KEYS.TITLE) === 'Daft Punk - Veridis Quo');
  assert.equal(state(w, FEATURE_KEYS.ALBUM), 'Radio Example');
  assert.equal(state(w, FEATURE_KEYS.DURATION), 0);
});

test('playback state, position, shuffle, repeat and mute are commands', async (t) => {
  const w = await world(t);
  const set = async (key, value) => {
    const { device: d, feature } = featureOf(w, key);
    return w.fake.setValue(d, feature, value);
  };
  const [first] = w.mopidy.enqueue('oneMoreTime', 'aerodynamic');
  w.mopidy.play({ tlid: first });
  await eventually(() => state(w, FEATURE_KEYS.PLAYBACK_STATE) === MUSIC_PLAYBACK_STATE.PLAYING);

  await set(FEATURE_KEYS.PLAYBACK_STATE, MUSIC_PLAYBACK_STATE.PAUSED);
  assert.equal(w.mopidy.state, 'paused');
  await set(FEATURE_KEYS.PLAYBACK_STATE, MUSIC_PLAYBACK_STATE.PLAYING);
  assert.equal(w.mopidy.state, 'playing');
  assert.ok(w.mopidy.methods().includes('core.playback.resume'), 'resumed, not restarted');
  await set(FEATURE_KEYS.POSITION, 95);
  assert.equal(w.mopidy.position, 95_000);
  await eventually(() => state(w, FEATURE_KEYS.POSITION) === 95);
  await set(FEATURE_KEYS.SHUFFLE, 1);
  assert.equal(w.mopidy.random, true);
  await eventually(() => state(w, FEATURE_KEYS.SHUFFLE) === 1);
  await set(FEATURE_KEYS.REPEAT, MUSIC_REPEAT_MODE.ONE);
  assert.deepEqual([w.mopidy.repeat, w.mopidy.single], [true, true]);
  await eventually(() => state(w, FEATURE_KEYS.REPEAT) === MUSIC_REPEAT_MODE.ONE);
  await set(FEATURE_KEYS.MUTE, 1);
  await eventually(() => state(w, FEATURE_KEYS.MUTE) === 1);
  await set(FEATURE_KEYS.PLAYBACK_STATE, MUSIC_PLAYBACK_STATE.IDLE);
  assert.equal(w.mopidy.state, 'stopped');

  const refused = await set(FEATURE_KEYS.PLAYBACK_STATE, MUSIC_PLAYBACK_STATE.BUFFERING);
  assert.equal(refused.success, false);
  assert.equal((await set(FEATURE_KEYS.REPEAT, 7)).success, false);
});

test('a device updated from the Discover tab gets every now-playing state again', async (t) => {
  const w = await world(t);
  const [first] = w.mopidy.enqueue('oneMoreTime');
  w.mopidy.play({ tlid: first });
  await eventually(() => state(w, FEATURE_KEYS.TITLE) === 'One More Time');
  const titles = published(w, FEATURE_KEYS.TITLE);
  const [player] = w.fake.discoveredDevices;
  await w.fake.deviceUpdated(player);
  await eventually(() => published(w, FEATURE_KEYS.TITLE) === titles + 1);
});

test('browse: the playlists and the roots of Mopidy, then any level, by pages', async (t) => {
  const w = await world(t);
  const root = await w.fake.musicBrowse(device(w));
  assert.equal(root.success, true);
  assert.deepEqual(
    root.data.items.map((i) => [i.id, i.type, i.title, i.browsable, i.playable]),
    [
      [PLAYLISTS_ID, 'folder', 'Playlists', true, false],
      ['file:///music', 'folder', 'Files', true, false],
      ['local:directory', 'folder', 'Local media', true, false],
    ],
  );
  assert.equal(root.data.total, 3);

  const playlists = await w.fake.musicBrowse(device(w), { parentId: PLAYLISTS_ID });
  assert.deepEqual(
    playlists.data.items.map((i) => [i.title, i.type, i.browsable, i.playable]),
    [
      ['Apéro', 'playlist', true, true],
      ['Empty', 'playlist', true, true],
      ['Morning', 'playlist', true, true],
    ],
  );
  // A playlist opens through its items (Mopidy cannot browse an M3U URI).
  const morning = playlists.data.items.find((i) => i.title === 'Morning');
  const items = await w.fake.musicBrowse(device(w), { parentId: morning.id });
  assert.deepEqual(
    items.data.items.map((i) => i.type),
    ['track', 'track'],
  );

  const album = await w.fake.musicBrowse(device(w), { parentId: ALBUM_URI });
  assert.deepEqual(
    album.data.items.map((i) => [i.title, Boolean(i.artwork_key)]),
    [
      ['One More Time', true],
      ['Aerodynamic', true],
    ],
  );

  // A directory is never playable (playing one crashes Mopidy 3.4); a stream is a radio.
  const files = await w.fake.musicBrowse(device(w), {
    parentId: 'file:///music',
    offset: 1,
    limit: 5,
  });
  assert.equal(files.data.total, 3);
  assert.deepEqual(
    files.data.items.map((i) => [i.type, i.playable]),
    [
      ['track', true],
      ['radio', true],
    ],
  );
  for (const answer of [root, playlists, items, album, files]) {
    assert.deepEqual(validateMediaItems(answer.data.items), []);
  }
});

test('search: playlists, artists and albums before the tracks, a type filters', async (t) => {
  const w = await world(t);
  const all = await w.fake.musicSearch(device(w), { query: 'discovery' });
  assert.deepEqual(
    all.data.items.map((i) => [i.type, i.title, i.subtitle]),
    [
      ['album', 'Discovery', 'Daft Punk'],
      ['track', 'One More Time', 'Daft Punk'],
      ['track', 'Aerodynamic', 'Daft Punk'],
    ],
  );
  assert.equal(all.data.items[1].duration, 320);
  assert.deepEqual(validateMediaItems(all.data.items), []);
  const albums = await w.fake.musicSearch(device(w), { query: 'discovery', type: 'album' });
  assert.deepEqual(
    albums.data.items.map((i) => i.id),
    [ALBUM_URI],
  );
  // Playlists by name, without accents: Mopidy does not search them.
  const playlists = await w.fake.musicSearch(device(w), { query: 'apero', type: 'playlist' });
  assert.deepEqual(
    playlists.data.items.map((i) => i.title),
    ['Apéro'],
  );
});

test('search results of every type share the list', () => {
  const make = (type, n) => Array.from({ length: n }, (_, i) => ({ id: `${type}${i}`, type }));
  const items = mixResults(
    {
      playlist: make('playlist', 1),
      artist: make('artist', 9),
      album: make('album', 9),
      track: make('track', 9),
    },
    20,
  );
  assert.deepEqual(
    items.map((i) => i.type).join(','),
    [
      'playlist',
      ...Array(5).fill('artist'),
      ...Array(5).fill('album'),
      ...Array(9).fill('track'),
    ].join(','),
  );
});

test('play: replace, next and append, a folder refused without touching the queue', async (t) => {
  const w = await world(t);
  const playlists = await w.fake.musicBrowse(device(w), { parentId: PLAYLISTS_ID });
  const morning = playlists.data.items.find((i) => i.title === 'Morning');
  assert.equal(
    (await w.fake.musicPlay(device(w), { id: morning.id, type: 'playlist' })).success,
    true,
  );
  assert.deepEqual(
    w.mopidy.tracklist.map((item) => item.track.name),
    ['la-440.ogg', 'mi-660.ogg'],
  );
  assert.equal(w.mopidy.state, 'playing');

  await w.fake.musicPlay(device(w), { id: ALBUM_URI, type: 'album' }, 'append');
  await w.fake.musicPlay(
    device(w),
    { id: 'http://radio.example/stream.mp3', type: 'radio' },
    'next',
  );
  assert.deepEqual(
    w.mopidy.tracklist.map((item) => item.track.name),
    ['la-440.ogg', 'Radio Example', 'mi-660.ogg', 'One More Time', 'Aerodynamic'],
  );

  const before = w.mopidy.tracklist.length;
  const folder = await w.fake.musicPlay(device(w), { id: 'file:///music/sub', type: 'folder' });
  assert.equal(folder.success, false);
  assert.match(folder.error, /folder cannot be played/);
  assert.equal(w.mopidy.tracklist.length, before);

  const unknown = await w.fake.musicPlay(device(w), { id: 'bogus:thing', type: 'track' }, 'append');
  assert.equal(unknown.success, false);
});

test('the queue: a page, the current index on the full queue, a jump', async (t) => {
  const w = await world(t);
  const [first] = w.mopidy.enqueue('la', 'mi', 'oneMoreTime', 'aerodynamic');
  w.mopidy.play({ tlid: first + 2 });
  await settle();
  const page = await w.fake.musicQueueGet(device(w), { offset: 1, limit: 2 });
  assert.equal(page.success, true);
  assert.deepEqual(
    [page.data.total, page.data.current_index, page.data.items.map((i) => i.title)],
    [4, 2, ['mi-660.ogg', 'One More Time']],
  );
  assert.deepEqual(validateMediaItems(page.data.items), []);

  assert.equal((await w.fake.musicQueuePlay(device(w), 3)).success, true);
  assert.equal(w.mopidy.currentTlTrack().track.name, 'Aerodynamic');
  assert.equal((await w.fake.musicQueuePlay(device(w), 9)).success, false);

  w.mopidy.handlers()['core.tracklist.clear']();
  const empty = await w.fake.musicQueueGet(device(w));
  assert.deepEqual([empty.data.total, empty.data.current_index, empty.data.items], [0, null, []]);
});

test('artwork: served from Mopidy, refused above the 300 KB Gladys accepts', async (t) => {
  const w = await world(t);
  const small = w.gladys.artworkKey(artworkUrl(w, '/local/discovery-300x300.jpeg'));
  const answer = await w.fake.musicGetArtwork(small);
  assert.equal(answer.success, true);
  assert.equal(answer.data.image, SMALL_JPEG.toString('base64'));

  const huge = w.gladys.artworkKey(artworkUrl(w, '/local/huge-1600x1600.jpeg'));
  const refused = await w.fake.musicGetArtwork(huge);
  assert.equal(refused.success, false);
  assert.match(refused.error, /larger than 300 KB/);
  // Without Content-Length: stopped while reading.
  const chunked = w.gladys.artworkKey(artworkUrl(w, '/local/huge-chunked.jpeg'));
  assert.match((await w.fake.musicGetArtwork(chunked)).error, /larger than 300 KB/);
  assert.equal((await w.fake.musicGetArtwork('art-000000000000')).success, false);
});

test('a catalog command for a server removed from the configuration fails cleanly', async (t) => {
  const w = await world(t, { servers: [new FakeMopidy()] });
  const answer = await w.fake.musicBrowse({ external_id: 'ext:nope:mopidy:9', params: [] });
  assert.equal(answer.success, false);
});

test('a playlist added on disk opens before Mopidy announces it', async (t) => {
  const w = await world(t);
  // The M3U backend reads its folder at each listing, without an event.
  w.mopidy.playlists.push({ uri: 'm3u:New.m3u8', name: 'New', items: ['la'] });
  const items = await w.fake.musicBrowse(device(w), { parentId: 'm3u:New.m3u8' });
  assert.deepEqual(
    items.data.items.map((i) => i.title),
    ['la-440.ogg'],
  );
});

test('a queue row whose URI is too long keeps the rows aligned with the queue', async (t) => {
  const w = await world(t);
  const long = `file:///music/${'x'.repeat(600)}.ogg`;
  const [first] = w.mopidy.enqueue('la', long, 'mi');
  w.mopidy.play({ tlid: first });
  await settle();
  const page = await w.fake.musicQueueGet(device(w));
  assert.equal(page.data.items.length, 3);
  assert.equal(page.data.items[2].title, 'mi-660.ogg');
  assert.ok(page.data.items[1].id.length <= 512);
  assert.deepEqual(validateMediaItems(page.data.items), []);
});

test('an artist with thousands of tracks queues 500 of them', async (t) => {
  const w = await world(t);
  w.mopidy.lookups = {
    'spotify:artist:many': Array.from({ length: 1200 }, (_, i) => ({
      __model__: 'Track',
      uri: `http://tracks.example/${i}.mp3`,
      name: `Track ${i}`,
      length: 1000,
    })),
  };
  const answer = await w.fake.musicPlay(device(w), { id: 'spotify:artist:many', type: 'artist' });
  assert.equal(answer.success, true);
  assert.equal(w.mopidy.tracklist.length, 500);
});

test('an answer too large is refused without losing the server', async (t) => {
  // 6 MB to build and send: room for a loaded CI runner.
  const w = await world(t, { clientTimings: { requestMs: 10_000, socketOpenMs: 500 } });
  TREE['file:///huge'] = Array.from({ length: 40_000 }, (_, i) => ({
    __model__: 'Ref',
    uri: `file:///huge/${'n'.repeat(100)}${i}.ogg`,
    name: `${i}.ogg`,
    type: 'track',
  }));
  t.after(() => delete TREE['file:///huge']);
  const answer = await w.fake.musicBrowse(device(w), { parentId: 'file:///huge' });
  assert.equal(answer.success, false);
  assert.match(answer.error, /too much at once/);
  assert.equal(w.hub.records.get(1).player.connected, true);
});
