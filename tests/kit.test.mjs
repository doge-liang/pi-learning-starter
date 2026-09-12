/**
 * kit.test.mjs —— 套件自检：纯文件检查与扩展的纯逻辑测试，不启动 pi，不调用模型。
 *
 * 检查的都是「第一次使用就会暴露」的结构性问题：技能 frontmatter 是否合规（Agent Skills 规范的硬约束），
 * 技能内引用的 references 是否存在且写法可被模型正确解析，依赖图模板是否符合 mermaid 语法约束，
 * 学习目录约定在 AGENTS.md 与 logging.md 之间是否一致，安装脚本的编码与覆盖范围，语体禁令，
 * 以及 quiz 与 viz-tools 两个扩展的纯逻辑（打乱与判定、mermaid 静态检查）。
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { IDK, buildQuiz, judge, shuffle } from "../extensions/quiz/logic.mjs";
import { lintMermaid } from "../extensions/viz-tools/lint.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const dirsOf = (rel) =>
	readdirSync(join(root, rel), { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);
const skillDirs = dirsOf("skills");
const extDirs = dirsOf("extensions");
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

/** Agent Skills 规范（agentskills.io）定义的全部 frontmatter 字段 */
const SPEC_FIELDS = ["name", "description", "license", "compatibility", "metadata", "allowed-tools"];

describe("技能 frontmatter 符合 Agent Skills 规范", () => {
	it("套件包含四个技能", () => {
		assert.deepEqual([...skillDirs].sort(), ["fact-check", "quiz", "teach", "viz"]);
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
			// 规范只认六个字段；出现别的会被严格实现拒绝
			for (const k of Object.keys(fm)) assert.ok(SPEC_FIELDS.includes(k), `未定义的 frontmatter 字段：${k}`);
			assert.equal(fm.license, "MIT", "技能被单独复制时需自带授权信息");
			assert.ok(fm.compatibility && fm.compatibility.length <= 500, "compatibility 需声明环境依赖且不超过 500 字符");
			assert.doesNotMatch(fm.compatibility, /: |\s#/, "compatibility 含 YAML 特殊序列");
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
	const logging = read("skills/teach/references/logging.md");
	const blocks = [...logging.matchAll(/```mermaid\r?\n([\s\S]*?)```/g)].map((m) => m[1]);

	it("存在模板且以 graph TD 开头，定义了四个状态样式类", () => {
		assert.ok(blocks.length >= 1);
		assert.match(blocks[0].trim(), /^graph TD/);
		for (const cls of STATES) assert.match(blocks[0], new RegExp(`classDef ${cls} `));
	});

	it("模板通过 viz-tools 的静态检查（与 viz 技能的规则一致）", () => {
		for (const block of blocks) assert.deepEqual(lintMermaid(block), []);
	});
});

describe("学习目录约定在 AGENTS.md、logging.md 与 README 之间一致", () => {
	it("AGENTS.md 与 logging.md 都声明 LEARNER.md、maps/、sessions/、attachments/", () => {
		const agents = read("AGENTS.md");
		const logging = read("skills/teach/references/logging.md");
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
	it("PowerShell 与 sh 两版都存在，遍历 skills/ 与 extensions/ 下全部目录，尊重 PI_CODING_AGENT_DIR", () => {
		const ps1 = read("scripts/install.ps1");
		const sh = read("scripts/install.sh");
		assert.ok(ps1.includes('Get-ChildItem (Join-Path $root "skills") -Directory'), "install.ps1 应遍历 skills 目录而非硬编码");
		assert.ok(ps1.includes('Get-ChildItem (Join-Path $root "extensions") -Directory'), "install.ps1 应遍历 extensions 目录");
		assert.ok(sh.includes('for src in "$root"/skills/*/'), "install.sh 应遍历 skills 目录而非硬编码");
		assert.ok(sh.includes('for src in "$root"/extensions/*/'), "install.sh 应遍历 extensions 目录");
		for (const t of [ps1, sh]) assert.ok(t.includes("PI_CODING_AGENT_DIR"), "应尊重 PI_CODING_AGENT_DIR");
		assert.match(ps1, /\[switch\]\$WorkspaceSkills/, "install.ps1 应提供 -WorkspaceSkills 开关");
		assert.ok(sh.includes("WORKSPACE_SKILLS"), "install.sh 应提供 WORKSPACE_SKILLS 开关");
		for (const t of [ps1, sh]) assert.ok(t.includes(".agents"), "工作区技能应装到 .agents/skills");
	});

	it("含中文的 .ps1 都带 UTF-8 BOM：Windows PowerShell 5.1 对无 BOM 的中文脚本按 ANSI 解码，整个文件解析失败", () => {
		for (const f of ["scripts/install.ps1", "scripts/learn.ps1"]) {
			const head = [...readFileSync(join(root, f)).subarray(0, 3)];
			assert.deepEqual(head, [0xef, 0xbb, 0xbf], `${f} 缺少 BOM`);
		}
	});

	it("启动脚本只带套件的四个技能，并要求学习目录里有 AGENTS.md", () => {
		for (const f of ["scripts/learn.ps1", "scripts/learn.sh"]) {
			const t = read(f);
			assert.ok(t.includes("--no-skills"), `${f} 应用 --no-skills 排除其它技能`);
			for (const s of skillDirs) assert.ok(t.includes(s), `${f} 未带技能 ${s}`);
			assert.ok(t.includes("AGENTS.md"), `${f} 应检查学习目录的 AGENTS.md`);
		}
	});
});

describe("扩展结构", () => {
	it("每个扩展有 index.ts 并注册至少一个工具；有 package.json 者为合法 JSON 且依赖在 dependencies 里", () => {
		assert.deepEqual([...extDirs].sort(), ["quiz", "viz-tools"]);
		for (const e of extDirs) {
			const src = read(`extensions/${e}/index.ts`);
			assert.match(src, /pi\.registerTool\(\{/, `${e} 未注册工具`);
			assert.match(src, /from "typebox"/, `${e} 应从 typebox 导入 Type（pi 为扩展提供该别名）`);
			assert.doesNotMatch(src, /isError\s*:/, `${e}：pi 忽略返回值里的 isError，错误必须 throw`);
			const pkg = join(root, "extensions", e, "package.json");
			if (existsSync(pkg)) {
				const json = JSON.parse(read(`extensions/${e}/package.json`));
				assert.ok(json.dependencies && !json.devDependencies, "运行时依赖须放在 dependencies（pi 用 --omit=dev 安装）");
			}
		}
	});

	it("技能在工具可用时改走工具：quiz 与 teach 提及 quiz，viz 提及 render_svg 与 check_mermaid", () => {
		assert.ok(read("skills/quiz/SKILL.md").includes("`quiz`"));
		assert.ok(read("skills/teach/SKILL.md").includes("`quiz`"));
		const viz = read("skills/viz/SKILL.md");
		assert.ok(viz.includes("`render_svg`") && viz.includes("`check_mermaid`"));
	});
});

describe("quiz 扩展的纯逻辑", () => {
	const seq = (values) => {
		let i = 0;
		return () => values[i++ % values.length];
	};

	it("shuffle 不改变元素集合，且可由注入的 rng 决定", () => {
		assert.deepEqual([...shuffle([1, 2, 3, 4], () => 0)].sort(), [1, 2, 3, 4]);
		assert.deepEqual(shuffle([1, 2, 3], () => 0), [2, 3, 1]);
	});

	it("buildQuiz：选项编号、末尾固定附加「我不知道」、order 与 display 一致", () => {
		const q = buildQuiz({ options: ["甲", "乙", "丙", "丁"], correct: 2 }, seq([0.99, 0.5, 0.1]));
		assert.equal(q.display.length, 5);
		assert.equal(q.display[4], `5. ${IDK}`);
		q.display.slice(0, 4).forEach((d, k) => assert.equal(d, `${k + 1}. ${q.options[q.order[k]]}`));
		assert.throws(() => buildQuiz({ options: ["只有一个"], correct: 0 }), /至少/);
		assert.throws(() => buildQuiz({ options: ["甲", "乙"], correct: 5 }), /合法下标/);
	});

	it("judge：答对、答错、我不知道、取消四种结果", () => {
		const q = buildQuiz({ options: ["甲", "乙", "丙"], correct: 1 }, () => 0);
		const correctDisplay = q.display[q.order.indexOf(1)];
		const wrongDisplay = q.display[q.order.indexOf(0)];
		assert.equal(judge(q, correctDisplay).status, "correct");
		const w = judge(q, wrongDisplay);
		assert.equal(w.status, "wrong");
		assert.equal(w.pickedText, "甲");
		assert.equal(w.correctText, "乙");
		assert.equal(judge(q, `4. ${IDK}`).status, "unknown");
		assert.equal(judge(q, "不存在的选项").status, "cancelled");
	});
});

describe("viz-tools 的 mermaid 静态检查", () => {
	it("合规的依赖图通过", () => {
		const ok = 'graph TD\n  classDef done fill:#e5e5e5\n  n1["余向量：线性泛函"]:::done --> n2["余向量场"]:::todo\n  n2 --> n3["沿曲线积分"]:::todo';
		assert.deepEqual(lintMermaid(ok), []);
	});

	it("抓出未加引号的标签、标签内形状字符、非 ASCII id、重复定义、括号不平衡、未知样式类", () => {
		const bad = 'graph TD\n  n1[余向量] --> 节点2["x"]\n  n1["余向量 (dual)"]:::pending --> n3["a|b"';
		const msgs = lintMermaid(bad).map((p) => p.message);
		assert.ok(msgs.some((m) => m.includes("双引号")));
		assert.ok(msgs.some((m) => m.includes("ASCII")));
		assert.ok(msgs.some((m) => m.includes("已在第")));
		assert.ok(msgs.some((m) => m.includes("[ ] ( ) { } | $")));
		assert.ok(msgs.some((m) => m.includes("不平衡")));
		assert.ok(msgs.some((m) => m.includes("未知样式类")));
	});

	it("sequenceDiagram 与 stateDiagram-v2：参与者引号、消息与转移标签里的半角分号井号", () => {
		const seqBad = 'sequenceDiagram\n  participant A as "客户端"\n  A->>B: 发送 SYN; 等待';
		const seqMsgs = lintMermaid(seqBad).map((p) => p.message);
		assert.ok(seqMsgs.some((m) => m.includes("参与者框")));
		assert.ok(seqMsgs.some((m) => m.includes("消息文本")));
		const stateBad = 'stateDiagram-v2\n  state "关闭" as s1\n  s1 --> s2: 事件; 动作';
		assert.ok(lintMermaid(stateBad).some((p) => p.message.includes("转移标签")));
		assert.deepEqual(lintMermaid("sequenceDiagram\n  participant A as 客户端\n  A->>B: 发送 SYN"), []);
	});

	it("无法识别的图类型与空内容", () => {
		assert.ok(lintMermaid("chart XY\n a --> b").some((p) => p.message.includes("无法识别")));
		assert.ok(lintMermaid("  \n").some((p) => p.message.includes("为空")));
	});
});
