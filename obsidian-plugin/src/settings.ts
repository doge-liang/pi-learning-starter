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
	/** 打开视图时自动启动 pi */
	autoStart: boolean;
}

export const DEFAULT_SETTINGS: PiLearningSettings = {
	projectDir: "",
	piPath: "",
	nodePath: "",
	model: "",
	extraArgs: "",
	autoStart: true,
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
					void this.plugin.controller.pickModel().then(() => this.display()).catch((e: Error) => new Notice(e.message));
				}),
			);
		new Setting(containerEl).setName("额外参数").setDesc("追加给 pi 的命令行参数，例如 --thinking high。").addText((t) =>
			t.setValue(s.extraArgs).onChange((v) => {
				s.extraArgs = v;
				save();
			}),
		);
		new Setting(containerEl).setName("打开视图时自动启动 pi").addToggle((t) =>
			t.setValue(s.autoStart).onChange((v) => {
				s.autoStart = v;
				save();
			}),
		);
		containerEl.createEl("p", { cls: "setting-item-description", text: "模型凭据不在本插件保存：在终端运行 pi 并 /login，或把 API key 放到用户级环境变量，pi 子进程会自行读取。" });
	}
}
