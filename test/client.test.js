// -----------------------------------------------------------------------------
// The JSON-RPC client and the event WebSocket, against the fake Mopidy and a
// few raw HTTP servers: batches, errors by kind, limits.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ERROR_KINDS, MopidyClient, serverUrl } from '../src/mopidy/client.js';
import { FakeMopidy, eventually } from './helpers/world.js';

async function fake(t, options) {
  const mopidy = new FakeMopidy(options);
  await mopidy.listen();
  t.after(() => mopidy.close());
  return mopidy;
}

async function rawServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

const clientOf = (t, port, timings) => {
  const client = new MopidyClient({ server: { host: '127.0.0.1', port }, timings });
  t.after(() => client.close());
  return client;
};

async function rejects(promise, kind, pattern) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.kind, kind);
    if (pattern) {
      assert.match(err.message, pattern);
    }
    return true;
  });
}

test('the URLs of a server: IPv6 in brackets, https and wss behind a proxy', () => {
  assert.equal(serverUrl({ host: '192.0.2.10', port: 6680 }), 'http://192.0.2.10:6680');
  assert.equal(serverUrl({ host: '2001:db8::1', port: 6680 }, 'ws'), 'ws://[2001:db8::1]:6680');
  assert.equal(
    serverUrl({ host: 'music.example.com', port: 443, secure: true }, 'ws'),
    'wss://music.example.com:443',
  );
});

test('one call, and a batch answered in the order of the calls', async (t) => {
  const mopidy = await fake(t);
  const client = clientOf(t, mopidy.port);
  assert.equal(await client.call('core.get_version'), '3.4.2');
  assert.deepEqual(
    await client.batch([
      ['core.mixer.set_volume', { volume: 12 }],
      ['core.mixer.get_volume'],
      ['core.playback.get_state'],
    ]),
    [true, 12, 'stopped'],
  );
});

test('a JSON-RPC error fails with the reason Mopidy gives', async (t) => {
  const mopidy = await fake(t);
  const client = clientOf(t, mopidy.port);
  await rejects(client.call('core.nope'), ERROR_KINDS.COMMAND, /Method not found/);
  await rejects(
    client.call('core.mixer.set_volume', { volume: 'x' }),
    ERROR_KINDS.COMMAND,
    /Application error: Expected an integer/,
  );
});

test('a refused connection is UNREACHABLE, a silent server times out', async (t) => {
  await rejects(clientOf(t, 1).call('core.get_version'), ERROR_KINDS.UNREACHABLE);
  const port = await rawServer(t, () => {});
  await rejects(
    clientOf(t, port, { requestMs: 100 }).call('core.get_version'),
    ERROR_KINDS.UNREACHABLE,
    /timeout/,
  );
});

test('another web server is NOT_MOPIDY, a proxy refusal is FORBIDDEN', async (t) => {
  const page = await rawServer(t, (req, res) => res.writeHead(404).end('<html>'));
  await rejects(clientOf(t, page).call('core.get_version'), ERROR_KINDS.NOT_MOPIDY, /404/);
  const html = await rawServer(t, (req, res) => res.writeHead(200).end('<html>'));
  await rejects(clientOf(t, html).call('core.get_version'), ERROR_KINDS.NOT_MOPIDY, /JSON/);
  const json = await rawServer(t, (req, res) => res.writeHead(200).end('{"hello":1}'));
  await rejects(clientOf(t, json).call('core.get_version'), ERROR_KINDS.NOT_MOPIDY);
  const proxy = await rawServer(t, (req, res) => res.writeHead(401).end());
  await rejects(clientOf(t, proxy).call('core.get_version'), ERROR_KINDS.FORBIDDEN);
});

test('an answer too large is refused, not kept in memory', async (t) => {
  const port = await rawServer(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const chunk = 'x'.repeat(1_000_000);
    for (let i = 0; i < 6; i += 1) {
      res.write(chunk);
    }
    res.end();
  });
  await rejects(clientOf(t, port).call('core.get_version'), ERROR_KINDS.NOT_MOPIDY, /too large/);
});

test('the event socket delivers the events, and says when it drops', async (t) => {
  const mopidy = await fake(t);
  const client = clientOf(t, mopidy.port);
  const events = [];
  let dropped = 0;
  client.on('event', (event) => events.push(event));
  client.on('socket-closed', () => (dropped += 1));
  assert.equal(await client.openEvents(), true);
  await client.call('core.mixer.set_volume', { volume: 20 });
  await eventually(() => events.length === 1);
  assert.deepEqual(events[0], { volume: 20, event: 'volume_changed' });
  mopidy.dropEventSockets();
  await eventually(() => dropped === 1);
  assert.equal(client.eventsOpen, false);
});

test('no event socket (a proxy that does not pass it): false, quietly', async (t) => {
  const mopidy = await fake(t, { websocket: false });
  const client = clientOf(t, mopidy.port);
  assert.equal(await client.openEvents(), false);
  assert.equal(await client.call('core.get_version'), '3.4.2');
});
