import { test } from "node:test";
import assert from "node:assert/strict";
import { clearClipboard, readClipboard, type ClipboardDeps } from "../src/clipboard.ts";

interface Call {
	cmd: string;
	args: string[];
}

function harness(
	opts: {
		platform?: string;
		env?: Record<string, string | undefined>;
		value?: string;
		/** exit code to fail a command with */
		fails?: Record<string, number>;
		/** error message to reject a command's exec with (a spawn failure) */
		rejects?: Record<string, string>;
	} = {},
) {
	const calls: Call[] = [];
	const exec = async (cmd: string, args: string[]) => {
		calls.push({ cmd, args: [...args] });
		const reject = opts.rejects?.[cmd];
		if (reject !== undefined) throw new Error(reject);
		const fail = opts.fails?.[cmd];
		if (fail !== undefined) return { code: fail, stdout: "", stderr: `no ${cmd}` };
		return { code: 0, stdout: opts.value ?? "SECRETVALUE12345", stderr: "" };
	};
	const deps: ClipboardDeps = { exec, platform: opts.platform, env: opts.env };
	return { calls, deps };
}

test("S7: darwin reads with pbpaste and clears with osascript", async () => {
	const h = harness({ platform: "darwin" });
	const { text, tool } = await readClipboard(h.deps);
	assert.equal(text, "SECRETVALUE12345");
	assert.deepEqual(h.calls, [{ cmd: "pbpaste", args: [] }]);
	assert.equal(await clearClipboard(h.deps, tool), true);
	assert.deepEqual(h.calls[1], { cmd: "osascript", args: ["-e", 'set the clipboard to ""'] });
});

test("S7: darwin keeps the old read-failure message", async () => {
	const h = harness({ platform: "darwin", fails: { pbpaste: 1 } });
	await assert.rejects(readClipboard(h.deps), /^Error: Could not read the clipboard: no pbpaste$/);
});

test("S7: linux with Wayland uses wl-paste and wl-copy first", async () => {
	const h = harness({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } });
	const { tool } = await readClipboard(h.deps);
	assert.deepEqual(h.calls[0], { cmd: "wl-paste", args: ["--no-newline"] });
	assert.equal(await clearClipboard(h.deps, tool), true);
	assert.deepEqual(h.calls[1], { cmd: "wl-copy", args: ["--clear"] });
});

test("S7: linux without Wayland starts at xclip", async () => {
	const h = harness({ platform: "linux", env: {} });
	const { tool } = await readClipboard(h.deps);
	assert.deepEqual(h.calls[0], { cmd: "xclip", args: ["-selection", "clipboard", "-o"] });
	assert.equal(await clearClipboard(h.deps, tool), true);
	assert.deepEqual(h.calls[1], { cmd: "xclip", args: ["-selection", "clipboard", "-i", "/dev/null"] });
});

test("S7: a failing wl-paste falls back to xclip, clearing with the same tool", async () => {
	const h = harness({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" }, fails: { "wl-paste": 127 } });
	const { tool } = await readClipboard(h.deps);
	assert.deepEqual(h.calls[0], { cmd: "wl-paste", args: ["--no-newline"] });
	assert.deepEqual(h.calls[1], { cmd: "xclip", args: ["-selection", "clipboard", "-o"] });
	assert.equal(await clearClipboard(h.deps, tool), true);
	assert.deepEqual(h.calls[2], { cmd: "xclip", args: ["-selection", "clipboard", "-i", "/dev/null"] });
});

test("S7: a failing xclip falls back to xsel", async () => {
	const h = harness({ platform: "linux", env: {}, fails: { xclip: 127 } });
	const { tool } = await readClipboard(h.deps);
	assert.deepEqual(h.calls[1], { cmd: "xsel", args: ["--clipboard", "--output"] });
	assert.equal(await clearClipboard(h.deps, tool), true);
	assert.deepEqual(h.calls[2], { cmd: "xsel", args: ["--clipboard", "--clear"] });
});

test("S7: no working tool explains what to install", async () => {
	const h = harness({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" }, fails: { "wl-paste": 127, xclip: 127, xsel: 127 } });
	await assert.rejects(readClipboard(h.deps), /^Error: No clipboard tool found: install wl-clipboard, xclip or xsel\.$/);
});

test("S7: an unsupported platform cannot use the clipboard for setup", async () => {
	const h = harness({ platform: "win32" });
	await assert.rejects(readClipboard(h.deps), /this platform is win32/);
	assert.equal(h.calls.length, 0);
});

test("S7: a failed clear reports false so setup can warn", async () => {
	const h = harness({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" }, fails: { "wl-copy": 1 } });
	const { tool } = await readClipboard(h.deps);
	assert.equal(await clearClipboard(h.deps, tool), false);
});

test("N2: a rejected wl-paste (missing tool) falls back to xclip and the xclip tool is returned", async () => {
	const h = harness({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" }, rejects: { "wl-paste": "spawn wl-paste ENOENT" } });
	const { text, tool } = await readClipboard(h.deps);
	assert.equal(text, "SECRETVALUE12345");
	assert.deepEqual(h.calls, [
		{ cmd: "wl-paste", args: ["--no-newline"] },
		{ cmd: "xclip", args: ["-selection", "clipboard", "-o"] },
	]);
	assert.deepEqual(tool.read, ["xclip", ["-selection", "clipboard", "-o"]], "clearing uses the tool that read");
	assert.equal(await clearClipboard(h.deps, tool), true);
	assert.deepEqual(h.calls[2], { cmd: "xclip", args: ["-selection", "clipboard", "-i", "/dev/null"] });
});

test("N2: wl-paste that exists but fails (empty Wayland clipboard) stops the chain and never reaches xclip", async () => {
	const h = harness({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" }, fails: { "wl-paste": 1 } });
	await assert.rejects(readClipboard(h.deps), /^Error: wl-paste failed: no wl-paste$/);
	assert.equal(h.calls.length, 1, "xclip (XWayland, possibly a stale X11 selection) is never tried");
});

test("N2: a rejection that is not a missing tool stops the chain with that error, value-free", async () => {
	const h = harness({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" }, rejects: { "wl-paste": "permission denied, are you in the input group?" } });
	const err = await readFailure(h);
	assert.match(err, /^Error: wl-paste failed: permission denied, are you in the input group\?$/);
	assert.doesNotMatch(err, /SECRETVALUE12345/, "the clipboard value never appears in an error");
	assert.equal(h.calls.length, 1);
});

test("N2: a rejected pbpaste maps to the old read-failure message", async () => {
	const h = harness({ platform: "darwin", rejects: { pbpaste: "spawn pbpaste ENOENT" } });
	await assert.rejects(readClipboard(h.deps), /^Error: Could not read the clipboard: spawn pbpaste ENOENT$/);
});

test("N2: a rejected clear reports false so setup can warn", async () => {
	const h = harness({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" }, rejects: { "wl-copy": "spawn wl-copy ENOENT" } });
	const { tool } = await readClipboard(h.deps);
	assert.equal(await clearClipboard(h.deps, tool), false);
});

/** Runs readClipboard and returns the rejection text (or "no rejection"). */
async function readFailure(h: ReturnType<typeof harness>): Promise<string> {
	try {
		await readClipboard(h.deps);
		return "no rejection";
	} catch (err) {
		return String(err);
	}
}
