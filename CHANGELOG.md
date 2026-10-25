# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Fixed

- Covers above 300 KB are shown again: Mopidy-Local serves the cover file as
  it is on disk, often a few megabytes, and Gladys refuses an image above
  300 KB. The integration now makes such a cover a JPEG of 400 pixels at most
  (JPEG and PNG, up to 10 MB), in plain JavaScript, within the memory of the
  container.

## [1.1.0] - 2026-10-25

### Added

- The music player of Gladys 5.3: the **Music** box of the dashboard shows
  the cover, the title, the artist, the album and a progress bar you can drag
  to seek, with shuffle, repeat and mute. New features on each server:
  title, artist, album, artwork, duration, position (writable: seek),
  shuffle and repeat (off, all, one).
- The panels of the Music box: the Mopidy **queue** (tap an item to play it),
  **search** in every Mopidy backend and in the playlist names, and
  **browsing** of the playlists and of the Mopidy library; an item plays in
  place of the queue, after the current track, or at the end of the queue.
  The core scene action "Play music on a speaker" uses the same catalog.
- Covers read from Mopidy (Mopidy-Local and other extensions), up to the
  300 KB Gladys accepts.

### Changed

- Requires Gladys 5.3.0 or later (SDK 0.16).
- The playback state is writable (play, pause, stop) and reads 2 (stopped)
  instead of 0 when Mopidy is stopped.
- The mute feature is a music mute (`music/mute`, same external id) instead
  of a switch.
- Devices added with 1.0.x get the new features after **Update** in the
  Discover tab of the integration; until then they work as before. The "Now
  playing" text feature (now doubled by title and artist) and the "Mopidy
  player" widget stay.

## [1.0.0] - 2026-10-24

### Added

- One Gladys device per Mopidy server, up to four: play, pause, previous,
  next, volume, mute, playback state, what is playing ("Title — Artist"), a
  playlist select listing the Mopidy playlists, and a notification feature.
  The server shows in the Music box of the dashboard and in the "Talk on a
  speaker" scene action.
- Notifications that put the music back: the address plays at the end of the
  queue, at the notification volume of the configuration, then the track that
  played resumes where it was, with its volume and options.
- Changes made on Mopidy reach Gladys within a second (Mopidy's event
  WebSocket), with a reading every 30 seconds and an automatic reconnection.
- Dashboard widget "Mopidy player": what plays, the volume, the state,
  buttons and an Options… form (volume, playlist, random, repeat).
- Scene triggers: a Mopidy track started (title, artist, album, URI), a Mopidy
  server lost.
- Scene actions: play a Mopidy playlist, play an address or a Mopidy URI (then
  resume the music, or keep playing it), search the library and play what it
  finds, clear the queue, random play, repeat.
- A "Test the connection" button, a connection status per server, and every
  text in English, French, German and Spanish.

[Unreleased]: https://github.com/guim31/gladys-mopidy/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/guim31/gladys-mopidy/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/guim31/gladys-mopidy/releases/tag/v1.0.0
