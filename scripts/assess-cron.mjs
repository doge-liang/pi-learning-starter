#!/usr/bin/env node
// 跨平台的无人值守出题脚本（等价于 assess-cron.sh，供 Windows 任务计划程序或任何有 node 的环境使用）。
// 作答仍由学习者在交互模式中完成（前台的 /learn 建议会列出待作答的测试）。
//
// 用法：node scripts/assess-cron.mjs [--force] [--max 8]
//   PI_BIN=<pi 可执行文件路径> 可覆盖 pi 的定位方式。
//
// Windows 任务计划程序示例（每周一、四 20:00）：
//   schtasks /Create /SC WEEKLY /D MON,THU /ST 20:00 /TN "pi-learning assess" ^
//     /TR "cmd /c cd /d D:\path\to\project && node scripts\assess-cron.mjs >> cron.log 2>&1"
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dueReport } from "./due-check.mjs";

// 项目根：当前目录若含 blackboard/ 则用之（任务计划里通常先 cd），否则用脚本所在仓库
const projectRoot = existsSync(join(process.cwd(), "blackboard")) ? process.cwd() : resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(projectRoot);

const args = process.argv.slice(2);
const force = args.includes("--force");
const maxIdx = args.indexOf("--max");
const maxItems = maxIdx >= 0 ? Number.parseInt(args[maxIdx + 1] ?? "", 10) || 8 : 8;

const report = dueReport(projectRoot);
console.log(`[${new Date().toISOString()}] ${report.summary}`);
if (!report.should && !force) process.exit(0);

/**
 * 定位 pi：优先环境变量 PI_BIN；其次项目内安装的 pi（devDependency，无需 shell 即可运行）；
 * 最后回退到 PATH 上的 pi（Windows 上是 pi.cmd，必须经 shell 启动）。
 */
function locatePi() {
	if (process.env.PI_BIN) return { cmd: process.env.PI_BIN, args: [], shell: process.platform === "win32" };
	const local = join(projectRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
	if (existsSync(local)) return { cmd: process.execPath, args: [local], shell: false };
	return { cmd: "pi", args: [], shell: process.platform === "win32" };
}

const pi = locatePi();
const prompt = `phase=generate。题数上限 ${maxItems}。请依据黑板上下文生成一次闭卷检索测试，并调用 bb_test_create 写入。`;
const sessionName = `assessor cron ${new Date().toISOString().slice(0, 10)}`;
// 提示词经 stdin 传入（pi 的 print 模式接受管道输入），避免 Windows shell 对中文与引号的改写
const r = spawnSync(pi.cmd, [...pi.args, "-p", "-a", "--name", sessionName], {
	input: prompt,
	stdio: ["pipe", "inherit", "inherit"],
	shell: pi.shell,
	env: { ...process.env, LEARN_ROLE: "assessor" },
});
if (r.error) {
	console.error(`无法启动 pi：${r.error.message}。请安装 pi 或设置 PI_BIN。`);
	process.exit(1);
}
process.exit(r.status ?? 1);
