/**
 * main.ts —— 插件入口：注册侧边栏视图、命令面板条目、设置页；持有唯一的 InstanceManager
 * （hub 花名册：每个角色一个常驻 pi 实例）。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FileSystemAdapter, Notice, Plugin, type WorkspaceLeaf } from "obsidian";
import { InstanceManager } from "./instances.ts";
import { DEFAULT_SETTINGS, type PiLearningSettings, PiLearningSettingTab } from "./settings.ts";
import { TriggerWatcher } from "./triggers.ts";
import { LearningView, VIEW_TYPE } from "./view.ts";

export default class PiLearningPlugin extends Plugin {
	settings: PiLearningSettings = { ...DEFAULT_SETTINGS, roleSessions: {} };
	manager!: InstanceManager;
	watcher!: TriggerWatcher;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.manager = new InstanceManager(this.app, () => this.settings, () => void this.saveSettings());
		// 面板里切换的模型写回设置，下次启动实例时作为 --model 沿用
		this.manager.onModelChosen = (model) => {
			this.settings.model = model;
			void this.saveSettings();
		};
		// 自主触发（P3）：常驻轮询，开关与冷却读设置；默认关闭
		this.watcher = new TriggerWatcher(this.manager, () => this.settings);
		this.watcher.start();

		this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new LearningView(leaf, this.manager, () => this.settings.autoStart));
		this.addRibbonIcon("graduation-cap", "打开 Pi Learning", () => void this.activateView());
		this.addCommand({ id: "open-view", name: "打开学习面板", callback: () => void this.activateView() });
		this.addCommand({
			id: "restart-pi",
			name: "重启当前实例",
			callback: () => void this.manager.get(this.manager.activeRole).start().catch((e) => new Notice((e as Error).message)),
		});
		this.addCommand({ id: "stop-pi", name: "停止全部实例", callback: () => void this.manager.stopAll() });
		this.addCommand({
			id: "pick-session",
			name: "切换当前实例的历史会话",
			callback: () => void this.activateView().then(() => this.manager.get(this.manager.activeRole).pickSession()).catch((e) => new Notice((e as Error).message)),
		});
		// 界面收敛后学习者只有 /learn 一个命令；其余流程用 @角色 对话推进
		this.addCommand({
			id: "cmd-learn",
			name: "黑板概览与下一步（/learn）",
			callback: () => void this.activateView().then(() => this.manager.dispatch("concierge", "/learn")).catch((e) => new Notice((e as Error).message)),
		});
		this.addSettingTab(new PiLearningSettingTab(this.app, this));
	}

	async onunload(): Promise<void> {
		this.watcher.stop();
		await this.manager.stopAll();
	}

	async loadSettings(): Promise<void> {
		const loaded = ((await this.loadData()) ?? {}) as Partial<PiLearningSettings>;
		this.settings = { ...DEFAULT_SETTINGS, ...loaded, roleSessions: { ...(loaded.roleSessions ?? {}) } };
		// 首次使用：若 vault 根目录本身就是学习项目，直接用它
		if (!this.settings.projectDir) {
			const base = this.vaultBasePath();
			if (base && existsSync(join(base, "blackboard")) && existsSync(join(base, ".pi", "extensions", "learning"))) {
				this.settings.projectDir = base;
				await this.saveSettings();
			}
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	vaultBasePath(): string | undefined {
		const adapter = this.app.vault.adapter;
		return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : undefined;
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
		if (!leaf) {
			leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
		workspace.revealLeaf(leaf);
	}
}
