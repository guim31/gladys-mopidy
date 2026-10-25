# Mopidy for Gladys Assistant

An external integration for [Gladys Assistant](https://gladysassistant.com)
that controls [Mopidy](https://mopidy.com) music servers over the local
network, through Mopidy's native API: local files, web radios, and every
source a Mopidy extension adds (Jellyfin, YouTube Music, TuneIn, Subsonic…).
No cloud, no account.

Tested against real Mopidy servers in Docker, **Mopidy 3.4.2** (Debian 13
package, with Mopidy-Local) and **4.0.5** (PyPI): playback, pause, volume,
mute, next, playlists, notifications, events, and the browse, search, queue
and cover reads of the Gladys 5.3 music player. Feedback welcome in the
[issues](https://github.com/guim31/gladys-mopidy/issues).

### Mopidy or MPD?

[gladys-mpd](https://github.com/guim31/gladys-mpd) speaks the MPD protocol,
which Mopidy offers through its Mopidy-MPD extension. This integration uses
Mopidy's own API instead (Mopidy-HTTP): changes arrive as live events, the
playlists of every backend are listed with their URIs, any Mopidy URI can be
played (`tunein:`, `local:`, `file:`, `jellyfin:`…), the library can be
searched, and the mute is exposed. Use this one for Mopidy, gladys-mpd for
MPD itself and the players built on it (moOde, Volumio, piCorePlayer).

## Features

- **Gladys 5.3 music player**: the **Music** box of the dashboard shows the
  cover, title, artist and album, a progress bar to seek, play/pause,
  previous, next, shuffle, repeat, volume and mute; its panels show the
  **queue** (tap to jump), **search** every Mopidy backend and the playlists,
  and **browse** the playlists and the library of Mopidy (play, play next,
  add to the queue). The core scene action _Play music on a speaker_ starts a
  playlist, an album or a track picked there.
- **One device per server** (up to four, each with its address and name),
  with the music features of Gladys, so it shows as a player in the **Music**
  dashboard box and in the **Talk on a speaker** scene action: play, pause,
  previous, next, **volume**, **mute**, **playback state** (play, pause, stop;
  for triggers and conditions), title, artist, album, artwork, duration,
  position, shuffle, repeat, **now playing** ("Title — Artist", or the song
  a web radio announces), a **playlist** select listing the Mopidy playlists
  (it follows Mopidy when one is created or deleted), and a **notification**
  feature.
- **Notifications that put the music back**: an address (a doorbell sound, a
  Mopidy URI, the voice of "Talk on a speaker") is added at the end of the
  queue and played, at the volume of the configuration; then it is removed,
  the volume and the options come back, and the track that played resumes at
  the second it was interrupted (paused stays paused). A second notification
  replaces the first; someone taking over the server ends it; a web radio
  keeps playing.
- **Real time**: Mopidy's event WebSocket is kept open, so a change made
  anywhere (Iris, a phone app, Gladys) reaches Gladys within a second. Plus a
  reading every 30 s of the container's own (the ping, the fallback when a
  proxy drops the WebSocket, and the refresh that does not depend on the core
  polling the devices), and a reconnection with back-off.
- **Dashboard widget** "Mopidy player": title, artist and album (or the radio
  station), a volume gauge, state, position in the queue, random and repeat,
  and four buttons: previous, play/pause, next, and **Options…**, a form
  pre-filled with the volume, a playlist to play, random and repeat.
- **Scene triggers**: _Mopidy track started_ (title, artist, album, URI; not
  for notifications) and _Mopidy server lost_.
- **Scene actions**: _Play a Mopidy playlist_ (by name, without case nor
  accents, or by URI; the number of tracks as output), _Play an address on
  Mopidy_ (a URL or a Mopidy URI; then resume the previous music, or keep
  playing it in place of the queue; with its own volume; fails when Mopidy
  cannot play it), _Search and play on Mopidy_ (the first 50 tracks found in
  the library), _Clear the Mopidy queue_, _Mopidy random play_ (on, off,
  toggle) and _Mopidy repeat_ (off, all, one).
- A **Test the connection** button, a connection status that names the
  server and the problem (does not answer, not Mopidy-HTTP, refused by a
  proxy…), and a transport badge per device (local, unreachable).
- Every text in English, French, German and Spanish.

## Requirements

- Gladys Assistant **5.3.0** or later (the music player and its panels).
- Mopidy 3 or 4 with Mopidy-HTTP reachable from Gladys (port 6680 by
  default; `hostname = 0.0.0.0` in the `[http]` section of `mopidy.conf`).

## Installation

1. In Gladys, open **Integrations** → **Install from GitHub** and enter the
   address of this repository: `https://github.com/guim31/gladys-mopidy` (or
   install **Mopidy** from the catalog once it is listed).
2. In **Configuration**, enter the address of your server (`192.168.1.20`,
   `mopidy.home:6680`, or the address of its web client) and a name; up to
   three more servers below. Save, then click **Test the connection**.
3. Open the **Discover** tab and add the devices.

The user guide is in [`docs/en.md`](docs/en.md) (also in
[French](docs/fr.md), [German](docs/de.md) and [Spanish](docs/es.md)); Gladys
links it from the Configuration screen.

## Gladys 5.3 music player

Version 1.1.0 follows the music player contract of Gladys 5.3
(`@gladysassistant/integration-sdk` 0.16): the now-playing features are
published by `publishNowPlaying` on Mopidy's events (the position only on a
change of track or state and on a seek: Gladys extrapolates it), the writable
ones are confirmed by Mopidy (`has_feedback`), and the manifest declares
`"music": { "browse": true, "search": true, "queue": true, "append": true }`
(`src/catalog.js`). Covers are read with `core.library.get_images` and
served to Gladys behind a key, never as a URL. A cover above the 300 KB the
core accepts (Mopidy-Local serves the file as it is on disk) is read up to
10 MB and made a JPEG of 400 px at most by `src/artwork-resize.js`: plain
JavaScript, no native binary, memory bounded for the 256 MB container
(reduced JPEG decoding from the DCT coefficients, PNG inflated row by row).

**Devices added with 1.0.x** keep their features and states; the new ones
appear after **Update** in the Discover tab (Gladys offers it because the
feature list changed). The mute feature keeps its external id and becomes
`music/mute` (it was `switch/binary`), and the playback state reads 2 (idle)
instead of 0 when Mopidy is stopped. The "Now playing" text feature and the
widget stay.

## How it works

- A small client written for the integration (`src/mopidy/client.js`): the
  JSON-RPC calls of a reading go in one batch (`POST /mopidy/rpc`), the events
  come from the WebSocket (`/mopidy/ws`, Node's built-in `WebSocket`). No
  runtime dependency beyond the Gladys SDK.
- Per server (`src/player.js`): the connection, the reconnection (2, 5, 15,
  30 s, then every minute), the readings after each burst of events, the
  commands, and the notifications. Mopidy answers `play` before it switches
  tracks: a notification is given a grace period before it counts as failed,
  and the interrupted track is put back in two steps (play, then pause and
  seek once it is loaded).
- The hub (`src/hub.js`) publishes one device per server, only the states
  that changed (with a heartbeat), the transport of each device, the
  connection status and the scene events.

## Limits

- Covers above 10 MB or 25 megapixels, in another format than JPEG, PNG and
  WebP (GIF…), or in WebP above 300 KB show the placeholder.
- Mopidy cannot be found automatically: addresses are typed.
- Mopidy-HTTP has no authentication: keep it on your local network.

## Development

```bash
npm install
npm test               # node --test, against the SDK's fake Gladys and a fake Mopidy
npm run lint
npm run format:check
```

`test/fixtures/mopidy/` holds answers recorded on Mopidy 3.4.2 and 4.0.5. See
[`CLAUDE.md`](CLAUDE.md) for the project rules.

## Credits

- [Mopidy](https://mopidy.com) and its
  [HTTP JSON-RPC API](https://docs.mopidy.com/stable/api/http/) (Apache 2.0),
  by Stein Magnus Jodal and the Mopidy contributors. The client was written
  from the documentation; no code was copied.
- The cover shows the Mopidy logo (`docs/images/logo.png` of the
  [Mopidy repository](https://github.com/mopidy/mopidy), Apache 2.0).
- The Home Assistant `mopidy` integration, for the feature set of a Mopidy
  media player.
- [Gladys Assistant](https://gladysassistant.com) and its
  [integration SDK](https://github.com/GladysAssistant/integration-sdk-js).

This integration is not affiliated with the Mopidy project.

## License

[Apache 2.0](LICENSE).
