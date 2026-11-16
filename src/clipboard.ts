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
 * so the caller clears with the same tool. On macOS a failing read keeps the old
 * "Could not read the clipboard" message; on Linux every tool failing means there
 * is no usable clipboard tool.
 */
export async function readClipboard(deps: ClipboardDeps): Promise<{ text: string; tool: ClipboardTool }> {
	const platform = deps.platform ?? process.platform;
	if (platform === "darwin") {
		const tool = darwinTools()[0];
		const [command, args] = tool.read;
		const result = await deps.exec(command, args);
		if (result.code !== 0) throw new Error(`Could not read the clipboard: ${result.stderr.trim()}`);
		return { text: result.stdout, tool };
	}
	if (platform !== "linux") throw new Error(unsupportedPlatformMessage(platform));

	for (const tool of linuxTools(deps.env ?? process.env)) {
		const [command, args] = tool.read;
		const result = await deps.exec(command, args);
		if (result.code === 0) return { text: result.stdout, tool };
	}
	throw new Error(NO_TOOL);
}

/** Clears the clipboard with the tool that read it. Returns false when clearing failed. */
export async function clearClipboard(deps: ClipboardDeps, tool: ClipboardTool): Promise<boolean> {
	const [command, args] = tool.clear;
	return (await deps.exec(command, args)).code === 0;
}
