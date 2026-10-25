// -----------------------------------------------------------------------------
// Mopidy answers -> the plain objects the rest of the integration uses. Every
// field is checked: a missing or odd value becomes a neutral one, never an
// exception.
//
// What Mopidy gives (recorded on 3.4.2 and 4.0.5, test/fixtures/mopidy/):
//   - the playback state is `playing`, `paused` or `stopped`;
//   - the volume is 0-100, or null when Mopidy has no mixer (`mixer = none`);
//   - a track is `{ uri, name, artists: [{ name }], album: { name }, length }`
//     (length in ms, absent for a web radio); the file backend names an
//     untagged file after the file itself;
//   - a web radio tells the song it plays through `get_stream_title` (ICY).
// -----------------------------------------------------------------------------

/** Playback states, as the rest of the integration names them. */
export const STATES = Object.freeze({ PLAY: 'play', PAUSE: 'pause', STOP: 'stop' });

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

const MOPIDY_STATES = { playing: STATES.PLAY, paused: STATES.PAUSE, stopped: STATES.STOP };

const MAX_TEXT = 200;

const text = (value) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, MAX_TEXT) : null;

const int = (value) => (Number.isInteger(value) ? value : null);

/** The calls of a reading, in the order parseStatus expects their results. */
export const STATUS_CALLS = [
  ['core.playback.get_state'],
  ['core.playback.get_current_tl_track'],
  ['core.playback.get_time_position'],
  ['core.playback.get_stream_title'],
  ['core.mixer.get_volume'],
  ['core.mixer.get_mute'],
  ['core.tracklist.get_random'],
  ['core.tracklist.get_repeat'],
  ['core.tracklist.get_single'],
  ['core.tracklist.get_consume'],
  ['core.tracklist.get_length'],
  ['core.tracklist.index'],
];

/**
 * @param {any[]} results the results of STATUS_CALLS
 * @returns {{ status: object, track: object|null }}
 */
export function parseStatus(results) {
  const [
    state,
    tlTrack,
    position,
    streamTitle,
    volume,
    mute,
    random,
    repeat,
    single,
    consume,
    length,
    index,
  ] = Array.isArray(results) ? results : [];
  const track = parseTrack(tlTrack?.track, streamTitle);
  const tlid = int(tlTrack?.tlid);
  return {
    status: {
      state: MOPIDY_STATES[state] ?? STATES.STOP,
      // No mixer: Mopidy cannot tell (nor change) the volume.
      volume: Number.isFinite(volume) ? Math.max(0, Math.min(100, Math.round(volume))) : null,
      mute: typeof mute === 'boolean' ? mute : null,
      random: random === true,
      repeat: repeat === true,
      single: single === true,
      consume: consume === true,
      tlid,
      index: int(index),
      queueLength: int(length) ?? 0,
      // Milliseconds.
      elapsed: Number.isFinite(position) && position >= 0 ? position : 0,
      duration: track?.length ?? null,
    },
    track: tlid === null ? null : track,
  };
}

/**
 * @param {object} raw a Mopidy Track
 * @param {string|null} [streamTitle] what a web radio says it plays
 */
export function parseTrack(raw, streamTitle = null) {
  if (!raw || typeof raw !== 'object' || typeof raw.uri !== 'string') {
    return null;
  }
  const artists = Array.isArray(raw.artists)
    ? raw.artists.map((artist) => text(artist?.name)).filter(Boolean)
    : [];
  const length = int(raw.length);
  return {
    uri: raw.uri,
    name: text(raw.name),
    artist: artists.length ? artists.join(', ').slice(0, MAX_TEXT) : null,
    album: text(raw.album?.name),
    length: length !== null && length > 0 ? length : null,
    streamTitle: text(streamTitle),
  };
}

/**
 * The playlists of `core.playlists.as_list`, sorted by name.
 * @returns {Array<{ uri: string, name: string }>}
 */
export function parsePlaylists(raw) {
  const seen = new Set();
  const playlists = [];
  for (const ref of Array.isArray(raw) ? raw : []) {
    const uri = typeof ref?.uri === 'string' ? ref.uri : '';
    if (uri === '' || seen.has(uri)) {
      continue;
    }
    seen.add(uri);
    playlists.push({ uri, name: text(ref.name) ?? uri });
  }
  return playlists.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }),
  );
}

/** The track URIs of `core.playlists.get_items` (Refs) or a search result. */
export function trackUris(refs) {
  return (Array.isArray(refs) ? refs : [])
    .filter((ref) => typeof ref?.uri === 'string' && ref.uri !== '')
    .filter((ref) => ref.type === undefined || ref.type === 'track')
    .map((ref) => ref.uri);
}

/**
 * The tracks of `core.library.search`: one result per backend, each with
 * `tracks`. Kept in the order of the backends, without duplicates.
 * @param {any} raw
 * @param {number} max
 */
export function searchTracks(raw, max) {
  const uris = [];
  for (const result of Array.isArray(raw) ? raw : []) {
    for (const track of Array.isArray(result?.tracks) ? result.tracks : []) {
      if (typeof track?.uri === 'string' && !uris.includes(track.uri)) {
        uris.push(track.uri);
        if (uris.length === max) {
          return uris;
        }
      }
    }
  }
  return uris;
}

/** The last part of a path or URL: what is shown for a track without tags. */
export function baseName(uri) {
  if (typeof uri !== 'string') {
    return '';
  }
  const withoutQuery = uri.replace(/[?#].*$/, '').replace(/\/+$/, '');
  const name = withoutQuery.slice(Math.max(withoutQuery.lastIndexOf('/'), 0) + 1);
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/**
 * The image to show among those `core.library.get_images` gives for a URI:
 * the smallest at least `minWidth` wide, else the widest; the first when
 * Mopidy does not know their sizes. Null when there is none.
 * @param {any} images a list of Mopidy Images ({ uri, width?, height? })
 * @param {number} minWidth
 * @returns {string|null} its URI (absolute, or a path on the Mopidy server)
 */
export function pickImage(images, minWidth) {
  const list = (Array.isArray(images) ? images : []).filter(
    (image) => typeof image?.uri === 'string' && image.uri !== '',
  );
  if (list.length === 0) {
    return null;
  }
  const sized = list.filter((image) => Number.isInteger(image.width) && image.width > 0);
  if (sized.length === 0) {
    return list[0].uri;
  }
  sized.sort((a, b) => a.width - b.width);
  return (sized.find((image) => image.width >= minWidth) ?? sized.at(-1)).uri;
}

/** Is this a stream (web radio), whose end never comes? */
export const isStream = (uri) => typeof uri === 'string' && /^https?:\/\//i.test(uri);

/**
 * What is playing, as two lines: the title and what goes with it (artist
 * and album, or the radio station).
 * @param {object|null} track parseTrack()
 * @returns {{ title: string|null, subtitle: string|null }}
 */
export function describeTrack(track) {
  if (!track) {
    return { title: null, subtitle: null };
  }
  // A web radio: the song it announces, under the station name.
  if (track.streamTitle) {
    const station = track.name ?? (track.album || null);
    return {
      title: track.streamTitle,
      subtitle: station && station !== track.streamTitle ? station : null,
    };
  }
  const title = track.name ?? baseName(track.uri);
  const parts = [track.artist, track.album].filter(Boolean);
  return { title: title || null, subtitle: parts.length ? parts.join(' · ') : null };
}

/** "Title — Artist" in one line, '' when nothing is known. */
export function trackText(track) {
  const { title, subtitle } = describeTrack(track);
  if (!title) {
    return '';
  }
  const artist = track.streamTitle ? subtitle : track.artist;
  return (artist ? `${title} — ${artist}` : title).slice(0, MAX_TEXT);
}
