/**
 * settings.ts —— 插件设置：学习项目目录、pi 定位、模型、额外参数。
 * 不在这里保存任何密钥：模型凭据由 pi 自己管理（`pi` 里 `/login`，或环境变量）。
 */
import { type App, Notice, PluginSettingTab, Setting } from "obsidian";
import type PiLearningPlugin from "./main.ts";

export interface PiLearningSettings {
	/** 含 .pi/extensions/learning 与 blackboard/ 的目录；留空则在首次打开时尝试用 vault 根目录 */
	projectDir: string;
	/** pi 的 dist/cli.js 或 pi 可执行文件；留空自动查找 */
	piPath: string;
	/** node 可执行文件；留空用 PATH 上的 node */
	nodePath: string;
	/** 启动时传给 pi 的 --model，如 deepseek/deepseek-v4-pro；留空沿用 pi 默认 */
	model: string;
	/** 其他追加参数，如 --thinking high */
	extraArgs: string;
	/** 打开视图时自动启动前台实例 */
	autoStart: boolean;
	/** 实例启动时续接它自己上次的会话；关闭则每次新开会话 */
	resumeLast: boolean;
	/** 各角色实例上次的会话文件（由 InstanceManager 回写；跨插件重启续接） */
	roleSessions: Record<string, string>;
	/** 自主触发：轮询黑板，把准备性工作（选材、出题、重规划提案）派发给实例；产物照旧等学习者裁决 */
	autoTriggers: boolean;
	/** 同一触发键的冷却时间（分钟） */
	triggerCooldownMinutes: number;
}

export const DEFAULT_SETTINGS: PiLearningSettings = {
	projectDir: "",
	piPath: "",
	nodePath: "",
	model: "",
	extraArgs: "",
	autoStart: true,
	resumeLast: true,
	roleSessions: {},
	autoTriggers: false,
	triggerCooldownMinutes: 360,
};

export class PiLearningSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: PiLearningPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;
		const save = () => void this.plugin.saveSettings();

		new Setting(containerEl).setName("学习项目目录").setDesc("含 .pi/extensions/learning 与 blackboard/ 的目录（pi 以它为工作目录启动）。改动后需重启 pi。").addText((t) =>
			t
				.setPlaceholder("D:\\Workspace\\project\\pi-learning-starter")
				.setValue(s.projectDir)
				.onChange((v) => {
					s.projectDir = v.trim();
					save();
				}),
		);
		new Setting(containerEl).setName("pi 路径").setDesc("留空自动查找全局安装的 pi（dist/cli.js）；也可填 pi 可执行文件的完整路径。").addText((t) =>
			t
				.setPlaceholder("自动")
				.setValue(s.piPath)
				.onChange((v) => {
					s.piPath = v.trim();
					save();
				}),
		);
		new Setting(containerEl).setName("node 路径").setDesc("留空使用 PATH 上的 node。").addText((t) =>
			t
				.setPlaceholder("node")
				.setValue(s.nodePath)
				.onChange((v) => {
					s.nodePath = v.trim();
					save();
				}),
		);
		new Setting(containerEl)
			.setName("模型")
			.setDesc("启动 pi 时的 --model，如 zai-coding-cn/glm-5.2；留空用 pi 的默认模型。面板顶栏点模型名也可随时切换（会写回这里）。各角色的模型仍可在项目的 .pi/learning.json 里分别配置。")
			.addText((t) =>
				t
					.setPlaceholder("provider/model-id")
					.setValue(s.model)
					.onChange((v) => {
						s.model = v.trim();
						save();
					}),
			)
			.addButton((b) =>
				b.setButtonText("从列表选择").onClick(() => {
					void this.plugin.manager
						.get(this.plugin.manager.activeRole)
						.pickModel()
						.then(() => this.display())
						.catch((e: Error) => new Notice(e.message));
				}),
			);
		new Setting(containerEl).setName("额外参数").setDesc("追加给 pi 的命令行参数，例如 --thinking high。").addText((t) =>
			t.setValue(s.extraArgs).onChange((v) => {
				s.extraArgs = v;
				save();
			}),
		);
		new Setting(containerEl).setName("启动时续上上次会话").setDesc("每个角色实例启动时续接它自己上次的会话；关闭则每次都是新会话。随时可用顶栏的「历史会话」切换。").addToggle((t) =>
			t.setValue(s.resumeLast).onChange((v) => {
				s.resumeLast = v;
				save();
			}),
		);
		new Setting(containerEl).setName("打开视图时自动启动前台实例").addToggle((t) =>
			t.setValue(s.autoStart).onChange((v) => {
				s.autoStart = v;
				save();
			}),
		);
		new Setting(containerEl)
			.setName("自主触发")
			.setDesc("轮询黑板，把无人值守的准备性工作派发给实例：单元缺资料时请馆员选材、到期或单元完成时请复盘老师出题、结构性缺口时请规划者重规划。产物（提案、测试）照旧排队等你裁决。默认关闭。")
			.addToggle((t) =>
				t.setValue(s.autoTriggers).onChange((v) => {
					s.autoTriggers = v;
					save();
				}),
			);
		new Setting(containerEl).setName("触发冷却（分钟）").setDesc("同一类触发两次之间的最短间隔；避免反复打扰。").addText((t) =>
			t
				.setPlaceholder("360")
				.setValue(String(s.triggerCooldownMinutes))
				.onChange((v) => {
					const n = Number.parseInt(v, 10);
					if (Number.isFinite(n) && n > 0) {
						s.triggerCooldownMinutes = n;
						save();
					}
				}),
		);
		containerEl.createEl("p", { cls: "setting-item-description", text: "模型凭据不在本插件保存：在终端运行 pi 并 /login，或把 API key 放到用户级环境变量，pi 子进程会自行读取。" });
	}
}
