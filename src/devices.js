// -----------------------------------------------------------------------------
// One Gladys device per Mopidy server, with the music features of the core so
// that Gladys shows it as a player (the "Music" dashboard box, the "Talk on a
// speaker" scene action):
//   - play, pause, previous, next: music/play… commands (has_feedback false:
//     Gladys keeps the last command it sent, the playback state says the truth);
//   - volume: music/volume 0-100, has_feedback true (Mopidy's mixer answers);
//   - mute: switch/binary, has_feedback true (the core has no music mute);
//   - playback state: music/playback_state, 1 playing, 0 paused or stopped
//     (MUSIC_PLAYBACK_STATE of the core);
//   - now playing: text/text, "Title — Artist" (the music box of Gladys has
//     no place for it), "Paused · …", "Stopped";
//   - notification: music/play_notification, receives an address (a URL or a
//     Mopidy URI) to play, then what played comes back;
//   - playlist: text/select whose options are the playlists of Mopidy (value:
//     the playlist URI, label: its name), upserted at each publication
//     (Gladys syncs `supported_options` of an added device without asking):
//     picking one plays it, in the dashboard or from "Control a device".
//
// Identity: the configuration slot (1 to 4), see src/config.js.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_POLL_FREQUENCIES,
} from '@gladysassistant/integration-sdk';
import { SLOTS, formatAddress } from './config.js';
import { STATES, trackText } from './mopidy/model.js';

export const DEVICE_TYPE = 'mopidy';
export const ADDRESS_PARAM = 'MOPIDY_ADDRESS';

// The core may poll (onPoll, a fallback of the container's own timer) once a
// minute: the slowest pace it knows.
export const POLL_FREQUENCY = DEVICE_POLL_FREQUENCIES.EVERY_MINUTES;

// At most this many playlists in the select (and in the widget form).
export const MAX_PLAYLISTS = 100;

// Suffixes of the feature external ids: permanent once published.
export const FEATURE_KEYS = Object.freeze({
  PLAY: 'play',
  PAUSE: 'pause',
  PREVIOUS: 'previous',
  NEXT: 'next',
  VOLUME: 'volume',
  MUTE: 'mute',
  PLAYBACK_STATE: 'playback-state',
  NOW_PLAYING: 'now-playing',
  PLAYLIST: 'playlist',
  NOTIFICATION: 'play-notification',
});

// Feature names, in the language chosen in the configuration (Gladys does not
// tell a device integration the user's language). Frozen at creation in Gladys.
export const NAMES = {
  en: {
    [FEATURE_KEYS.PLAY]: 'Play',
    [FEATURE_KEYS.PAUSE]: 'Pause',
    [FEATURE_KEYS.PREVIOUS]: 'Previous track',
    [FEATURE_KEYS.NEXT]: 'Next track',
    [FEATURE_KEYS.VOLUME]: 'Volume',
    [FEATURE_KEYS.MUTE]: 'Mute',
    [FEATURE_KEYS.PLAYBACK_STATE]: 'Playback state',
    [FEATURE_KEYS.NOW_PLAYING]: 'Now playing',
    [FEATURE_KEYS.PLAYLIST]: 'Playlist',
    [FEATURE_KEYS.NOTIFICATION]: 'Notification',
  },
  fr: {
    [FEATURE_KEYS.PLAY]: 'Lecture',
    [FEATURE_KEYS.PAUSE]: 'Pause',
    [FEATURE_KEYS.PREVIOUS]: 'Morceau précédent',
    [FEATURE_KEYS.NEXT]: 'Morceau suivant',
    [FEATURE_KEYS.VOLUME]: 'Volume',
    [FEATURE_KEYS.MUTE]: 'Muet',
    [FEATURE_KEYS.PLAYBACK_STATE]: 'État de lecture',
    [FEATURE_KEYS.NOW_PLAYING]: 'En cours',
    [FEATURE_KEYS.PLAYLIST]: 'Playlist',
    [FEATURE_KEYS.NOTIFICATION]: 'Notification',
  },
  de: {
    [FEATURE_KEYS.PLAY]: 'Wiedergabe',
    [FEATURE_KEYS.PAUSE]: 'Pause',
    [FEATURE_KEYS.PREVIOUS]: 'Vorheriger Titel',
    [FEATURE_KEYS.NEXT]: 'Nächster Titel',
    [FEATURE_KEYS.VOLUME]: 'Lautstärke',
    [FEATURE_KEYS.MUTE]: 'Stumm',
    [FEATURE_KEYS.PLAYBACK_STATE]: 'Wiedergabestatus',
    [FEATURE_KEYS.NOW_PLAYING]: 'Aktuelle Wiedergabe',
    [FEATURE_KEYS.PLAYLIST]: 'Playlist',
    [FEATURE_KEYS.NOTIFICATION]: 'Benachrichtigung',
  },
  es: {
    [FEATURE_KEYS.PLAY]: 'Reproducir',
    [FEATURE_KEYS.PAUSE]: 'Pausa',
    [FEATURE_KEYS.PREVIOUS]: 'Pista anterior',
    [FEATURE_KEYS.NEXT]: 'Pista siguiente',
    [FEATURE_KEYS.VOLUME]: 'Volumen',
    [FEATURE_KEYS.MUTE]: 'Silencio',
    [FEATURE_KEYS.PLAYBACK_STATE]: 'Estado de reproducción',
    [FEATURE_KEYS.NOW_PLAYING]: 'Reproduciendo ahora',
    [FEATURE_KEYS.PLAYLIST]: 'Lista de reproducción',
    [FEATURE_KEYS.NOTIFICATION]: 'Notificación',
  },
};

const MUSIC = DEVICE_FEATURE_CATEGORIES.MUSIC;
const TYPES = DEVICE_FEATURE_TYPES.MUSIC;

const command = (key, type) => ({
  key,
  definition: {
    category: MUSIC,
    type,
    read_only: false,
    has_feedback: false,
    keep_history: false,
    min: 0,
    max: 1,
  },
});

// Order = display order in Gladys.
const FEATURES = [
  command(FEATURE_KEYS.PLAY, TYPES.PLAY),
  command(FEATURE_KEYS.PAUSE, TYPES.PAUSE),
  command(FEATURE_KEYS.PREVIOUS, TYPES.PREVIOUS),
  command(FEATURE_KEYS.NEXT, TYPES.NEXT),
  {
    key: FEATURE_KEYS.VOLUME,
    definition: {
      category: MUSIC,
      type: TYPES.VOLUME,
      read_only: false,
      has_feedback: true,
      keep_history: false,
      min: 0,
      max: 100,
    },
    // No mixer: Mopidy cannot tell (nor change) the volume.
    value: (status) => status.volume,
  },
  {
    key: FEATURE_KEYS.MUTE,
    definition: {
      category: DEVICE_FEATURE_CATEGORIES.SWITCH,
      type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
      read_only: false,
      has_feedback: true,
      keep_history: false,
      min: 0,
      max: 1,
    },
    value: (status) => (status.mute === null ? null : Number(status.mute)),
  },
  {
    key: FEATURE_KEYS.PLAYBACK_STATE,
    definition: {
      category: MUSIC,
      type: TYPES.PLAYBACK_STATE,
      read_only: true,
      has_feedback: false,
      keep_history: true,
      min: 0,
      max: 1,
    },
    // MUSIC_PLAYBACK_STATE of the core: PLAYING 1, PAUSED 0 (stopped too).
    value: (status) => (status.state === STATES.PLAY ? 1 : 0),
  },
  {
    key: FEATURE_KEYS.NOW_PLAYING,
    definition: {
      category: DEVICE_FEATURE_CATEGORIES.TEXT,
      type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
      read_only: true,
      has_feedback: false,
      keep_history: false,
      // NOT NULL in the core database, meaningless for a text.
      min: 0,
      max: 0,
    },
  },
  {
    key: FEATURE_KEYS.PLAYLIST,
    definition: {
      category: DEVICE_FEATURE_CATEGORIES.TEXT,
      type: DEVICE_FEATURE_TYPES.TEXT.SELECT,
      read_only: false,
      // Gladys saves the option picked; Mopidy has no "current playlist" to
      // report back (the queue is a copy of it).
      has_feedback: false,
      keep_history: false,
      // NOT NULL in the core database, meaningless for a select.
      min: 0,
      max: 0,
    },
  },
  {
    key: FEATURE_KEYS.NOTIFICATION,
    definition: {
      category: MUSIC,
      type: TYPES.PLAY_NOTIFICATION,
      read_only: false,
      has_feedback: false,
      keep_history: false,
      min: 0,
      max: 0,
    },
  },
];

/** External ids of a player's device and features. */
export const deviceIds = (gladys, slot) => gladys.externalIds(DEVICE_TYPE, String(slot));

/** The slot of a device external id, null when it is not one of ours. */
export function slotOf(gladys, externalId) {
  for (const slot of SLOTS) {
    if (deviceIds(gladys, slot).device === externalId) {
      return slot;
    }
  }
  return null;
}

/** The name shown for a player: the one typed in the configuration, else its address. */
export const playerName = (server) => server.name ?? `Mopidy ${formatAddress(server)}`;

// The now-playing text when nothing plays, or before a paused track.
export const STATE_TEXT = {
  en: { pause: 'Paused', stop: 'Stopped', offline: 'Offline' },
  fr: { pause: 'En pause', stop: 'Arrêté', offline: 'Hors ligne' },
  de: { pause: 'Pausiert', stop: 'Gestoppt', offline: 'Offline' },
  es: { pause: 'En pausa', stop: 'Detenido', offline: 'Sin conexión' },
};

const MAX_TEXT = 200;

/**
 * What the player plays, for the now-playing text (never empty: the core
 * ignores an empty text).
 * @param {object|null} status
 * @param {object|null} track
 * @param {string} language
 */
export function nowPlayingText(status, track, language) {
  const labels = STATE_TEXT[language] ?? STATE_TEXT.en;
  if (!status) {
    return labels.offline;
  }
  const text = trackText(track);
  if (status.state === STATES.PLAY && text) {
    return text;
  }
  if (status.state === STATES.PAUSE && text) {
    return `${labels.pause} · ${text}`.slice(0, MAX_TEXT);
  }
  return status.state === STATES.PAUSE ? labels.pause : labels.stop;
}

/**
 * The options of the playlist select: value the playlist URI (stable, and
 * unique even when two backends have a playlist of the same name), label its
 * name. The core refuses a value that is blank or has spaces around it.
 * @param {Array<{ uri: string, name: string }>|null} playlists
 * @returns {Array<{ value: string, label: string }>|undefined} undefined when
 *   unknown (player not read yet): the options already in Gladys stay
 */
export function playlistOptions(playlists) {
  if (!Array.isArray(playlists)) {
    return undefined;
  }
  const seen = new Set();
  const options = [];
  for (const { uri, name } of playlists) {
    if (typeof uri !== 'string' || uri !== uri.trim() || uri === '' || seen.has(uri)) {
      continue;
    }
    seen.add(uri);
    options.push({ value: uri, label: String(name).slice(0, 100) });
    if (options.length === MAX_PLAYLISTS) {
      break;
    }
  }
  return options;
}

/**
 * The discovery payload of a player.
 * @param {object} gladys SDK client
 * @param {{ slot: number, host: string, port: number, name: string|null }} server
 * @param {string} language feature names language
 * @param {Array<{ uri: string, name: string }>|null} [playlists] when known
 * @param {string|null} [version] Mopidy version, when known
 */
export function buildDevice(gladys, server, language = 'fr', playlists = null, version = null) {
  const ids = deviceIds(gladys, server.slot);
  const names = NAMES[language] ?? NAMES.fr;
  const options = playlistOptions(playlists);
  return {
    name: playerName(server),
    external_id: ids.device,
    model: version ? `Mopidy ${version}`.slice(0, 60) : 'Mopidy',
    // The container keeps the event socket open and refreshes on its own
    // timer (Gladys#3198: the core may never poll); onPoll is the fallback.
    should_poll: true,
    poll_frequency: POLL_FREQUENCY,
    params: [{ name: ADDRESS_PARAM, value: formatAddress(server) }],
    features: FEATURES.map(({ key, definition }) => {
      const feature = { ...definition, name: names[key], external_id: ids.feature(key) };
      if (key === FEATURE_KEYS.PLAYLIST && options !== undefined) {
        feature.supported_options = options;
      }
      return feature;
    }),
  };
}

/**
 * The states to publish for a player (features without a value left out).
 * @param {object} gladys
 * @param {number} slot
 * @param {object|null} status
 * @param {object|null} track
 * @param {string} language of the now-playing text
 */
export function featureStates(gladys, slot, status, track, language = 'fr') {
  if (!status) {
    return [];
  }
  const ids = deviceIds(gladys, slot);
  const states = FEATURES.filter(({ value }) => typeof value === 'function')
    .map(({ key, value }) => ({
      device_feature_external_id: ids.feature(key),
      state: value(status),
    }))
    .filter(({ state }) => typeof state === 'number' && Number.isFinite(state));
  states.push({
    device_feature_external_id: ids.feature(FEATURE_KEYS.NOW_PLAYING),
    text: nowPlayingText(status, track, language),
  });
  return states;
}

/** The feature key of a feature external id of the slot, null when unknown. */
export function featureKeyOf(gladys, slot, externalId) {
  const ids = deviceIds(gladys, slot);
  return Object.values(FEATURE_KEYS).find((key) => ids.feature(key) === externalId) ?? null;
}
