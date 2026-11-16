# gentle-spotify

Control the **Spotify app on your Mac** from [Gentle Shell](https://gentlemanprogramming.com/) / Pi with slash
commands, and optionally see what is playing in the sidebar.

```
/sp Eminem my name is        ▶ My Name Is — Eminem (The Slim Shady LP, 1999)
/sp                          ⏸ My Name Is — Eminem
/sp next                     ▶ Without Me — Eminem
```

```
INTEGRATIONS (2)
- engram ✓
- ♪ Eminem — My Name Is
```

- **One command.** Everything lives under `/sp`, so it never collides with other extensions.
- **Deterministic.** Commands run inside the extension, not through the model: same input, same result, no tokens.
- **Plays in your real Spotify app.** Your account, your library, your devices. Not a separate player.
- **Optional sidebar row.** One line under INTEGRATIONS; turn it off with `/sp sidebar off`.

## How it works

Two halves, because the Spotify app can only play a track by its URI:

1. **Search** goes to the Spotify Web API with your developer credentials (client-credentials token, cached),
   and the extension picks the best match deterministically.
2. **Playback** goes to the Spotify app on your Mac through AppleScript (`osascript`): play, pause, next,
   previous, and reading what is playing.

That second half is why it is **macOS only**: AppleScript is how macOS apps are controlled. Spotify brings
its window to the front when it starts a track; the extension hands focus straight back to the app you were
using (it waits at most one second, and only for that command).

## Requirements

- macOS with the Spotify desktop app installed.
- A Spotify developer app of your own, used only for search (see [Setup](#setup)). Creating one is free, but
  Spotify's docs state that "the app owner must have a Spotify Premium account for apps in development mode to
  function" ([quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)).
- Use **your own** credentials. Never share them or ship them in a package: the client secret identifies your
  developer account, and every request made with it counts against your account's quota.
- Gentle Shell, or any Pi build with extension support.

## Install

```bash
pi install git:github.com/<owner>/gentle-spotify
```

Or from a local clone: `pi install ./gentle-spotify`. Then run `/reload` or start a new session.

## Setup

Spotify's AppleScript interface can only play a track by its URI, so finding a song by name goes through
the Spotify Web API. That needs a developer app, and it takes about two minutes:

1. Open https://developer.spotify.com/dashboard and choose **Create app**.
2. Use any name, set the redirect URI to `http://127.0.0.1:8888/callback` (it is not used) and tick **Web API**.
3. In the app's **Settings**, copy the **Client ID** and run `/sp setup`.
4. Copy the **Client secret** and run `/sp setup` again.
5. Run `/sp check`.

`/sp setup` reads the value from the clipboard, never prints it and clears the clipboard afterwards.
Credentials live in `~/.config/spotify-cli/credentials` with mode `600`; set `SPOTIFY_CLI_DIR` to use
another folder.

## Commands

Everything is one command, `/sp`. Type `/sp ` and press Tab to see the fixed forms.

| Command | What it does |
| --- | --- |
| `/sp <song or artist>` | Plays the best match. Word order does not matter. |
| `/sp --artist <name> <song>` | Only considers tracks by that artist (use quotes for names with spaces). |
| `/sp spotify:track:<id>` | Plays that exact track; `open.spotify.com/track/...` links work too. |
| `/sp` | Play/pause. |
| `/sp play` | Resumes playback. |
| `/sp pause`, `/sp next`, `/sp prev` | Playback controls; each one reports the resulting state. |
| `/sp np` | What is playing now. |
| `/sp setup [id\|secret]` | Pastes a credential from the clipboard. |
| `/sp check` | Verifies credentials with a search, without playing anything. |
| `/sp sidebar on\|off` | Shows or hides the now-playing row. The choice is remembered. |
| `/sp help` | Lists these forms. |

### Controls versus songs

The rule is fixed: when the **whole** argument is exactly one of the forms above (case and extra spaces
ignored), it is a control. Anything else is a song search. So `/sp next` skips a track and `/sp next episode`
searches for that song. To search for a song whose name is a control word, prefix it with `play`:
`/sp play next` always searches for "next".

### How a song is chosen

Spotify returns up to 10 results. The extension picks, in order of priority:

1. the result whose title and artists contain the most words of your query,
2. then the one whose title words appear most in your query,
3. then the shortest title (so `My Name Is` wins over `My Name Is - Remix`),
4. then Spotify's own order.

Accents, case and punctuation are ignored. The same query against the same results always picks the same track.

## Sidebar row

When enabled (the default), the extension asks Spotify for the current track every 5 seconds and shows
`♪ title — artist` (or `⏸` when paused) as one row in the INTEGRATIONS section. It never launches Spotify:
when the app is closed or stopped, the row disappears. Gentle Shell shows the sidebar on terminals at least
140 columns wide.

Gentle Shell does not offer extensions a sidebar section of their own, so the row lives inside INTEGRATIONS.

## Privacy

- Your Client ID and secret go only to `accounts.spotify.com` to get a token; searches go to `api.spotify.com`.
- The token is cached in `~/.config/spotify-cli/token` (mode `600`) until it expires.
- Nothing is sent anywhere else.

## Development

```bash
npm test   # node --test test/*.test.ts (Node 22.18+ / 24, no dependencies)
```

Tests use fakes for the network, `osascript` and the clipboard, so they never touch your Spotify.

## Listing on Gentle Hub

[Gentle Hub](https://gentlemanprogramming.com/gentle-hub/) lists public GitHub repositories by topic.
This repository uses `gentle-shell-package` and `gentle-shell-extension`.

## License

MIT
