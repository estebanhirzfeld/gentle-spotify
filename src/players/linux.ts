/**
 * Linux player (experimental): controls the Spotify desktop app through its MPRIS
 * D-Bus interface, using `dbus-send` (run directly, never through a shell).
 *
 * Spotify is never launched: every call first asks the session bus whether the app
 * owns its name (NameHasOwner), and playback controls ask the user to open the app
 * instead when it is not running. The URI handed to OpenUri is already validated by
 * parseTrackRef / the search filter, so it is always a plain spotify:track:<id>.
 */
import { SpotifyError, type NowPlaying, type Player, type RunResult, type Runner } from "../spotify.ts";

const MPRIS_DEST = "org.mpris.MediaPlayer2.spotify";
const MPRIS_PATH = "/org/mpris/MediaPlayer2";
const PLAYER_IFACE = "org.mpris.MediaPlayer2.Player";

const NOT_FOUND = "dbus-send not found: install your distribution's dbus package.";
const NOT_RUNNING = "Spotify is not running: open it first.";

/** A missing binary shows up as exit code 127 (the shell convention) or an ENOENT spawn error. */
function missingTool(result: RunResult): boolean {
	return result.code === 127 || /ENOENT|spawn /.test(result.stderr);
}

/** dbus-send prints strings escaped inside quotes; undo the escapes. */
function unquote(escaped: string): string {
	return escaped.replace(/\\(.)/g, "$1");
}

function quotedString(text: string): string | null {
	const m = /"((?:\\.|[^"\\])*)"/.exec(text);
	return m ? unquote(m[1]) : null;
}

export function createLinuxPlayer(run: Runner): Player {
	async function send(args: string[]): Promise<RunResult> {
		let result: RunResult;
		try {
			result = await run("dbus-send", args);
		} catch {
			throw new SpotifyError(NOT_FOUND); // a rejected exec is a spawn error
		}
		if (missingTool(result)) throw new SpotifyError(NOT_FOUND);
		if (result.code !== 0) {
			throw new SpotifyError(`dbus-send failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
		}
		return result;
	}

	function playerCall(method: string, ...args: string[]): Promise<RunResult> {
		return send(["--session", "--print-reply", `--dest=${MPRIS_DEST}`, MPRIS_PATH, method, ...args]);
	}

	/** True when the Spotify app owns its bus name; asks the session bus, never launches Spotify. */
	async function hasOwner(): Promise<boolean> {
		const result = await send([
			"--session",
			"--print-reply",
			"--dest=org.freedesktop.DBus",
			"/org/freedesktop/DBus",
			"org.freedesktop.DBus.NameHasOwner",
			`string:${MPRIS_DEST}`,
		]);
		return result.stdout.includes("boolean true");
	}

	async function requireRunning(): Promise<void> {
		if (!(await hasOwner())) throw new SpotifyError(NOT_RUNNING);
	}

	function property(name: string): Promise<RunResult> {
		return playerCall("org.freedesktop.DBus.Properties.Get", `string:${PLAYER_IFACE}`, `string:${name}`);
	}

	/** Values of one metadata key ("xesam:title", "xesam:artist", ...), parsed tolerantly. */
	function metadataValues(reply: string, key: string): string[] {
		for (const entry of reply.split("dict entry(").slice(1)) {
			const keyMatch = /"((?:\\.|[^"\\])*)"/.exec(entry);
			if (!keyMatch || unquote(keyMatch[1]) !== key) continue;
			const rest = entry.slice(keyMatch.index + keyMatch[0].length);
			const array = /array\s*\[([^\]]*)\]/.exec(rest);
			if (array) {
				return [...array[1].matchAll(/"((?:\\.|[^"\\])*)"/g)].map((m) => unquote(m[1]));
			}
			const value = /string\s+"((?:\\.|[^"\\])*)"/.exec(rest);
			if (value) return [unquote(value[1])];
		}
		return [];
	}

	async function nowPlaying(): Promise<NowPlaying> {
		if (!(await hasOwner())) return { state: "closed" };
		const status = quotedString((await property("PlaybackStatus")).stdout) ?? "Stopped";
		if (status !== "Playing" && status !== "Paused") return { state: "stopped" };
		const metadata = await property("Metadata");
		return {
			state: status === "Playing" ? "playing" : "paused",
			name: metadataValues(metadata.stdout, "xesam:title")[0] ?? "",
			artist: metadataValues(metadata.stdout, "xesam:artist").join(", "),
		};
	}

	return {
		async resume() {
			await requireRunning();
			await playerCall(`${PLAYER_IFACE}.Play`);
		},
		async playUri(uri: string) {
			await requireRunning();
			await playerCall(`${PLAYER_IFACE}.OpenUri`, `string:${uri}`);
		},
		async toggle() {
			await requireRunning();
			await playerCall(`${PLAYER_IFACE}.PlayPause`);
		},
		async control(verb) {
			if (!(await hasOwner())) return false;
			const method = verb === "pause" ? "Pause" : verb === "next" ? "Next" : "Previous";
			await playerCall(`${PLAYER_IFACE}.${method}`);
			return true;
		},
		nowPlaying,
	};
}
