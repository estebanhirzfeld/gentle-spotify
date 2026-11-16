/**
 * macOS player: controls the Spotify app through AppleScript (osascript).
 *
 * Why AppleScript: the app's AppleScript dictionary can only play a track by URI
 * ("play track" in Spotify.sdef), so playback goes through osascript on the local app.
 * Moved unchanged from the engine when the Linux (MPRIS) player arrived.
 */
import { SpotifyError, type NowPlaying, type Player, type Runner } from "../spotify.ts";

function guarded(lines: string[]): string[] {
	return [
		'if application "Spotify" is running then',
		...lines,
		'return "ok"',
		"else",
		'return "closed"',
		"end if",
	];
}

/**
 * Spotify brings its window to the front on `play track` (measured: about 50 ms after the command).
 * Remember the front app, then hand focus back as soon as it changes, waiting at most 1 second.
 * `path to frontmost application` and `activate` need no extra macOS permission.
 * Only `play track` steals focus (play, playpause and state reads were measured not to), so only it
 * pays this bounded wait.
 */
function keepFocus(lines: string[]): string[] {
	return [
		"set frontApp to path to frontmost application as text",
		...lines,
		"repeat 20 times",
		"delay 0.05",
		"if (path to frontmost application as text) is not frontApp then",
		"tell application frontApp to activate",
		"exit repeat",
		"end if",
		"end repeat",
	];
}

const STATE_SCRIPT = [
	'if application "Spotify" is running then',
	'tell application "Spotify"',
	"set s to (player state as string)",
	'if s is "stopped" then return "stopped"',
	"return s & tab & (name of current track) & tab & (artist of current track)",
	"end tell",
	"else",
	'return "closed"',
	"end if",
];

function parseState(stdout: string): NowPlaying {
	const [state, name = "", artist = ""] = stdout.replace(/\n$/, "").split("\t");
	if (state === "playing" || state === "paused") return { state, name, artist };
	if (state === "stopped") return { state: "stopped" };
	return { state: "closed" };
}

export function createMacOSPlayer(run: Runner): Player {
	async function osa(lines: string[]): Promise<string> {
		const result = await run("osascript", lines.flatMap((line) => ["-e", line]));
		if (result.code !== 0) {
			throw new SpotifyError(`osascript failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
		}
		return result.stdout.trim();
	}

	return {
		async resume() {
			await osa(['tell application "Spotify" to play']);
		},
		async playUri(uri: string) {
			await osa(keepFocus([`tell application "Spotify" to play track "${uri}"`]));
		},
		async toggle() {
			await osa(['tell application "Spotify" to playpause']);
		},
		async control(verb) {
			const script = verb === "pause" ? "pause" : verb === "next" ? "next track" : "previous track";
			// guarded: a closed Spotify answers "closed" instead of being launched.
			return (await osa(guarded([`tell application "Spotify" to ${script}`]))) !== "closed";
		},
		async nowPlaying() {
			return parseState(await osa(STATE_SCRIPT));
		},
	};
}
