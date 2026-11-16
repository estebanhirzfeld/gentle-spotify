/**
 * Spotify engine: credentials, token cache, search, deterministic ranking and
 * AppleScript control of the macOS Spotify app.
 *
 * Everything that touches the outside world (network, osascript, clock) is
 * injected through SpotifyDeps, so the whole engine runs under tests without a
 * network or a real Spotify app.
 *
 * Why two halves: the app's AppleScript dictionary can only play a track by URI
 * ("play track" in Spotify.sdef), so name -> URI goes through the Web API search
 * and playback goes through osascript on the local app.
 */
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------- types

export interface Track {
	uri: string;
	name: string;
	artists: string[];
	album: string;
	year: string;
}

export type NowPlaying =
	| { state: "playing" | "paused"; name: string; artist: string }
	| { state: "stopped" }
	| { state: "closed" };

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type Runner = (command: string, args: string[]) => Promise<RunResult>;

export interface SpotifyDeps {
	/** Holds `credentials` and the `token` cache. */
	configDir: string;
	fetch: typeof fetch;
	run: Runner;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	apiBase?: string;
	tokenUrl?: string;
	market?: string;
}

export class SpotifyError extends Error {
	override name = "SpotifyError";
}

export type CredentialField = "clientId" | "clientSecret";

const KEYS: Record<CredentialField, string> = {
	clientId: "SPOTIFY_CLIENT_ID",
	clientSecret: "SPOTIFY_CLIENT_SECRET",
};

const CREDENTIALS_TEMPLATE = `# Spotify developer app credentials (https://developer.spotify.com/dashboard)
# Keep this file private (mode 600). Fill it with /sp setup.
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
`;

/** Spotify waits a moment before the new track/state is visible to AppleScript. */
const SETTLE_MS = 300;

// --------------------------------------------------------------- ranking

function tokens(text: string): string[] {
	return (
		text
			.normalize("NFD")
			.replace(/\p{M}/gu, "")
			.toLowerCase()
			.match(/[\p{L}\p{N}]+/gu) ?? []
	);
}

function normalize(text: string): string {
	return tokens(text).join(" ");
}

/**
 * Picks the best track for a query. Pure and deterministic:
 *   1. most query words found in the title or the artists,
 *   2. most title words found in the query,
 *   3. fewest extra title words (prefers "My Name Is" over "My Name Is - Remix"),
 *   4. Spotify's own order.
 * Returns null when nothing is left after the optional artist filter.
 */
export function pickTrack(query: string, tracks: Track[], artist?: string): Track | null {
	const wanted = new Set(tokens(query));
	const artistFilter = artist ? normalize(artist) : "";

	const scored = tracks
		.map((track, index) => {
			const title = new Set(tokens(track.name));
			const artists = new Set(tokens(track.artists.join(" ")));
			let covered = 0;
			for (const w of wanted) if (title.has(w) || artists.has(w)) covered++;
			let titleMatched = 0;
			for (const w of title) if (wanted.has(w)) titleMatched++;
			const extra = titleMatched > 0 ? title.size - titleMatched : 0;
			return { track, index, covered, titleMatched, extra };
		})
		.filter(({ track }) => !artistFilter || track.artists.some((a) => normalize(a).includes(artistFilter)));

	scored.sort(
		(a, b) =>
			b.covered - a.covered || b.titleMatched - a.titleMatched || a.extra - b.extra || a.index - b.index,
	);
	return scored[0]?.track ?? null;
}

/** Accepts a `spotify:track:<id>` URI or an open.spotify.com track link. */
export function parseTrackRef(input: string): string | null {
	const text = input.trim();
	const uri = /^spotify:track:([A-Za-z0-9]+)$/.exec(text);
	if (uri) return `spotify:track:${uri[1]}`;
	const link = /^https?:\/\/open\.spotify\.com\/(?:[a-z-]+\/)?track\/([A-Za-z0-9]+)(?:[?#].*)?$/.exec(text);
	if (link) return `spotify:track:${link[1]}`;
	return null;
}

/** `--artist Eminem my name is`, `--artist "Soda Stereo" persiana americana`, `--artist=X q`. */
export function parsePlayArgs(args: string): { query: string; artist: string | undefined } {
	let rest = args.trim();
	let artist: string | undefined;
	const flag = /^--artist(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))\s*/.exec(rest);
	if (flag) {
		artist = flag[1] ?? flag[2] ?? flag[3];
		rest = rest.slice(flag[0].length);
	}
	return { query: rest.trim(), artist };
}

// ----------------------------------------------------------- credentials

/** Creates the config dir if needed and tightens it to 700 even when it already existed. */
function ensurePrivateDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
}

function credentialsPath(dir: string): string {
	return join(dir, "credentials");
}

function readCredentialFile(dir: string): Record<string, string> {
	const file = credentialsPath(dir);
	if (!existsSync(file)) return {};
	const values: Record<string, string> = {};
	for (const line of readFileSync(file, "utf8").split("\n")) {
		const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
		if (m) values[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
	}
	return values;
}

export function credentialStatus(dir: string): Record<CredentialField, number> {
	const values = readCredentialFile(dir);
	return {
		clientId: (values[KEYS.clientId] ?? "").length,
		clientSecret: (values[KEYS.clientSecret] ?? "").length,
	};
}

/**
 * Stores one credential, keeping comments and order. Without an explicit field it
 * fills the client id first, then the secret. Returns the field it wrote.
 */
export function saveCredential(dir: string, rawValue: string, field?: CredentialField): CredentialField {
	const value = rawValue.trim();
	if (!value) throw new SpotifyError("The clipboard is empty: copy the value from the Spotify dashboard first.");
	if (value.length < 10 || value.length > 200 || /\s/.test(value)) {
		throw new SpotifyError(`That does not look like a Spotify credential (${value.length} characters).`);
	}

	const target: CredentialField = field ?? (credentialStatus(dir).clientId === 0 ? "clientId" : "clientSecret");
	const key = KEYS[target];

	ensurePrivateDir(dir);
	const file = credentialsPath(dir);
	const current = existsSync(file) ? readFileSync(file, "utf8") : CREDENTIALS_TEMPLATE;
	let replaced = false;
	const lines = current.replace(/\n$/, "").split("\n").map((line) => {
		if (!replaced && new RegExp(`^\\s*${key}\\s*=`).test(line)) {
			replaced = true;
			return `${key}=${value}`;
		}
		return new RegExp(`^\\s*${key}\\s*=`).test(line) ? null : line;
	});
	const next = lines.filter((l): l is string => l !== null);
	if (!replaced) next.push(`${key}=${value}`);

	const tmp = `${file}.tmp`;
	rmSync(tmp, { force: true }); // a stale temp file could carry a wider mode
	writeFileSync(tmp, `${next.join("\n")}\n`, { mode: 0o600, flag: "wx" });
	chmodSync(tmp, 0o600);
	renameSync(tmp, file);
	return target;
}

function loadCredentials(dir: string): { id: string; secret: string } {
	const values = readCredentialFile(dir);
	const id = values[KEYS.clientId] ?? "";
	const secret = values[KEYS.clientSecret] ?? "";
	if (!id || !secret) {
		throw new SpotifyError(
			`Missing Spotify credentials in ${credentialsPath(dir)}. Run /sp setup to add them.`,
		);
	}
	return { id, secret };
}

// ------------------------------------------------------------ AppleScript

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

export function formatNowPlaying(np: NowPlaying): string {
	switch (np.state) {
		case "playing":
			return `▶ ${np.name} — ${np.artist}`;
		case "paused":
			return `⏸ ${np.name} — ${np.artist}`;
		case "stopped":
			return "■ Stopped";
		case "closed":
			return "Spotify is not running";
	}
}

// ---------------------------------------------------------------- engine

export function createSpotify(deps: SpotifyDeps) {
	const now = deps.now ?? (() => Date.now());
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const apiBase = deps.apiBase ?? "https://api.spotify.com";
	const tokenUrl = deps.tokenUrl ?? "https://accounts.spotify.com/api/token";
	const market = deps.market ?? "AR";
	const tokenFile = join(deps.configDir, "token");

	async function osa(lines: string[]): Promise<string> {
		const result = await deps.run("osascript", lines.flatMap((line) => ["-e", line]));
		if (result.code !== 0) {
			throw new SpotifyError(`osascript failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
		}
		return result.stdout.trim();
	}

	async function request(url: string, init?: RequestInit): Promise<Response> {
		try {
			return await deps.fetch(url, init);
		} catch (error) {
			throw new SpotifyError(`Could not reach Spotify: ${(error as Error).message}`);
		}
	}

	async function token(): Promise<string> {
		const nowSeconds = Math.floor(now() / 1000);
		if (existsSync(tokenFile)) {
			try {
				const cached = JSON.parse(readFileSync(tokenFile, "utf8"));
				if (cached.access_token && typeof cached.expires_at === "number" && nowSeconds < cached.expires_at) {
					return cached.access_token as string;
				}
			} catch {
				// A corrupt cache is just a miss.
			}
		}

		const { id, secret } = loadCredentials(deps.configDir);
		const response = await request(tokenUrl, {
			method: "POST",
			headers: {
				Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: "grant_type=client_credentials",
		});
		if (!response.ok) {
			throw new SpotifyError(
				`Spotify rejected the credentials (HTTP ${response.status}). Check them with /sp setup.`,
			);
		}
		const body = (await response.json()) as { access_token?: string; expires_in?: number };
		if (!body.access_token) throw new SpotifyError("Spotify returned no access token.");

		ensurePrivateDir(deps.configDir);
		const expiresAt = nowSeconds + (body.expires_in ?? 0) - 60;
		writeFileSync(tokenFile, `${JSON.stringify({ access_token: body.access_token, expires_at: expiresAt })}\n`, {
			mode: 0o600,
		});
		chmodSync(tokenFile, 0o600);
		return body.access_token;
	}

	async function search(query: string, artist?: string): Promise<Track[]> {
		const q = artist ? `${query} artist:${artist}` : query;
		const url = `${apiBase}/v1/search?q=${encodeURIComponent(q)}&type=track&limit=10&market=${market}`;
		const response = await request(url, { headers: { Authorization: `Bearer ${await token()}` } });
		if (!response.ok) throw new SpotifyError(`Spotify search failed (HTTP ${response.status}).`);
		const body = (await response.json()) as {
			tracks?: { items?: Array<{ uri?: string; name?: string; artists?: Array<{ name?: string }>; album?: { name?: string; release_date?: string } }> };
		};
		return (body.tracks?.items ?? [])
			.filter((item) => typeof item.uri === "string" && /^spotify:track:[A-Za-z0-9_]+$/.test(item.uri))
			.map((item) => ({
				uri: item.uri as string,
				name: item.name ?? "",
				artists: (item.artists ?? []).map((a) => a.name ?? "").filter(Boolean),
				album: item.album?.name ?? "",
				year: (item.album?.release_date ?? "").slice(0, 4),
			}));
	}

	async function nowPlaying(): Promise<NowPlaying> {
		return parseState(await osa(STATE_SCRIPT));
	}

	async function control(verb: "pause" | "next track" | "previous track"): Promise<string> {
		const out = await osa(guarded([`tell application "Spotify" to ${verb}`]));
		if (out === "closed") return formatNowPlaying({ state: "closed" });
		await sleep(SETTLE_MS);
		return formatNowPlaying(await nowPlaying());
	}

	async function playUri(uri: string): Promise<void> {
		await osa(keepFocus([`tell application "Spotify" to play track "${uri}"`]));
	}

	return {
		nowPlaying,

		/** Resumes when the query is empty; plays a URI/link directly; otherwise searches. */
		async play(query: string, options: { artist?: string } = {}): Promise<string> {
			const text = query.trim();
			if (!text) {
				await osa(['tell application "Spotify" to play']);
				await sleep(SETTLE_MS);
				return formatNowPlaying(await nowPlaying());
			}

			const ref = parseTrackRef(text);
			if (ref) {
				await playUri(ref);
				await sleep(SETTLE_MS);
				return formatNowPlaying(await nowPlaying());
			}

			const track = pickTrack(text, await search(text, options.artist), options.artist);
			if (!track) {
				const by = options.artist ? ` by "${options.artist}"` : "";
				throw new SpotifyError(`No track found for "${text}"${by}.`);
			}
			await playUri(track.uri);
			const album = track.album ? ` (${track.album}${track.year ? `, ${track.year}` : ""})` : "";
			return `▶ ${track.name} — ${track.artists.join(", ")}${album}`;
		},

		/** Play/pause toggle. User-initiated, so it may launch a closed Spotify (like play). */
		async toggle(): Promise<string> {
			await osa(['tell application "Spotify" to playpause']);
			await sleep(SETTLE_MS);
			return formatNowPlaying(await nowPlaying());
		},

		pause: () => control("pause"),
		next: () => control("next track"),
		prev: () => control("previous track"),

		/** Gets a token and runs a real search; never plays anything. */
		async check(): Promise<string> {
			const [first] = await search("eminem");
			const sample = first ? ` (${first.artists.join(", ")} — ${first.name})` : "";
			return `Credentials OK — search works${sample}`;
		},
	};
}

export type Spotify = ReturnType<typeof createSpotify>;

/** Runner for use outside Pi (pi.exec is preferred inside the extension). */
export const nodeRunner: Runner = (command, args) =>
	new Promise((resolve) => {
		execFile(command, args, { timeout: 10_000 }, (error, stdout, stderr) => {
			const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
			resolve({ code, stdout: String(stdout), stderr: String(stderr) });
		});
	});
