// -----------------------------------------------------------------------------
// Normalization of the configuration: addresses as people type them, slots,
// passwords kept as typed, defaults.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, formatAddress, normalizeConfig, parseAddress } from '../src/config.js';
import { checkUri } from '../src/player.js';
import { parseVolume } from '../src/scenes.js';
import { safeText } from '../src/texts.js';

test('addresses: IP, name, port, IPv6, copied web client URLs, https', () => {
  const plain = (host, port) => ({ host, port, secure: false });
  assert.deepEqual(parseAddress('192.0.2.10'), plain('192.0.2.10', 6680));
  assert.deepEqual(parseAddress(' Mopidy.home:6681 '), plain('mopidy.home', 6681));
  assert.deepEqual(parseAddress('http://192.0.2.10:6680/iris/'), plain('192.0.2.10', 6680));
  assert.deepEqual(parseAddress('http://mopidy.local/'), plain('mopidy.local', 6680));
  assert.deepEqual(parseAddress('ws://192.0.2.10:6680/mopidy/ws'), plain('192.0.2.10', 6680));
  assert.deepEqual(parseAddress('https://music.example.com/'), {
    host: 'music.example.com',
    port: 443,
    secure: true,
  });
  assert.deepEqual(parseAddress('[2001:db8::1]:6682'), plain('2001:db8::1', 6682));
  assert.deepEqual(parseAddress('2001:db8::1'), plain('2001:db8::1', 6680));
  for (const bad of [
    '',
    '   ',
    'host:0',
    'host:70000',
    'host:abc',
    'user:pass@host',
    'http://user:pass@host/',
    'mpd://host',
    'a b',
    null,
    42,
  ]) {
    assert.equal(parseAddress(bad), null, String(bad));
  }
  assert.equal(formatAddress(plain('192.0.2.10', 6680)), '192.0.2.10');
  assert.equal(formatAddress(plain('192.0.2.10', 6681)), '192.0.2.10:6681');
  assert.equal(formatAddress(plain('2001:db8::1', 6682)), '[2001:db8::1]:6682');
  assert.equal(
    formatAddress({ host: 'music.example.com', port: 443, secure: true }),
    'https://music.example.com',
  );
});

test('the defaults, with nothing configured', () => {
  assert.deepEqual(normalizeConfig(), {
    players: [],
    invalidSlots: [],
    notificationVolume: null,
    language: 'fr',
  });
  assert.equal(DEFAULT_CONFIG.language, 'fr');
});

test('slots keep their number, a bad address is reported', () => {
  const config = normalizeConfig({
    player_1_address: '192.0.2.10',
    player_2_address: 'not an address',
    player_3_address: '192.0.2.12:6681',
    player_3_name: '  Cuisine  ',
    notification_volume: '60',
    language: 'de',
  });
  assert.deepEqual(config.players, [
    { slot: 1, host: '192.0.2.10', port: 6680, secure: false, name: null },
    { slot: 3, host: '192.0.2.12', port: 6681, secure: false, name: 'Cuisine' },
  ]);
  assert.deepEqual(config.invalidSlots, [2]);
  assert.equal(config.notificationVolume, 60);
  assert.equal(config.language, 'de');
  assert.equal(
    normalizeConfig({ notification_volume: '55', language: 'it' }).notificationVolume,
    null,
  );
  assert.equal(normalizeConfig({ language: 'it' }).language, 'fr');
});

test('what can be handed to Mopidy: URIs with a scheme', () => {
  assert.equal(checkUri(' http://radio.example.com/live '), 'http://radio.example.com/live');
  assert.equal(checkUri('tunein:station:s12345'), 'tunein:station:s12345');
  assert.equal(checkUri('file:///music/doorbell.ogg'), 'file:///music/doorbell.ogg');
  assert.equal(checkUri('local:track:a.flac'), 'local:track:a.flac');
  for (const bad of ['', '  ', 'sounds/doorbell.mp3', 'http://a\nb', 'x'.repeat(2001), null, 3]) {
    assert.equal(checkUri(bad), null, String(bad));
  }
});

test('a volume field of a scene: empty is unchanged, numbers are bounded', () => {
  assert.equal(parseVolume(undefined), null);
  assert.equal(parseVolume(''), null);
  assert.equal(parseVolume('42,6'), 43);
  assert.equal(parseVolume(150), 100);
  assert.equal(parseVolume(-3), 0);
  assert.equal(parseVolume('loud'), null);
});

test('credentials in an address never reach a log or a message', () => {
  assert.equal(
    safeText('Failed to open "http://user:pa55@radio.example.com/a.mp3"'),
    'Failed to open "http://radio.example.com/a.mp3"',
  );
  assert.equal(safeText('no address here'), 'no address here');
});
