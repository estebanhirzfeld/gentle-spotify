import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpotify, type NowPlaying, type Runner, type SpotifyDeps } from "../src/spotify.ts";

// ---------------------------------------------------------------- fixtures

const SEARCH = {
	tracks: {
		items: [
			{
				uri: "spotify:track:MY_NAME_IS",
				name: "My Name Is",
				artists: [{ name: "Eminem" }],
				album: { name: "The Slim Shady LP", release_date: "1999-02-23" },
			},
		],
	},
};

const STATUS = (value: string) =>
	`method return time=1700000000.123 sender=:1.42 -> dest=:1.9 serial=12 reply_serial=11\n   variant       string "${value}"`;

// The real shape of a Properties.Get("Metadata") reply from dbus-send --print-reply.
const METADATA = `method return time=1700000000.200 sender=:1.42 -> dest=:1.9 serial=13 reply_serial=12
   variant       struct {
      dict entry(
         string "mpris:trackid"
         variant string "/com/spotify/track/ABC123"
      )
      dict entry(
         string "xesam:title"
         variant string "My \\"Best\\" Song"
      )
      dict entry(
         string "xesam:artist"
         variant array [
            string "Eminem",
            string "Dido"
         ]
      )
      dict entry(
         string "xesam:album"
         variant string "Collaborations"
      )
   }`;

const OWNER_ARGS = [
	"--session",
	"--print-reply",
	"--dest=org.freedesktop.DBus",
	"/org/freedesktop/DBus",
	"org.freedesktop.DBus.NameHasOwner",
	"string:org.mpris.MediaPlayer2.spotify",
];

const mpris = (method: string, ...rest: string[]) => [
	"--session",
	"--print-reply",
	"--dest=org.mpris.MediaPlayer2.spotify",
	"/org/mpris/MediaPlayer2",
	method,
	...rest,
];

// ---------------------------------------------------------------- harness

interface Call {
	cmd: string;
	args: string[];
}

function linuxHarness(
	opts: { owner?: boolean; status?: string; metadata?: string; fail?: { code: number; stderr?: string } } = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "gentle-spotify-linux-"));
	writeFileSync(join(dir, "credentials"), "SPOTIFY_CLIENT_ID=id1234567890\nSPOTIFY_CLIENT_SECRET=secret1234567890\n");
	const calls: Call[] = [];
	const fetches: string[] = [];

	const run: Runner = async (cmd, args) => {
		calls.push({ cmd, args: [...args] });
		if (opts.fail) return { code: opts.fail.code, stdout: "", stderr: opts.fail.stderr ?? "" };
		const a = args.join(" ");
		if (a.includes("NameHasOwner")) {
			return { code: 0, stdout: `method return time=1 sender=:1.1 -> dest=:1.2 serial=2 reply_serial=1\n   boolean ${opts.owner === false ? "false" : "true"}\n`, stderr: "" };
		}
		if (a.includes("string:PlaybackStatus")) return { code: 0, stdout: opts.status ?? STATUS("Playing"), stderr: "" };
		if (a.includes("string:Metadata")) return { code: 0, stdout: opts.metadata ?? METADATA, stderr: "" };
		return { code: 0, stdout: "method return time=1 sender=:1.1 -> dest=:1.2 serial=2 reply_serial=1\n", stderr: "" };
	};

	const fetch = (async (url: string | URL) => {
		fetches.push(String(url));
		if (String(url).includes("/token")) return Response.json({ access_token: "TOKEN", expires_in: 3600 });
		if (String(url).includes("/v1/search")) return Response.json(SEARCH);
		return new Response("not found", { status: 404 });
	}) as typeof fetch;

	const deps: SpotifyDeps = {
		configDir: dir,
		fetch,
		run,
		sleep: async () => {},
		platform: "linux",
	};
	return { deps, calls, fetches };
}

const NOT_FOUND = /dbus-send not found: install your distribution's dbus package\./;
const CLOSED = /Spotify is not running: open it first\./;

// ------------------------------------------------------------------ tests

test("S7: toggle checks the bus owner first, then sends PlayPause", async () => {
	const h = linuxHarness();
	const msg = await createSpotify(h.deps).toggle();
	assert.ok(h.calls.every((c) => c.cmd === "dbus-send"), "everything goes through dbus-send");
	assert.deepEqual(h.calls[0].args, OWNER_ARGS, "running check comes first, Spotify is never launched");
	assert.deepEqual(h.calls[1].args, mpris("org.mpris.MediaPlayer2.Player.PlayPause"));
	// after the control: settle, then report the parsed state (owner + status + metadata)
	assert.deepEqual(h.calls[2].args, OWNER_ARGS);
	assert.deepEqual(h.calls[3].args, mpris("org.freedesktop.DBus.Properties.Get", "string:org.mpris.MediaPlayer2.Player", "string:PlaybackStatus"));
	assert.deepEqual(h.calls[4].args, mpris("org.freedesktop.DBus.Properties.Get", "string:org.mpris.MediaPlayer2.Player", "string:Metadata"));
	assert.equal(msg, `▶ My "Best" Song — Eminem, Dido`);
});

test("S7: resume sends Play without touching the network", async () => {
	const h = linuxHarness();
	const msg = await createSpotify(h.deps).play("");
	assert.equal(h.fetches.length, 0);
	assert.deepEqual(h.calls[0].args, OWNER_ARGS);
	assert.deepEqual(h.calls[1].args, mpris("org.mpris.MediaPlayer2.Player.Play"));
	assert.match(msg, /^▶ /);
});

test("S7: a URI or link plays directly with OpenUri, without searching", async () => {
	const h = linuxHarness();
	await createSpotify(h.deps).play("spotify:track:ABC123def456");
	assert.equal(h.fetches.length, 0);
	assert.deepEqual(h.calls[1].args, mpris("org.mpris.MediaPlayer2.Player.OpenUri", "string:spotify:track:ABC123def456"));

	const h2 = linuxHarness();
	await createSpotify(h2.deps).play("https://open.spotify.com/track/ABC123def456?si=x");
	assert.equal(h2.fetches.length, 0);
	assert.deepEqual(h2.calls[1].args, mpris("org.mpris.MediaPlayer2.Player.OpenUri", "string:spotify:track:ABC123def456"));
});

test("S7: pause, next and prev send Pause, Next and Previous", async () => {
	const h = linuxHarness();
	const sp = createSpotify(h.deps);
	assert.match(await sp.pause(), /^▶ /);
	assert.deepEqual(h.calls[1].args, mpris("org.mpris.MediaPlayer2.Player.Pause"));
	assert.match(await sp.next(), /^▶ /);
	assert.deepEqual(h.calls[6].args, mpris("org.mpris.MediaPlayer2.Player.Next"));
	assert.match(await sp.prev(), /^▶ /);
	assert.deepEqual(h.calls[11].args, mpris("org.mpris.MediaPlayer2.Player.Previous"));
});

test("S3 on Linux: controls and np report a closed Spotify and send nothing else", async () => {
	const h = linuxHarness({ owner: false });
	const sp = createSpotify(h.deps);
	for (const action of [sp.pause, sp.next, sp.prev]) {
		const before = h.calls.length;
		assert.equal(await action(), "Spotify is not running");
		assert.equal(h.calls.length - before, 1, "only the running check was sent");
		assert.deepEqual(h.calls[before].args, OWNER_ARGS);
	}
	const before = h.calls.length;
	assert.deepEqual(await sp.nowPlaying(), { state: "closed" });
	assert.equal(h.calls.length - before, 1);
});

test("S3 on Linux: play, resume and toggle when closed fail asking to open Spotify first", async () => {
	const h = linuxHarness({ owner: false });
	const sp = createSpotify(h.deps);
	await assert.rejects(sp.play(""), CLOSED);
	await assert.rejects(sp.toggle(), CLOSED);
	await assert.rejects(sp.play("spotify:track:ABC123def456"), CLOSED);
	await assert.rejects(sp.play("my name is"), CLOSED); // after the search, before playing
	for (const c of h.calls) assert.deepEqual(c.args, OWNER_ARGS, "only the running check was ever sent");
});

test("S7: state parsing covers Playing/Paused/Stopped, several artists and escaped quotes", async () => {
	const h = linuxHarness();
	const sp = createSpotify(h.deps);
	assert.deepEqual(await sp.nowPlaying(), { state: "playing", name: 'My "Best" Song', artist: "Eminem, Dido" });

	const paused = linuxHarness({ status: STATUS("Paused") });
	assert.deepEqual(await createSpotify(paused.deps).nowPlaying(), {
		state: "paused",
		name: 'My "Best" Song',
		artist: "Eminem, Dido",
	});

	const stopped = linuxHarness({ status: STATUS("Stopped") });
	assert.deepEqual(await createSpotify(stopped.deps).nowPlaying(), { state: "stopped" });
	assert.ok(
		!stopped.calls.some((c) => c.args.join(" ").includes("string:Metadata")),
		"stopped needs no metadata call",
	);
});

test("S7: a missing dbus-send reports the install hint", async () => {
	const exit127 = linuxHarness({ fail: { code: 127 } });
	await assert.rejects(createSpotify(exit127.deps).toggle(), NOT_FOUND);

	const spawnError = linuxHarness({ fail: { code: 1, stderr: "spawn dbus-send ENOENT" } });
	await assert.rejects(createSpotify(spawnError.deps).pause(), NOT_FOUND);
});

test("S7: other dbus failures surface the stderr", async () => {
	const h = linuxHarness({ fail: { code: 1, stderr: "Rejected send message, 1 matched rules\n" } });
	await assert.rejects(createSpotify(h.deps).toggle(), /dbus-send failed: Rejected send message, 1 matched rules/);
});

test("S7: /sp check on Linux needs no dbus-send at all", async () => {
	const h = linuxHarness({ fail: { code: 127 } });
	const msg = await createSpotify(h.deps).check();
	assert.match(msg, /^Credentials OK/);
	assert.equal(h.calls.length, 0);
});

test("S7: nowPlaying never launches a closed Spotify", async () => {
	const h = linuxHarness({ owner: false });
	assert.deepEqual(await createSpotify(h.deps).nowPlaying(), { state: "closed" } satisfies NowPlaying);
	assert.deepEqual(h.calls[0].args, OWNER_ARGS);
});
