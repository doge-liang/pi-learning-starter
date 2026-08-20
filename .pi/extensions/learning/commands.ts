/**
 * commands.ts —— 斜杠命令：设计稿五个流程的入口，以及学习者侧的交互（闭卷作答、术语表、复盘作答）。
 *
 * 角色会话的隔离靠 pi 的会话：/plan、/sources、/read、/review、/assess 会通过 ctx.newSession 切到新会话，
 * 目标角色通过交接文件传给新的扩展实例（见 state.ts）。当前会话尚无消息时则直接在原地进入角色。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ACCESS_LABEL, type Acquisition, type Blackboard, today } from "./blackboard.ts";
import { readConfig } from "./config.ts";
import { acquireBrief, download, downloadableUrl, libraryDirRel, libraryReport } from "./library.ts";
import { pushToRemote } from "./remote.ts";
import { kickoff, ROLES } from "./roles.ts";
import { saveToZotero } from "./zotero.ts";
import { type LearnerAnswer, type LearningState, type Role, ROLE_NAMES, writeHandoff, takeHandoff } from "./state.ts";
import { applyProposal } from "./tools.ts";

export interface CommandDeps {
	bb: Blackboard;
	state: () => LearningState;
	persist: () => void;
	/** 在当前会话原地进入角色（设置工具、模型、会话名） */
	applyRole: (role: Role | null, partial: Partial<LearningState>, sessionName: string | undefined, ctx: ExtensionCommandContext) => Promise<void>;
	note: (ctx: ExtensionCommandContext, text: string) => void;
}

export function registerCommands(pi: ExtensionAPI, deps: CommandDeps): void {
	const { bb } = deps;

	/** 进入角色：会话为空则原地进入，否则切到新会话并交接 */
	async function enter(ctx: ExtensionCommandContext, role: Role, partial: Partial<LearningState>, sessionName: string, kick: string) {
		const hasMessages = ctx.sessionManager.getBranch().some((e) => e.type === "message");
		if (!hasMessages) {
			await deps.applyRole(role, partial, sessionName, ctx);
			pi.sendUserMessage(kick);
			return;
		}
		writeHandoff(ctx.cwd, { ...partial, role, sessionName });
		const res = await ctx.newSession({
			withSession: async (c) => {
				await c.sendUserMessage(kick);
			},
		});
		if (res.cancelled) {
			takeHandoff(ctx.cwd);
			ctx.ui.notify("会话切换被取消。", "warning");
		}
	}

	pi.registerCommand("learn", {
		description: "黑板概览：掌握度、当前单元、到期复习、事件",
		handler: async (_args, ctx) => deps.note(ctx, bb.status()),
	});

	pi.registerCommand("plan", {
		description: "领域专家：规划（/plan）、增量重规划（/plan replan）、按评审意见修改最近的提案（/plan revise）",
		getArgumentCompletions: (prefix) => {
			const items = ["replan", "revise"].filter((x) => x.startsWith(prefix)).map((x) => ({ value: x, label: x }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			if (!bb.domain().domain) return ctx.ui.notify("还没有学习者画像；请先运行 /placement（先对话确定目标，再测试定位起点）。", "warning");
			const mode = args.trim();
			const replan = mode === "replan";
			const revise = mode === "revise";
			if (revise) {
				const pending = bb.latestProposal("plan");
				if (!pending || !bb.readReview(pending)) return ctx.ui.notify("没有带评审意见的待接受规划提案；先运行 /critique。", "warning");
			}
			await enter(ctx, "planner", {}, `planner ${revise ? "revise" : replan ? "replan" : "plan"} ${today()}`, kickoff("planner", { replan, revise }));
		},
	});

	pi.registerCommand("exemplar", {
		description: "提供规划范例或良好实践（课程大纲、你认可的学习路径等），供规划者与评审员参考：/exemplar <名字>",
		getArgumentCompletions: (prefix) => {
			const items = bb
				.exemplars(1)
				.map((e) => e.name)
				.filter((n) => n.startsWith(prefix))
				.map((n) => ({ value: n, label: n }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			let name = args.trim();
			if (!name) return ctx.ui.notify("用法：/exemplar <名字>，例如 /exemplar cs336-syllabus", "warning");
			if (/[\\/]/.test(name)) return ctx.ui.notify("只接受名字，不接受路径。", "warning");
			name = name.replace(/\.md$/, "");
			if (!ctx.hasUI) return ctx.ui.notify("该命令需要交互界面。", "warning");
			const rel = `exemplars/${name}.md`;
			const current = bb.readText(rel);
			const body = await ctx.ui.editor(`范例：${name}（粘贴课程大纲、学习路径或你认可的做法；可加一两句说明好在哪里）`, current);
			if (body === undefined || !body.trim()) return;
			bb.writeText(rel, body.endsWith("\n") ? body : `${body}\n`);
			ctx.ui.notify(`已保存 blackboard/${rel}；规划者与评审员会在下次进入时看到。`, "info");
		},
	});

	pi.registerCommand("critique", {
		description: "提案评审员：独立审查最近一份尚未接受的（或指定的）提案，/critique [提案文件]",
		handler: async (args, ctx) => {
			const file = args.trim() ? resolve(ctx.cwd, args.trim()) : bb.latestProposal();
			if (!file || !existsSync(file)) return ctx.ui.notify("没有待审的提案文件；先运行 /plan 或 /sources。", "warning");
			const base = file.split(/[\\/]/).pop() ?? "proposal";
			await enter(ctx, "critic", { proposal: file }, `critic ${base} ${today()}`, kickoff("critic", { proposal: file }));
		},
	});

	pi.registerCommand("accept", {
		description: "接受最近一份尚未接受的（或指定的）规划 / 资料提案，写入黑板",
		handler: async (args, ctx) => {
			const file = args.trim() ? resolve(ctx.cwd, args.trim()) : bb.latestProposal();
			if (!file || !existsSync(file)) return ctx.ui.notify("没有可接受的提案文件。", "warning");
			let summary = file;
			try {
				summary = bb.summarizeProposal(JSON.parse(readFileSync(file, "utf8")));
			} catch {
				/* 摘要失败时退回显示路径 */
			}
			// 有评审意见时一并提示：结论与各级发现数
			const review = bb.readReview(file) as { verdict?: string; counts?: { blocking?: number; major?: number; minor?: number } } | undefined;
			const reviewLine = review
				? `\n\n评审结论：${review.verdict}（blocking ${review.counts?.blocking ?? 0}，major ${review.counts?.major ?? 0}，minor ${review.counts?.minor ?? 0}）${review.verdict === "revise" ? "。评审员建议先修改：/plan revise。" : ""}`
				: "\n\n（尚未评审；可先运行 /critique 让评审员审查。）";
			const ok = ctx.hasUI ? await ctx.ui.confirm("接受提案？", `${summary}${reviewLine}\n\n接受后写入黑板。要修改请回到该角色会话说明，由其重新提交。`) : true;
			if (!ok) return;
			try {
				deps.note(ctx, applyProposal(bb, file));
			} catch (e) {
				ctx.ui.notify(String((e as Error).message ?? e), "error");
			}
		},
	});

	pi.registerCommand("verify", {
		description: "标记一份资料为已亲自核验：/verify <资料id>；无参数时从未核验列表中选择",
		getArgumentCompletions: (prefix) => {
			const items = bb
				.sources()
				.filter((s) => !s.verified && s.id.startsWith(prefix))
				.map((s) => ({ value: s.id, label: `${s.id} ${s.title}` }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			let id = args.trim();
			if (!id) {
				const pending = bb.sources().filter((s) => !s.verified);
				if (!pending.length) return ctx.ui.notify("所有资料都已核验。", "info");
				if (!ctx.hasUI) return ctx.ui.notify("用法：/verify <资料id>", "warning");
				const pick = await ctx.ui.select("选择已亲自核验的资料", pending.map((s) => `${s.id}  ${s.title}`));
				if (!pick) return;
				id = pick.split(/\s+/)[0];
			}
			const s = bb.sources().find((x) => x.id === id);
			if (!s) return ctx.ui.notify(`资料 ${id} 不在 sources.json 中。`, "warning");
			const ok = ctx.hasUI ? await ctx.ui.confirm("确认核验？", `${s.title}\n${s.locator ?? ""}\n\n你已亲自打开这份资料，确认它存在且适合对应单元？`) : true;
			if (!ok) return;
			bb.verifySource(id, true);
			ctx.ui.notify(`已标记 ${id} 为已核验。`, "info");
		},
	});

	pi.registerCommand("sources", {
		description: "资料管理员：为尚无资料的单元匹配资料；/sources <unit> <障碍说明> 请求替代资料",
		handler: async (args, ctx) => {
			const [unit, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const note = rest.join(" ");
			const units = unit ? [unit] : bb.units().filter((u) => !u.sources?.length).map((u) => u.id);
			if (!units.length) return ctx.ui.notify("所有单元都已有资料；要请求替代资料请指定单元与障碍说明，要整理馆藏请运行 /curate。", "info");
			await enter(ctx, "librarian", { unit }, `librarian ${today()}`, kickoff("librarian", { units, unit, note: note || undefined }));
		},
	});

	pi.registerCommand("curate", {
		description: "资料管理员：整理馆藏（合并重复、下线失效、排定阅读顺序、打标签、列出缺口）；/curate [unit]",
		getArgumentCompletions: (prefix) => {
			const items = bb.units().filter((u) => u.id.startsWith(prefix)).map((u) => ({ value: u.id, label: `${u.id} ${u.title}` }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			if (!bb.sources().length) return ctx.ui.notify("馆藏为空；先运行 /sources 选材。", "warning");
			const unit = args.trim() || undefined;
			await enter(ctx, "librarian", { unit }, `librarian curate ${today()}`, kickoff("librarian", { curate: true, unit }));
		},
	});

	pi.registerCommand("library", {
		description: "馆藏概览：按单元列出资料、获取与核验状态、本地副本与入库情况、覆盖缺口；/library [unit]",
		getArgumentCompletions: (prefix) => {
			const items = bb.units().filter((u) => u.id.startsWith(prefix)).map((u) => ({ value: u.id, label: `${u.id} ${u.title}` }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			if (!bb.sources().length) return ctx.ui.notify("馆藏为空；先运行 /sources 选材。", "info");
			deps.note(ctx, libraryReport(bb, ctx.cwd, readConfig(ctx.cwd).library, args.trim() || undefined));
		},
	});

	pi.registerCommand("collect", {
		description: "获取一份资料并登记：下载或填写本地路径，可选入 Zotero 与网盘；/collect <资料id>",
		getArgumentCompletions: (prefix) => {
			const items = bb
				.activeSources()
				.filter((s) => s.acquisition?.status !== "obtained" && s.id.startsWith(prefix))
				.map((s) => ({ value: s.id, label: `${s.id} ${s.title}` }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => runCollect(args.trim(), ctx),
	});

	/**
	 * 收集一份资料：呈现获取清单 → 取得本地副本（下载或学习者自己给路径）→ 可选入 Zotero 与网盘 → 登记台账。
	 * 下载与入库都是对外动作，每一步都先经确认框；模型没有进入这条路径的入口。
	 */
	async function runCollect(idArg: string, ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI) return ctx.ui.notify("该命令需要交互界面（下载与入库都要逐步确认）。", "warning");
		const cfg = readConfig(ctx.cwd);
		let id = idArg;
		if (!id) {
			const pending = bb.activeSources().filter((s) => s.acquisition?.status !== "obtained");
			if (!pending.length) return ctx.ui.notify("在架资料都已登记为已获取。", "info");
			const pick = await ctx.ui.select("选择要获取的资料", pending.map((s) => `${s.id}  ${s.title}`));
			if (!pick) return;
			id = pick.split(/\s+/)[0];
		}
		const source = bb.sources().find((x) => x.id === id);
		if (!source) return ctx.ui.notify(`资料 ${id} 不在 sources.json 中。`, "warning");
		deps.note(ctx, acquireBrief(source));

		const patch: Partial<Acquisition> = {};
		let localRel = source.acquisition?.local_path;

		// 1. 本地副本：先试直链下载，失败或没有直链时让学习者给出自己已获取的路径
		const url = downloadableUrl(source);
		if (!localRel && url) {
			const ok = await ctx.ui.confirm(
				"下载这份资料？",
				`${source.title}\n获取等级：${ACCESS_LABEL[source.access ?? "unknown"]}\n${url}\n\n保存到 ${libraryDirRel(cfg.library)}/。请先确认这是合法的公开获取渠道；付费墙与盗版站点不要下载。`,
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
				? `已登记 ${id} 为已获取${localRel ? `（${localRel}）` : ""}。亲自打开确认后运行 /verify ${id}。`
				: `已登记 ${id} 的获取状态为 ${patch.status}。${patch.status === "unavailable" ? `换一份更易得的资料：/sources ${source.for_units?.[0] ?? ""} 拿不到这份资料` : ""}`,
			"info",
		);
	}

	pi.registerCommand("read", {
		description: "陪读老师：开始某单元的阅读会话（缺省为当前单元）",
		getArgumentCompletions: (prefix) => {
			const items = bb
				.units()
				.filter((u) => u.status !== "done" && u.id.startsWith(prefix))
				.map((u) => ({ value: u.id, label: `${u.id} ${u.title}` }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const unit = args.trim() ? bb.findUnit(args.trim()) : bb.nextUnit();
			if (!unit) return ctx.ui.notify("没有可学习的单元；先运行 /plan 与 /sources。", "warning");
			const units = bb.units();
			for (const u of units) if (u.id === unit.id) u.status = "active";
			bb.saveUnits(units);
			await enter(ctx, "tutor", { unit: unit.id, mode: "hint", prequestions: [], answers: [] }, `tutor ${unit.id} ${today()}`, kickoff("tutor"));
		},
	});

	pi.registerCommand("hint", {
		description: "陪读老师切换到最小提示模式（默认）",
		handler: async (_args, ctx) => setMode(ctx, "hint"),
	});
	pi.registerCommand("explain", {
		description: "陪读老师切换到讲解模式（仍会先要求你陈述理解）",
		handler: async (_args, ctx) => setMode(ctx, "explain"),
	});
	async function setMode(ctx: ExtensionCommandContext, mode: "hint" | "explain") {
		const state = deps.state();
		if (state.role !== "tutor") return ctx.ui.notify("当前不在陪读会话中。", "warning");
		state.mode = mode;
		state.contextHash = undefined;
		deps.persist();
		ctx.ui.notify(`已切换到 ${mode} 模式。`, "info");
	}

	pi.registerCommand("answer", {
		description: "闭卷回答本会话的预问题（逐题输入并给出信心 1–5）",
		handler: async (_args, ctx) => {
			const state = deps.state();
			if (state.role !== "tutor") return ctx.ui.notify("当前不在陪读会话中。", "warning");
			if (!state.prequestions.length) return ctx.ui.notify("本会话还没有预问题；请等陪读老师调用 bb_prequestions。", "warning");
			const answers = await collect(ctx, state.prequestions.map((q) => ({ id: q.id, prompt: `${q.id}: ${q.text}` })), "闭卷作答：不要翻资料。");
			if (!answers) return;
			state.answers = answers;
			deps.persist();
			pi.sendUserMessage(`[mode: ${state.mode}] [closed-book answers] 请逐题批改（不含信心评分）：\n\n${answers.map((a) => `${a.id}: ${a.answer}`).join("\n\n")}`);
		},
	});

	pi.registerCommand("gloss", {
		description: "为某概念写术语表条目（自己的话）并请陪读老师核对：/gloss <概念id>",
		getArgumentCompletions: (prefix) => {
			const items = bb.concepts().filter((c) => c.id.startsWith(prefix)).map((c) => ({ value: c.id, label: `${c.id} ${c.name}` }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const state = deps.state();
			const id = args.trim();
			const c = bb.conceptIndex().get(id);
			if (!c) return ctx.ui.notify(`概念 ${id || "（未指定）"} 不在 concepts.json 中。`, "warning");
			const body = await ctx.ui.editor(`术语表条目：${c.name}（用自己的话；先占位，理解加深后再改为完整）`, "");
			if (!body?.trim()) return;
			const entry = `\n## ${c.name} <!-- id: ${c.id} -->\n状态：占位\n依赖：${c.prereqs?.length ? c.prereqs.join(", ") : "无"}\n\n${body.trim()}\n`;
			bb.appendText("glossary.md", entry);
			ctx.ui.notify("已写入 glossary.md。", "info");
			if (state.role === "tutor") pi.sendUserMessage(`[mode: ${state.mode}] [glossary check] 请核对以下术语表条目：\n${entry}`);
		},
	});

	pi.registerCommand("done", {
		description: "结束陪读会话：请陪读老师提交证据（bb_evidence）",
		handler: async (_args, ctx) => {
			const state = deps.state();
			if (state.role !== "tutor") return ctx.ui.notify("当前不在陪读会话中。", "warning");
			pi.sendUserMessage(`[mode: ${state.mode}] [end-session] 请调用 bb_evidence 提交本会话的结构化证据。`);
		},
	});

	pi.registerCommand("review", {
		description: "评审员：评审你的产出物，/review <文件> [单元id]",
		handler: async (args, ctx) => {
			const [file, unit] = args.trim().split(/\s+/).filter(Boolean);
			if (!file) return ctx.ui.notify("用法：/review <文件路径> [单元id]", "warning");
			const abs = resolve(ctx.cwd, file);
			if (!existsSync(abs)) return ctx.ui.notify(`文件不存在：${abs}`, "warning");
			await enter(ctx, "reviewer", { artifact: abs, unit }, `reviewer ${file} ${today()}`, kickoff("reviewer", { artifact: abs, unit }));
		},
	});

	pi.registerCommand("assess", {
		description: "复盘老师：生成一次闭卷检索测试，/assess [题数上限]",
		handler: async (args, ctx) => {
			const maxItems = Number.parseInt(args.trim(), 10) || 8;
			if (!bb.concepts().length) return ctx.ui.notify("还没有可考核的概念。", "warning");
			await enter(ctx, "assessor", {}, `assessor generate ${today()}`, kickoff("assessor", { maxItems }));
		},
	});

	pi.registerCommand("placement", {
		description: "水平测试官：先对话确定领域、目标与背景（写入画像），再出诊断题定位起点；/placement [题数上限]；作答用 /take",
		handler: async (args, ctx) => {
			const existing = Boolean(bb.domain().domain);
			const maxItems = Number.parseInt(args.trim(), 10) || 10;
			await enter(ctx, "placement", {}, `placement ${today()}`, kickoff("placement", { maxItems, existing }));
		},
	});

	pi.registerCommand("take", {
		description: "闭卷作答最近一次（或指定的）测试——复盘测试交给复盘老师、水平测试交给水平测试官批改",
		handler: async (args, ctx) => {
			// 待作答的测试可能在 assessments/（复盘）或 placement/（入学诊断）；取最近写入的一份
			let rel: string | undefined;
			const arg = args.trim();
			if (arg) {
				const base = arg.replace(/^.*[\\/]/, "");
				rel = arg.includes("placement") ? `placement/${base}` : `assessments/${base}`;
			} else {
				const candidates = [
					...bb.listFiles("assessments", "pending-", ".json").map((f) => `assessments/${f}`),
					...bb.listFiles("placement", "pending-", ".json").map((f) => `placement/${f}`),
				];
				candidates.sort((a, b) => statSync(bb.path(a)).mtimeMs - statSync(bb.path(b)).mtimeMs);
				rel = candidates[candidates.length - 1];
			}
			if (!rel || !existsSync(bb.path(rel))) return ctx.ui.notify("没有待作答的测试；先运行 /assess（复盘）或 /placement（水平测试）。", "warning");
			const isPlacement = rel.startsWith("placement/");
			const test = bb.readJson<{ items: Array<{ id: string; type: string; concept?: string; area?: string; level?: string; question: string }> }>(rel, { items: [] });
			const responses = await collect(
				ctx,
				test.items.map((it) => ({ id: it.id, prompt: `[${it.id} · ${it.type} · ${isPlacement ? `${it.area} · ${it.level}` : it.concept}]\n${it.question}` })),
				isPlacement ? "水平测试，闭卷作答：不确定就写不知道，这是为了定位起点，不是考核。" : "闭卷作答：不要翻资料，不要查术语表。",
			);
			if (!responses) return;
			const state = deps.state();
			const role = isPlacement ? "placement" : "assessor";
			const msg = isPlacement
				? `[grade-placement] 学习者已完成水平测试 ${rel}。作答如下（含信心 1–5）：\n${JSON.stringify(responses, null, 1)}\n请按 rubric 逐题评分并调用 bb_placement_grade。`
				: `[grade] 学习者已完成测试 ${rel}。作答如下（含信心 1–5）：\n${JSON.stringify(responses, null, 1)}\n请按 rubric 逐题评分并调用 bb_grade。`;
			if (state.role === role) {
				state.testFile = rel;
				state.responses = responses;
				state.contextHash = undefined;
				deps.persist();
				pi.sendUserMessage(msg);
			} else {
				await enter(ctx, role, { testFile: rel, responses }, `${role} grade ${today()}`, msg);
			}
		},
	});

	pi.registerCommand("reflect", {
		description: "亲笔写复盘：在最近一份（或指定的）复盘提纲后作答，/reflect [文件]",
		handler: async (args, ctx) => {
			const outlines = bb.listFiles("reflections", "", "-outline.md");
			const rel = args.trim() ? `reflections/${args.trim().replace(/^.*reflections[\\/]/, "")}` : outlines.length ? `reflections/${outlines[outlines.length - 1]}` : undefined;
			if (!rel || !existsSync(bb.path(rel))) return ctx.ui.notify("没有复盘提纲；先完成一次 /take 与批改。", "warning");
			if (!ctx.hasUI) return ctx.ui.notify("该命令需要交互界面。", "warning");
			const current = bb.readText(rel);
			const edited = await ctx.ui.editor(`复盘：${rel}（提纲之后「我的复盘」一节由你亲笔作答）`, current);
			if (edited === undefined || edited === current) return ctx.ui.notify("未修改。", "info");
			bb.writeText(rel, edited.endsWith("\n") ? edited : `${edited}\n`);
			ctx.ui.notify(`已保存 ${rel}。`, "info");
		},
	});

	pi.registerCommand("artifact", {
		description: "写一份产出物到 blackboard/artifacts/：/artifact <文件名>（缺省扩展名 .md），然后可 /review",
		handler: async (args, ctx) => {
			let name = args.trim();
			if (!name) return ctx.ui.notify("用法：/artifact <文件名>", "warning");
			if (!/\.[a-z0-9]+$/i.test(name)) name += ".md";
			if (/[\\/]/.test(name)) return ctx.ui.notify("只接受文件名，不接受路径。", "warning");
			if (!ctx.hasUI) return ctx.ui.notify("该命令需要交互界面。", "warning");
			const rel = `artifacts/${name}`;
			const current = bb.readText(rel);
			const body = await ctx.ui.editor(`产出物：${rel}（在无 AI 协助下完成）`, current);
			if (body === undefined || !body.trim()) return;
			bb.writeText(rel, body.endsWith("\n") ? body : `${body}\n`);
			ctx.ui.notify(`已保存 blackboard/${rel}。评审：/review blackboard/${rel} [单元id]`, "info");
		},
	});

	pi.registerCommand("events", {
		description: "查看黑板上的未处理事件",
		handler: async (_args, ctx) => {
			const ev = bb.unhandledEvents();
			deps.note(ctx, ev.length ? ev.map((e) => `${e.ts}  ${e.type}  ${JSON.stringify(e.payload)}`).join("\n") + "\n\n运行 /dispatch 处理第一条。" : "没有未处理事件。");
		},
	});

	pi.registerCommand("dispatch", {
		description: "处理第一条未处理事件：structure_ready/resource_request/sources_gap → 馆员；unit_complete/errors_threshold → 考评官；replan_request → 规划者",
		handler: async (_args, ctx) => {
			const ev = bb.unhandledEvents()[0];
			if (!ev) return ctx.ui.notify("没有未处理事件。", "info");
			switch (ev.type) {
				case "structure_ready": {
					const units = bb.units().filter((u) => !u.sources?.length).map((u) => u.id);
					if (!units.length) {
						bb.markHandled(["structure_ready"]);
						return ctx.ui.notify("所有单元已有资料，事件已标记处理。", "info");
					}
					return enter(ctx, "librarian", {}, `librarian ${today()}`, kickoff("librarian", { units }));
				}
				case "resource_request": {
					const unit = String(ev.payload.unit ?? "");
					return enter(ctx, "librarian", { unit }, `librarian alt ${unit}`, kickoff("librarian", { unit, note: String(ev.payload.note ?? "未说明") }));
				}
				case "sources_gap": {
					// 整段单元缺资料 → 补料（新提案）；只是概念没被覆盖 → 整理并列出缺口
					const units = Array.isArray(ev.payload.units) ? (ev.payload.units as string[]) : [];
					if (units.length) return enter(ctx, "librarian", {}, `librarian gap ${today()}`, kickoff("librarian", { units }));
					return enter(ctx, "librarian", {}, `librarian curate ${today()}`, kickoff("librarian", { curate: true }));
				}
				case "unit_complete":
				case "errors_threshold":
					return enter(ctx, "assessor", {}, `assessor generate ${today()}`, kickoff("assessor", { maxItems: 8 }));
				case "replan_request":
					return enter(ctx, "planner", {}, `planner replan ${today()}`, kickoff("planner", { replan: true }));
				default:
					bb.markHandled([ev.type]);
					return ctx.ui.notify(`未知事件 ${ev.type} 已标记处理。`, "warning");
			}
		},
	});

	pi.registerCommand("role", {
		description: "在当前会话原地切换角色（高级用法）：/role <planner|librarian|tutor|reviewer|assessor|none>",
		getArgumentCompletions: (prefix) => {
			const items = [...ROLE_NAMES, "none"].filter((r) => r.startsWith(prefix)).map((r) => ({ value: r, label: r }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const r = args.trim();
			if (r === "none") {
				await deps.applyRole(null, {}, undefined, ctx);
				ctx.ui.notify("已退出角色，恢复默认工具。", "info");
				return;
			}
			if (!ROLE_NAMES.includes(r as Role)) return ctx.ui.notify(`未知角色：${r}`, "warning");
			await deps.applyRole(r as Role, {}, undefined, ctx);
			ctx.ui.notify(`已进入 ${ROLES[r as Role].label}。`, "info");
		},
	});
}

/** 项目内的路径统一存成相对项目根的 POSIX 形式，项目外的保持绝对路径（黑板要能跨机器读） */
function toProjectRelative(cwd: string, p: string): string {
	const abs = isAbsolute(p) ? p : resolve(cwd, p);
	const rel = relative(cwd, abs);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(/[\\/]/).join("/") : abs;
}

function absolutize(cwd: string, p: string): string {
	return isAbsolute(p) ? p : join(cwd, p);
}

/** 逐题弹出编辑器与信心选择；任一步取消则返回 null */
async function collect(ctx: ExtensionCommandContext, items: Array<{ id: string; prompt: string }>, banner: string): Promise<LearnerAnswer[] | null> {
	if (!ctx.hasUI) {
		ctx.ui.notify("该命令需要交互界面。", "warning");
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
