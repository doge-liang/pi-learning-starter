/**
 * locate.ts —— 定位 pi 的启动方式。
 *
 * 优先 node + dist/cli.js（跨平台、无 shell、Windows 上不受 pi.cmd 垫片限制）；
 * 找不到 cli.js 时回退到 PATH 上的 pi 可执行文件（pi.dev 安装脚本装的二进制）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PiLaunch {
	command: string;
	args: string[];
	/** 人类可读的来源说明 */
	source: string;
}

const PKG = join("@earendil-works", "pi-coding-agent", "dist", "cli.js");

export function candidateCliPaths(projectDir?: string): string[] {
	const home = homedir();
	const out: string[] = [];
	if (projectDir) out.push(join(projectDir, "node_modules", PKG));
	if (process.platform === "win32") {
		if (process.env.APPDATA) out.push(join(process.env.APPDATA, "npm", "node_modules", PKG));
		if (process.env.LOCALAPPDATA) out.push(join(process.env.LOCALAPPDATA, "Volta", "tools", "image", "packages", "@earendil-works", "pi-coding-agent", "lib", "node_modules", PKG));
	} else {
		out.push(join("/usr/local/lib/node_modules", PKG), join("/usr/lib/node_modules", PKG), join("/opt/homebrew/lib/node_modules", PKG));
		out.push(join(home, ".npm-global", "lib", "node_modules", PKG));
		out.push(join(home, ".local", "lib", "node_modules", PKG));
		const nvm = join(home, ".nvm", "versions", "node");
		if (existsSync(nvm)) {
			for (const v of safeReaddir(nvm).sort().reverse()) out.push(join(nvm, v, "lib", "node_modules", PKG));
		}
		const volta = join(home, ".volta", "tools", "image", "packages", "@earendil-works", "pi-coding-agent", "lib", "node_modules", PKG);
		out.push(volta);
	}
	return out;
}

function safeReaddir(p: string): string[] {
	try {
		return readdirSync(p);
	} catch {
		return [];
	}
}

/** 最后手段：问 npm 全局目录（约 200ms，只在前面都找不到时调用） */
function npmGlobalCli(): string | undefined {
	try {
		const root = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], { encoding: "utf8", timeout: 5000, windowsHide: true, shell: process.platform === "win32" }).trim();
		const p = join(root, PKG);
		return existsSync(p) ? p : undefined;
	} catch {
		return undefined;
	}
}

/**
 * @param override 用户在设置里填写的路径：可以是 cli.js，也可以是 pi 可执行文件
 */
export function locatePi(override: string | undefined, nodePath: string, projectDir?: string): PiLaunch | undefined {
	if (override?.trim()) {
		const p = override.trim();
		if (p.endsWith(".js") || p.endsWith(".mjs")) return { command: nodePath, args: [p], source: `设置：${p}` };
		return { command: p, args: [], source: `设置：${p}` };
	}
	for (const p of candidateCliPaths(projectDir)) {
		if (existsSync(p)) return { command: nodePath, args: [p], source: p };
	}
	const viaNpm = npmGlobalCli();
	if (viaNpm) return { command: nodePath, args: [viaNpm], source: viaNpm };
	// Windows 上 PATH 里的 pi 是 .cmd/.ps1 垫片，spawn 需要 shell，这里不做；Unix 可直接用
	if (process.platform !== "win32") return { command: "pi", args: [], source: "PATH 上的 pi" };
	return undefined;
}
