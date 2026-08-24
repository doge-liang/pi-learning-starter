/**
 * index.ts —— 学习工作流扩展入口。
 *
 * 结构映射（设计稿 → pi）：
 * - 黑板              → 项目里的 blackboard/ 目录（blackboard.ts）
 * - 八个角色          → 八段系统提示 + 各自的工具白名单（roles.ts），通过 before_agent_start 注入
 * - 规则在代码        → bb_* 工具内部的状态机与阈值（tools.ts、blackboard.ts、route.ts）
 * - 角色会话隔离      → pi 会话：/go 路由用 ctx.newSession 切换，角色经交接文件传递（state.ts）
 * - 学习者交互        → 默认进入前台角色对话；推进与闸门经对话框收口（bb_route_ask、尾部询问、
 *                       actions.ts 的收集 / 核验 / 编辑器流程）；仅存 /learn 与内部 /go 两个命令
 * - 定时触发          → LEARN_ROLE=assessor pi -p -a "..."（见 scripts/）
 */
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Blackboard, shortHash } from "./blackboard.ts";
import { registerCommands } from "./commands.ts";
import { readConfig } from "./config.ts";
import { groupTranscriptSection } from "./group.ts";
import { buildContext, READ_TOOLS, ROLES } from "./roles.ts";
import { hubMode } from "./route.ts";
import { emptyState, type LearningState, persist as persistState, restore, type Role, ROLE_NAMES, takeHandoff } from "./state.ts";
import { registerTools } from "./tools.ts";

export default function (pi: ExtensionAPI) {
	const bb = new Blackboard(process.cwd());
	let state: LearningState = emptyState();
	const sessionsDir = join(getAgentDir(), "sessions");

	const persist = () => persistState(pi, state);

	/** 进入（或退出）角色：设置工具白名单、模型偏好、会话名与状态栏 */
	async function applyRole(role: Role | null, partial: Partial<LearningState>, sessionName: string | undefined, ctx: ExtensionContext) {
		state = { ...state, ...partial, role, contextHash: undefined };
		if (role) state.optOut = undefined; // 重新进入任一角色即视为回到学习模式
		if (role) {
			pi.setActiveTools([...READ_TOOLS, ...ROLES[role].tools]);
			const pref = readConfig(ctx.cwd).models?.[role];
			if (pref) {
				const [provider, ...rest] = pref.split("/");
				const model = ctx.modelRegistry.find(provider, rest.join("/"));
				if (model) await pi.setModel(model);
			}
			if (sessionName) pi.setSessionName(sessionName);
			if (ctx.hasUI) {
				const extra = [state.unit, role === "tutor" ? state.mode : undefined].filter(Boolean).join(" · ");
				ctx.ui.setStatus("learning", `${ROLES[role].label}${extra ? " · " + extra : ""}`);
			}
		} else {
			// 退出角色：恢复全部内置与其他扩展工具，但不暴露 bb_*（无角色时它们只会抛错，徒耗一轮）
			pi.setActiveTools(nonBlackboardTools(pi.getAllTools().map((t) => t.name)));
			if (ctx.hasUI) ctx.ui.setStatus("learning", undefined);
		}
		persist();
	}

	const nonBlackboardTools = (names: string[]) => names.filter((n) => !n.startsWith("bb_"));

	function note(ctx: ExtensionContext, text: string) {
		pi.appendEntry("learning-note", { text });
		if (!ctx.hasUI) console.log(text);
	}

	pi.registerEntryRenderer<{ text: string }>("learning-note", (entry, _opts, theme) => new Text(theme.fg("muted", entry.data?.text ?? ""), 0, 0));

	// ---------- 会话生命周期 ----------

	pi.on("session_start", async (event, ctx) => {
		bb.setCwd(ctx.cwd);
		state = restore(ctx) ?? emptyState();
		let sessionName: string | undefined;

		// 1. 会话切换交接（/go 的进入角色路由写入；只在新会话中消费）
		const handoff = takeHandoff(ctx.cwd);
		if (handoff && (event.reason === "new" || event.reason === "startup")) {
			const { sessionName: name, ...rest } = handoff;
			state = { ...emptyState(), ...rest };
			sessionName = name;
		}
		// 2. 非交互 / 定时任务：LEARN_ROLE=assessor pi -p -a "..."
		const envRole = process.env.LEARN_ROLE as Role | undefined;
		if (!state.role && envRole && ROLE_NAMES.includes(envRole)) state.role = envRole;

		if (state.role) {
			await applyRole(state.role, {}, sessionName, ctx);
		} else if (bb.exists() && !state.optOut) {
			// 默认人格：前台。学习者直接说话即可，命令只剩 /learn（概览与推进）与内部的 /go。
			await applyRole("concierge", {}, sessionName, ctx);
			if (event.reason === "startup" && ctx.hasUI) {
				ctx.ui.notify("学习工作流已加载：直接说你想做什么，前台会安排下一步；/learn 查看黑板与建议。要维护本项目就说「退出学习模式」。", "info");
			}
		} else {
			// 没有黑板的目录：从当前白名单里摘掉 bb_*，其余（含 --tools 等配置）保持不动
			pi.setActiveTools(nonBlackboardTools(pi.getActiveTools()));
		}
	});

	// ---------- 每轮：角色提示 + 黑板上下文 ----------

	// 常驻实例（hub）模式：角色固定在实例上，跨角色靠学习者 @ 唤醒，不切会话
	const HUB_ADDENDUM = `

## 常驻实例模式
本会话是一个固定角色的常驻实例（花名册的一员）。不要试图切换角色或会话；流程需要其他角色时，请学习者用 @对应角色 唤醒（如 @资料管理员、@提案评审员、@复盘老师）。角色无关的动作（接受提案、闭卷作答、收集、核验、亲笔编辑器）照常进行。`;

	pi.on("before_agent_start", async (event) => {
		if (!state.role) return;
		// 群转写（hub P2）：附在黑板上下文之后，同一份哈希去重；评审员与复盘老师被隔离（group.ts）
		const context = buildContext(bb, state) + groupTranscriptSection(bb.cwd, state.role);
		const hash = shortHash(context);
		const result: { systemPrompt: string; message?: { customType: string; content: string; display: boolean } } = {
			systemPrompt: `${event.systemPrompt}\n\n${ROLES[state.role].prompt}${hubMode() ? HUB_ADDENDUM : ""}`,
		};
		if (hash !== state.contextHash) {
			state.contextHash = hash;
			persist();
			result.message = { customType: "learning-context", content: context, display: false };
		}
		return result;
	});

	// 陪读会话：给学习者的每条消息加模式标记
	pi.on("input", async (event) => {
		if (state.role === "tutor" && event.source === "interactive" && !event.text.startsWith("[mode:")) {
			return { action: "transform", text: `[mode: ${state.mode}] ${event.text}` };
		}
		return { action: "continue" };
	});

	// ---------- 工具调用护栏 ----------

	pi.on("tool_call", async (event) => {
		if (!state.role) return;
		if (event.toolName === "write" || event.toolName === "edit" || event.toolName === "bash") {
			return { block: true, reason: "角色会话中只能通过 bb_* 工具修改黑板；文件写入与 shell 已禁用。" };
		}
		const p = (event.input as { path?: unknown }).path;
		if (typeof p === "string" && (p.startsWith(sessionsDir) || /[\\/]\.pi[\\/]agent[\\/]sessions[\\/]/.test(p))) {
			return { block: true, reason: "不允许读取原始会话记录；复盘老师只依据黑板上的结构化数据工作。" };
		}
	});

	// ---------- 工具与命令 ----------

	registerTools(pi, { bb, state: () => state, persist });
	registerCommands(pi, {
		bb,
		state: () => state,
		persist,
		applyRole: (role, partial, sessionName, ctx) => applyRole(role, partial, sessionName, ctx),
		note,
	});
}
