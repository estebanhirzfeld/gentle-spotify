/**
 * Clipboard read/clear for `/sp setup`, one set of commands per platform.
 * Commands run without a shell and without stdin through the injected exec
 * (pi.exec inside the extension), so the value never touches a command line.
 *
 * The platform and the environment are injectable (ClipboardDeps), so tests can
 * exercise every tool selection without touching a real clipboard.
 */
import { unsupportedPlatformMessage } from "./spotify.ts";

export interface ClipboardResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface ClipboardDeps {
	exec: (command: string, args: string[]) => Promise<ClipboardResult>;
	/** Defaults to process.platform. */
	platform?: string;
	/** Defaults to process.env. Only WAYLAND_DISPLAY is read (Linux tool choice). */
	env?: Record<string, string | undefined>;
}

export interface ClipboardTool {
	/** Command and arguments to read the clipboard. */
	read: [string, string[]];
	/** Command and arguments to clear the clipboard. */
	clear: [string, string[]];
}

const NO_TOOL = "No clipboard tool found: install wl-clipboard, xclip or xsel.";

/**
 * A tool that is not installed is not a clipboard failure: Node's exec rejects with
 * a spawn error whose message mentions ENOENT (never checked against stderr, which
 * can legitimately contain such words). Everything else is a real failure.
 */
function isMissingToolRejection(err: unknown): boolean {
	return err instanceof Error && err.message.includes("ENOENT");
}

function darwinTools(): ClipboardTool[] {
	return [
		{
			read: ["pbpaste", []],
			clear: ["osascript", ["-e", 'set the clipboard to ""']],
		},
	];
}

/** Order: wl-clipboard when a Wayland compositor is in use, then xclip, then xsel. */
function linuxTools(env: Record<string, string | undefined>): ClipboardTool[] {
	const tools: ClipboardTool[] = [];
	if (env.WAYLAND_DISPLAY) {
		tools.push({ read: ["wl-paste", ["--no-newline"]], clear: ["wl-copy", ["--clear"]] });
	}
	tools.push(
		{
			read: ["xclip", ["-selection", "clipboard", "-o"]],
			clear: ["xclip", ["-selection", "clipboard", "-i", "/dev/null"]],
		},
		{
			read: ["xsel", ["--clipboard", "--output"]],
			clear: ["xsel", ["--clipboard", "--clear"]],
		},
	);
	return tools;
}

/**
 * Reads the clipboard with the first tool that works and returns which one it was,
 * so the caller clears with the same tool. A tool that is missing (a rejected exec
 * mentioning ENOENT, or exit code 127) falls through to the next tool; a tool that
 * is installed but fails stops the chain with that tool's error — on Wayland an
 * empty clipboard makes wl-paste exit non-zero and falling through to xclip would
 * read a stale X11 selection. On macOS a failing read keeps the old "Could not read
 * the clipboard" message; on Linux every tool missing means there is no usable
 * clipboard tool. No error message ever contains the clipboard value.
 */
export async function readClipboard(deps: ClipboardDeps): Promise<{ text: string; tool: ClipboardTool }> {
	const platform = deps.platform ?? process.platform;
	if (platform === "darwin") {
		const tool = darwinTools()[0];
		const [command, args] = tool.read;
		let result: ClipboardResult;
		try {
			result = await deps.exec(command, args);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			throw new Error(`Could not read the clipboard: ${reason}`);
		}
		if (result.code !== 0) throw new Error(`Could not read the clipboard: ${result.stderr.trim()}`);
		return { text: result.stdout, tool };
	}
	if (platform !== "linux") throw new Error(unsupportedPlatformMessage(platform));

	for (const tool of linuxTools(deps.env ?? process.env)) {
		const [command, args] = tool.read;
		let result: ClipboardResult;
		try {
			result = await deps.exec(command, args);
		} catch (err) {
			if (isMissingToolRejection(err)) continue; // not installed: try the next tool
			const reason = err instanceof Error ? err.message : String(err);
			throw new Error(`${command} failed: ${reason}`);
		}
		if (result.code === 0) return { text: result.stdout, tool };
		if (result.code === 127) continue; // the shell's "command not found"
		// the tool exists but failed: report its own error instead of falling through
		throw new Error(`${command} failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
	}
	throw new Error(NO_TOOL);
}

/** Clears the clipboard with the tool that read it. Returns false when clearing failed, including a rejected exec. */
export async function clearClipboard(deps: ClipboardDeps, tool: ClipboardTool): Promise<boolean> {
	const [command, args] = tool.clear;
	try {
		return (await deps.exec(command, args)).code === 0;
	} catch {
		return false; // a rejected exec is a failed tool: setup warns instead of throwing
	}
}
