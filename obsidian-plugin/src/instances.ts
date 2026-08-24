/**
 * instances.ts —— hub 的实例管理器：花名册上每个角色一个 LearningController（懒创建、懒启动），
 * 输入的寻址路由（@ → 目标实例；无 @ → 当前活跃实例），以及全局回合串行队列——
 * 同一时刻只有一个实例在生成回合，是黑板并发写的第一道防线（第二道是扩展内的跨进程锁）。
 */
import type { App } from "obsidian";
import { LearningController } from "./controller.ts";
import { parseAddress, ROSTER, roleSpec } from "./roster.ts";
import type { PiLearningSettings } from "./settings.ts";

export class InstanceManager {
	private controllers = new Map<string, LearningController>();
	/** 当前活跃页签的角色；无 @ 的消息路由到它 */
	activeRole = "concierge";
	/** 面板里选了模型时回写设置（沿用单实例时代的行为） */
	onModelChosen: ((model: string) => void) | null = null;

	private queue: Array<{ role: string; run: () => Promise<void> }> = [];
	private draining = false;
	/** 队列状态变化（长度、正在执行的实例）时通知视图 */
	onQueueChanged: (() => void) | null = null;
	/** 队列执行出错时的呈现（默认丢给 console） */
	onError: ((role: string, err: Error) => void) | null = null;
	/** 消息回显（视图把它接到对应实例的对话记录上）；未接视图时静默 */
	onEcho: ((role: string, message: string) => void) | null = null;

	constructor(
		private app: App,
		private settings: () => PiLearningSettings,
		private persist: () => void,
	) {}

	get(role: string): LearningController {
		let c = this.controllers.get(role);
		if (!c) {
			const spec = roleSpec(role);
			if (!spec) throw new Error(`未知角色：${role}`);
			c = new LearningController(this.app, this.settings, {
				role: spec.role,
				label: spec.label,
				savedSession: () => this.settings().roleSessions[role],
				onSessionFile: (file) => {
					this.settings().roleSessions[role] = file;
					this.persist();
				},
			});
			c.onModelChosen = (m) => this.onModelChosen?.(m);
			this.controllers.set(role, c);
		}
		return c;
	}

	/** 已创建的实例（未创建的角色不在其中） */
	all(): Array<[string, LearningController]> {
		return ROSTER.filter((r) => this.controllers.has(r.role)).map((r) => [r.role, this.controllers.get(r.role) as LearningController]);
	}

	async ensureStarted(role: string): Promise<void> {
		const c = this.get(role);
		if (!c.running) await c.start();
	}

	async stopAll(): Promise<void> {
		this.queue.length = 0;
		await Promise.all([...this.controllers.values()].map((c) => c.stop()));
	}

	get pendingCount(): number {
		return this.queue.length + (this.draining ? 1 : 0);
	}

	/**
	 * 路由一条输入并入队执行。返回解析结果供视图切页签与提示；
	 * 消息本体在队列里逐实例串行执行（启动 → 回显 → 发送 → 等回合结束）。
	 * 只 @ 不带话视为唤醒：仅启动实例。
	 */
	route(text: string): { targets: string[]; unknown?: string } {
		const { roles, body, unknown } = parseAddress(text);
		const targets = roles.length ? roles : [this.activeRole];
		const message = roles.length ? body : text.trim();
		for (const role of targets) this.dispatch(role, message);
		return { targets, unknown };
	}

	/** 定向执行（命令条按钮、路由）：入队到指定实例；空消息视为唤醒（仅启动） */
	dispatch(role: string, message: string): void {
		this.enqueue(role, async () => {
			await this.ensureStarted(role);
			if (!message) return;
			this.onEcho?.(role, message);
			const c = this.get(role);
			await c.send(message);
			await c.waitIdle();
		});
	}

	private enqueue(role: string, run: () => Promise<void>): void {
		this.queue.push({ role, run });
		this.onQueueChanged?.();
		void this.drain();
	}

	private async drain(): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		try {
			while (this.queue.length) {
				const job = this.queue.shift();
				if (!job) break;
				this.onQueueChanged?.();
				try {
					await job.run();
				} catch (e) {
					(this.onError ?? ((r, err) => console.error(`[pi-learning] ${r}:`, err)))(job.role, e as Error);
				}
			}
		} finally {
			this.draining = false;
			this.onQueueChanged?.();
		}
	}
}
