// -----------------------------------------------------------------------------
// A scripted Mopidy server on the loopback: JSON-RPC 2.0 over HTTP
// (`POST /mopidy/rpc`, batches included) and the event WebSocket
// (`/mopidy/ws`), shaped after the answers recorded on Mopidy 3.4.2 and 4.0.5
// (test/fixtures/mopidy/). It behaves like the real one where the integration
// depends on it:
//   - 415 without `Content-Type: application/json`, -32601 for an unknown method;
//   - `tracklist.add` of a URI no backend knows adds nothing ([]);
//   - `play` of a track that cannot be read stays stopped, announces nothing;
//   - `play` may switch tracks after it answered (`playLagMs`), as the real
//     one does, and a `seek` sent before the switch is lost;
//   - `single` stops after the track (current track null), `seek` works
//     while paused, `remove` of an unknown tlid removes nothing.
// Time does not flow: tests move it with `advance()` and end a track with
// `finishTrack()`.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import http from 'node:http';
import { WebSocketServer } from 'ws';

export const FIXTURE = JSON.parse(
  readFileSync(new URL('../fixtures/mopidy/mopidy-3.4.2.json', import.meta.url), 'utf8'),
);

const track = (uri, name, extra = {}) => ({ __model__: 'Track', uri, name, ...extra });

// The library: the files of the bench (recorded), tagged tracks and a radio
// written after Mopidy's Track model.
export const LIBRARY = {
  la: FIXTURE['tracklist-add'][0].track,
  mi: FIXTURE['tracklist-add'][1].track,
  ding: track('file:///music/ding.ogg', 'ding.ogg', { length: 928, bitrate: 80000 }),
  oneMoreTime: track('local:track:one-more-time.flac', 'One More Time', {
    artists: [{ __model__: 'Artist', name: 'Daft Punk' }],
    album: { __model__: 'Album', name: 'Discovery' },
    length: 320_000,
  }),
  aerodynamic: track('local:track:aerodynamic.flac', 'Aerodynamic', {
    artists: [{ __model__: 'Artist', name: 'Daft Punk' }],
    album: { __model__: 'Album', name: 'Discovery' },
    length: 212_000,
  }),
  radio: track('http://radio.example/stream.mp3', 'Radio Example'),
};

// A file the file backend accepts but cannot read.
export const BROKEN = 'file:///music/none.ogg';

export const PLAYLISTS = [
  { uri: FIXTURE.playlists[1].uri, name: 'Morning', items: ['la', 'mi'] },
  { uri: FIXTURE.playlists[0].uri, name: 'Apéro', items: ['oneMoreTime', 'aerodynamic'] },
  { uri: 'm3u:Empty.m3u8', name: 'Empty', items: [] },
];

export class FakeMopidy {
  constructor({ volume = 40, mixer = true, websocket = true, version = '3.4.2' } = {}) {
    this.version = version;
    this.websocket = websocket;
    this.mixer = mixer;
    this.volume = mixer ? volume : null;
    this.mute = mixer ? false : null;
    this.random = false;
    this.repeat = false;
    this.single = false;
    this.consume = false;
    this.state = 'stopped';
    this.tracklist = [];
    this.nextTlid = 1;
    this.current = null; // tlid
    this.position = 0;
    this.streamTitle = null;
    this.playLagMs = 0;
    this.playlists = PLAYLISTS.map((p) => ({ ...p, items: [...p.items] }));
    this.calls = [];
    this.offline = false;
    this.server = null;
    this.wss = null;
    this.port = 0;
  }

  async listen() {
    this.sockets = new Set();
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      if (this.offline) {
        socket.destroy();
      }
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      if (!this.websocket || this.offline || req.url !== '/mopidy/ws') {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws));
    });
    await new Promise((resolve) => this.server.listen(this.port, '127.0.0.1', resolve));
    this.port = this.server.address().port;
  }

  async close() {
    for (const client of this.wss?.clients ?? []) {
      client.terminate();
    }
    for (const socket of this.sockets ?? []) {
      socket.destroy();
    }
    await new Promise((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  /** The server stops answering: sockets cut, new connections dropped. */
  goOffline() {
    this.offline = true;
    for (const client of this.wss.clients) {
      client.terminate();
    }
    for (const socket of this.sockets) {
      socket.destroy();
    }
  }

  goOnline() {
    this.offline = false;
  }

  /** Close the WebSockets only (a proxy dropping them), the API keeps answering. */
  dropEventSockets() {
    for (const client of this.wss.clients) {
      client.terminate();
    }
  }

  get eventClients() {
    return this.wss ? this.wss.clients.size : 0;
  }

  methods() {
    return this.calls.map((call) => call.method);
  }

  emit(event, data = {}) {
    const message = JSON.stringify({ ...data, event });
    for (const client of this.wss?.clients ?? []) {
      client.send(message);
    }
  }

  // --- HTTP ---------------------------------------------------------------------

  handle(req, res) {
    if (this.offline) {
      req.socket.destroy();
      return;
    }
    if (req.method !== 'POST' || req.url !== '/mopidy/rpc') {
      res.writeHead(404).end('Not found');
      return;
    }
    if (!String(req.headers['content-type']).startsWith('application/json')) {
      res.writeHead(415).end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700 } }));
        return;
      }
      const answer = Array.isArray(payload)
        ? payload.map((request) => this.answer(request))
        : this.answer(payload);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  }

  answer(request) {
    const { id, method, params = {} } = request;
    this.calls.push({ method, params });
    const handler = this.handlers()[method];
    if (!handler) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'Method not found', data: "No object found at 'core'" },
      };
    }
    try {
      return { jsonrpc: '2.0', id, result: handler(params) ?? null };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: 0,
          message: 'Application error',
          data: { type: 'ValidationError', message: err.message },
        },
      };
    }
  }

  // --- Mopidy core ----------------------------------------------------------------

  tlTrack(tlid) {
    return this.tracklist.find((item) => item.tlid === tlid) ?? null;
  }

  currentTlTrack() {
    const item = this.tlTrack(this.current);
    return item ? { __model__: 'TlTrack', tlid: item.tlid, track: item.track } : null;
  }

  /** Put tracks of LIBRARY (keys) or URIs in the tracklist. */
  enqueue(...keys) {
    return keys.map((key) => {
      const item = { tlid: this.nextTlid++, track: LIBRARY[key] ?? track(key, key) };
      this.tracklist.push(item);
      return item.tlid;
    });
  }

  setState(state) {
    if (state !== this.state) {
      const old = this.state;
      this.state = state;
      this.emit('playback_state_changed', { old_state: old, new_state: state });
    }
  }

  startTrack(tlid) {
    const item = this.tlTrack(tlid);
    if (!item || item.track.uri === BROKEN) {
      // Mopidy cannot read it: nothing changes, nothing is announced.
      return false;
    }
    if (this.current !== null && this.state !== 'stopped') {
      this.emit('track_playback_ended', {
        tl_track: this.currentTlTrack(),
        time_position: this.position,
      });
    }
    this.current = tlid;
    this.position = 0;
    this.streamTitle = null;
    this.setState('playing');
    this.emit('track_playback_started', { tl_track: this.currentTlTrack() });
    return true;
  }

  play({ tlid } = {}) {
    const target = tlid ?? this.current ?? this.tracklist[0]?.tlid ?? null;
    if (target === null) {
      return;
    }
    if (this.playLagMs > 0) {
      setTimeout(() => this.startTrack(target), this.playLagMs);
      return;
    }
    this.startTrack(target);
  }

  /** The current track reaches its end, as Mopidy goes on after it. */
  finishTrack() {
    const ended = this.currentTlTrack();
    if (!ended) {
      return;
    }
    const index = this.tracklist.findIndex((item) => item.tlid === this.current);
    let next;
    if (this.single) {
      next = this.repeat ? this.current : null;
    } else {
      next = this.tracklist[index + 1]?.tlid ?? (this.repeat ? this.tracklist[0]?.tlid : null);
    }
    if (this.consume) {
      this.tracklist.splice(index, 1);
    }
    this.emit('track_playback_ended', { tl_track: ended, time_position: this.position });
    if (next === null) {
      this.current = null;
      this.position = 0;
      this.setState('stopped');
      return;
    }
    this.state = 'stopped';
    this.startTrack(next);
  }

  advance(ms) {
    if (this.state === 'playing') {
      this.position += ms;
    }
  }

  setVolumeSilently(volume) {
    this.volume = volume;
  }

  handlers() {
    const option = (name) => ({
      [`core.tracklist.get_${name}`]: () => this[name],
      [`core.tracklist.set_${name}`]: ({ value }) => {
        this[name] = Boolean(value);
        this.emit('options_changed');
      },
    });
    return {
      'core.get_version': () => this.version,
      'core.playback.get_state': () => this.state,
      'core.playback.get_current_tl_track': () => this.currentTlTrack(),
      'core.playback.get_current_tlid': () => (this.state === 'stopped' ? null : this.current),
      'core.playback.get_time_position': () => this.position,
      'core.playback.get_stream_title': () => this.streamTitle,
      'core.playback.play': (params) => this.play(params),
      'core.playback.pause': () => {
        if (this.state === 'playing') {
          this.setState('paused');
        }
      },
      'core.playback.resume': () => {
        if (this.state === 'paused') {
          this.setState('playing');
        }
      },
      'core.playback.stop': () => {
        this.setState('stopped');
        this.position = 0;
      },
      'core.playback.next': () => {
        const index = this.tracklist.findIndex((item) => item.tlid === this.current);
        const next = this.tracklist[index + 1];
        if (next) {
          this.startTrack(next.tlid);
        }
      },
      'core.playback.previous': () => {
        const index = this.tracklist.findIndex((item) => item.tlid === this.current);
        const previous = this.tracklist[Math.max(index - 1, 0)];
        if (previous) {
          this.startTrack(previous.tlid);
        }
      },
      'core.playback.seek': ({ time_position: position }) => {
        if (this.state === 'stopped' || !Number.isInteger(position)) {
          return false;
        }
        this.position = position;
        this.emit('seeked', { time_position: position });
        return true;
      },
      'core.mixer.get_volume': () => this.volume,
      'core.mixer.set_volume': ({ volume }) => {
        if (!this.mixer) {
          return false;
        }
        if (!Number.isInteger(volume) || volume < 0 || volume > 100) {
          throw new Error(`Expected an integer, not '${volume}'`);
        }
        this.volume = volume;
        this.emit('volume_changed', { volume });
        return true;
      },
      'core.mixer.get_mute': () => this.mute,
      'core.mixer.set_mute': ({ mute }) => {
        if (!this.mixer) {
          return false;
        }
        this.mute = Boolean(mute);
        this.emit('mute_changed', { mute: this.mute });
        return true;
      },
      ...option('random'),
      ...option('repeat'),
      ...option('single'),
      ...option('consume'),
      'core.tracklist.get_length': () => this.tracklist.length,
      'core.tracklist.index': () => {
        const index = this.tracklist.findIndex((item) => item.tlid === this.current);
        return index < 0 ? null : index;
      },
      'core.tracklist.get_tl_tracks': () =>
        this.tracklist.map((item) => ({ __model__: 'TlTrack', ...item })),
      'core.tracklist.add': ({ uris = [] }) => {
        const added = [];
        for (const uri of uris) {
          const known = Object.values(LIBRARY).find((t) => t.uri === uri);
          const readable =
            known ?? (/^(file|https?|local|m3u):/.test(uri) ? track(uri, uri) : null);
          if (!readable) {
            continue; // no backend for this scheme
          }
          const item = { tlid: this.nextTlid++, track: readable };
          this.tracklist.push(item);
          added.push({ __model__: 'TlTrack', ...item });
        }
        if (added.length) {
          this.emit('tracklist_changed');
        }
        return added;
      },
      'core.tracklist.clear': () => {
        this.tracklist = [];
        this.current = null;
        this.emit('tracklist_changed');
      },
      'core.tracklist.remove': ({ criteria = {} }) => {
        const tlids = criteria.tlid ?? [];
        const removed = this.tracklist.filter((item) => tlids.includes(item.tlid));
        this.tracklist = this.tracklist.filter((item) => !tlids.includes(item.tlid));
        if (removed.length) {
          this.emit('tracklist_changed');
        }
        return removed.map((item) => ({ __model__: 'TlTrack', ...item }));
      },
      'core.playlists.as_list': () =>
        this.playlists.map(({ uri, name }) => ({ __model__: 'Ref', uri, name, type: 'playlist' })),
      'core.playlists.get_items': ({ uri }) => {
        const playlist = this.playlists.find((p) => p.uri === uri);
        return playlist
          ? playlist.items.map((key) => ({
              __model__: 'Ref',
              uri: LIBRARY[key].uri,
              name: LIBRARY[key].name,
              type: 'track',
            }))
          : null;
      },
      'core.library.search': ({ query = {} }) => {
        const wanted = String(query.any?.[0] ?? '').toLowerCase();
        const tracks = Object.values(LIBRARY).filter((t) =>
          [t.name, t.album?.name, ...(t.artists ?? []).map((a) => a.name)]
            .filter(Boolean)
            .some((value) => value.toLowerCase().includes(wanted)),
        );
        return [{ __model__: 'SearchResult', uri: 'local:search', tracks }];
      },
    };
  }
}
