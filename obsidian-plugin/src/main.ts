/**
 * main.ts —— 插件入口：注册侧边栏视图、命令面板条目、设置页；持有唯一的 LearningController。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FileSystemAdapter, Notice, Plugin, type WorkspaceLeaf } from "obsidian";
import { LearningController } from "./controller.ts";
import { DEFAULT_SETTINGS, type PiLearningSettings, PiLearningSettingTab } from "./settings.ts";
import { LearningView, VIEW_TYPE } from "./view.ts";

export default class PiLearningPlugin extends Plugin {
	settings: PiLearningSettings = { ...DEFAULT_SETTINGS };
	controller!: LearningController;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.controller = new LearningController(this.app, () => this.settings);
		// 面板里切换的模型写回设置，下次启动 pi 时作为 --model 沿用
		this.controller.onModelChosen = (model) => {
			this.settings.model = model;
			void this.saveSettings();
		};

		this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new LearningView(leaf, this.controller, () => this.settings.autoStart));
		this.addRibbonIcon("graduation-cap", "打开 Pi Learning", () => void this.activateView());
		this.addCommand({ id: "open-view", name: "打开学习面板", callback: () => void this.activateView() });
		this.addCommand({ id: "restart-pi", name: "重启 pi", callback: () => void this.controller.start().catch((e) => new Notice((e as Error).message)) });
		this.addCommand({ id: "stop-pi", name: "停止 pi", callback: () => void this.controller.stop() });
		this.addCommand({ id: "pick-session", name: "切换历史会话", callback: () => void this.activateView().then(() => this.controller.pickSession()).catch((e) => new Notice((e as Error).message)) });
		for (const [id, name, cmd] of [
			["learn", "黑板概览（/learn）", "/learn"],
			["domain", "入学访谈（/domain）", "/domain"],
			["read", "开始阅读（/read）", "/read"],
			["take", "作答测试（/take）", "/take"],
			["events", "查看事件（/events）", "/events"],
		] as const) {
			this.addCommand({
				id: `cmd-${id}`,
				name,
				callback: () => void this.activateView().then(() => this.controller.send(cmd)).catch((e) => new Notice((e as Error).message)),
			});
		}
		this.addSettingTab(new PiLearningSettingTab(this.app, this));
	}

	async onunload(): Promise<void> {
		await this.controller.stop();
	}

	async loadSettings(): Promise<void> {
		this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) ?? {}) };
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
