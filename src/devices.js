// -----------------------------------------------------------------------------
// One Gladys device per Mopidy server, with the music features of the core so
// that Gladys shows it as a player (the Music box of the dashboard, the "Talk
// on a speaker" and "Play on a player" scene actions):
//   - play, pause, previous, next: music/play… one-shot commands (has_feedback
//     false: kept for the scenes and dashboards made before Gladys 5.3);
//   - volume, mute: music/volume 0-100 and music/mute (has_feedback true:
//     Mopidy's mixer answers);
//   - playback state: music/playback_state, 1 playing, 0 paused, 2 stopped
//     (MUSIC_PLAYBACK_STATE of the core), writable: Gladys 5.3 plays, pauses
//     and stops through it;
//   - now playing (Gladys 5.3): title, artist, album, artwork (an image key
//     served by src/catalog.js), duration and position (seconds, position
//     writable = seek), shuffle, repeat (off, all, one), published by
//     publishNowPlaying on Mopidy's events;
//   - now playing text: text/text, "Title — Artist", "Paused · …", "Stopped"
//     (from before Gladys 5.3, kept for the dashboards and scenes using it);
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
  DEVICE_FEATURE_UNITS,
  DEVICE_POLL_FREQUENCIES,
  MUSIC_PLAYBACK_STATE,
  MUSIC_REPEAT_MODE,
} from '@gladysassistant/integration-sdk';
import { SLOTS, formatAddress } from './config.js';
import { STATES, describeTrack, repeatMode, trackText } from './mopidy/model.js';

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
  // Gladys 5.3: the same as the feature types, the default of publishNowPlaying.
  TITLE: 'title',
  ARTIST: 'artist',
  ALBUM: 'album',
  ARTWORK: 'artwork',
  DURATION: 'duration',
  POSITION: 'position',
  SHUFFLE: 'shuffle',
  REPEAT: 'repeat',
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
    [FEATURE_KEYS.TITLE]: 'Title',
    [FEATURE_KEYS.ARTIST]: 'Artist',
    [FEATURE_KEYS.ALBUM]: 'Album',
    [FEATURE_KEYS.ARTWORK]: 'Artwork',
    [FEATURE_KEYS.DURATION]: 'Duration',
    [FEATURE_KEYS.POSITION]: 'Position',
    [FEATURE_KEYS.SHUFFLE]: 'Shuffle',
    [FEATURE_KEYS.REPEAT]: 'Repeat',
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
    [FEATURE_KEYS.TITLE]: 'Titre',
    [FEATURE_KEYS.ARTIST]: 'Artiste',
    [FEATURE_KEYS.ALBUM]: 'Album',
    [FEATURE_KEYS.ARTWORK]: 'Pochette',
    [FEATURE_KEYS.DURATION]: 'Durée',
    [FEATURE_KEYS.POSITION]: 'Position',
    [FEATURE_KEYS.SHUFFLE]: 'Lecture aléatoire',
    [FEATURE_KEYS.REPEAT]: 'Répétition',
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
    [FEATURE_KEYS.TITLE]: 'Titel',
    [FEATURE_KEYS.ARTIST]: 'Künstler',
    [FEATURE_KEYS.ALBUM]: 'Album',
    [FEATURE_KEYS.ARTWORK]: 'Cover',
    [FEATURE_KEYS.DURATION]: 'Dauer',
    [FEATURE_KEYS.POSITION]: 'Position',
    [FEATURE_KEYS.SHUFFLE]: 'Zufallswiedergabe',
    [FEATURE_KEYS.REPEAT]: 'Wiederholung',
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
    [FEATURE_KEYS.TITLE]: 'Título',
    [FEATURE_KEYS.ARTIST]: 'Artista',
    [FEATURE_KEYS.ALBUM]: 'Álbum',
    [FEATURE_KEYS.ARTWORK]: 'Carátula',
    [FEATURE_KEYS.DURATION]: 'Duración',
    [FEATURE_KEYS.POSITION]: 'Posición',
    [FEATURE_KEYS.SHUFFLE]: 'Reproducción aleatoria',
    [FEATURE_KEYS.REPEAT]: 'Repetición',
    [FEATURE_KEYS.NOW_PLAYING]: 'Reproduciendo ahora',
    [FEATURE_KEYS.PLAYLIST]: 'Lista de reproducción',
    [FEATURE_KEYS.NOTIFICATION]: 'Notificación',
  },
};

const MUSIC = DEVICE_FEATURE_CATEGORIES.MUSIC;

// Bound of the duration and the position (24 h: a long mix, an audiobook).
export const MAX_SECONDS = 86_400;
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

/** A writable music feature that Mopidy confirms through its events. */
const control = (key, type, max, extra = {}) => ({
  key,
  definition: {
    category: MUSIC,
    type,
    read_only: false,
    has_feedback: true,
    keep_history: false,
    min: 0,
    max,
    ...extra,
  },
});

/** A read-only string feature (the core stores its value as a text). */
const text = (key, category, type) => ({
  key,
  definition: {
    category,
    type,
    read_only: true,
    has_feedback: false,
    keep_history: false,
    // NOT NULL in the core database, meaningless for a text.
    min: 0,
    max: 0,
  },
});

// Order = display order in Gladys.
const FEATURES = [
  command(FEATURE_KEYS.PLAY, TYPES.PLAY),
  command(FEATURE_KEYS.PAUSE, TYPES.PAUSE),
  command(FEATURE_KEYS.PREVIOUS, TYPES.PREVIOUS),
  command(FEATURE_KEYS.NEXT, TYPES.NEXT),
  // No mixer (`mixer = none`): Mopidy can neither tell nor change the volume
  // and the mute, nothing is published for them.
  control(FEATURE_KEYS.VOLUME, TYPES.VOLUME, 100),
  // A switch/binary before 1.1.0: same external id, the "Update" of the
  // Discover tab turns it into music/mute.
  control(FEATURE_KEYS.MUTE, TYPES.MUTE, 1),
  // PAUSED 0, PLAYING 1, IDLE 2 (stopped); BUFFERING is never reported.
  control(FEATURE_KEYS.PLAYBACK_STATE, TYPES.PLAYBACK_STATE, MUSIC_PLAYBACK_STATE.IDLE),
  text(FEATURE_KEYS.TITLE, MUSIC, TYPES.TITLE),
  text(FEATURE_KEYS.ARTIST, MUSIC, TYPES.ARTIST),
  text(FEATURE_KEYS.ALBUM, MUSIC, TYPES.ALBUM),
  text(FEATURE_KEYS.ARTWORK, MUSIC, TYPES.ARTWORK),
  {
    key: FEATURE_KEYS.DURATION,
    definition: {
      category: MUSIC,
      type: TYPES.DURATION,
      unit: DEVICE_FEATURE_UNITS.SECONDS,
      read_only: true,
      has_feedback: false,
      keep_history: false,
      min: 0,
      max: MAX_SECONDS,
    },
  },
  control(FEATURE_KEYS.POSITION, TYPES.POSITION, MAX_SECONDS, {
    unit: DEVICE_FEATURE_UNITS.SECONDS,
  }),
  control(FEATURE_KEYS.SHUFFLE, TYPES.SHUFFLE, 1),
  control(FEATURE_KEYS.REPEAT, TYPES.REPEAT, MUSIC_REPEAT_MODE.ONE),
  text(FEATURE_KEYS.NOW_PLAYING, DEVICE_FEATURE_CATEGORIES.TEXT, DEVICE_FEATURE_TYPES.TEXT.TEXT),
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
 * The text states to publish for a player (the "now playing" text), sent by
 * publishChangedStates; the music features go through publishNowPlaying.
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
  return [
    {
      device_feature_external_id: deviceIds(gladys, slot).feature(FEATURE_KEYS.NOW_PLAYING),
      text: nowPlayingText(status, track, language),
    },
  ];
}

const PLAYBACK_STATES = {
  [STATES.PLAY]: MUSIC_PLAYBACK_STATE.PLAYING,
  [STATES.PAUSE]: MUSIC_PLAYBACK_STATE.PAUSED,
  [STATES.STOP]: MUSIC_PLAYBACK_STATE.IDLE,
};

const REPEAT_STATES = {
  off: MUSIC_REPEAT_MODE.OFF,
  all: MUSIC_REPEAT_MODE.ALL,
  one: MUSIC_REPEAT_MODE.ONE,
};

const seconds = (ms) => Math.min(MAX_SECONDS, Math.max(0, Math.round((ms ?? 0) / 1000)));

/**
 * The snapshot given to publishNowPlaying (Gladys 5.3). Nothing loaded: the
 * texts are cleared explicitly (an absent key means "unchanged"). A web
 * radio: the song it announces as title, the station as album, duration 0
 * (live). Stopped with a track still loaded (Mopidy keeps it): IDLE, the
 * track stays shown.
 * @param {object} status parseStatus().status
 * @param {object|null} track parseStatus().track
 * @param {string|null} artworkUrl absolute URL of the current artwork
 */
export function nowPlaying(status, track, artworkUrl = null) {
  const snapshot = {
    playback_state: PLAYBACK_STATES[status.state] ?? MUSIC_PLAYBACK_STATE.IDLE,
    title: '',
    artist: '',
    album: '',
    artwork_url: track ? artworkUrl : null,
    duration: seconds(status.duration),
    position: track && status.state !== STATES.STOP ? seconds(status.elapsed) : 0,
    shuffle: status.random,
    repeat: REPEAT_STATES[repeatMode(status)],
  };
  if (track?.streamTitle) {
    snapshot.title = track.streamTitle;
    snapshot.album = track.name && track.name !== track.streamTitle ? track.name : '';
  } else if (track) {
    snapshot.title = describeTrack(track).title ?? '';
    snapshot.artist = track.artist ?? '';
    snapshot.album = track.album ?? '';
  }
  // No mixer: nothing to tell.
  if (status.volume !== null) {
    snapshot.volume = status.volume;
  }
  if (status.mute !== null) {
    snapshot.mute = status.mute;
  }
  return snapshot;
}

/** The feature external ids publishNowPlaying cannot guess (`${device}:${type}`). */
export const nowPlayingIds = (gladys, slot) => ({
  playback_state: deviceIds(gladys, slot).feature(FEATURE_KEYS.PLAYBACK_STATE),
});

/** The feature key of a feature external id of the slot, null when unknown. */
export function featureKeyOf(gladys, slot, externalId) {
  const ids = deviceIds(gladys, slot);
  return Object.values(FEATURE_KEYS).find((key) => ids.feature(key) === externalId) ?? null;
}
