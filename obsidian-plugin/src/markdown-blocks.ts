/**
 * markdown-blocks.ts —— 流式渲染用的纯函数：按块切分、临时闭合围栏。与 Obsidian 无关，可在 Node 里测试。
 */

/**
 * 按空行切块，围栏代码内的空行不算边界。返回已完成的块与末尾未完成的块。
 * 末尾块即使以空行结尾也视为未完成：下一段可能紧接着来（列表、表格续行）。
 */
export function splitBlocks(text: string): { blocks: string[]; tail: string } {
	const lines = text.split("\n");
	const blocks: string[] = [];
	let cur: string[] = [];
	let fence: string | null = null;
	const flush = () => {
		const body = cur.join("\n").replace(/\s+$/, "");
		if (body) blocks.push(body);
		cur = [];
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
		if (m) {
			if (!fence) fence = m[1];
			else if (line.trim().startsWith(fence[0].repeat(fence.length))) fence = null;
		}
		if (!fence && line.trim() === "" && cur.length) {
			flush();
			continue;
		}
		cur.push(line);
	}
	// 最后一块始终是 tail（可能为空）
	const tail = cur.join("\n");
	return { blocks, tail };
}

/** 末尾块里是否有未闭合的围栏（重绘节流用：闭合后的代码块每次重绘都要全量重新高亮，代价大） */
export function hasOpenFence(text: string): boolean {
	let fence: string | null = null;
	for (const line of text.split("\n")) {
		const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
		if (!m) continue;
		if (!fence) fence = m[1];
		else if (line.trim().startsWith(fence[0].repeat(fence.length))) fence = null;
	}
	return fence !== null;
}

/** 末尾块里有未闭合的围栏时临时补上，避免把后续文本当成代码 */
export function closeOpenFence(text: string): string {
	let fence: string | null = null;
	for (const line of text.split("\n")) {
		const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
		if (!m) continue;
		if (!fence) fence = m[1];
		else if (line.trim().startsWith(fence[0].repeat(fence.length))) fence = null;
	}
	return fence ? `${text}\n${fence}` : text;
}
