// -----------------------------------------------------------------------------
// Reading Mopidy's answers, recorded on Mopidy 3.4.2 and 4.0.5
// (test/fixtures/mopidy/, see its README): both give the same model.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  STATES,
  describeTrack,
  parsePlaylists,
  parseStatus,
  parseTrack,
  searchTracks,
  trackText,
  trackUris,
} from '../src/mopidy/model.js';

const recorded = (version) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/mopidy/mopidy-${version}.json`, import.meta.url), 'utf8'),
  );

for (const version of ['3.4.2', '4.0.5']) {
  const fixture = recorded(version);

  test(`Mopidy ${version}: a stopped server with an empty queue`, () => {
    const { status, track } = parseStatus(fixture['status-stopped-empty']);
    assert.deepEqual(status, {
      state: STATES.STOP,
      volume: 40,
      mute: false,
      random: false,
      repeat: false,
      single: false,
      consume: false,
      tlid: null,
      index: null,
      queueLength: 0,
      elapsed: 0,
      duration: null,
    });
    assert.equal(track, null);
  });

  test(`Mopidy ${version}: playing a file, then paused in random order`, () => {
    const playing = parseStatus(fixture['status-playing']);
    assert.equal(playing.status.state, STATES.PLAY);
    assert.equal(playing.status.queueLength, 2);
    assert.equal(playing.status.index, 0);
    assert.ok(playing.status.elapsed > 1000);
    assert.equal(playing.status.duration, 6965);
    assert.equal(playing.status.tlid, fixture['tracklist-add'][0].tlid);
    // An untagged file: Mopidy names it after the file.
    assert.deepEqual(playing.track, {
      uri: 'file:///music/la-440.ogg',
      name: 'la-440.ogg',
      artist: null,
      album: null,
      length: 6965,
      streamTitle: null,
    });
    const paused = parseStatus(fixture['status-paused-random']);
    assert.equal(paused.status.state, STATES.PAUSE);
    assert.equal(paused.status.random, true);
  });

  test(`Mopidy ${version}: playlists sorted by name, their items, an empty search`, () => {
    assert.deepEqual(parsePlaylists(fixture.playlists), [
      { uri: 'm3u:Ap%C3%A9ro.m3u8', name: 'Apéro' },
      { uri: 'm3u:Morning.m3u8', name: 'Morning' },
    ]);
    assert.deepEqual(trackUris(fixture['playlist-items']), [
      'file:///music/la-440.ogg',
      'file:///music/mi-660.ogg',
    ]);
    assert.deepEqual(searchTracks(fixture.search, 10), []);
    assert.deepEqual(fixture['add-unknown-scheme'], []);
  });
}

test('a tagged track, a web radio and its stream title', () => {
  const tagged = parseTrack({
    uri: 'local:track:a.flac',
    name: 'One More Time',
    artists: [{ name: 'Daft Punk' }, { name: 'Romanthony' }],
    album: { name: 'Discovery' },
    length: 320000,
  });
  assert.deepEqual(describeTrack(tagged), {
    title: 'One More Time',
    subtitle: 'Daft Punk, Romanthony · Discovery',
  });
  assert.equal(trackText(tagged), 'One More Time — Daft Punk, Romanthony');
  const radio = parseTrack(
    { uri: 'http://radio.example/live', name: 'FIP' },
    'Miles Davis - So What',
  );
  assert.deepEqual(describeTrack(radio), { title: 'Miles Davis - So What', subtitle: 'FIP' });
  assert.equal(trackText(radio), 'Miles Davis - So What — FIP');
  const nameless = parseTrack({ uri: 'file:///music/Mon%20morceau.ogg' });
  assert.equal(describeTrack(nameless).title, 'Mon morceau.ogg');
});

test('odd answers become neutral values, never an exception', () => {
  const { status, track } = parseStatus(['weird', { tlid: 'x' }, -5, 3, 'loud', 'no']);
  assert.equal(status.state, STATES.STOP);
  assert.equal(status.volume, null);
  assert.equal(status.mute, null);
  assert.equal(status.elapsed, 0);
  assert.equal(track, null);
  assert.deepEqual(parseStatus(null).status.queueLength, 0);
  assert.deepEqual(parsePlaylists([{ uri: 'a:1' }, { uri: 'a:1' }, null, { name: 'x' }]), [
    { uri: 'a:1', name: 'a:1' },
  ]);
  assert.equal(parseTrack({ name: 'no uri' }), null);
  assert.deepEqual(
    searchTracks(
      [{ tracks: [{ uri: 'a' }, { uri: 'b' }, { uri: 'a' }] }, { tracks: [{ uri: 'c' }] }],
      2,
    ),
    ['a', 'b'],
  );
});
