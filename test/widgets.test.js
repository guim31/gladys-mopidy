// -----------------------------------------------------------------------------
// The `player` dashboard widget: its content fits the vocabulary and the
// budget of the core (validateWidgetContent of the SDK), says what plays,
// and its buttons and form drive the player.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { ACTIONS, KEEP_PLAYLIST } from '../src/widgets.js';
import { FakeMopidy, createWorld, deviceId, eventually, settle } from './helpers/world.js';

/** Mopidy plays the first queued track, as another client would ask it. */
function playQueued(w, ...keys) {
  const [first] = w.mopidy.enqueue(...keys);
  w.mopidy.play({ tlid: first });
}

const set = (w, method, params) => w.mopidy.handlers()[method](params);

async function world(t, options) {
  const w = await createWorld(options);
  t.after(() => w.stop());
  return w;
}

async function content(w, settings = {}, language = 'en') {
  const ack = await w.fake.widgetGet('player', { settings, language });
  assert.equal(ack.success, true, ack.error);
  const { content: body } = ack.data;
  assert.deepEqual(validateWidgetContent(body), [], 'rendered exactly as sent');
  return body;
}

const ofType = (body, type) => body.components.filter((c) => c.type === type);

test('what plays: title, artist · album, volume, state, queue, buttons', async (t) => {
  const w = await world(t);
  playQueued(w, 'oneMoreTime', 'aerodynamic');
  set(w, 'core.tracklist.set_random', { value: true });
  await settle();
  const body = await content(w);
  const [heading, caption] = ofType(body, 'text');
  assert.equal(heading.text, 'One More Time');
  assert.equal(caption.text, 'Daft Punk · Discovery');
  assert.equal(ofType(body, 'gauge')[0].value, 40);
  const [status] = ofType(body, 'status');
  assert.deepEqual(
    status.items.map((item) => [item.label, item.value]),
    [
      ['Salon', 'Playing'],
      ['Queue', '1 / 2'],
      ['Random', 'On'],
      ['Repeat', 'Off'],
    ],
  );
  const buttons = ofType(body, 'button');
  assert.deepEqual(
    buttons.map((button) => button.action.key),
    [ACTIONS.PREVIOUS, ACTIONS.TOGGLE, ACTIONS.NEXT, ACTIONS.OPTIONS],
  );
  assert.equal(buttons[1].label, 'Pause');
  assert.ok(
    buttons.every((button) => button.style !== 'primary'),
    'primary is invisible in dark mode',
  );
});

test('a web radio shows its title and station, in French', async (t) => {
  const w = await world(t);
  playQueued(w, 'radio');
  w.mopidy.streamTitle = 'Some Artist - Some Song';
  w.mopidy.emit('stream_title_changed', { title: w.mopidy.streamTitle });
  await settle();
  const body = await content(w, {}, 'fr');
  const [heading, caption] = ofType(body, 'text');
  assert.equal(heading.text, 'Some Artist - Some Song');
  assert.equal(caption.text, 'Radio Example');
  assert.equal(ofType(body, 'status')[0].items[0].value, 'Lecture');
});

test('an empty queue, a server without mixer nor playlists: no gauge, a short form', async (t) => {
  const mopidy = new FakeMopidy({ mixer: false });
  mopidy.playlists = [];
  const w = await world(t, { servers: [mopidy] });
  const body = await content(w);
  assert.equal(ofType(body, 'text')[0].text, 'The queue is empty');
  assert.equal(ofType(body, 'gauge').length, 0);
  const form = ofType(body, 'button').at(-1).action.fields;
  assert.deepEqual(
    form.map((field) => field.key),
    ['random', 'repeat'],
  );
});

test('the options form is pre-filled with the current values', async (t) => {
  const w = await world(t);
  set(w, 'core.tracklist.set_repeat', { value: true });
  set(w, 'core.tracklist.set_single', { value: true });
  await settle();
  const form = ofType(await content(w), 'button').at(-1).action.fields;
  const byKey = Object.fromEntries(form.map((field) => [field.key, field]));
  assert.equal(byKey.volume.default, 40);
  assert.equal(byKey.playlist.default, KEEP_PLAYLIST);
  assert.deepEqual(
    byKey.playlist.options.map((option) => option.value),
    [KEEP_PLAYLIST, 'm3u:Ap%C3%A9ro.m3u8', 'm3u:Empty.m3u8', 'm3u:Morning.m3u8'],
  );
  assert.deepEqual(byKey.playlist.options[1].label, { en: 'Apéro' });
  assert.equal(byKey.random.default, false);
  assert.equal(byKey.repeat.default, 'one');
});

test('the buttons drive the player; play/pause follows the state at the tap', async (t) => {
  const w = await world(t);
  w.mopidy.enqueue('oneMoreTime', 'aerodynamic');
  const tap = async (key, values) => {
    const ack = await w.fake.widgetAction('player', key, {}, { settings: {}, values });
    assert.equal(ack.success, true, ack.error);
    return ack;
  };
  await tap(ACTIONS.TOGGLE);
  assert.equal(w.mopidy.state, 'playing');
  await tap(ACTIONS.NEXT);
  assert.equal(w.mopidy.current, 2);
  await tap(ACTIONS.PREVIOUS);
  assert.equal(w.mopidy.current, 1);
  // Paused by someone else since the card was drawn: the tap plays.
  set(w, 'core.playback.pause');
  await settle();
  await tap(ACTIONS.TOGGLE);
  assert.equal(w.mopidy.state, 'playing');

  const ack = await tap(ACTIONS.OPTIONS, {
    volume: 55,
    playlist: 'm3u:Morning.m3u8',
    random: true,
    repeat: 'all',
  });
  assert.equal(w.mopidy.volume, 55);
  assert.equal(w.mopidy.random, true);
  assert.equal(w.mopidy.repeat, true);
  assert.deepEqual(
    w.mopidy.tracklist.map((item) => item.track.name),
    ['la-440.ogg', 'mi-660.ogg'],
  );
  assert.match(ack.data.message.en, /Morning/);

  // Nothing changed in the form: nothing sent.
  const commands = () => w.mopidy.methods().filter((m) => !/\.(get_|index)/.test(m)).length;
  const before = commands();
  await tap(ACTIONS.OPTIONS, {
    volume: 55,
    playlist: KEEP_PLAYLIST,
    random: true,
    repeat: 'all',
  });
  assert.equal(commands(), before);
});

test('a Gladys older than 5.2.0 sends the form tap without values: it says so', async (t) => {
  const w = await world(t);
  const ack = await w.fake.widgetAction('player', ACTIONS.OPTIONS, {}, { settings: {} });
  assert.equal(ack.success, false);
  assert.match(ack.error, /5\.2\.0/);
});

test('the widget follows the server chosen in its settings, and says when it is gone', async (t) => {
  const w = await world(t, { servers: [new FakeMopidy(), new FakeMopidy({ volume: 77 })] });
  const second = await content(w, { device: deviceId(w.gladys, 2) });
  assert.equal(ofType(second, 'gauge')[0].value, 77);
  const gone = await content(w, { device: deviceId(w.gladys, 4) });
  assert.match(gone.components[0].text, /no longer in the configuration/);
});

test('an unreachable server is said, without buttons', async (t) => {
  const w = await world(t);
  w.mopidy.goOffline();
  await eventually(() => !w.hub.records.get(1).player.connected);
  const body = await content(w);
  assert.equal(ofType(body, 'button').length, 0);
  assert.equal(ofType(body, 'status')[0].items[0].value, 'does not answer');
});

test('no server configured: the widget says what to do', async (t) => {
  const w = await world(t, { servers: [] });
  const body = await content(w);
  assert.match(body.components[0].text, /Enter the address of your Mopidy server/);
});

test('a change on the player asks Gladys to refresh the widget, at most every 10 s', async (t) => {
  const w = await world(t);
  const nudges = () => w.fake.widgetRefreshes.length;
  const before = nudges();
  set(w, 'core.mixer.set_volume', { volume: 20 });
  await settle(100);
  set(w, 'core.mixer.set_volume', { volume: 21 });
  await settle(100);
  assert.ok(nudges() - before <= 1, `${nudges() - before} refreshes asked`);
});
