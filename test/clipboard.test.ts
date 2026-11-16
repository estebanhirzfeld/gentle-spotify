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
	} = {},
) {
	const calls: Call[] = [];
	const exec = async (cmd: string, args: string[]) => {
		calls.push({ cmd, args: [...args] });
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
