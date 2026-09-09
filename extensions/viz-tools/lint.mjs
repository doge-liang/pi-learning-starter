/**
 * viz-tools/lint.mjs —— mermaid 源码的静态检查：实现 viz-cn 技能里的语法约束。
 * 不做完整解析（那需要浏览器环境），只抓在 Obsidian 里最常见的几类解析失败与
 * 会让 edit 失去唯一锚点的写法。与 pi 无关，可在 Node 里直接测试。
 */
const DIAGRAMS = ["graph", "flowchart", "sequenceDiagram", "stateDiagram-v2", "stateDiagram", "timeline", "classDiagram", "erDiagram", "gantt", "pie", "mindmap"];
const FORBIDDEN_IN_LABEL = /[[\]{}()|$;#"]/;

/** 返回问题列表；空数组即通过。每项 { line, message } */
export function lintMermaid(source) {
	const problems = [];
	const lines = source.replace(/\r\n/g, "\n").split("\n");
	const first = lines.find((l) => l.trim() && !l.trim().startsWith("%%"));
	if (!first) return [{ line: 0, message: "内容为空" }];
	const head = first.trim();
	const kind = DIAGRAMS.find((d) => head.startsWith(d));
	if (!kind) problems.push({ line: 1, message: `无法识别的图类型：${head}` });

	const isFlow = kind === "graph" || kind === "flowchart";
	const defined = new Map();
	lines.forEach((raw, i) => {
		const n = i + 1;
		const line = raw.trim();
		if (!line || line.startsWith("%%")) return;
		if (isFlow) {
			for (const m of line.matchAll(/([^\s[\]>"-]+)\[([^\]]*)\]/g)) {
				const [, id, label] = m;
				if (!/^[A-Za-z0-9_]+$/.test(id)) problems.push({ line: n, message: `节点 id 须为 ASCII：${id}` });
				if (!/^"[^"]*"$/.test(label)) problems.push({ line: n, message: `标签须加双引号：${id}[${label}]` });
				else if (FORBIDDEN_IN_LABEL.test(label.slice(1, -1))) problems.push({ line: n, message: `标签内含半角 [ ] ( ) { } | $ ; # 或引号：${label}` });
				if (defined.has(id)) problems.push({ line: n, message: `节点 ${id} 已在第 ${defined.get(id)} 行定义，其余边只用裸 id` });
				else defined.set(id, n);
			}
			for (const m of line.matchAll(/:::([A-Za-z_]\w*)/g)) {
				if (!["done", "todo", "skip", "defer"].includes(m[1])) problems.push({ line: n, message: `未知样式类 :::${m[1]}（依赖图只用 done/todo/skip/defer；其它图请去掉）` });
			}
		}
		if (kind === "sequenceDiagram") {
			if (/^participant\s+\S+\s+as\s+"/.test(line)) problems.push({ line: n, message: "participant 的显示名不要加引号，引号会原样画进参与者框" });
			const msg = /^[^:]+(?:->>|-->>|->|-->|-x|--x|-\)|--\))[^:]*:(.*)$/.exec(line);
			if (msg && /[;#]/.test(msg[1])) problems.push({ line: n, message: "消息文本含半角分号或井号，会被截断或报错；改用全角" });
		}
		if (kind === "stateDiagram-v2" || kind === "stateDiagram") {
			const trans = /-->\s*[^:]+:(.*)$/.exec(line);
			if (trans && /[;#]/.test(trans[1])) problems.push({ line: n, message: "转移标签含半角分号或井号，会被拆成伪状态；改用全角" });
		}
	});

	// 括号平衡：flowchart 里最常见的解析失败
	if (isFlow) {
		const open = (source.match(/\[/g) ?? []).length;
		const close = (source.match(/\]/g) ?? []).length;
		if (open !== close) problems.push({ line: 0, message: `方括号不平衡：${open} 个 [ 与 ${close} 个 ]` });
	}
	return problems;
}
