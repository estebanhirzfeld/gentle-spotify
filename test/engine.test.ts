import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSpotify,
	credentialStatus,
	saveCredential,
	type Runner,
	type SpotifyDeps,
} from "../src/spotify.ts";

const SEARCH = {
	tracks: {
		items: [
			{
				uri: "spotify:track:WITHOUT_ME",
				name: "Without Me",
				artists: [{ name: "Eminem" }],
				album: { name: "The Eminem Show", release_date: "2002-05-26" },
			},
			{
				uri: "spotify:track:MY_NAME_IS",
				name: "My Name Is",
				artists: [{ name: "Eminem" }],
				album: { name: "The Slim Shady LP", release_date: "1999-02-23" },
			},
		],
	},
};

interface Harness {
	deps: SpotifyDeps;
	dir: string;
	fetches: string[];
	scripts: string[];
	setState(s: string): void;
	setClock(ms: number): void;
}

function harness(opts: { creds?: boolean; tokenStatus?: number; state?: string; osaFail?: boolean } = {}): Harness {
	const dir = mkdtempSync(join(tmpdir(), "gentle-spotify-"));
	if (opts.creds !== false) {
		writeFileSync(join(dir, "credentials"), "# comment\nSPOTIFY_CLIENT_ID=id1234567890\nSPOTIFY_CLIENT_SECRET=secret1234567890\n");
	}
	const fetches: string[] = [];
	const scripts: string[] = [];
	let state = opts.state ?? "playing\tMy Name Is\tEminem";
	let clock = 1_000_000_000_000;

	const fakeFetch = (async (url: string | URL) => {
		const u = String(url);
		fetches.push(u);
		if (u.includes("/token")) {
			if (opts.tokenStatus && opts.tokenStatus !== 200) {
				return new Response('{"error":"invalid_client"}', { status: opts.tokenStatus });
			}
			return Response.json({ access_token: "TOKEN", expires_in: 3600 });
		}
		if (u.includes("/v1/search")) return Response.json(SEARCH);
		return new Response("not found", { status: 404 });
	}) as typeof fetch;

	const run: Runner = async (cmd, args) => {
		assert.equal(cmd, "osascript");
		const script = args.filter((_, i) => i % 2 === 1).join("\n");
		scripts.push(script);
		if (opts.osaFail) return { code: 1, stdout: "", stderr: "execution error (-1728)" };
		if (script.includes("player state")) return { code: 0, stdout: `${state}\n`, stderr: "" };
		if (script.includes("is running") && state === "closed") return { code: 0, stdout: "closed\n", stderr: "" };
		return { code: 0, stdout: "ok\n", stderr: "" };
	};

	return {
		dir,
		fetches,
		scripts,
		setState: (s) => (state = s),
		setClock: (ms) => (clock = ms),
		deps: {
			configDir: dir,
			fetch: fakeFetch,
			run,
			now: () => clock,
			sleep: async () => {},
			apiBase: "https://api.test",
			tokenUrl: "https://accounts.test/api/token",
		},
	};
}

const playScripts = (h: Harness) => h.scripts.filter((s) => s.includes("play track"));

test("S2: play 'My name is Eminem' plays My Name Is and says so", async () => {
	const h = harness();
	const msg = await createSpotify(h.deps).play("My name is Eminem");
	assert.equal(playScripts(h).length, 1);
	assert.match(playScripts(h)[0], /play track "spotify:track:MY_NAME_IS"/);
	assert.equal(msg, "▶ My Name Is — Eminem (The Slim Shady LP, 1999)");
});

test("S2: play with no query resumes and reports the state", async () => {
	const h = harness();
	const msg = await createSpotify(h.deps).play("");
	assert.equal(h.fetches.length, 0, "resume needs no network");
	assert.ok(h.scripts.some((s) => /to play$/m.test(s)), "sends play");
	assert.equal(msg, "▶ My Name Is — Eminem");
});

test("S2: pause, next and prev report the resulting state", async () => {
	const h = harness({ state: "paused\tMy Name Is\tEminem" });
	const sp = createSpotify(h.deps);
	assert.equal(await sp.pause(), "⏸ My Name Is — Eminem");
	assert.ok(h.scripts.some((s) => s.includes("to pause")));
	h.setState("playing\tWithout Me\tEminem");
	assert.equal(await sp.next(), "▶ Without Me — Eminem");
	assert.ok(h.scripts.some((s) => s.includes("to next track")));
	assert.equal(await sp.prev(), "▶ Without Me — Eminem");
	assert.ok(h.scripts.some((s) => s.includes("to previous track")));
});

test("S3: controls never launch a closed Spotify", async () => {
	const h = harness({ state: "closed" });
	const sp = createSpotify(h.deps);
	for (const action of [sp.pause, sp.next, sp.prev]) {
		assert.equal(await action(), "Spotify is not running");
	}
	for (const s of h.scripts) {
		assert.match(s, /^if application "Spotify" is running then/, "every control is guarded");
	}
});

test("S3: nowPlaying reports closed without launching Spotify", async () => {
	const h = harness({ state: "closed" });
	assert.deepEqual(await createSpotify(h.deps).nowPlaying(), { state: "closed" });
	assert.match(h.scripts[0], /^if application "Spotify" is running then/);
});

test("nowPlaying parses playing, paused and stopped", async () => {
	const h = harness();
	const sp = createSpotify(h.deps);
	assert.deepEqual(await sp.nowPlaying(), { state: "playing", name: "My Name Is", artist: "Eminem" });
	h.setState("paused\tX\tY");
	assert.deepEqual(await sp.nowPlaying(), { state: "paused", name: "X", artist: "Y" });
	h.setState("stopped");
	assert.deepEqual(await sp.nowPlaying(), { state: "stopped" });
});

test("an explicit URI or link plays without searching", async () => {
	const h = harness();
	await createSpotify(h.deps).play("https://open.spotify.com/track/75IN3CtuZwTHTnZvYM4qnJ?si=x");
	assert.equal(h.fetches.length, 0);
	assert.match(playScripts(h)[0], /play track "spotify:track:75IN3CtuZwTHTnZvYM4qnJ"/);
});

test("--artist with no match fails and plays nothing", async () => {
	const h = harness();
	await assert.rejects(createSpotify(h.deps).play("my name is", { artist: "Nirvana" }), /No track found for "my name is" by "Nirvana"/);
	assert.equal(playScripts(h).length, 0);
});

test("S6: missing credentials fail with the setup hint and play nothing", async () => {
	const h = harness({ creds: false });
	await assert.rejects(createSpotify(h.deps).play("anything"), /\/sp setup/);
	assert.equal(h.fetches.length, 0);
	assert.equal(h.scripts.length, 0);
});

test("S6: rejected credentials fail clearly and play nothing", async () => {
	const h = harness({ tokenStatus: 401 });
	await assert.rejects(createSpotify(h.deps).play("anything"), /rejected the credentials/);
	await assert.rejects(createSpotify(h.deps).play("anything"), /Check them with \/sp setup/);
	assert.equal(h.scripts.length, 0);
	await assert.rejects(createSpotify(h.deps).check(), /rejected the credentials/);
});

test("S6: check validates credentials with a real search and plays nothing", async () => {
	const h = harness();
	const msg = await createSpotify(h.deps).check();
	assert.match(msg, /^Credentials OK/);
	assert.equal(h.scripts.length, 0);
});

test("token is cached (mode 600) and reused until it expires", async () => {
	const h = harness();
	const sp = createSpotify(h.deps);
	await sp.check();
	await sp.check();
	assert.equal(h.fetches.filter((u) => u.includes("/token")).length, 1);
	assert.equal(statSync(join(h.dir, "token")).mode & 0o777, 0o600);
	h.setClock(1_000_000_000_000 + 3600 * 1000);
	await sp.check();
	assert.equal(h.fetches.filter((u) => u.includes("/token")).length, 2);
});

test("token cache stays compatible with the bash play script format", async () => {
	const h = harness();
	await createSpotify(h.deps).check();
	const cached = JSON.parse(readFileSync(join(h.dir, "token"), "utf8"));
	assert.equal(cached.access_token, "TOKEN");
	assert.equal(typeof cached.expires_at, "number");
	assert.ok(cached.expires_at < 2_000_000_000, "expires_at is in epoch seconds");
});

test("a failing osascript surfaces as an error, never as success", async () => {
	const h = harness({ osaFail: true });
	await assert.rejects(createSpotify(h.deps).pause(), /osascript failed/);
	await assert.rejects(createSpotify(h.deps).play("My name is Eminem"), /osascript failed/);
});

test("S6: saveCredential fills id then secret, keeps comments, mode 600", () => {
	const dir = mkdtempSync(join(tmpdir(), "gentle-spotify-"));
	assert.deepEqual(credentialStatus(dir), { clientId: 0, clientSecret: 0 });
	assert.equal(saveCredential(dir, "abcdefghij1234567890"), "clientId");
	assert.equal(saveCredential(dir, "SECRETSECRET12345678"), "clientSecret");
	assert.deepEqual(credentialStatus(dir), { clientId: 20, clientSecret: 20 });
	const file = join(dir, "credentials");
	assert.equal(statSync(file).mode & 0o777, 0o600);
	writeFileSync(file, `# keep me\n${readFileSync(file, "utf8")}`);
	assert.equal(saveCredential(dir, "NEWSECRET12345678901", "clientSecret"), "clientSecret");
	const text = readFileSync(file, "utf8");
	assert.match(text, /^# keep me$/m);
	assert.match(text, /^SPOTIFY_CLIENT_SECRET=NEWSECRET12345678901$/m);
	assert.equal(text.match(/^SPOTIFY_CLIENT_SECRET=/gm)?.length, 1);
});

test("S6: saveCredential rejects values that are not credentials and writes nothing", () => {
	const dir = mkdtempSync(join(tmpdir(), "gentle-spotify-"));
	assert.throws(() => saveCredential(dir, ""), /clipboard is empty/);
	assert.throws(() => saveCredential(dir, "short"), /does not look like/);
	assert.throws(() => saveCredential(dir, "has space 1234567890"), /does not look like/);
	assert.throws(() => saveCredential(dir, "x".repeat(300)), /does not look like/);
	assert.deepEqual(credentialStatus(dir), { clientId: 0, clientSecret: 0 });
});

test("item 2: an existing open config dir is tightened to 700 and a stale temp file never leaks", () => {
	const dir = join(mkdtempSync(join(tmpdir(), "gentle-spotify-")), "cfg");
	mkdirSync(dir, { mode: 0o755 });
	chmodSync(dir, 0o755);
	writeFileSync(join(dir, "credentials.tmp"), "stale\n", { mode: 0o644 });
	chmodSync(join(dir, "credentials.tmp"), 0o644);
	saveCredential(dir, "abcdefghij1234567890");
	assert.equal(statSync(dir).mode & 0o777, 0o700);
	assert.equal(statSync(join(dir, "credentials")).mode & 0o777, 0o600);
	assert.equal(existsSync(join(dir, "credentials.tmp")), false);
});

test("item 2: the token cache also tightens an existing open config dir", async () => {
	const h = harness();
	chmodSync(h.dir, 0o755);
	await createSpotify(h.deps).check();
	assert.equal(statSync(h.dir).mode & 0o777, 0o700);
});

test("S1: toggle sends playpause and reports the resulting state", async () => {
	const h = harness({ state: "paused\tMy Name Is\tEminem" });
	assert.equal(await createSpotify(h.deps).toggle(), "⏸ My Name Is — Eminem");
	assert.ok(h.scripts.some((s) => /to playpause$/m.test(s)));
});
