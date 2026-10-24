# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

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

[Unreleased]: https://github.com/guim31/gladys-mopidy/commits/main
