// -----------------------------------------------------------------------------
// The catalog of the Gladys 5.3 music panel (manifest `music`): browse,
// search, play, the queue, and the bytes of the artworks. Read on demand
// from Mopidy, never stored. Everything comes back as MediaItems whose `id`
// is the Mopidy URI (opaque to Gladys, carried back by a play command and by
// the `music.play-media` scene action).
//
// What Mopidy gives (checked on 3.4.2 with Mopidy-Local, and 4.0.5):
//   - `core.library.browse` answers the whole level at once (no paging): the
//     page is cut here, `total` is the size of the level;
//   - a playlist URI (`m3u:…`) is not browsable nor playable by URI: its
//     items come from `core.playlists.get_items`;
//   - a directory URI added to the tracklist becomes a "track" that crashes
//     Mopidy 3.4 when played (GStreamer, segfault): a folder is never
//     playable, and a play command refuses it;
//   - images come from `core.library.get_images`, by URI, sometimes as a
//     path on the server (`/local/<hash>.jpeg`), at the size of the file
//     (Mopidy-Local does not resize).
// -----------------------------------------------------------------------------

import { MUSIC_MEDIA_TYPES, MUSIC_PLAY_MODES } from '@gladysassistant/integration-sdk';
import { baseName, describeTrack, isStream, parseTrack } from './mopidy/model.js';
import { IMAGE_WIDTHS, fold } from './player.js';
import { ACTION_TEXT, CATALOG_TEXT, UserError, pick, safeText } from './texts.js';

// The id of our own root folder: no Mopidy backend uses the `gladys:` scheme.
export const PLAYLISTS_ID = 'gladys:playlists';

// Bounds of the core (capabilities/music.md, section 4.2).
const MAX_ID = 512;
const MAX_TEXT = 200;

// The core refuses artworks above 300 KB: never read more than that.
export const MAX_ARTWORK_BYTES = 300 * 1024;
const ARTWORK_TIMEOUT_MS = 10_000;

const REF_TYPES = {
  directory: { type: MUSIC_MEDIA_TYPES.FOLDER, browsable: true, playable: false },
  album: { type: MUSIC_MEDIA_TYPES.ALBUM, browsable: true, playable: true },
  artist: { type: MUSIC_MEDIA_TYPES.ARTIST, browsable: true, playable: true },
  playlist: { type: MUSIC_MEDIA_TYPES.PLAYLIST, browsable: true, playable: true },
  track: { type: MUSIC_MEDIA_TYPES.TRACK, browsable: false, playable: true },
};

const clip = (value) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, MAX_TEXT) : null;

const usableId = (uri) => typeof uri === 'string' && uri !== '' && uri.length <= MAX_ID;

/** A MediaItem from a Mopidy Ref (browse, playlist items). Null when unknown. */
export function refItem(ref) {
  const kind = REF_TYPES[ref?.type];
  if (!kind || !usableId(ref.uri)) {
    return null;
  }
  const radio = ref.type === 'track' && isStream(ref.uri);
  return {
    id: ref.uri,
    type: radio ? MUSIC_MEDIA_TYPES.RADIO : kind.type,
    title: clip(ref.name) ?? clip(baseName(ref.uri)) ?? ref.uri.slice(0, MAX_TEXT),
    browsable: kind.browsable,
    playable: kind.playable,
  };
}

/** A MediaItem from a Mopidy Track (search results, queue). Null when unusable. */
export function trackItem(raw) {
  const track = parseTrack(raw);
  if (!track || !usableId(track.uri)) {
    return null;
  }
  const item = {
    id: track.uri,
    type: isStream(track.uri) ? MUSIC_MEDIA_TYPES.RADIO : MUSIC_MEDIA_TYPES.TRACK,
    title: describeTrack(track).title ?? track.uri.slice(0, MAX_TEXT),
    duration: track.length === null ? null : Math.round(track.length / 1000),
    browsable: false,
    playable: true,
  };
  if (track.artist) {
    item.subtitle = track.artist;
  }
  return item;
}

/** A MediaItem from a Mopidy Album or Artist of a search result. */
function searchItem(raw, type) {
  if (!usableId(raw?.uri)) {
    return null;
  }
  const item = {
    id: raw.uri,
    type,
    title: clip(raw.name) ?? raw.uri.slice(0, MAX_TEXT),
    browsable: true,
    playable: true,
  };
  const artists = (Array.isArray(raw.artists) ? raw.artists : [])
    .map((artist) => clip(artist?.name))
    .filter(Boolean);
  if (artists.length) {
    item.subtitle = artists.join(', ').slice(0, MAX_TEXT);
  }
  return item;
}

/** Without duplicates (two backends, one URI), in order. */
function unique(items) {
  const seen = new Set();
  return items.filter((item) => item && !seen.has(item.id) && seen.add(item.id));
}

/**
 * Search results of every type in one list of `limit`: the playlists, the
 * artists and the albums first (a quarter of the list each at most), the
 * tracks after, then what is left of the others.
 * @param {Record<string, object[]>} groups by MediaItem type
 * @param {number} limit
 */
export function mixResults(groups, limit) {
  const share = Math.max(1, Math.floor(limit / 4));
  const heads = ['playlist', 'artist', 'album'];
  const first = heads.flatMap((type) => (groups[type] ?? []).slice(0, share));
  const rest = heads.flatMap((type) => (groups[type] ?? []).slice(share));
  return [...first, ...(groups.track ?? []), ...rest].slice(0, limit);
}

/** Give each item its artwork key, read in one call (never fatal). */
async function withArtwork(hub, record, items) {
  const uris = items
    .filter((item) => item.type !== MUSIC_MEDIA_TYPES.FOLDER)
    .map((item) => item.id);
  const images = await record.player.images(record.player.client, uris, IMAGE_WIDTHS.THUMBNAIL);
  return items.map((item) =>
    images.has(item.id)
      ? { ...item, artwork_key: hub.gladys.artworkKey(images.get(item.id)) }
      : item,
  );
}

/** The record of a device of a music command (a removed server: an error the panel shows). */
const recordOf = (hub, device) => hub.recordOf(device?.external_id);

/**
 * onMusicBrowse: our "Playlists" folder and Mopidy's roots, then any level.
 * @returns {Promise<{ items: object[], total: number }>}
 */
export async function browse(hub, device, { parentId = null, offset = 0, limit = 50 } = {}) {
  const record = recordOf(hub, device);
  return hub.command(
    record,
    `browse ${parentId === null ? 'root' : safeText(parentId)}`,
    async (player) => {
      let items;
      if (parentId === null) {
        const roots = await player.library('core.library.browse', { uri: null });
        items = [
          {
            id: PLAYLISTS_ID,
            type: MUSIC_MEDIA_TYPES.FOLDER,
            title: pick(CATALOG_TEXT.playlists, hub.language),
            browsable: true,
            playable: false,
          },
          ...(Array.isArray(roots) ? roots : []).map(refItem),
        ];
      } else if (parentId === PLAYLISTS_ID) {
        const playlists = await player.library('core.playlists.as_list');
        items = (Array.isArray(playlists) ? playlists : [])
          .map((ref) => refItem({ ...ref, type: 'playlist' }))
          .filter(Boolean)
          .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
      } else if ((player.playlists ?? []).some((playlist) => playlist.uri === parentId)) {
        items = (await player.library('core.playlists.get_items', { uri: parentId })) ?? [];
        items = items.map((ref) => refItem({ ...ref, type: ref.type ?? 'track' }));
      } else {
        items = (await player.library('core.library.browse', { uri: parentId })) ?? [];
        items = items.map(refItem);
      }
      const all = unique(items);
      const page = all.slice(offset, offset + limit);
      return { items: await withArtwork(hub, record, page), total: all.length };
    },
    { quiet: true },
  );
}

/**
 * onMusicSearch: every backend of Mopidy that searches, and the playlists by
 * name (Mopidy does not search them).
 * @returns {Promise<{ items: object[] }>}
 */
export async function search(hub, device, { query, type = null, limit = 20 } = {}) {
  const record = recordOf(hub, device);
  const text = String(query ?? '').trim();
  if (!text) {
    return { items: [] };
  }
  return hub.command(
    record,
    `search "${safeText(text)}"`,
    async (player) => {
      const groups = { playlist: [], artist: [], album: [], track: [] };
      if (type === null || type === MUSIC_MEDIA_TYPES.PLAYLIST) {
        groups.playlist = (player.playlists ?? [])
          .filter((playlist) => fold(playlist.name).includes(fold(text)))
          .map((playlist) => refItem({ ...playlist, type: 'playlist' }));
      }
      if (type !== MUSIC_MEDIA_TYPES.PLAYLIST) {
        const results = await player.library('core.library.search', { query: { any: [text] } });
        for (const result of Array.isArray(results) ? results : []) {
          groups.artist.push(...(result?.artists ?? []).map((a) => searchItem(a, 'artist')));
          groups.album.push(...(result?.albums ?? []).map((a) => searchItem(a, 'album')));
          groups.track.push(...(result?.tracks ?? []).map(trackItem));
        }
      }
      // A radio is a track whose URI is a stream: the filter reads the item type.
      const all = Object.values(groups).flat();
      for (const key of Object.keys(groups)) {
        groups[key] = unique(groups[key]);
      }
      const items =
        type === null
          ? mixResults(groups, limit)
          : unique(all.filter((item) => item?.type === type)).slice(0, limit);
      return { items: await withArtwork(hub, record, items) };
    },
    { quiet: true },
  );
}

/** onMusicPlay (and the `music.play-media` scene action). */
export async function play(hub, device, media, mode = MUSIC_PLAY_MODES.REPLACE) {
  const record = recordOf(hub, device);
  if (media?.type === MUSIC_MEDIA_TYPES.FOLDER || media?.id === PLAYLISTS_ID) {
    throw new UserError(ACTION_TEXT.folderNotPlayable, hub.language);
  }
  if (!usableId(media?.id)) {
    throw new Error('A media id is required');
  }
  await hub.command(
    record,
    `play ${media.type} ${safeText(media.id)} (${mode})`,
    async (player) => {
      const tracks = await player.playMedia(media.id, media.type, mode);
      if (tracks === 0) {
        throw new UserError(ACTION_TEXT.notPlayable, hub.language);
      }
    },
  );
}

/**
 * onMusicQueueGet: a page of Mopidy's tracklist.
 * @returns {Promise<{ items: object[], currentIndex: number|null, total: number }>}
 */
export async function queueGet(hub, device, { offset = 0, limit = 50 } = {}) {
  const record = recordOf(hub, device);
  return hub.command(
    record,
    `queue ${offset}+${limit}`,
    async (player) => {
      const { tlTracks, index, length } = await player.queuePage(offset, limit);
      // A track queued twice is two rows: no de-duplication here.
      const items = tlTracks.map((tlTrack) => trackItem(tlTrack?.track)).filter(Boolean);
      return {
        items: await withArtwork(hub, record, items),
        // Stopped with a track loaded, Mopidy keeps it current: play resumes it.
        currentIndex: index,
        total: length,
      };
    },
    { quiet: true },
  );
}

/** onMusicQueuePlay: jump to an item of the queue. */
export async function queuePlay(hub, device, index) {
  const record = recordOf(hub, device);
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Invalid queue index ${index}`);
  }
  await hub.command(record, `play queue item ${index}`, async (player) => {
    if (!(await player.playIndex(index))) {
      throw new UserError(ACTION_TEXT.notInQueue, hub.language);
    }
  });
}

/**
 * onMusicGetArtwork: the bytes of an image whose URL artworkKey recorded,
 * read up to the 300 KB the core accepts (Mopidy-Local serves the cover as
 * it is on disk, often larger: refused here rather than sent for nothing).
 * @param {object} hub
 * @param {string} key
 * @returns {Promise<string>} raw base64
 */
export async function artwork(hub, key) {
  const url = hub.gladys.artworkUrls.get(key);
  if (url === undefined) {
    throw new Error(`Unknown artwork ${key}`);
  }
  const fetchImpl = hub.playerOptions.fetch ?? globalThis.fetch;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(ARTWORK_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`Artwork ${key}: HTTP ${response.status}`);
  }
  const tooBig = () =>
    new Error(`Artwork ${key} is larger than 300 KB: Gladys would refuse it (use a smaller cover)`);
  if (Number(response.headers.get('content-length')) > MAX_ARTWORK_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw tooBig();
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > MAX_ARTWORK_BYTES) {
      throw tooBig();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('base64');
}
