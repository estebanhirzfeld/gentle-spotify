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
type Engine = Pick<Spotify, "play" | "pause" | "next" | "prev" | "nowPlaying" | "check">;
type Timer = { unref?: () => void } | number | undefined;
interface Reply {
	message: string;
	level: Level;
}

export interface ExtensionOptions {
	configDir?: string;
	spotify?: Engine;
	setInterval?: (fn: () => void, ms: number) => Timer;
	clearInterval?: (timer: Timer) => void;
}

const USAGE = `Spotify commands:
  /play <song or artist>       play the best match (--artist <name> filters; spotify:track: URIs and open.spotify.com links work)
  /play                        resume
  /pause  /next  /prev         playback controls
  /np                          what is playing now
  /spotify setup [id|secret]   paste a credential from the clipboard (never shown, clipboard cleared)
  /spotify check               verify credentials without playing anything
  /spotify sidebar on|off      show or hide the now-playing row in the sidebar`;

const COMPLETIONS = ["setup", "setup id", "setup secret", "check", "sidebar on", "sidebar off", "help"];

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

		async function setup(arg: string): Promise<Reply> {
			let field: CredentialField | undefined;
			if (arg === "id") field = "clientId";
			else if (arg === "secret") field = "clientSecret";
			else if (arg) throw new Error(`Unknown field "${arg}": use /spotify setup id or /spotify setup secret.`);

			const clip = await exec("pbpaste", [], 5_000);
			if (clip.code !== 0) throw new Error(`Could not read the clipboard: ${clip.stderr.trim()}`);
			const written = saveCredential(configDir, clip.stdout, field); // validates before writing
			const cleared = (await exec("osascript", ["-e", 'set the clipboard to ""'], 5_000)).code === 0;

			const length = clip.stdout.trim().length;
			const label = written === "clientId" ? "Client ID" : "Client secret";
			const nextStep =
				written === "clientId"
					? "Now copy the Client secret and run /spotify setup again."
					: "Run /spotify check to verify.";
			return cleared
				? { message: `Saved the ${label} (${length} characters) and cleared the clipboard. ${nextStep}`, level: "info" }
				: {
						message: `Saved the ${label} (${length} characters), but could not clear the clipboard: clear it yourself. ${nextStep}`,
						level: "warning",
					};
		}

		async function sidebar(arg: string): Promise<string> {
			if (arg !== "on" && arg !== "off") throw new Error(`Use /spotify sidebar on or /spotify sidebar off.\n\n${USAGE}`);
			enabled = arg === "on";
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

		pi.registerCommand("play", {
			description: "Spotify: play a song (/play <song or artist>), or resume with no argument",
			handler: command(async (args) => {
				const { query, artist } = parsePlayArgs(args);
				return spotify.play(query, { artist });
			}),
		});
		pi.registerCommand("pause", { description: "Spotify: pause", handler: command(() => spotify.pause()) });
		pi.registerCommand("next", { description: "Spotify: next track", handler: command(() => spotify.next()) });
		pi.registerCommand("prev", { description: "Spotify: previous track", handler: command(() => spotify.prev()) });
		pi.registerCommand("np", {
			description: "Spotify: what is playing now",
			handler: command(async () => formatNowPlaying(await spotify.nowPlaying())),
		});

		pi.registerCommand("spotify", {
			description: "Spotify: setup, check, sidebar on|off, help",
			getArgumentCompletions: (prefix: string) => {
				const items = COMPLETIONS.filter((c) => c.startsWith(prefix.trimStart())).map((c) => ({ value: c, label: c }));
				return items.length > 0 ? items : null;
			},
			handler: command(async (args) => {
				const [sub = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
				const arg = rest.join(" ");
				switch (sub) {
					case "":
					case "help":
						return USAGE;
					case "setup":
						return setup(arg);
					case "check":
						return spotify.check();
					case "sidebar":
						return sidebar(arg);
					default:
						throw new Error(`Unknown subcommand "${sub}".\n\n${USAGE}`);
				}
			}),
		});
	};
}

export default createExtension();
