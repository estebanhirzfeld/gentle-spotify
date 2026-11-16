<p align="center"><img src="assets/logo.png" alt="gentle-spotify logo" width="140"></p>

# gentle-spotify

![macOS: supported](https://img.shields.io/badge/macOS-supported-brightgreen) ![Linux: experimental](https://img.shields.io/badge/Linux-experimental-orange)

Control the **Spotify desktop app** from [Gentle Shell](https://gentlemanprogramming.com/) / Pi with slash
commands, and optionally see what is playing in the sidebar.

```
/sp Eminem my name is     ▶ My Name Is — Eminem (The Slim Shady LP, 1999)
/sp                       play/pause
/sp next                  ▶ Without Me — Eminem
```

```
INTEGRATIONS (2)
- engram ✓
- ♪ Eminem — My Name Is
```

One command, handled by the extension and never by the model: deterministic, no tokens. It drives your real
Spotify app, not a separate player.

## Install

```bash
pi install git:github.com/estebanhirzfeld/gentle-spotify
```

From a local clone: `pi install ./gentle-spotify`. Then run `/reload`, or start a new session.

## Setup (2 minutes)

Spotify can only play a track by its URI, so finding a song by name needs a Web API search, and that needs a
developer app of your own — free to create.

1. Open the [developer dashboard](https://developer.spotify.com/dashboard) → **Create app**. Any name,
   redirect URI `http://127.0.0.1:8888/callback` (unused), tick **Web API**.
2. In **Settings**, copy the **Client ID** → run `/sp setup`.
3. Copy the **Client secret** → run `/sp setup` again → `/sp check`.

`/sp setup` takes the value from your clipboard, never prints it, and clears the clipboard afterwards.
Credentials live in `~/.config/spotify-cli/credentials` (mode `600`); set `SPOTIFY_CLI_DIR` to use another
folder. Use **your own** credentials — every request counts against the owner account's quota, and the client
secret must never be shared or shipped.

> Spotify's docs state that "the app owner must have a Spotify Premium account for apps in development mode to
> function" ([quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)).

## Commands

Type `/sp ` and press Tab to see the fixed forms.

| Command | What it does |
| --- | --- |
| `/sp <song or artist>` | Play the best match. Word order does not matter. |
| `/sp --artist <name> <song>` | Only consider tracks by that artist. |
| `/sp spotify:track:<id>` | Play that exact track; `open.spotify.com/track/...` links work too. |
| `/sp` | Play/pause. |
| `/sp play` | Resume. |
| `/sp pause` · `/sp next` · `/sp prev` | Controls; each reports the resulting state. |
| `/sp np` | What is playing now. |
| `/sp setup [id\|secret]` · `/sp check` | Load and verify credentials. |
| `/sp sidebar on\|off` | Show or hide the now-playing row (remembered). |

**Controls versus songs.** When the whole argument is exactly one of the forms above (case and extra spaces
ignored), it is a control; anything else is a song search. So `/sp next` skips a track and `/sp next episode`
searches for that song. Prefix with `play` to search a word that is also a control: `/sp play next`.

**Which match wins.** Most query words in the title or artists, then title words in the query, then the
shortest title (`My Name Is` beats `My Name Is - Remix`), then Spotify's own order. Accents, case and
punctuation are ignored, so the same query always picks the same track.

## Platforms

- **macOS:** supported. Playback goes through the app's AppleScript interface. Starting a track makes Spotify
  bring its window forward; the extension hands focus straight back to the app you were using (it waits at most
  one second, and only for that command).
- **Linux:** experimental, driven by the app's MPRIS D-Bus interface (`dbus-send` from your distribution's
  `dbus` package; `wl-clipboard`, `xclip` or `xsel` for `/sp setup`). It has **not** been verified against a
  real Spotify on Linux yet — reports from real setups are welcome. Spotify is never launched: commands answer
  `Spotify is not running: open it first.` when it is closed.

The sidebar row (default on) reads the current track every 5 seconds and shows one line under INTEGRATIONS.
Gentle Shell offers extensions no sidebar section of their own, so the row lives there; it disappears when
Spotify is closed or stopped. The sidebar shows at 140+ columns.

## Privacy

Your Client ID and secret go only to `accounts.spotify.com` for a token; searches go to `api.spotify.com`. The
token is cached in `~/.config/spotify-cli/token` (mode `600`) until it expires. Nothing is sent anywhere else.

## Development

```bash
npm test   # node --test test/*.test.ts — Node 22.18+/24, no dependencies
```

Network, `osascript`, `dbus-send` and the clipboard are faked, so tests never touch your Spotify.

## License

MIT · listed on [Gentle Hub](https://gentlemanprogramming.com/gentle-hub/) via the `gentle-shell-package` and
`gentle-shell-extension` topics.
