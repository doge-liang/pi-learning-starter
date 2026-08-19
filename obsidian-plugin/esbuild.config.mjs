import esbuild from "esbuild";
import builtins from "builtin-modules";
import { copyFileSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");

// 输出到 dist/，与 manifest.json、styles.css 一起即可安装；Obsidian 要求 CJS、无外部依赖
const ctx = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtins, ...builtins.map((m) => `node:${m}`)],
	format: "cjs",
	platform: "node",
	target: "es2022",
	outfile: "dist/main.js",
	sourcemap: watch ? "inline" : false,
	logLevel: "info",
	treeShaking: true,
	// pi 的类型剥离风格在本包里同样使用；esbuild 直接消费 .ts
});

mkdirSync("dist", { recursive: true });
copyFileSync("manifest.json", "dist/manifest.json");
copyFileSync("styles.css", "dist/styles.css");

if (watch) {
	await ctx.watch();
} else {
	await ctx.rebuild();
	await ctx.dispose();
}
