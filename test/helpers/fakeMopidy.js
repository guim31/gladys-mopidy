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
import jpeg from 'jpeg-js';

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
  // The voice of "Talk on a speaker": a web address with a length.
  voice: track('https://gladys.example/tts/abc.mp3?token=x', 'abc.mp3', { length: 8000 }),
};

// The album of the tagged tracks, as Mopidy-Local names it.
export const ALBUM_URI = 'local:album:md5:discovery';
export const ARTIST_URI = 'local:artist:md5:daftpunk';

// Images by URI, as `core.library.get_images` gives them: Mopidy-Local
// serves one image per album, a path on the server, at the size of the file;
// a streaming backend gives absolute URLs in several sizes.
export const IMAGES = {
  [ALBUM_URI]: [{ uri: '/local/discovery-300x300.jpeg', width: 300, height: 300 }],
  'local:track:one-more-time.flac': [
    { uri: '/local/discovery-300x300.jpeg', width: 300, height: 300 },
  ],
  'local:track:aerodynamic.flac': [
    { uri: '/local/huge-1600x1600.jpeg', width: 1600, height: 1600 },
  ],
};

// A small JPEG the core accepts as it is, and one above 300 KB (noise, so
// that it stays large): 800 × 600 px, made smaller by the integration.
export const SMALL_JPEG = readFileSync(
  new URL('../fixtures/artwork/baseline-420.jpg', import.meta.url),
);
export const HUGE_JPEG = (() => {
  const width = 800;
  const height = 600;
  const data = Buffer.alloc(width * height * 4, 255);
  let seed = 7;
  for (let i = 0; i < data.length; i++) {
    if (i % 4 !== 3) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      data[i] = 128 + (seed % 101) - 50;
    }
  }
  return jpeg.encode({ data, width, height }, 100).data;
})();
// Above the 10 MB the integration reads.
export const OVERSIZE = Buffer.alloc(11 * 1024 * 1024);

// The library as `core.library.browse` walks it.
export const TREE = {
  root: [
    { __model__: 'Ref', uri: 'file:///music', name: 'Files', type: 'directory' },
    { __model__: 'Ref', uri: 'local:directory', name: 'Local media', type: 'directory' },
  ],
  'local:directory': [
    { __model__: 'Ref', uri: ALBUM_URI, name: 'Discovery', type: 'album' },
    { __model__: 'Ref', uri: ARTIST_URI, name: 'Daft Punk', type: 'artist' },
  ],
  [ALBUM_URI]: [
    {
      __model__: 'Ref',
      uri: 'local:track:one-more-time.flac',
      name: 'One More Time',
      type: 'track',
    },
    { __model__: 'Ref', uri: 'local:track:aerodynamic.flac', name: 'Aerodynamic', type: 'track' },
  ],
  'file:///music': [
    { __model__: 'Ref', uri: 'file:///music/sub', name: 'sub', type: 'directory' },
    { __model__: 'Ref', uri: 'file:///music/la-440.ogg', name: 'la-440.ogg', type: 'track' },
    {
      __model__: 'Ref',
      uri: 'http://radio.example/stream.mp3',
      name: 'Radio Example',
      type: 'track',
    },
  ],
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
    if (req.method === 'GET' && req.url.startsWith('/local/')) {
      const image = req.url.includes('huge')
        ? HUGE_JPEG
        : req.url.includes('oversize')
          ? OVERSIZE
          : req.url.includes('page')
            ? Buffer.from('<html>Not an image</html>')
            : SMALL_JPEG;
      if (req.url.includes('chunked')) {
        // No Content-Length: the size is only known by reading.
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Transfer-Encoding': 'chunked' });
        for (let at = 0; at < image.length; at += 64 * 1024) {
          res.write(image.subarray(at, at + 64 * 1024));
        }
        res.end();
        return;
      }
      res
        .writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': image.length })
        .end(image);
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
      'core.tracklist.add': ({ uris = [], at_position: atPosition }) => {
        const added = [];
        const expanded = uris.flatMap((uri) =>
          uri === ALBUM_URI ? TREE[ALBUM_URI].map((ref) => ref.uri) : [uri],
        );
        for (const uri of expanded) {
          const known = Object.values(LIBRARY).find((t) => t.uri === uri);
          const readable =
            known ?? (/^(file|https?|local|m3u):/.test(uri) ? track(uri, uri) : null);
          if (!readable) {
            continue; // no backend for this scheme
          }
          const item = { tlid: this.nextTlid++, track: readable };
          if (Number.isInteger(atPosition)) {
            this.tracklist.splice(atPosition + added.length, 0, item);
          } else {
            this.tracklist.push(item);
          }
          added.push({ __model__: 'TlTrack', ...item });
        }
        if (added.length) {
          this.emit('tracklist_changed');
        }
        return added;
      },
      'core.tracklist.slice': ({ start, end }) =>
        this.tracklist.slice(start, end).map((item) => ({ __model__: 'TlTrack', ...item })),
      'core.library.browse': ({ uri }) => TREE[uri ?? 'root'] ?? [],
      'core.library.lookup': ({ uris = [] }) =>
        Object.fromEntries(
          uris.map((uri) => [
            uri,
            this.lookups?.[uri] ??
              (TREE[uri] ?? [])
                .map((ref) => Object.values(LIBRARY).find((t) => t.uri === ref.uri))
                .filter(Boolean),
          ]),
        ),
      'core.library.get_images': ({ uris = [] }) =>
        Object.fromEntries(
          uris.map((uri) => [uri, (IMAGES[uri] ?? []).map((i) => ({ __model__: 'Image', ...i }))]),
        ),
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
        const albums = tracks.some((t) => t.album?.name === 'Discovery')
          ? [
              {
                __model__: 'Album',
                uri: ALBUM_URI,
                name: 'Discovery',
                artists: [{ __model__: 'Artist', uri: ARTIST_URI, name: 'Daft Punk' }],
              },
            ]
          : [];
        return [{ __model__: 'SearchResult', uri: 'local:search', tracks, albums }];
      },
    };
  }
}
