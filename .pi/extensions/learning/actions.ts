/**
 * actions.ts —— 学习者侧的对话框流程：闭卷作答、核验、收集入库、编辑器（产出物 / 范例 / 复盘 / 术语表）。
 *
 * 这些流程原先散在各斜杠命令里；界面收敛后由两条路径共用：
 * - /go <route>（命令上下文，学习者或路由询问派发）
 * - 前台 / 陪读老师的 bb_* 工具（工具上下文，模型在恰当时机触发）
 * 两条路径的每一步仍以对话框收口：下载、入库、核验、作答的内容与裁决都在学习者手里。
 */
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ACCESS_LABEL, type Acquisition, type Blackboard, today } from "./blackboard.ts";
import { readConfig } from "./config.ts";
import { acquireBrief, download, downloadableUrl, libraryDirRel } from "./library.ts";
import { pushToRemote } from "./remote.ts";
import { saveToZotero } from "./zotero.ts";
import type { LearnerAnswer } from "./state.ts";

/** 逐题弹出编辑器与信心选择；任一步取消则返回 null */
export async function collectAnswers(ctx: ExtensionContext, items: Array<{ id: string; prompt: string }>, banner: string): Promise<LearnerAnswer[] | null> {
	if (!ctx.hasUI) {
		ctx.ui.notify("闭卷作答需要交互界面。", "warning");
		return null;
	}
	ctx.ui.notify(banner, "info");
	const out: LearnerAnswer[] = [];
	for (const it of items) {
		const answer = await ctx.ui.editor(it.prompt, "");
		if (answer === undefined) return null;
		const conf = await ctx.ui.select("信心（1 完全猜测 … 5 确定）", ["1", "2", "3", "4", "5"]);
		if (conf === undefined) return null;
		out.push({ id: it.id, answer: answer.trim(), confidence: Number(conf) });
	}
	return out;
}

/** 核验：学习者确认已亲自打开资料。verified 只有这一条路径。 */
export async function runVerify(bb: Blackboard, ctx: ExtensionContext, idArg: string): Promise<boolean> {
	let id = idArg.trim();
	if (!id) {
		const pending = bb.sources().filter((s) => !s.verified);
		if (!pending.length) {
			ctx.ui.notify("所有资料都已核验。", "info");
			return false;
		}
		if (!ctx.hasUI) return false;
		const pick = await ctx.ui.select("选择已亲自核验的资料", pending.map((s) => `${s.id}  ${s.title}`));
		if (!pick) return false;
		id = pick.split(/\s+/)[0];
	}
	const s = bb.sources().find((x) => x.id === id);
	if (!s) {
		ctx.ui.notify(`资料 ${id} 不在 sources.json 中。`, "warning");
		return false;
	}
	const ok = ctx.hasUI
		? await ctx.ui.confirm("确认核验？", `${s.title}\n${s.locator ?? ""}\n\n只有你已亲自打开这份资料、确认它存在且适合对应单元时才确认；还没打开就选取消。`)
		: false;
	if (!ok) return false;
	bb.verifySource(id, true);
	ctx.ui.notify(`已标记 ${id} 为已核验。`, "info");
	return true;
}

/**
 * 收集一份资料：呈现获取清单 → 取得本地副本（下载或学习者自己给路径）→ 可选入 Zotero 与网盘 → 登记台账。
 * 下载与入库都是对外动作，每一步都先经确认框。
 */
export async function runCollect(bb: Blackboard, ctx: ExtensionContext, note: (text: string) => void, idArg: string): Promise<void> {
	if (!ctx.hasUI) return ctx.ui.notify("获取入库需要交互界面（下载与入库都要逐步确认）。", "warning");
	const cfg = readConfig(ctx.cwd);
	let id = idArg.trim();
	if (!id) {
		const pending = bb.activeSources().filter((s) => s.acquisition?.status !== "obtained");
		if (!pending.length) return ctx.ui.notify("在架资料都已登记为已获取。", "info");
		const pick = await ctx.ui.select("选择要获取的资料", pending.map((s) => `${s.id}  ${s.title}`));
		if (!pick) return;
		id = pick.split(/\s+/)[0];
	}
	const source = bb.sources().find((x) => x.id === id);
	if (!source) return ctx.ui.notify(`资料 ${id} 不在 sources.json 中。`, "warning");
	note(acquireBrief(source));

	const patch: Partial<Acquisition> = {};
	let localRel = source.acquisition?.local_path;

	// 1. 本地副本：先试直链下载，失败或没有直链时让学习者给出自己已获取的路径
	const url = downloadableUrl(source);
	if (!localRel && url) {
		const ok = await ctx.ui.confirm(
			"下载这份资料？",
			`${source.title}\n获取等级：${ACCESS_LABEL[source.access ?? "unknown"]}\n${url}\n\n保存到 ${libraryDirRel(cfg.library)}/。`,
		);
		if (ok) {
			try {
				const d = await download(url, { cwd: ctx.cwd, cfg: cfg.library, id: source.id, signal: ctx.signal });
				localRel = d.rel;
				ctx.ui.notify(
					`已下载 ${d.rel}（${(d.bytes / 1024).toFixed(0)} KB）${d.looksLikeLandingPage ? "；返回的是 HTML 页面，可能只是落地页而非资料本身，请打开确认" : ""}`,
					d.looksLikeLandingPage ? "warning" : "info",
				);
			} catch (e) {
				ctx.ui.notify(`下载失败：${(e as Error).message}`, "warning");
			}
		}
	}
	if (!localRel) {
		const p = await ctx.ui.input("本地文件路径（已自行获取时填写；留空则只登记获取状态）", "例如 D:/books/deep-learning.pdf");
		if (p?.trim()) {
			const rel = toProjectRelative(ctx.cwd, p.trim());
			if (!existsSync(absolutize(ctx.cwd, rel))) ctx.ui.notify(`路径不存在，仍按你填的登记：${rel}`, "warning");
			localRel = rel;
		}
	}

	// 2. 获取状态：有本地副本即已获取；纸质书等没有文件的情形由学习者自己选
	if (localRel) {
		patch.status = "obtained";
		patch.local_path = localRel;
	} else {
		const pick = await ctx.ui.select("登记获取状态", ["obtained  已获取（纸质书或已存在别处）", "pending  还没拿到", "unavailable  暂无渠道"]);
		if (!pick) return;
		patch.status = pick.split(/\s+/)[0] as Acquisition["status"];
	}
	const localAbs = localRel ? absolutize(ctx.cwd, localRel) : undefined;

	// 3. Zotero：未配置时走 file 模式写 CSL-JSON，学习者在 Zotero 里导入
	const zoteroMode = cfg.zotero?.mode ?? "file";
	if (patch.status === "obtained") {
		const ok = await ctx.ui.confirm(
			"把题录送进 Zotero？",
			`${source.title}\n模式：${zoteroMode}${zoteroMode === "file" ? "（写出 CSL-JSON，之后在 Zotero 里「文件 → 导入」）" : zoteroMode === "connector" ? "（本地 Zotero 桌面端需正在运行）" : "（Zotero Web API，会上传本地副本作为附件）"}`,
		);
		if (ok) {
			try {
				const r = await saveToZotero(source, { cwd: ctx.cwd, cfg: cfg.zotero, library: cfg.library, localAbs, signal: ctx.signal });
				patch.zotero = { mode: r.mode, key: r.key, file: r.file, at: today() };
				ctx.ui.notify(r.message, "info");
			} catch (e) {
				ctx.ui.notify(`Zotero 入库失败：${(e as Error).message}`, "warning");
			}
		}
	}

	// 4. 网盘：只有存在本地副本且配置了目标时才提议
	if (localAbs && cfg.remote?.mode) {
		const ok = await ctx.ui.confirm("把本地副本送进网盘？", `${localRel}\n模式：${cfg.remote.mode}${cfg.remote.mode === "folder" ? `　目录：${cfg.remote.dir ?? "（未配置）"}` : `　地址：${cfg.remote.url ?? "（未配置）"}`}`);
		if (ok) {
			try {
				const r = await pushToRemote(source, localAbs, { cfg: cfg.remote, signal: ctx.signal });
				patch.remote = { provider: r.provider, path: r.path, at: today() };
				ctx.ui.notify(r.message, "info");
			} catch (e) {
				ctx.ui.notify(`网盘入库失败：${(e as Error).message}`, "warning");
			}
		}
	}

	patch.at = today();
	bb.recordAcquisition(id, patch);
	ctx.ui.notify(
		patch.status === "obtained"
			? `已登记 ${id} 为已获取${localRel ? `（${localRel}）` : ""}。亲自打开确认后再核验（对前台说，或 /go verify ${id}）。`
			: `已登记 ${id} 的获取状态为 ${patch.status}。${patch.status === "unavailable" ? "拿不到时告诉前台，请资料管理员换一份更易得的。" : ""}`,
		"info",
	);
}

/** 产出物编辑器：在无 AI 协助下写练习、推导或复述。返回保存的相对路径（blackboard/ 下）。 */
export async function editArtifact(bb: Blackboard, ctx: ExtensionContext, nameArg: string): Promise<string | null> {
	let name = nameArg.trim();
	if (!name) {
		ctx.ui.notify("需要一个文件名，例如 u01-graph。", "warning");
		return null;
	}
	if (!/\.[a-z0-9]+$/i.test(name)) name += ".md";
	if (/[\\/]/.test(name)) {
		ctx.ui.notify("只接受文件名，不接受路径。", "warning");
		return null;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify("该操作需要交互界面。", "warning");
		return null;
	}
	const rel = `artifacts/${name}`;
	const current = bb.readText(rel);
	const body = await ctx.ui.editor(`产出物：${rel}（在无 AI 协助下完成）`, current);
	if (body === undefined || !body.trim()) return null;
	bb.writeText(rel, body.endsWith("\n") ? body : `${body}\n`);
	ctx.ui.notify(`已保存 blackboard/${rel}。要评审时对前台说，或 /go review blackboard/${rel} [单元id]。`, "info");
	return rel;
}

/** 规划范例编辑器：粘贴课程大纲或良好实践，供规划者与评审员参考 */
export async function editExemplar(bb: Blackboard, ctx: ExtensionContext, nameArg: string): Promise<string | null> {
	let name = nameArg.trim();
	if (!name) {
		ctx.ui.notify("需要一个名字，例如 cs336-syllabus。", "warning");
		return null;
	}
	if (/[\\/]/.test(name)) {
		ctx.ui.notify("只接受名字，不接受路径。", "warning");
		return null;
	}
	name = name.replace(/\.md$/, "");
	if (!ctx.hasUI) {
		ctx.ui.notify("该操作需要交互界面。", "warning");
		return null;
	}
	const rel = `exemplars/${name}.md`;
	const current = bb.readText(rel);
	const body = await ctx.ui.editor(`范例：${name}（粘贴课程大纲、学习路径或你认可的做法；可加一两句说明好在哪里）`, current);
	if (body === undefined || !body.trim()) return null;
	bb.writeText(rel, body.endsWith("\n") ? body : `${body}\n`);
	ctx.ui.notify(`已保存 blackboard/${rel}；规划者与评审员会在下次进入时看到。`, "info");
	return rel;
}

/** 复盘编辑器：在最近一份（或指定的）复盘提纲后亲笔作答 */
export async function editReflection(bb: Blackboard, ctx: ExtensionContext, fileArg: string): Promise<boolean> {
	const outlines = bb.listFiles("reflections", "", "-outline.md");
	const rel = fileArg.trim()
		? `reflections/${fileArg.trim().replace(/^.*reflections[\\/]/, "")}`
		: outlines.length
			? `reflections/${outlines[outlines.length - 1]}`
			: undefined;
	if (!rel || !existsSync(bb.path(rel))) {
		ctx.ui.notify("没有复盘提纲；先完成一次闭卷测试与批改。", "warning");
		return false;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify("该操作需要交互界面。", "warning");
		return false;
	}
	const current = bb.readText(rel);
	const edited = await ctx.ui.editor(`复盘：${rel}（提纲之后「我的复盘」一节由你亲笔作答）`, current);
	if (edited === undefined || edited === current) {
		ctx.ui.notify("未修改。", "info");
		return false;
	}
	bb.writeText(rel, edited.endsWith("\n") ? edited : `${edited}\n`);
	ctx.ui.notify(`已保存 ${rel}。`, "info");
	return true;
}

/** 术语表编辑器：用自己的话写条目并追加到 glossary.md。返回条目全文（供陪读老师核对）。 */
export async function editGloss(bb: Blackboard, ctx: ExtensionContext, conceptId: string): Promise<string | null> {
	const c = bb.conceptIndex().get(conceptId.trim());
	if (!c) {
		ctx.ui.notify(`概念 ${conceptId.trim() || "（未指定）"} 不在 concepts.json 中。`, "warning");
		return null;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify("该操作需要交互界面。", "warning");
		return null;
	}
	const body = await ctx.ui.editor(`术语表条目：${c.name}（用自己的话；先占位，理解加深后再改为完整）`, "");
	if (!body?.trim()) return null;
	const entry = `\n## ${c.name} <!-- id: ${c.id} -->\n状态：占位\n依赖：${c.prereqs?.length ? c.prereqs.join(", ") : "无"}\n\n${body.trim()}\n`;
	bb.appendText("glossary.md", entry);
	ctx.ui.notify("已写入 glossary.md。", "info");
	return entry;
}

/** 项目内的路径统一存成相对项目根的 POSIX 形式，项目外的保持绝对路径（黑板要能跨机器读） */
export function toProjectRelative(cwd: string, p: string): string {
	const abs = isAbsolute(p) ? p : resolve(cwd, p);
	const rel = relative(cwd, abs);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(/[\\/]/).join("/") : abs;
}

function absolutize(cwd: string, p: string): string {
	return isAbsolute(p) ? p : join(cwd, p);
}
