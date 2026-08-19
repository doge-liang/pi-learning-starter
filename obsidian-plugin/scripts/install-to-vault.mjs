#!/usr/bin/env node
// 把构建产物复制到某个 vault 的 .obsidian/plugins/pi-learning/。
// 用法：node scripts/install-to-vault.mjs <vault 路径>   （或设置环境变量 OBSIDIAN_VAULT）
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vault = process.argv[2] ?? process.env.OBSIDIAN_VAULT;
if (!vault) {
	console.error("用法：node scripts/install-to-vault.mjs <vault 路径>");
	process.exit(2);
}
if (!existsSync(join(vault, ".obsidian"))) {
	console.error(`${vault} 不像一个 Obsidian vault（没有 .obsidian/）`);
	process.exit(2);
}
const dist = join(root, "dist");
if (!existsSync(join(dist, "main.js"))) {
	console.error("没有构建产物，请先 npm run build");
	process.exit(2);
}
const target = join(vault, ".obsidian", "plugins", "pi-learning");
mkdirSync(target, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) copyFileSync(join(dist, f), join(target, f));
console.log(`已安装到 ${target}。在 Obsidian 设置 → 第三方插件 里启用「Pi Learning」（已启用则重新加载）。`);
