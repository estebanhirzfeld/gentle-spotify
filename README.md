# gentle-spotify

Control the **Spotify app on your Mac** from [Gentle Shell](https://gentlemanprogramming.com/) / Pi with slash
commands, and optionally see what is playing in the sidebar.

```
/play Eminem my name is      ▶ My Name Is — Eminem (The Slim Shady LP, 1999)
/pause                       ⏸ My Name Is — Eminem
/next                        ▶ Without Me — Eminem
```

```
INTEGRATIONS (2)
- engram ✓
- ♪ Eminem — My Name Is
```

- **Deterministic.** Commands run inside the extension, not through the model: same input, same result, no tokens.
- **Plays in your real Spotify app.** Your account, your library, your devices. Not a separate player.
- **Optional sidebar row.** One line under INTEGRATIONS; turn it off with `/spotify sidebar off`.

## Requirements

- macOS with the Spotify desktop app installed.
- A free Spotify developer app, used only for search (see [Setup](#setup)).
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
3. In the app's **Settings**, copy the **Client ID** and run `/spotify setup`.
4. Copy the **Client secret** and run `/spotify setup` again.
5. Run `/spotify check`.

`/spotify setup` reads the value from the clipboard, never prints it and clears the clipboard afterwards.
Credentials live in `~/.config/spotify-cli/credentials` with mode `600`; set `SPOTIFY_CLI_DIR` to use
another folder.

## Commands

| Command | What it does |
| --- | --- |
| `/play <song or artist>` | Plays the best match. Word order does not matter. |
| `/play --artist <name> <song>` | Only considers tracks by that artist (use quotes for names with spaces). |
| `/play spotify:track:<id>` | Plays that exact track; `open.spotify.com/track/...` links work too. |
| `/play` | Resumes playback. |
| `/pause`, `/next`, `/prev` | Playback controls; each one reports the resulting state. |
| `/np` | What is playing now. |
| `/spotify setup [id\|secret]` | Pastes a credential from the clipboard. |
| `/spotify check` | Verifies credentials with a search, without playing anything. |
| `/spotify sidebar on\|off` | Shows or hides the now-playing row. The choice is remembered. |
| `/spotify` | Lists these commands. |

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
