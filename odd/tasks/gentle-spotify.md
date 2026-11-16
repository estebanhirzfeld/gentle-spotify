# gentle-spotify

Pi / Gentle Shell package that controls the macOS Spotify app with deterministic slash commands
and an optional "now playing" row in the Gentle Shell sidebar (INTEGRATIONS section).
Replaces the clunky `!play` bash flow; publishable to Gentle Hub as a public GitHub repo.

## Specs

- **S1 Commands.** User: "me gustaria algo que pueda hacer con comandos". Slash commands handled by the
  extension, never by the model: `/play <búsqueda>`, `/play spotify:track:<id>`, `/pause`, `/next`,
  `/prev`, `/np`.
- **S2 Fix what felt clunky.** User: "es medio tosco, como lo mejoramos?". Observed, verbatim:
  - `play My name is Eminem` printed `▶ Eminem — Without Me (The Eminem Show, 2002)`: the query must
    resolve to Eminem — My Name Is.
  - `pause` → `/bin/bash: pause: command not found`: a short pause command must exist (`/pause`).
  - `play --resume` → `play: opción desconocida: --resume`, and `play` with no argument printed help
    and exited 1: `/play` with no argument resumes playback.
  - `play --pause` and `play --play` printed `(no output)`: every control reports the resulting state.
- **S3 Sidebar, optional.** User: "si podemos mostrarlo (y que sea opcional ) en el lateral derecho por
  ejemplo abajo de INTEGRATIONS". Decision (L3): one row inside INTEGRATIONS via `ctx.ui.setStatus`,
  because gentle-pi's rail sections are a closed set (`lib/shell-bar.ts:232`). `/spotify sidebar on|off`
  toggles it and the choice persists across sessions. Polling never launches Spotify when it is closed.
- **S4 Deterministic.** User: "lo que sea determinista mejor". The same query against the same search
  results always picks the same track; ranking is a pure function of the query and the result list.
- **S5 Gentle Hub.** User: "si lo podemos subir a gentle-hub estaria bueno tambien". Repo ready for a
  public GitHub repo: `package.json` with the `pi` manifest and `pi-package` keyword, README, LICENSE,
  documented topics `gentle-shell-package` + `gentle-shell-extension`. Creating the remote, pushing and
  adding topics is the user's decision.
- **S6 Credentials.** Carry over the existing flow: `/spotify setup` pastes from the clipboard, clears
  it, never prints the value; `/spotify check` validates credentials without playing. Reads the same
  `~/.config/spotify-cli/credentials` file the user already has.

## Tasks

- [x] T1 S5 — scaffold: package.json manifest, LICENSE, .gitignore, this document. inline. Commit eb3c4ab.
- [x] T2 S2,S4,S6 — engine `src/spotify.ts`: credentials, token cache, search, ranking, AppleScript, state. inline, test-first. 27 tests; live state + ranking checked. Commit: see git log (feat: add Spotify engine).
- [x] T3 S1,S2,S3,S6 — extension `src/extension.ts`: commands, sidebar row, toggle persistence. inline (worker unavailable: session cwd ~/Desktop is not a git repo), test-first. 21 tests (48 total); loads under Gentle Shell's jiti 2.7.0. Commit: feat: add slash commands and sidebar row.
- [ ] T4 S5 — README (install, commands, Gentle Hub topics), local install in Gentle Shell, live check. inline.

## Log

- L1 (user, verbatim): "es medio tosco, como lo mejoramos? el tema de comandos y eso? podemos hacer que
  interactue con la gentle-shell? lo que sea determinista mejor" — after running `play My name is Eminem`
  (got Without Me), `pause` (command not found), `play --pause`, `play --resume` (unknown option), `play`
  (help, exit 1), `play --play`.
- L2 (user, verbatim): "si lo podemos subir a gentle-hub estaria bueno tambien, me gustaria algo que pueda
  hacer con comandos y si podemos mostrarlo (y que sea opcional ) en el lateral derecho por ejemplo abajo
  de INTEGRATIONS estaria bueno supongo"
- L3 (decision): no public API adds a rail section (gentle-pi `lib/shell-bar.ts:232`, closed union);
  extension statuses render as rows inside INTEGRATIONS (`extensions/gentle-shell.ts:366-370`). User chose
  "Fila dentro de INTEGRATIONS" and the location `~/Desktop/gentle-spotify`.
- L4 (evidence): Gentle Hub lists public GitHub repos with topic `gentle-shell-package`; optional subtype
  `gentle-shell-extension` (gentlemanprogramming.com/gentle-hub). Install: `pi install git:github.com/<owner>/<repo>`.
- L5 (evidence): the `Without Me` result was not a ranking problem. Spotify returns My Name Is first for
  "My name is Eminem"; the bash `play` script overwrote `query` with each unquoted word, so it searched
  only "Eminem". Fixed in `~/.local/bin/play` (outside this repo) with a RED-then-GREEN selftest. The
  extension receives one argument string, so it is not affected; `pickTrack` still re-ranks deterministically.
