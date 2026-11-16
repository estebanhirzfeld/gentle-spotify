/**
 * gentle-spotify: Pi / Gentle Shell extension.
 *
 * Slash commands are handled here, never by the model, so they are deterministic
 * and cost no tokens. The optional now-playing row uses ctx.ui.setStatus, which
 * Gentle Shell renders inside the INTEGRATIONS section of the sidebar.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	createSpotify,
	formatNowPlaying,
	parsePlayArgs,
	saveCredential,
	type CredentialField,
	type NowPlaying,
	type Spotify,
} from "./spotify.ts";
import { clearClipboard, readClipboard } from "./clipboard.ts";

const STATUS_KEY = "spotify";
const POLL_MS = 5000;
const SETTINGS_FILE = "gentle-spotify.json";

type Level = "info" | "warning" | "error";
interface UI {
	notify(message: string, level?: Level): void;
	setStatus(key: string, text: string | undefined): void;
}
interface Ctx {
	ui: UI;
}
type Engine = Pick<Spotify, "play" | "toggle" | "pause" | "next" | "prev" | "nowPlaying" | "check">;
type Timer = { unref?: () => void } | number | undefined;
interface Reply {
	message: string;
	level: Level;
}

export interface ExtensionOptions {
	configDir?: string;
	spotify?: Engine;
	/** Defaults to process.platform; picks the clipboard commands for /sp setup. */
	platform?: string;
	/** Defaults to process.env; only WAYLAND_DISPLAY is read (Linux clipboard). */
	env?: Record<string, string | undefined>;
	setInterval?: (fn: () => void, ms: number) => Timer;
	clearInterval?: (timer: Timer) => void;
}

const USAGE = `/sp — Spotify:
  /sp <song or artist>       play the best match (--artist <name> filters; spotify:track: URIs and open.spotify.com links work)
  /sp                        play/pause
  /sp play                   resume        /sp play <text>   always search <text>, even "next"
  /sp pause  /sp next  /sp prev  /sp np    controls and what is playing now
  /sp setup [id|secret]      paste a credential from the clipboard (never shown, clipboard cleared)
  /sp check                  verify credentials without playing anything
  /sp sidebar on|off         show or hide the now-playing row in the sidebar
The whole argument must match one of these forms exactly; anything else is a song search.`;

/** Fixed forms, matched against the whole (case-insensitive, space-normalized) argument. */
const FIXED: Record<string, SpAction> = {
	"": { kind: "toggle" },
	play: { kind: "resume" },
	pause: { kind: "pause" },
	next: { kind: "next" },
	prev: { kind: "prev" },
	np: { kind: "np" },
	check: { kind: "check" },
	help: { kind: "help" },
	setup: { kind: "setup", field: undefined },
	"setup id": { kind: "setup", field: "clientId" },
	"setup secret": { kind: "setup", field: "clientSecret" },
	"sidebar on": { kind: "sidebar", on: true },
	"sidebar off": { kind: "sidebar", on: false },
};

const COMPLETIONS = Object.keys(FIXED).filter(Boolean);

export type SpAction =
	| { kind: "toggle" | "resume" | "pause" | "next" | "prev" | "np" | "check" | "help" }
	| { kind: "setup"; field: CredentialField | undefined }
	| { kind: "sidebar"; on: boolean }
	| { kind: "search"; query: string; artist: string | undefined };

/** Deterministic: a fixed form only when the whole argument matches it; otherwise a song search. */
export function parseSp(args: string): SpAction {
	const text = args.trim();
	const fixed = FIXED[text.toLowerCase().replace(/\s+/g, " ")];
	if (fixed) return fixed;
	const forced = /^play\s+([\s\S]+)$/i.exec(text);
	const { query, artist } = parsePlayArgs(forced ? forced[1] : text);
	return { kind: "search", query, artist };
}

export function defaultConfigDir(): string {
	return process.env.SPOTIFY_CLI_DIR || join(homedir(), ".config", "spotify-cli");
}

/** Text for the sidebar row; undefined hides it. */
export function sidebarText(np: NowPlaying): string | undefined {
	if (np.state === "playing") return `♪ ${np.name} — ${np.artist}`;
	if (np.state === "paused") return `⏸ ${np.name} — ${np.artist}`;
	return undefined;
}

function readSidebarSetting(dir: string): boolean {
	try {
		return JSON.parse(readFileSync(join(dir, SETTINGS_FILE), "utf8")).sidebar !== false;
	} catch {
		return true; // missing or corrupt settings: default on
	}
}

function writeSidebarSetting(dir: string, on: boolean): void {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = join(dir, SETTINGS_FILE);
	writeFileSync(file, `${JSON.stringify({ sidebar: on })}\n`, { mode: 0o600 });
	chmodSync(file, 0o600);
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createExtension(options: ExtensionOptions = {}) {
	return function gentleSpotify(pi: ExtensionAPI): void {
		const configDir = options.configDir ?? defaultConfigDir();
		const exec = (command: string, args: string[], timeout = 10_000) =>
			pi.exec(command, args, { timeout }).then((r) => ({ code: r.code, stdout: r.stdout, stderr: r.stderr }));
		const spotify: Engine =
			options.spotify ?? createSpotify({ configDir, fetch: globalThis.fetch, run: (c, a) => exec(c, a) });
		const startTimer = options.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms) as Timer);
		const stopTimer = options.clearInterval ?? ((t: Timer) => clearInterval(t as ReturnType<typeof setInterval>));

		let ui: UI | undefined;
		let enabled = readSidebarSetting(configDir);
		let timer: Timer;
		let polling = false;

		async function refresh(): Promise<void> {
			if (!enabled || !ui || polling) return;
			polling = true;
			try {
				ui.setStatus(STATUS_KEY, sidebarText(await spotify.nowPlaying()));
			} catch {
				ui.setStatus(STATUS_KEY, undefined); // stay quiet: a poll must never spam notifications
			} finally {
				polling = false;
			}
		}

		function startPolling(): void {
			if (timer === undefined) {
				timer = startTimer(() => void refresh(), POLL_MS);
				if (timer && typeof timer === "object") timer.unref?.();
			}
		}

		function stopPolling(): void {
			if (timer !== undefined) stopTimer(timer);
			timer = undefined;
			ui?.setStatus(STATUS_KEY, undefined);
		}

		/** Wraps a command: reports its result or error, then refreshes the row. */
		function command(run: (args: string, ctx: Ctx) => Promise<string | Reply>) {
			return async (args: string, ctx: Ctx): Promise<void> => {
				ui = ctx.ui;
				try {
					const reply = await run(args ?? "", ctx);
					if (typeof reply === "string") ctx.ui.notify(reply, "info");
					else ctx.ui.notify(reply.message, reply.level);
				} catch (error) {
					ctx.ui.notify(message(error), "error");
				}
				await refresh();
			};
		}

		async function setup(field: CredentialField | undefined): Promise<Reply> {
			const clipDeps = {
				exec: (c: string, a: string[]) => exec(c, a, 5_000),
				platform: options.platform ?? process.platform,
				env: options.env ?? process.env,
			};
			const clip = await readClipboard(clipDeps); // platform-specific commands, no shell
			const written = saveCredential(configDir, clip.text, field); // validates before writing
			const cleared = await clearClipboard(clipDeps, clip.tool); // same tool that read it

			const length = clip.text.trim().length;
			const label = written === "clientId" ? "Client ID" : "Client secret";
			const nextStep =
				written === "clientId"
					? "Now copy the Client secret and run /sp setup again."
					: "Run /sp check to verify.";
			return cleared
				? { message: `Saved the ${label} (${length} characters) and cleared the clipboard. ${nextStep}`, level: "info" }
				: {
						message: `Saved the ${label} (${length} characters), but could not clear the clipboard: clear it yourself. ${nextStep}`,
						level: "warning",
					};
		}

		function sidebar(on: boolean): string {
			enabled = on;
			writeSidebarSetting(configDir, enabled);
			if (enabled) {
				startPolling();
				return "Sidebar row on: now playing shows under INTEGRATIONS.";
			}
			stopPolling();
			return "Sidebar row off.";
		}

		pi.on("session_start", async (_event, ctx) => {
			ui = (ctx as Ctx).ui;
			enabled = readSidebarSetting(configDir);
			if (enabled) {
				startPolling();
				await refresh();
			}
		});

		pi.on("session_shutdown", async () => {
			stopPolling();
		});

		pi.registerCommand("sp", {
			description: "Spotify: /sp <song>, /sp (play/pause), next, prev, np, setup, check, sidebar on|off, help",
			getArgumentCompletions: (prefix: string) => {
				const typed = prefix.trimStart().toLowerCase();
				const items = COMPLETIONS.filter((c) => c.startsWith(typed)).map((c) => ({ value: c, label: c }));
				return items.length > 0 ? items : null;
			},
			handler: command(async (args) => {
				const action = parseSp(args);
				switch (action.kind) {
					case "toggle":
						return spotify.toggle();
					case "resume":
						return spotify.play("");
					case "search":
						return spotify.play(action.query, { artist: action.artist });
					case "pause":
						return spotify.pause();
					case "next":
						return spotify.next();
					case "prev":
						return spotify.prev();
					case "np":
						return formatNowPlaying(await spotify.nowPlaying());
					case "check":
						return spotify.check();
					case "help":
						return USAGE;
					case "setup":
						return setup(action.field);
					case "sidebar":
						return sidebar(action.on);
				}
			}),
		});
	};
}

export default createExtension();
