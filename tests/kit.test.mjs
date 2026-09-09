/**
 * kit.test.mjs —— 套件自检：纯文件检查，不启动 pi，不调用模型。
 *
 * 检查的都是「第一次使用就会暴露」的结构性问题：技能 frontmatter 是否合规（pi 的硬约束），
 * 技能内引用的 references 是否存在且写法可被模型正确解析，依赖图模板是否符合 mermaid 语法约束，
 * 学习目录约定在 AGENTS.md 与 logging.md 之间是否一致，安装脚本的编码，以及语体禁令。
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const skillDirs = readdirSync(join(root, "skills"), { withFileTypes: true })
	.filter((d) => d.isDirectory())
	.map((d) => d.name);
const STATES = ["done", "todo", "skip", "defer"];

/** 某技能的 references/*.md 文件名列表；没有该目录则为空 */
function refsOf(skill) {
	const dir = join(root, "skills", skill, "references");
	return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
}

/** 解析 SKILL.md 顶部的 YAML 头：只支持 key: value 单行形式，足够本套件使用 */
function frontmatter(text) {
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	assert.ok(m, "缺少 frontmatter");
	const out = {};
	for (const line of m[1].split(/\r?\n/)) {
		const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
		if (kv) out[kv[1]] = kv[2].trim();
	}
	return out;
}

describe("技能 frontmatter 符合 pi 的约束", () => {
	it("套件包含四个技能", () => {
		assert.deepEqual([...skillDirs].sort(), ["fact-check-cn", "quiz-cn", "teach-cn", "viz-cn"]);
	});
	for (const dir of skillDirs) {
		it(`${dir}：name 与目录同名、合法；description 非空、不超过 1024 字符、无 YAML 特殊序列`, () => {
			const fm = frontmatter(read(`skills/${dir}/SKILL.md`));
			assert.equal(fm.name, dir);
			assert.match(fm.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, "name 只允许小写字母、数字与单个连字符");
			assert.ok(fm.name.length <= 64);
			assert.ok(fm.description && fm.description.length > 0, "description 缺失时 pi 不加载该技能");
			assert.ok(fm.description.length <= 1024, `description 过长：${fm.description.length}`);
			// pi 用 yaml 库解析：未加引号的值里出现「: 」会解析失败，「 #」之后会被当作注释截断
			assert.doesNotMatch(fm.description, /: |\s#/, "description 含 YAML 特殊序列，需加引号或改写");
		});
	}
});

describe("references 引用可被解析", () => {
	for (const skill of skillDirs) {
		const refFiles = refsOf(skill);
		if (!refFiles.length) continue;
		const texts = [read(`skills/${skill}/SKILL.md`), ...refFiles.map((f) => read(`skills/${skill}/references/${f}`))];

		it(`${skill}：每个 \`references/xxx.md\` 引用都指向存在的文件`, () => {
			for (const t of texts) {
				for (const m of t.matchAll(/`references\/([a-z0-9-]+\.md)`/g)) {
					assert.ok(refFiles.includes(m[1]), `引用了不存在的 references/${m[1]}`);
				}
			}
		});

		it(`${skill}：不出现省略 references/ 前缀的裸文件名引用（模型会按技能目录解析而找不到）`, () => {
			for (const t of texts) {
				for (const f of refFiles) {
					const bare = new RegExp(`(?<![\\w/])\`${f.replace(".", "\\.")}\``);
					assert.ok(!bare.test(t), `裸引用 \`${f}\` 应写作 \`references/${f}\``);
				}
			}
		});

		it(`${skill}：SKILL.md 提及 references/ 下的每个文件`, () => {
			const skillText = read(`skills/${skill}/SKILL.md`);
			for (const f of refFiles) assert.ok(skillText.includes(`references/${f}`), `SKILL.md 未提及 references/${f}`);
		});
	}
});

describe("依赖图模板符合 mermaid 语法约束", () => {
	const logging = read("skills/teach-cn/references/logging.md");
	const blocks = [...logging.matchAll(/```mermaid\r?\n([\s\S]*?)```/g)].map((m) => m[1]);

	it("存在模板且以 graph TD 开头，定义了四个状态样式类", () => {
		assert.ok(blocks.length >= 1);
		assert.match(blocks[0].trim(), /^graph TD/);
		for (const cls of STATES) assert.match(blocks[0], new RegExp(`classDef ${cls} `));
	});

	it("节点 id 为 ASCII、标签加双引号、标签内无形状语法字符、状态类合法、每个节点只定义一次", () => {
		for (const block of blocks) {
			const defined = new Map();
			for (const line of block.split(/\r?\n/)) {
				for (const node of line.matchAll(/([^\s[\]>"-]+)\[([^\]]*)\]/g)) {
					const [, id, label] = node;
					assert.match(id, /^[A-Za-z0-9_]+$/, `节点 id 须为 ASCII：${id}`);
					assert.match(label, /^"[^"]*"$/, `标签须加双引号：${label}`);
					assert.doesNotMatch(label, /[[\]{}()|$]/, `标签内含形状语法字符：${label}`);
					assert.ok(!defined.has(id), `节点 ${id} 定义了两次，edit 将失去唯一锚点`);
					defined.set(id, label);
				}
				for (const cls of line.matchAll(/:::(\S+)/g)) assert.ok(STATES.includes(cls[1]), `未知状态类 ${cls[1]}`);
			}
		}
	});
});

describe("学习目录约定在 AGENTS.md、logging.md 与 README 之间一致", () => {
	it("AGENTS.md 与 logging.md 都声明 LEARNER.md、maps/、sessions/、attachments/", () => {
		const agents = read("AGENTS.md");
		const logging = read("skills/teach-cn/references/logging.md");
		for (const p of ["LEARNER.md", "maps/", "sessions/", "attachments/"]) {
			assert.ok(agents.includes(p), `AGENTS.md 未声明 ${p}`);
			assert.ok(logging.includes(p), `logging.md 未声明 ${p}`);
		}
	});

	it("AGENTS.md 声明对上级目录约定的优先权并映射四个技能；README 要求在学习目录内启动 pi", () => {
		const agents = read("AGENTS.md");
		assert.ok(agents.includes("优先"), "应声明本文件优先于上级目录的约定");
		for (const s of skillDirs) assert.ok(agents.includes(`\`${s}\``), `AGENTS.md 未提及技能 ${s}`);
		assert.ok(read("README.md").includes("必须在学习目录"), "README 应要求在学习目录内启动 pi");
	});
});

describe("语体禁令", () => {
	const files = ["AGENTS.md"];
	for (const s of skillDirs) {
		files.push(`skills/${s}/SKILL.md`);
		for (const f of refsOf(s)) files.push(`skills/${s}/references/${f}`);
	}
	for (const f of files) {
		it(`${f}：不含感叹号、对勾叉号与 emoji`, () => {
			const t = read(f);
			// 半角 ! 只允许出现在 Obsidian 的嵌入语法 ![[...]] 里
			assert.doesNotMatch(t, /！|!(?!\[\[)/, "含感叹号");
			assert.doesNotMatch(t, /[✓✗✔✘]/, "含对勾叉号");
			assert.doesNotMatch(t, /\p{Extended_Pictographic}/u, "含 emoji");
		});
	}
});

describe("安装脚本", () => {
	it("PowerShell 与 sh 两版都存在，遍历 skills/ 下全部技能，尊重 PI_CODING_AGENT_DIR", () => {
		const ps1 = read("scripts/install.ps1");
		const sh = read("scripts/install.sh");
		assert.ok(ps1.includes("Get-ChildItem (Join-Path $root \"skills\") -Directory"), "install.ps1 应遍历 skills 目录而非硬编码");
		assert.ok(sh.includes('for src in "$root"/skills/*/'), "install.sh 应遍历 skills 目录而非硬编码");
		for (const t of [ps1, sh]) assert.ok(t.includes("PI_CODING_AGENT_DIR"), "应尊重 PI_CODING_AGENT_DIR");
	});

	it("install.ps1 带 UTF-8 BOM：Windows PowerShell 5.1 对无 BOM 的中文脚本按 ANSI 解码，整个文件解析失败", () => {
		const head = [...readFileSync(join(root, "scripts/install.ps1")).subarray(0, 3)];
		assert.deepEqual(head, [0xef, 0xbb, 0xbf]);
	});
});
