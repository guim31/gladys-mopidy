// -----------------------------------------------------------------------------
// One Mopidy server: its state read through JSON-RPC, kept up to date by the
// event WebSocket (a change made in Iris, a phone app or by a button is seen
// at once), a reconnection with back-off when the server is lost, the
// commands of Gladys, and the notifications that play an address then put
// back what was playing.
//
// "Connected" means the JSON-RPC API answers. The WebSocket only makes the
// readings immediate: without it (a proxy that does not pass it), the hub's
// 30 s reading keeps the states right, and it is opened again at each one.
//
// Events (the hub listens to them, the player itself never logs above debug):
//   - `connected`     the API answers and the first reading is done;
//   - `failed`        a connection attempt failed (err);
//   - `disconnected`  a connected server stopped answering (err);
//   - `update`        a new reading of the state, track or playlists;
//   - `track-started` Mopidy started a track (not a notification) ({ track });
//   - `notification`  a notification ended ({ reason, error }).
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { createLogger } from '@gladysassistant/integration-sdk';
import { ERROR_KINDS, MopidyClient, MopidyError } from './mopidy/client.js';
import {
  STATES,
  STATUS_CALLS,
  isStream,
  parsePlaylists,
  parseStatus,
  parseTrack,
  searchTracks,
  trackUris,
} from './mopidy/model.js';

const logger = createLogger({ name: 'mopidy-player' });

export const PLAYER_TIMINGS = {
  // Waits between connection attempts, then the last one again and again.
  reconnectMs: [2_000, 5_000, 15_000, 30_000, 60_000],
  // Events come in bursts (a play sends four): one reading after the burst.
  eventDebounceMs: 150,
  // A notification still playing after this long is ended (a stream that is
  // not a radio, a track paused by someone): what was playing comes back.
  notificationMaxMs: 5 * 60_000,
  // A notification playing this long without a known length is a web
  // radio: it keeps playing, nothing is put back.
  streamAfterMs: 4_000,
  // How long a scene action waits for its address to start playing.
  startTimeoutMs: 10_000,
  // Mopidy answers `play` before it switches tracks (the next reading may
  // still show the paused track): a notification not yet seen as the
  // current track is given this long before it counts as failed.
  startGraceMs: 3_000,
  // Putting back the interrupted track: how long to wait for it to load.
  resumeTimeoutMs: 5_000,
  resumeCheckMs: 50,
  startCheckMs: 500,
};

// Events that change what playlists exist.
const PLAYLIST_EVENTS = new Set(['playlists_loaded', 'playlist_changed', 'playlist_deleted']);

// At most this many tracks queued by a playlist or a search: Mopidy reads
// each one (tags, length) when it is added.
export const MAX_QUEUED_TRACKS = 500;

// The code of the error thrown when no backend of Mopidy knows an address.
export const NOT_PLAYABLE = 'not_playable';
export const MAX_SEARCH_TRACKS = 50;

/** Repeat modes offered to scenes and the widget, as Mopidy's `repeat` and `single`. */
export const REPEAT_MODES = Object.freeze({
  off: { repeat: false, single: false },
  all: { repeat: true, single: false },
  one: { repeat: true, single: true },
});

/** The repeat mode of a status. */
export function repeatMode(status) {
  if (!status?.repeat) {
    return 'off';
  }
  return status.single ? 'one' : 'all';
}

/**
 * Is this something Mopidy may play? A URI with a scheme: `http(s)://` (a
 * web radio, a sound), `file://`, `local:`, `tunein:`, `jellyfin:`... A
 * scheme no backend knows is refused by Mopidy itself (nothing is added).
 * @param {unknown} uri
 * @returns {string|null}
 */
export function checkUri(uri) {
  if (typeof uri !== 'string') {
    return null;
  }
  const text = uri.trim();
  if (text === '' || text.length > 2000 || /[\r\n]/.test(text)) {
    return null;
  }
  return /^[a-z][a-z0-9+.-]*:\S/i.test(text) ? text : null;
}

/** Names compared without case nor accents. */
export const fold = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();

export class Player extends EventEmitter {
  /**
   * @param {object} options
   * @param {{ slot: number, host: string, port: number, secure?: boolean }} options.server
   * @param {boolean} [options.timers] reconnection, debounce and notification timers
   * @param {object} [options.timings] PLAYER_TIMINGS overrides
   * @param {object} [options.clientTimings] CLIENT_TIMINGS overrides
   * @param {typeof fetch} [options.fetch] seam
   * @param {typeof WebSocket} [options.WebSocket] seam
   * @param {() => number} [options.now]
   */
  constructor({ server, timers = true, timings, clientTimings, fetch, WebSocket, now }) {
    super();
    this.server = server;
    this.timers = timers;
    this.timings = { ...PLAYER_TIMINGS, ...timings };
    this.clientOptions = { timings: clientTimings, fetch, WebSocket };
    this.now = now ?? (() => Date.now());
    /** @type {MopidyClient|null} set while connected */
    this.client = null;
    this.connecting = null;
    this.stopped = false;
    this.version = null;
    /** Last error of the connection, null while connected. */
    this.error = null;
    this.failures = 0;
    this.everConnected = false;
    this.reconnectTimer = null;
    this.debounceTimer = null;
    this.status = null;
    this.track = null;
    /** Playlists ({ uri, name }), null until read (or when Mopidy cannot list them). */
    this.playlists = null;
    this.refreshedAt = null;
    this.refreshing = null;
    this.pendingRefresh = null;
    this.wantPlaylists = false;
    /** The notification playing, if any. */
    this.notification = null;
    /** The last notification being started (they start one after the other). */
    this.notifying = Promise.resolve();
    /** The track a notification resumes: its start is not news. */
    this.resumedTlid = null;
  }

  get connected() {
    return this.client !== null;
  }

  get eventsOpen() {
    return this.client?.eventsOpen ?? false;
  }

  // --- Connection ------------------------------------------------------------

  /**
   * Connect, unless connected or connecting. Never throws: a failure is the
   * `failed` event, and a new attempt is scheduled.
   */
  connect() {
    if (this.stopped || this.client) {
      return Promise.resolve();
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.connecting ??= this.attempt().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async attempt() {
    const client = new MopidyClient({ server: this.server, ...this.clientOptions });
    try {
      const version = await client.call('core.get_version');
      if (typeof version !== 'string') {
        throw new MopidyError(ERROR_KINDS.NOT_MOPIDY, 'no Mopidy version in the answer');
      }
      if (this.stopped) {
        client.close();
        return;
      }
      this.version = version;
      this.client = client;
      this.wantPlaylists = true;
      await this.refresh();
    } catch (err) {
      if (this.client === client) {
        this.client = null;
      }
      client.close();
      if (this.stopped) {
        return;
      }
      this.failures += 1;
      this.error = asMopidyError(err);
      this.emit('failed', this.error);
      this.scheduleReconnect();
      return;
    }
    client.on('event', (event) => this.onEvent(client, event));
    client.on('socket-closed', () => this.onSocketClosed(client));
    // Opened right after the first reading: nothing to read again.
    await this.openEvents({ reread: false });
    const restored = this.everConnected;
    this.everConnected = true;
    this.failures = 0;
    this.error = null;
    this.emit('connected', { restored });
  }

  /**
   * Open the event WebSocket if it is not (quietly: the timer reads anyway).
   * @param {{ reread?: boolean }} [options] read once it is open: changes made
   *   while it was closed were not announced
   */
  async openEvents({ reread = true } = {}) {
    const client = this.client;
    if (!client || client.eventsOpen) {
      return;
    }
    const opened = await client.openEvents();
    if (opened && this.client === client && reread) {
      await this.refresh().catch(() => {});
    } else if (!opened) {
      logger.debug(`Player ${this.server.slot}: event socket not opened`);
    }
  }

  /** The WebSocket dropped: Mopidy restarting, or a network cut. Check the API now. */
  onSocketClosed(client) {
    if (this.client !== client || this.stopped) {
      return;
    }
    logger.debug(`Player ${this.server.slot}: event socket closed`);
    this.refresh().catch(() => {});
  }

  /** The API stopped answering: the server is lost until a new attempt succeeds. */
  lose(client, err) {
    if (this.client !== client) {
      return;
    }
    this.client = null;
    client.close();
    this.error = asMopidyError(err);
    // A notification cannot be put back on a server that is gone: Mopidy
    // keeps playing it, the user sees it in the queue.
    this.dropNotification();
    if (this.stopped) {
      return;
    }
    this.failures = 1;
    this.emit('disconnected', this.error);
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (!this.timers || this.stopped || this.reconnectTimer) {
      return;
    }
    const delays = this.timings.reconnectMs;
    const delay = delays[Math.min(this.failures - 1, delays.length - 1)] ?? delays[0];
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /** Stop for good: close the WebSocket, no more attempts. */
  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.debounceTimer);
    this.reconnectTimer = null;
    this.dropNotification();
    const client = this.client;
    this.client = null;
    client?.close();
  }

  onEvent(client, event) {
    if (this.client !== client) {
      return;
    }
    logger.debug(`Player ${this.server.slot}: event ${event.event}`);
    if (event.event === 'track_playback_started') {
      this.onTrackStarted(event.tl_track);
    }
    if (PLAYLIST_EVENTS.has(event.event)) {
      this.wantPlaylists = true;
    }
    if (!this.timers) {
      this.refresh().catch(() => {});
      return;
    }
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.refresh().catch(() => {});
    }, this.timings.eventDebounceMs);
    this.debounceTimer.unref?.();
  }

  onTrackStarted(tlTrack) {
    const tlid = Number.isInteger(tlTrack?.tlid) ? tlTrack.tlid : null;
    const notification = this.notification;
    if (notification && tlid === notification.id) {
      notification.seen = true;
      notification.playing = true;
      notification.settle();
      return;
    }
    if (tlid !== null && tlid === this.resumedTlid) {
      this.resumedTlid = null;
      return;
    }
    this.resumedTlid = null;
    const track = parseTrack(tlTrack?.track);
    if (track) {
      this.emit('track-started', { track });
    }
  }

  /**
   * The periodic check of the hub (and the core's onPoll): a reading when
   * connected — it is also the ping that notices a server gone silent, and
   * the WebSocket is opened again if it dropped —, a connection attempt
   * otherwise, unless one is already planned.
   */
  async tick() {
    if (this.stopped) {
      return;
    }
    if (this.client) {
      await this.refresh().catch(() => {});
      await this.openEvents();
      return;
    }
    if (!this.connecting && !this.reconnectTimer) {
      await this.connect();
    }
  }

  requireClient() {
    if (!this.client) {
      throw this.error ?? new MopidyError(ERROR_KINDS.UNREACHABLE, 'not connected');
    }
    return this.client;
  }

  // --- Reading ---------------------------------------------------------------

  /**
   * Read the state and current track (and the playlists when they changed).
   * Calls made while a reading runs share the next one, which starts after
   * it: whoever sent a command then asks for a reading sees its effect.
   */
  refresh() {
    if (!this.pendingRefresh) {
      const previous = this.refreshing ?? Promise.resolve();
      this.pendingRefresh = previous
        .catch(() => {})
        .then(() => {
          this.pendingRefresh = null;
          this.refreshing = this.read().finally(() => {
            this.refreshing = null;
          });
          return this.refreshing;
        });
    }
    return this.pendingRefresh;
  }

  async read() {
    const client = this.requireClient();
    let results;
    try {
      results = await client.batch(STATUS_CALLS);
    } catch (err) {
      if (asMopidyError(err).kind !== ERROR_KINDS.COMMAND) {
        this.lose(client, err);
      }
      throw err;
    }
    let playlists = this.playlists;
    if (this.wantPlaylists) {
      this.wantPlaylists = false;
      try {
        playlists = parsePlaylists(await client.call('core.playlists.as_list'));
      } catch (err) {
        if (asMopidyError(err).kind !== ERROR_KINDS.COMMAND) {
          this.lose(client, err);
          throw err;
        }
        logger.debug(`Player ${this.server.slot}: playlists not listed (${err.message})`);
        playlists = null;
      }
    }
    if (this.client !== client) {
      return;
    }
    const { status, track } = parseStatus(results);
    this.status = status;
    this.track = track;
    this.playlists = playlists;
    this.refreshedAt = this.now();
    this.emit('update');
    this.checkNotification();
  }

  // --- Commands ----------------------------------------------------------------

  /**
   * Run calls as one batch, then read the new state.
   * @param {Array<[string, object?]>} calls
   */
  async run(calls) {
    const client = this.requireClient();
    let answers;
    try {
      answers = await client.batch(calls);
    } catch (err) {
      if (asMopidyError(err).kind !== ERROR_KINDS.COMMAND) {
        this.lose(client, err);
      }
      throw err;
    }
    await this.refresh().catch(() => {});
    return answers;
  }

  play() {
    // `play` on a paused track would start it again from its beginning.
    return this.run([
      this.status?.state === STATES.PAUSE ? ['core.playback.resume'] : ['core.playback.play'],
    ]);
  }

  pause() {
    return this.run([['core.playback.pause']]);
  }

  /** Play or pause, from the state at the time of the tap. */
  async toggle() {
    await this.refresh();
    return this.status?.state === STATES.PLAY ? this.pause() : this.play();
  }

  next() {
    return this.run([['core.playback.next']]);
  }

  previous() {
    return this.run([['core.playback.previous']]);
  }

  stopPlayback() {
    return this.run([['core.playback.stop']]);
  }

  setVolume(volume) {
    const value = Math.round(Math.min(100, Math.max(0, Number(volume))));
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid volume ${volume}`);
    }
    return this.run([['core.mixer.set_volume', { volume: value }]]);
  }

  /** @param {boolean} mute */
  setMute(mute) {
    return this.run([['core.mixer.set_mute', { mute: Boolean(mute) }]]);
  }

  clearQueue() {
    this.endNotificationQuietly();
    return this.run([['core.playback.stop'], ['core.tracklist.clear']]);
  }

  /** @param {boolean} enabled */
  setRandom(enabled) {
    return this.run([['core.tracklist.set_random', { value: Boolean(enabled) }]]);
  }

  /** @param {'off'|'all'|'one'} mode */
  setRepeat(mode) {
    const { repeat, single } = REPEAT_MODES[mode] ?? REPEAT_MODES.off;
    return this.run([
      ['core.tracklist.set_repeat', { value: repeat }],
      ['core.tracklist.set_single', { value: single }],
    ]);
  }

  /**
   * The playlist matching what the user typed: its URI, its exact name, or
   * its name without case nor accents. Null when there is none.
   * @param {string} wanted
   * @returns {Promise<{ uri: string, name: string }|null>}
   */
  async findPlaylist(wanted) {
    this.wantPlaylists = true;
    await this.refresh();
    const list = this.playlists ?? [];
    const text = String(wanted ?? '').trim();
    return (
      list.find((playlist) => playlist.uri === text) ??
      list.find((playlist) => playlist.name === text) ??
      list.find((playlist) => fold(playlist.name) === fold(text)) ??
      null
    );
  }

  /**
   * Replace the queue with the tracks of a playlist and play it.
   * @param {{ uri: string }} playlist
   * @returns {Promise<number>} number of tracks queued
   */
  async playPlaylist(playlist) {
    const client = this.requireClient();
    const items = await client.call('core.playlists.get_items', { uri: playlist.uri });
    const uris = trackUris(items).slice(0, MAX_QUEUED_TRACKS);
    return this.replaceQueue(uris);
  }

  /**
   * Replace the queue with what a library search finds, and play it.
   * @param {string} query searched in every field
   * @returns {Promise<number>} number of tracks queued
   */
  async playSearch(query) {
    const client = this.requireClient();
    const results = await client.call('core.library.search', {
      query: { any: [query] },
    });
    return this.replaceQueue(searchTracks(results, MAX_SEARCH_TRACKS));
  }

  /**
   * Replace the queue with an address and play it (no resume).
   * @param {string} uri
   * @returns {Promise<number>} number of tracks queued
   */
  playUri(uri) {
    return this.replaceQueue([uri]);
  }

  /** @returns {Promise<number>} the number of tracks Mopidy accepted */
  async replaceQueue(uris) {
    if (uris.length === 0) {
      return 0;
    }
    this.endNotificationQuietly();
    const [, , added] = await this.run([
      ['core.playback.stop'],
      ['core.tracklist.clear'],
      ['core.tracklist.add', { uris }],
      ['core.playback.play'],
    ]);
    return Array.isArray(added) ? added.length : 0;
  }

  // --- Notifications -------------------------------------------------------------
  //
  // The queue is never replaced: the address is added at its end and played
  // with `single` on (Mopidy stops after it), `repeat`, `random` and
  // `consume` off. When it ends, it is removed, the options and the volume
  // come back, and the track that was playing resumes where it was (paused
  // stays paused). A second notification during the first one replaces it,
  // and the state saved by the first one is kept. A web radio (no length) is
  // not a notification: it keeps playing, only the options are put back.
  // Someone else taking over the player (next, another track) ends the
  // notification without touching the playback.

  /**
   * @param {string} uri
   * @param {{ volume?: number|null }} [options] volume during the notification
   * @returns {Promise<object>} the notification (for waitForStart)
   */
  playNotification(uri, options) {
    // One at a time: two doorbell presses must not both save the state of
    // the player (the second would save the first notification).
    const run = this.notifying.catch(() => {}).then(() => this.startNotification(uri, options));
    this.notifying = run;
    return run;
  }

  async startNotification(uri, { volume = null } = {}) {
    const client = this.requireClient();
    // Added first, alone: an address Mopidy refuses changes nothing.
    const added = await client.call('core.tracklist.add', { uris: [uri] });
    const id = Array.isArray(added) && Number.isInteger(added[0]?.tlid) ? added[0].tlid : null;
    if (id === null) {
      throw new MopidyError(ERROR_KINDS.COMMAND, 'no Mopidy backend can play this address', {
        code: NOT_PLAYABLE,
      });
    }
    await this.refresh();
    // Read after the reading: a notification may have just ended.
    const previous = this.notification;
    const status = this.status;
    const saved = previous?.saved ?? {
      state: status.state,
      tlid: status.tlid,
      uri: this.track?.uri ?? null,
      elapsed: status.elapsed,
      volume: status.volume,
      repeat: status.repeat,
      single: status.single,
      consume: status.consume,
      random: status.random,
    };
    // Options so that Mopidy stops after the address and keeps the queue
    // whole (consume would remove the interrupted track). Set once, by the
    // first notification of a series.
    const calls = [];
    if (!previous) {
      for (const [option, wanted] of [
        ['consume', false],
        ['repeat', false],
        ['random', false],
        ['single', true],
      ]) {
        if (saved[option] !== wanted) {
          calls.push([`core.tracklist.set_${option}`, { value: wanted }]);
        }
      }
    }
    const changedOptions = previous ? previous.changedOptions : calls.length > 0;
    const target = Number.isFinite(volume) ? Math.round(Math.min(100, Math.max(0, volume))) : null;
    const setVolume = target !== null && status.volume !== null && status.volume !== target;
    if (setVolume) {
      calls.push(['core.mixer.set_volume', { volume: target }]);
    }
    calls.push(['core.playback.play', { tlid: id }]);
    if (previous) {
      clearTimeout(previous.maxTimer);
      clearTimeout(previous.streamTimer);
      clearTimeout(previous.graceTimer);
      calls.push(['core.tracklist.remove', { criteria: { tlid: [previous.id] } }]);
      // It did play (or was about to): its scene action is not a failure.
      previous.settle();
    }
    let settle;
    const started = new Promise((resolve, reject) => {
      settle = (error) => (error ? reject(error) : resolve());
    });
    // Nobody may wait for the start (onSetValue does not): no unhandled rejection.
    started.catch(() => {});
    const notification = {
      id,
      uri,
      saved,
      changedVolume: (previous?.changedVolume ?? false) || setVolume,
      changedOptions,
      startedAt: this.now(),
      // Seen as the current track (or announced by the start event).
      seen: false,
      playing: false,
      settled: false,
      started,
      settle: (error) => {
        if (!notification.settled) {
          notification.settled = true;
          settle(error);
        }
      },
      maxTimer: null,
      streamTimer: null,
      graceTimer: null,
    };
    this.notification = notification;
    if (this.timers) {
      notification.maxTimer = setTimeout(
        () => this.endNotification(notification, 'timeout'),
        this.timings.notificationMaxMs,
      );
      notification.maxTimer.unref?.();
      // Without any event (an address Mopidy cannot play stays silent), a
      // reading after the grace decides.
      notification.graceTimer = setTimeout(
        () => this.refresh().catch(() => {}),
        this.timings.startGraceMs + 50,
      );
      notification.graceTimer.unref?.();
    }
    try {
      await this.run(calls);
    } catch (err) {
      // Not even started: put everything back now.
      await this.endNotification(notification, 'failed', err);
      throw err;
    }
    return notification;
  }

  /**
   * Wait until a notification plays (a scene action reports whether the
   * address could be played). Reads the player every startCheckMs.
   * @param {object} notification what playNotification resolved
   */
  async waitForStart(notification) {
    const deadline = this.now() + this.timings.startTimeoutMs;
    let timer;
    const poll = new Promise((resolve) => {
      const check = () => {
        if (notification.settled || this.now() >= deadline || this.notification !== notification) {
          resolve();
          return;
        }
        this.refresh()
          .catch(() => {})
          .finally(() => {
            timer = setTimeout(check, this.timings.startCheckMs);
          });
      };
      timer = setTimeout(check, this.timings.startCheckMs);
    });
    await Promise.race([notification.started, poll]).finally(() => clearTimeout(timer));
    if (!notification.settled) {
      throw new MopidyError(ERROR_KINDS.COMMAND, 'the address did not start playing');
    }
    await notification.started;
  }

  /** After each reading: did the notification start, end, or turn out to be a radio? */
  checkNotification() {
    const notification = this.notification;
    if (!notification || !this.status) {
      return;
    }
    const { state, tlid, elapsed, duration } = this.status;
    if (tlid === notification.id) {
      notification.seen = true;
    } else if (!notification.seen) {
      // Not switched yet: wait for it, up to the grace.
      if (this.now() - notification.startedAt < this.timings.startGraceMs) {
        return;
      }
      this.endNotification(
        notification,
        'failed',
        new MopidyError(ERROR_KINDS.COMMAND, 'Mopidy could not play the address'),
      );
      return;
    }
    if (tlid === notification.id) {
      if (state === STATES.PLAY) {
        // The start event may be lost (no WebSocket): time going by says it.
        if (elapsed > 0) {
          notification.playing = true;
          notification.settle();
        }
        if (duration === null || isStream(notification.uri)) {
          this.watchStream(notification);
        }
        return;
      }
      if (state === STATES.PAUSE) {
        return; // paused by someone: the timeout decides
      }
    }
    if (state === STATES.STOP && (tlid === notification.id || tlid === null)) {
      // Stopped on it: the end (single mode), or an address Mopidy could not
      // play — it then stays stopped and never announces the start. A sound
      // shorter than a reading is announced by the event.
      const failed = !notification.playing;
      const error = failed
        ? new MopidyError(ERROR_KINDS.COMMAND, 'Mopidy could not play the address')
        : undefined;
      this.endNotification(notification, failed ? 'failed' : 'ended', error);
      return;
    }
    // Another track, or a stop elsewhere in the queue: someone took over.
    this.endNotification(notification, 'interrupted');
  }

  /** Read again when a notification without length has played long enough to be a radio. */
  watchStream(notification) {
    const playedFor = this.now() - notification.startedAt;
    if (playedFor >= this.timings.streamAfterMs && notification.playing) {
      this.endNotification(notification, 'stream');
      return;
    }
    if (this.timers && !notification.streamTimer) {
      notification.streamTimer = setTimeout(
        () => {
          notification.streamTimer = null;
          this.refresh().catch(() => {});
        },
        Math.max(this.timings.streamAfterMs - playedFor, 0) + 50,
      );
      notification.streamTimer.unref?.();
    }
  }

  /**
   * Put back what the notification changed.
   * @param {object} notification
   * @param {'ended'|'failed'|'interrupted'|'timeout'|'stream'} reason
   * @param {Error} [error]
   */
  async endNotification(notification, reason, error) {
    if (this.notification !== notification) {
      return;
    }
    this.notification = null;
    clearTimeout(notification.maxTimer);
    clearTimeout(notification.streamTimer);
    clearTimeout(notification.graceTimer);
    notification.settle(reason === 'failed' ? (error ?? new Error('failed')) : undefined);
    const { saved } = notification;
    try {
      const client = this.requireClient();
      const calls = [];
      if (reason !== 'stream') {
        // Gone already when someone cleared the queue: Mopidy removes nothing.
        calls.push(['core.tracklist.remove', { criteria: { tlid: [notification.id] } }]);
      }
      if (notification.changedOptions) {
        for (const option of ['consume', 'repeat', 'random', 'single']) {
          calls.push([`core.tracklist.set_${option}`, { value: saved[option] }]);
        }
      }
      if (notification.changedVolume && reason !== 'stream' && saved.volume !== null) {
        calls.push(['core.mixer.set_volume', { volume: saved.volume }]);
      }
      const resume = ['ended', 'failed', 'timeout'].includes(reason);
      if (resume && (saved.tlid === null || saved.state === STATES.STOP)) {
        // A timeout leaves the notification playing: stop it.
        if (reason === 'timeout') {
          calls.push(['core.playback.stop']);
        }
      } else if (resume) {
        this.resumedTlid = saved.tlid;
        calls.push(['core.playback.play', { tlid: saved.tlid }]);
      }
      if (calls.length > 0) {
        await client.batch(calls);
      }
      if (resume && saved.tlid !== null && saved.state !== STATES.STOP) {
        await this.restorePosition(client, saved);
      }
      await this.refresh().catch(() => {});
      logger.debug(`Player ${this.server.slot}: notification ${reason}`);
    } catch (err) {
      logger.debug(`Player ${this.server.slot}: notification not put back (${err.message})`);
      error ??= err;
    }
    this.emit('notification', { reason, error: reason === 'failed' ? error : undefined });
  }

  /**
   * Put the resumed track back at its position, paused if it was. Mopidy
   * answers `play` before the track is loaded, and a seek sent too early is
   * lost (seen on 3.4 and 4.0): wait until it is the current track first.
   */
  async restorePosition(client, saved) {
    const deadline = this.now() + this.timings.resumeTimeoutMs;
    for (;;) {
      const [state, tlid] = await client.batch([
        ['core.playback.get_state'],
        ['core.playback.get_current_tlid'],
      ]);
      if (tlid === saved.tlid && state === 'playing') {
        break;
      }
      if (this.now() >= deadline || (tlid !== null && tlid !== saved.tlid)) {
        return; // someone else took over, or it does not start
      }
      await new Promise((resolve) => setTimeout(resolve, this.timings.resumeCheckMs));
    }
    const calls = [];
    if (saved.state === STATES.PAUSE) {
      calls.push(['core.playback.pause']);
    }
    // A web radio cannot seek: it simply starts again.
    if (saved.elapsed > 0 && !isStream(saved.uri)) {
      calls.push(['core.playback.seek', { time_position: Math.round(saved.elapsed) }]);
    }
    if (calls.length > 0) {
      await client.batch(calls);
    }
  }

  /** A command of the user replaces the queue: the notification is over, nothing to resume. */
  endNotificationQuietly() {
    const notification = this.notification;
    if (notification) {
      this.endNotification(notification, 'interrupted').catch(() => {});
    }
  }

  /** The server is gone: forget the notification (nothing can be put back). */
  dropNotification() {
    const notification = this.notification;
    if (!notification) {
      return;
    }
    this.notification = null;
    clearTimeout(notification.maxTimer);
    clearTimeout(notification.streamTimer);
    clearTimeout(notification.graceTimer);
    notification.settle(new MopidyError(ERROR_KINDS.UNREACHABLE, 'connection lost'));
  }
}

/** Any error as a MopidyError with a kind. */
export function asMopidyError(err) {
  if (err instanceof MopidyError) {
    return err;
  }
  return new MopidyError(ERROR_KINDS.UNREACHABLE, err?.message ?? String(err));
}
