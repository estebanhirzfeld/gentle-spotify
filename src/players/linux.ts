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
/** Constant on purpose: an invalid URI is never echoed back. */
const NOT_A_TRACK_URI = "Not a valid spotify:track:<id> URI.";
/** Every URI reaching OpenUri looks like spotify:track:<id> (parseTrackRef / the search filter). */
const TRACK_URI = /^spotify:track:[A-Za-z0-9_]+$/;

/** A missing binary is not a dbus failure: it rejects with Node's spawn error, or exits 127. */
function isMissingToolRejection(err: unknown): boolean {
	return err instanceof Error && err.message.includes("ENOENT");
}

/** dbus-send prints strings escaped inside quotes; undo the escapes. */
function unquote(escaped: string): string {
	return escaped.replace(/\\(.)/g, "$1");
}

function quotedString(text: string): string | null {
	const m = /"((?:\\.|[^"\\])*)"/.exec(text);
	return m ? unquote(m[1]) : null;
}

/** One dbus-send reply token: a quoted string (escapes already undone) or a bare word. */
type Token = { kind: "string"; value: string } | { kind: "word"; text: string };

/**
 * Splits reply text into tokens so metadata text that itself contains "array [",
 * "dict entry(...)", brackets or quotes stays inside its string token and is never
 * mistaken for structure.
 */
function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	let word = "";
	let i = 0;
	const flush = () => {
		if (word) {
			tokens.push({ kind: "word", text: word });
			word = "";
		}
	};
	while (i < text.length) {
		const c = text[i];
		if (c === '"') {
			flush();
			i++;
			let value = "";
			// quoted string with escapes: `\"` does not end the string
			while (i < text.length && text[i] !== '"') {
				if (text[i] === "\\" && i + 1 < text.length) {
					value += text[i + 1];
					i += 2;
				} else {
					value += text[i];
					i++;
				}
			}
			i++; // the closing quote
			tokens.push({ kind: "string", value });
		} else if (/\s/.test(c)) {
			flush();
			i++;
		} else {
			word += c;
			i++;
		}
	}
	flush();
	return tokens;
}

export function createLinuxPlayer(run: Runner): Player {
	async function send(args: string[]): Promise<RunResult> {
		let result: RunResult;
		try {
			result = await run("dbus-send", args);
		} catch (err) {
			if (isMissingToolRejection(err)) throw new SpotifyError(NOT_FOUND);
			throw err; // not a spawn failure: surface the runner's own error
		}
		if (result.code === 127) throw new SpotifyError(NOT_FOUND);
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

	/** Values of one metadata key ("xesam:title", "xesam:artist", ...), read token by token. */
	function metadataValues(reply: string, key: string): string[] {
		const tokens = tokenize(reply);
		for (let i = 0; i + 2 < tokens.length; i++) {
			if (tokens[i].kind !== "word" || tokens[i].text !== "dict") continue;
			if (tokens[i + 1].kind !== "word" || tokens[i + 1].text !== "entry(") continue;
			// dbus-send prints the type before the value: `string "xesam:title"`
			const typeWord = tokens[i + 2];
			if (typeWord?.kind !== "word" || typeWord.text !== "string") continue;
			const keyToken = tokens[i + 3];
			if (keyToken.kind !== "string" || keyToken.value !== key) continue;
			const variant = tokens[i + 4];
			if (variant?.kind !== "word" || variant.text !== "variant") return [];
			const type = tokens[i + 5];
			if (type?.kind !== "word") return [];
			if (type.text === "string") {
				const value = tokens[i + 6];
				return value?.kind === "string" ? [value.value] : [];
			}
			if (type.text === "array") {
				const values: string[] = [];
				// quoted strings are single tokens, so the first `]` word is the real array end
				for (let j = i + 6; j < tokens.length && !(tokens[j].kind === "word" && tokens[j].text === "]"); j++) {
					if (tokens[j].kind === "string") values.push(tokens[j].value);
				}
				return values;
			}
			return [];
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
			// validated here too: nothing is sent for anything that is not spotify:track:<id>
			if (!TRACK_URI.test(uri)) throw new SpotifyError(NOT_A_TRACK_URI);
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
