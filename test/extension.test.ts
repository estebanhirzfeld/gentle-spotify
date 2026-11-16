import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtension, parseSp } from "../src/extension.ts";
import { SpotifyError, type NowPlaying } from "../src/spotify.ts";

type Level = "info" | "warning" | "error" | undefined;

function setup(opts: { clipboard?: string; sidebar?: boolean; clearFails?: boolean } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "gentle-spotify-ext-"));
	if (opts.sidebar === false) writeFileSync(join(dir, "gentle-spotify.json"), '{"sidebar":false}\n');

	let clipboard = opts.clipboard ?? "";
	const commands = new Map<string, any>();
	const handlers = new Map<string, Array<(e: unknown, ctx: unknown) => unknown>>();
	const execs: Array<[string, string[]]> = [];
	const pi = {
		registerCommand: (name: string, options: unknown) => commands.set(name, options),
		on: (event: string, h: (e: unknown, ctx: unknown) => unknown) =>
			handlers.set(event, [...(handlers.get(event) ?? []), h]),
		exec: async (cmd: string, args: string[]) => {
			execs.push([cmd, args]);
			if (cmd === "pbpaste") return { stdout: clipboard, stderr: "", code: 0, killed: false };
			if (cmd === "osascript" && args.join(" ").includes("set the clipboard")) {
				if (opts.clearFails) return { stdout: "", stderr: "not allowed", code: 1, killed: false };
				clipboard = "";
			}
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
	};

	const notes: Array<[string, Level]> = [];
	const statuses: Array<[string, string | undefined]> = [];
	const ctx = {
		ui: {
			notify: (m: string, l?: Level) => notes.push([m, l]),
			setStatus: (k: string, t: string | undefined) => statuses.push([k, t]),
		},
	};

	const calls: string[] = [];
	let state: NowPlaying = { state: "playing", name: "My Name Is", artist: "Eminem" };
	let failWith: Error | undefined;
	let pending: Promise<NowPlaying> | undefined;
	const act = async (name: string, result: string) => {
		calls.push(name);
		if (failWith) throw failWith;
		return result;
	};
	const engine = {
		play: (q: string, o: { artist?: string } = {}) => act(`play:${q}|${o.artist ?? ""}`, `▶ played ${q}`),
		pause: () => act("pause", "⏸ My Name Is — Eminem"),
		toggle: () => act("toggle", "⏸ My Name Is — Eminem"),
		next: () => act("next", "▶ Without Me — Eminem"),
		prev: () => act("prev", "▶ Superman — Eminem"),
		check: () => act("check", "Credentials OK — search works"),
		nowPlaying: async () => {
			calls.push("nowPlaying");
			if (pending) return pending;
			return state;
		},
	};

	const timers: Array<{ fn: () => void; cleared: boolean; unrefed: boolean }> = [];
	const ext = createExtension({
		configDir: dir,
		spotify: engine,
		setInterval: (fn: () => void) => {
			const t = { fn, cleared: false, unrefed: false, unref() { this.unrefed = true; } };
			timers.push(t);
			return t;
		},
		clearInterval: (t: unknown) => {
			(t as { cleared: boolean }).cleared = true;
		},
	});
	ext(pi as never);

	const flush = () => new Promise((r) => setImmediate(r));
	return {
		dir,
		ctx,
		notes,
		statuses,
		execs,
		calls,
		timers,
		get clipboard() {
			return clipboard;
		},
		setState: (s: NowPlaying) => (state = s),
		fail: (e: Error | undefined) => (failWith = e),
		hold: (p: Promise<NowPlaying> | undefined) => (pending = p),
		run: async (name: string, args = "") => {
			await commands.get(name).handler(args, ctx);
			await flush();
		},
		emit: async (event: string) => {
			for (const h of handlers.get(event) ?? []) await h({}, ctx);
			await flush();
		},
		tick: async () => {
			for (const t of timers) if (!t.cleared) t.fn();
			await flush();
		},
		commands,
		lastStatus: () => statuses.filter(([k]) => k === "spotify").at(-1)?.[1],
	};
}

test("S1: one command only: /sp, with a description", () => {
	const h = setup();
	assert.deepEqual([...h.commands.keys()], ["sp"]);
	assert.ok(h.commands.get("sp").description);
});

test("S1/S2: /sp <song> passes the whole query and --artist, and reports the result", async () => {
	const h = setup();
	await h.run("sp", "My name is Eminem");
	await h.run("sp", "--artist Eminem my name is");
	assert.deepEqual(h.calls.filter((c) => c.startsWith("play:")), ["play:My name is Eminem|", "play:my name is|Eminem"]);
	assert.deepEqual(h.notes[0], ["▶ played My name is Eminem", "info"]);
});

test("S2: /sp play resumes", async () => {
	const h = setup();
	await h.run("sp", "play");
	assert.equal(h.calls[0], "play:|");
});

test("S2: pause, next, prev and np report the resulting state", async () => {
	const h = setup();
	await h.run("sp", "pause");
	await h.run("sp", "next");
	await h.run("sp", "prev");
	h.setState({ state: "paused", name: "Stan", artist: "Eminem" });
	await h.run("sp", "np");
	assert.deepEqual(
		h.notes.map(([m]) => m),
		["⏸ My Name Is — Eminem", "▶ Without Me — Eminem", "▶ Superman — Eminem", "⏸ Stan — Eminem"],
	);
	assert.ok(h.notes.every(([, l]) => l === "info"));
});

test("an engine error is reported as an error and never thrown", async () => {
	const h = setup();
	h.fail(new SpotifyError("Missing Spotify credentials. Run /sp setup to add them."));
	await h.run("sp", "anything");
	await h.run("sp", "pause");
	assert.deepEqual(h.notes.map(([, l]) => l), ["error", "error"]);
	assert.match(h.notes[0][0], /\/sp setup/);
});

test("S6: /sp check reports through notify", async () => {
	const h = setup();
	await h.run("sp", "check");
	assert.deepEqual(h.notes.at(-1), ["Credentials OK — search works", "info"]);
});

test("S6: /sp setup stores the clipboard, never echoes it, clears the clipboard", async () => {
	const id = "CLIENTID1234567890ab";
	const h = setup({ clipboard: id });
	await h.run("sp", "setup");
	assert.match(readFileSync(join(h.dir, "credentials"), "utf8"), new RegExp(`^SPOTIFY_CLIENT_ID=${id}$`, "m"));
	assert.equal(h.clipboard, "", "clipboard cleared");
	const [message, level] = h.notes.at(-1)!;
	assert.equal(level, "info");
	assert.ok(!message.includes(id), "value never shown");
	assert.match(message, /20 characters/);
	assert.match(message, /Client secret/);
});

test("S6: /sp setup secret targets the secret explicitly", async () => {
	const secret = "SECRET1234567890abcd";
	const h = setup({ clipboard: secret });
	await h.run("sp", "setup secret");
	const text = readFileSync(join(h.dir, "credentials"), "utf8");
	assert.match(text, new RegExp(`^SPOTIFY_CLIENT_SECRET=${secret}$`, "m"));
	assert.match(text, /^SPOTIFY_CLIENT_ID=$/m);
	assert.ok(!h.notes.at(-1)![0].includes(secret));
	assert.match(h.notes.at(-1)![0], /\/sp check/);
});

test("S6: an empty clipboard is an error: nothing written, clipboard not touched", async () => {
	const h = setup({ clipboard: "" });
	await h.run("sp", "setup");
	assert.equal(h.notes.at(-1)![1], "error");
	assert.match(h.notes.at(-1)![0], /clipboard is empty/);
	assert.equal(existsSync(join(h.dir, "credentials")), false);
	assert.ok(!h.execs.some(([c, a]) => c === "osascript" && a.join(" ").includes("clipboard")), "did not clear");
});

test("S1: anything that is not a fixed form is a song search", async () => {
	const h = setup();
	await h.run("sp", "bogus");
	await h.run("sp", "sidebar blues");
	await h.run("sp", "setup something");
	assert.deepEqual(h.calls.filter((c) => c.startsWith("play:")), ["play:bogus|", "play:sidebar blues|", "play:setup something|"]);
});

test("S1: bare /sp toggles play/pause", async () => {
	const h = setup();
	await h.run("sp", "");
	assert.equal(h.calls[0], "toggle");
	assert.deepEqual(h.notes[0], ["⏸ My Name Is — Eminem", "info"]);
});

test("S1: /sp play <x> always searches, even a keyword", async () => {
	const h = setup();
	await h.run("sp", "play next");
	await h.run("sp", "next");
	assert.deepEqual(h.calls.filter((c) => c !== "nowPlaying"), ["play:next|", "next"]);
});

test("/sp help lists every form", async () => {
	const h = setup();
	await h.run("sp", "help");
	const [usage, level] = h.notes.at(-1)!;
	assert.equal(level, "info");
	for (const c of ["/sp <song", "/sp play", "/sp pause", "/sp next", "/sp prev", "/sp np", "/sp setup", "/sp check", "/sp sidebar on|off"]) {
		assert.ok(usage.includes(c), `usage mentions ${c}`);
	}
});

test("/sp completes its fixed forms", () => {
	const h = setup();
	const complete = h.commands.get("sp").getArgumentCompletions;
	assert.deepEqual(complete("side").map((i: { value: string }) => i.value), ["sidebar on", "sidebar off"]);
	assert.equal(complete("zzz"), null);
	assert.ok(complete("").map((i: { value: string }) => i.value).includes("next"));
});

test("S3: session_start shows the now-playing row and polls (unref'd timer)", async () => {
	const h = setup();
	await h.emit("session_start");
	assert.equal(h.lastStatus(), "♪ My Name Is — Eminem");
	assert.equal(h.timers.length, 1);
	assert.ok(h.timers[0].unrefed);
	h.setState({ state: "paused", name: "Stan", artist: "Eminem" });
	await h.tick();
	assert.equal(h.lastStatus(), "⏸ Stan — Eminem");
	h.setState({ state: "closed" });
	await h.tick();
	assert.equal(h.lastStatus(), undefined);
	h.setState({ state: "stopped" });
	await h.tick();
	assert.equal(h.lastStatus(), undefined);
});

test("S3: a playback command refreshes the row right away", async () => {
	const h = setup();
	await h.emit("session_start");
	h.setState({ state: "playing", name: "Without Me", artist: "Eminem" });
	await h.run("sp", "next");
	assert.equal(h.lastStatus(), "♪ Without Me — Eminem");
});

test("S3: polls never overlap", async () => {
	const h = setup();
	await h.emit("session_start");
	const before = h.calls.filter((c) => c === "nowPlaying").length;
	let release!: (np: NowPlaying) => void;
	h.hold(new Promise((r) => (release = r)));
	await h.tick();
	await h.tick();
	await h.tick();
	assert.equal(h.calls.filter((c) => c === "nowPlaying").length, before + 1);
	h.hold(undefined);
	release({ state: "playing", name: "Stan", artist: "Eminem" });
	await new Promise((r) => setImmediate(r));
	await h.tick();
	assert.equal(h.calls.filter((c) => c === "nowPlaying").length, before + 2);
});

test("S3: a poll error clears the row silently", async () => {
	const h = setup();
	await h.emit("session_start");
	h.hold(Promise.reject(new Error("osascript failed")));
	await h.tick();
	assert.equal(h.lastStatus(), undefined);
	assert.equal(h.notes.length, 0, "no notify spam");
	h.hold(undefined);
});

test("S3: /sp sidebar off clears the row, persists, and stops polling", async () => {
	const h = setup();
	await h.emit("session_start");
	await h.run("sp", "sidebar off");
	assert.equal(h.lastStatus(), undefined);
	assert.ok(h.timers[0].cleared);
	assert.deepEqual(JSON.parse(readFileSync(join(h.dir, "gentle-spotify.json"), "utf8")), { sidebar: false });
	const polls = h.calls.filter((c) => c === "nowPlaying").length;
	await h.tick();
	await h.run("sp", "next");
	assert.equal(h.calls.filter((c) => c === "nowPlaying").length, polls, "no polling while off");
	assert.equal(h.lastStatus(), undefined);
});

test("S3: the off setting survives a new session", async () => {
	const h = setup({ sidebar: false });
	await h.emit("session_start");
	assert.equal(h.timers.length, 0);
	assert.equal(h.lastStatus(), undefined);
});

test("S3: /sp sidebar on persists and shows the row", async () => {
	const h = setup({ sidebar: false });
	await h.emit("session_start");
	await h.run("sp", "sidebar on");
	assert.equal(h.lastStatus(), "♪ My Name Is — Eminem");
	assert.equal(h.timers.length, 1);
	assert.deepEqual(JSON.parse(readFileSync(join(h.dir, "gentle-spotify.json"), "utf8")), { sidebar: true });
});

test("a corrupt settings file means the sidebar stays on", async () => {
	const h = setup();
	writeFileSync(join(h.dir, "gentle-spotify.json"), "{not json");
	await h.emit("session_start");
	assert.equal(h.lastStatus(), "♪ My Name Is — Eminem");
});

test("S3: session_shutdown stops the timer and clears the row", async () => {
	const h = setup();
	await h.emit("session_start");
	await h.emit("session_shutdown");
	assert.ok(h.timers[0].cleared);
	assert.equal(h.lastStatus(), undefined);
});

test("item 4: a rejected value never reaches osascript or any message", async () => {
	for (const bad of ["short", "has space 1234567890"]) {
		const h = setup({ clipboard: bad });
		await h.run("sp", "setup");
		assert.equal(h.notes.at(-1)![1], "error");
		assert.ok(!h.notes.some(([m]) => m.includes(bad)), "value not shown");
		assert.ok(!h.execs.some(([c]) => c === "osascript"), "no osascript call");
		assert.equal(h.clipboard, bad, "clipboard untouched");
	}
});

test("N3: when the clipboard cannot be cleared, setup says so instead of claiming it", async () => {
	const h = setup({ clipboard: "CLIENTID1234567890ab", clearFails: true });
	await h.run("sp", "setup");
	const [message, level] = h.notes.at(-1)!;
	assert.equal(level, "warning");
	assert.match(message, /could not clear the clipboard/i);
	assert.ok(!/and cleared the clipboard/.test(message));
	assert.ok(!message.includes("CLIENTID1234567890ab"));
});

test("N4: the settings file is private (600)", async () => {
	const h = setup();
	await h.run("sp", "sidebar off");
	assert.equal(statSync(join(h.dir, "gentle-spotify.json")).mode & 0o777, 0o600);
});

test("S1: parseSp maps the whole argument deterministically", () => {
	assert.deepEqual(parseSp(""), { kind: "toggle" });
	assert.deepEqual(parseSp("   "), { kind: "toggle" });
	assert.deepEqual(parseSp("play"), { kind: "resume" });
	for (const k of ["pause", "next", "prev", "np", "check", "help"] as const) assert.deepEqual(parseSp(k), { kind: k });
	assert.deepEqual(parseSp("NEXT"), { kind: "next" });
	assert.deepEqual(parseSp("setup"), { kind: "setup", field: undefined });
	assert.deepEqual(parseSp("setup  ID"), { kind: "setup", field: "clientId" });
	assert.deepEqual(parseSp("setup secret"), { kind: "setup", field: "clientSecret" });
	assert.deepEqual(parseSp("sidebar on"), { kind: "sidebar", on: true });
	assert.deepEqual(parseSp("Sidebar OFF"), { kind: "sidebar", on: false });
	assert.deepEqual(parseSp("play next"), { kind: "search", query: "next", artist: undefined });
	assert.deepEqual(parseSp("next episode"), { kind: "search", query: "next episode", artist: undefined });
	assert.deepEqual(parseSp("--artist Eminem my name is"), { kind: "search", query: "my name is", artist: "Eminem" });
	assert.deepEqual(parseSp("play --artist Eminem stan"), { kind: "search", query: "stan", artist: "Eminem" });
});
