// -----------------------------------------------------------------------------
// Conformity with the Gladys core, on every device discovered from realistic
// servers (fake Mopidy servers answering like Mopidy 3.4 and 4.0): one to
// four servers, with and without mixer, with playlists whose URIs the core
// would refuse, a server offline at start (playlists unknown), in every
// feature-name language.
//
// The table (test/fixtures/gladys-feature-table.json) is extracted from the
// core code: a category/type couple missing there shows as "undefined" or
// without icon in Gladys, a poll frequency outside its list is a 400 on
// discovery, a feature without min/max is a 422 on "Add to Gladys".
// The supported_options rules are those of the core
// (server/utils/normalizeSupportedOptions.js, Gladys 5.2.1).
// Do not loosen this test to make it pass: fix the integration.
// (Adapted from guim31/gladys-wled.)
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FakeMopidy, createWorld } from './helpers/world.js';

const table = JSON.parse(
  await readFile(new URL('./fixtures/gladys-feature-table.json', import.meta.url), 'utf8'),
);

const odd = () => {
  const mopidy = new FakeMopidy({ mixer: false, version: '4.0.5' });
  mopidy.playlists = [
    { uri: ' m3u:leading.m3u8', name: 'Leading space', items: [] },
    { uri: 'm3u:trailing.m3u8 ', name: 'Trailing space', items: [] },
    { uri: 'm3u:Rock.m3u8', name: 'Rock', items: [] },
    { uri: 'spotify:playlist:37i9dQZF1DX', name: 'Rock & Roll “live”', items: [] },
    { uri: 'm3u:Rock.m3u8', name: 'Rock again', items: [] },
  ];
  return mopidy;
};

const empty = () => {
  const mopidy = new FakeMopidy();
  mopidy.playlists = [];
  return mopidy;
};

const scenarios = [
  { label: 'one server', servers: () => [new FakeMopidy()], config: {} },
  {
    label: 'four servers, one without mixer, odd playlist URIs',
    servers: () => [new FakeMopidy(), odd(), empty(), new FakeMopidy()],
    config: {},
  },
  {
    label: 'a server offline at start',
    servers: () => [new FakeMopidy()],
    offline: true,
    config: {},
  },
  { label: 'French names', servers: () => [new FakeMopidy()], config: { language: 'fr' } },
  { label: 'German names', servers: () => [new FakeMopidy()], config: { language: 'de' } },
  { label: 'Spanish names', servers: () => [new FakeMopidy()], config: { language: 'es' } },
];

/** The checks of the core on supported_options (text/select: string values allowed). */
function supportedOptionsProblems(feature, at) {
  if (feature.supported_options === undefined) {
    return [];
  }
  const found = [];
  const allowStrings = feature.category === 'text' && feature.type === 'select';
  const values = new Set();
  for (const option of feature.supported_options) {
    const { value, label } = option;
    const validValue =
      Number.isInteger(value) ||
      (allowStrings && typeof value === 'string' && value.trim() === value && value.length > 0);
    if (!validValue) {
      found.push(`${at}: option value ${JSON.stringify(value)} refused by the core`);
    }
    if (typeof label !== 'string' || label.trim() !== label || label.length === 0) {
      found.push(`${at}: option label ${JSON.stringify(label)} refused by the core`);
    }
    if (values.has(String(value))) {
      found.push(`${at}: duplicate option value ${JSON.stringify(value)}`);
    }
    values.add(String(value));
  }
  return found;
}

for (const scenario of scenarios) {
  test(`every discovered device follows the Gladys rules (${scenario.label})`, async (t) => {
    const servers = scenario.servers();
    for (const server of servers) {
      await server.listen();
    }
    if (scenario.offline) {
      servers[0].goOffline();
    }
    const world = await createWorld({ servers, config: scenario.config });
    t.after(() => world.stop());
    const devices = world.gladys.fake.discoveredDevices;
    assert.equal(devices.length, servers.length);

    for (const device of devices) {
      const where = device.name;

      // should_poll: true if and only if poll_frequency is provided, in ms.
      if (device.poll_frequency === undefined) {
        assert.notEqual(device.should_poll, true, `${where}: should_poll without poll_frequency`);
      } else {
        assert.equal(device.should_poll, true, `${where}: poll_frequency without should_poll`);
        assert.ok(
          table.poll_frequencies_ms.includes(device.poll_frequency),
          `${where}: poll_frequency ${device.poll_frequency} is not one of ${table.poll_frequencies_ms}`,
        );
      }

      assert.ok(device.features.length > 0, `${where}: no feature`);
      const externalIds = new Set();
      const names = new Set();
      for (const feature of device.features) {
        const at = `${where} / ${feature.name}`;
        const pair = table.pairs[`${feature.category}/${feature.type}`];
        assert.ok(pair, `${at}: ${feature.category}/${feature.type} is not a couple Gladys knows`);
        assert.ok(
          pair.label_en && pair.label_fr && pair.icon,
          `${at}: couple without label or icon`,
        );

        assert.equal(typeof feature.min, 'number', `${at}: min must be a number`);
        assert.equal(typeof feature.max, 'number', `${at}: max must be a number`);
        assert.ok(
          Number.isFinite(feature.min) && Number.isFinite(feature.max),
          `${at}: finite min/max`,
        );
        assert.ok(feature.min <= feature.max, `${at}: min > max`);
        assert.equal(typeof feature.read_only, 'boolean', `${at}: read_only must be a boolean`);
        assert.equal(
          typeof feature.has_feedback,
          'boolean',
          `${at}: has_feedback must be a boolean`,
        );
        if (feature.unit !== undefined) {
          assert.ok(table.units.includes(feature.unit), `${at}: unknown unit ${feature.unit}`);
        }
        assert.deepEqual(supportedOptionsProblems(feature, at), []);

        assert.ok(!externalIds.has(feature.external_id), `${at}: duplicate external_id`);
        externalIds.add(feature.external_id);
        assert.ok(!names.has(feature.name), `${at}: duplicate feature name on the device`);
        names.add(feature.name);
      }
    }
  });
}

test('the supported_options check catches what the core refuses', () => {
  const feature = (options) => ({ category: 'text', type: 'select', supported_options: options });
  assert.equal(supportedOptionsProblems(feature([{ value: ' a', label: 'a' }]), 'x').length, 1);
  assert.equal(supportedOptionsProblems(feature([{ value: 'a', label: '' }]), 'x').length, 1);
  assert.equal(
    supportedOptionsProblems(
      feature([
        { value: 'a', label: 'a' },
        { value: 'a', label: 'b' },
      ]),
      'x',
    ).length,
    1,
  );
  assert.equal(
    supportedOptionsProblems(
      { category: 'music', type: 'volume', supported_options: [{ value: 'a', label: 'a' }] },
      'x',
    ).length,
    1,
  );
});
