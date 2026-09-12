/**
 * viz-tools —— 给 viz 技能的两件工具。
 *
 * render_svg：把 SVG 文件光栅化成 PNG 并作为图片返回给模型，让模型能亲眼核对坐标、
 * 重叠与箭头方向（pi 的 read 只把 SVG 当文本）。优先用 npm 预编译的 @resvg/resvg-js
 * （本目录 npm install 后可用），其次系统里的 rsvg-convert 或 ImageMagick；都不可用时抛错并附原因。
 * check_mermaid：静态检查 mermaid 源码里在 Obsidian 中最常见的解析失败写法（规则见 lint.mjs）。
 *
 * 装在 ~/.pi/agent/extensions/viz-tools/（用户级，不需要 /trust）。
 * 注意：pi 忽略返回值里的 isError，错误一律 throw。
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { lintMermaid } from "./lint.mjs";

const run = promisify(execFile);

/** Windows 自带雅黑，其它平台优先系统 CJK 字体；resvg 按 font-family 找不到时回落到这里 */
const DEFAULT_FONT = process.platform === "win32" ? "Microsoft YaHei" : process.platform === "darwin" ? "PingFang SC" : "Noto Sans CJK SC";
/** pi 会把工具结果里的图片缩到最长边 2000px，渲染得更大只是浪费 */
const MAX_EDGE = 2000;

async function rasterize(svgPath: string, zoom: number): Promise<{ png: Buffer; via: string }> {
	const svg = readFileSync(svgPath, "utf8");
	let resvgError: string | undefined;
	try {
		const mod: any = await import("@resvg/resvg-js");
		const Resvg = mod.Resvg ?? mod.default?.Resvg;
		const probe = new Resvg(svg);
		const eff = Math.max(1, Math.min(zoom, MAX_EDGE / Math.max(probe.width, probe.height, 1)));
		const r = new Resvg(svg, { fitTo: { mode: "zoom", value: eff }, font: { loadSystemFonts: true, defaultFontFamily: DEFAULT_FONT } });
		return { png: Buffer.from(r.render().asPng()), via: "@resvg/resvg-js" };
	} catch (e) {
		// 缺包、缺原生模块、运行库被拦截都落到这里：记下原因，尝试系统渲染器
		resvgError = String((e as Error).message).split("\n")[0];
	}
	const out = join(mkdtempSync(join(tmpdir(), "viz-")), "render.png");
	const candidates: Array<[string, string[]]> = [
		["rsvg-convert", ["-z", String(zoom), svgPath, "-o", out]],
		["magick", ["-density", String(96 * zoom), "-background", "white", svgPath, out]],
	];
	for (const [bin, args] of candidates) {
		try {
			await run(bin, args);
			return { png: readFileSync(out), via: bin };
		} catch (e) {
			const err = e as NodeJS.ErrnoException & { stderr?: string };
			if (err.code !== "ENOENT") throw new Error(`${bin} 渲染失败：${err.stderr?.trim() || err.message}`);
		}
	}
	throw new Error(`没有可用的 SVG 渲染器（@resvg/resvg-js 未启用：${resvgError}）。在扩展目录 ~/.pi/agent/extensions/viz-tools 执行 npm install，或安装 ImageMagick / rsvg-convert。`);
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "render_svg",
		label: "渲染 SVG",
		description: "把一个 SVG 文件渲染成 PNG 并作为图片返回，供你亲眼检查坐标、文字重叠与箭头方向；可选把 PNG 也保存到指定路径。当前模型不支持图片输入时只返回文字说明。",
		promptSnippet: "把 SVG 渲染成 PNG 供你查看",
		promptGuidelines: ["写完 SVG 后用 render_svg 渲染并查看图片，确认无误再嵌入笔记；发现问题就改源文件再渲染。"],
		parameters: Type.Object({
			path: Type.String({ description: "SVG 文件路径，相对当前工作目录或绝对路径" }),
			zoom: Type.Optional(Type.Number({ minimum: 1, maximum: 4, description: "放大倍数，默认 2；结果最长边不超过 2000px，超过无意义" })),
			save_as: Type.Optional(Type.String({ description: "可选：把 PNG 也保存到这个路径" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const svgPath = isAbsolute(params.path) ? params.path : resolve(ctx.cwd, params.path);
			if (!existsSync(svgPath)) throw new Error(`找不到文件：${svgPath}`);
			const { png, via } = await rasterize(svgPath, params.zoom ?? 2);
			let saved: string | null = null;
			if (params.save_as) {
				saved = isAbsolute(params.save_as) ? params.save_as : resolve(ctx.cwd, params.save_as);
				writeFileSync(saved, png);
			}
			// 不支持图片输入的模型会被 pi 静默去掉图片；此时明说，免得模型以为自己看过图
			const model = (ctx as { model?: { input?: string[] } }).model;
			const blind = !!model && Array.isArray(model.input) && !model.input.includes("image");
			if (blind) {
				return {
					content: [{ type: "text", text: `已用 ${via} 渲染 ${svgPath}，但当前模型不支持图片输入，无法查看。${saved ? `PNG 已保存到 ${saved}，请学习者在 Obsidian 或图片查看器中确认。` : "请退回源码级检查，或传 save_as 保存 PNG 交学习者确认。"}` }],
					details: { ok: true, path: svgPath, via, bytes: png.length, saved, viewed: false },
				};
			}
			return {
				content: [
					{ type: "text", text: `已用 ${via} 渲染 ${svgPath}（${png.length} 字节）。请检查：元素是否越界、文字是否重叠、箭头方向是否与说明一致。` },
					{ type: "image", data: png.toString("base64"), mimeType: "image/png" },
				],
				details: { ok: true, path: svgPath, via, bytes: png.length, saved, viewed: true },
			};
		},
	});

	pi.registerTool({
		name: "check_mermaid",
		label: "检查 mermaid",
		description: "静态检查一段 mermaid 源码里在 Obsidian 中最常见的解析失败写法：未加引号的标签、标签内的形状语法字符、非 ASCII 节点 id、重复定义的节点、括号不平衡、sequenceDiagram 与 stateDiagram 里的分号与井号。传入源码本身，不含 ``` 围栏。通过即可嵌入笔记。",
		promptSnippet: "静态检查 mermaid 源码",
		promptGuidelines: ["把 mermaid 图嵌入笔记之前先用 check_mermaid 检查（只传源码，不含围栏），问题清零再写入。"],
		parameters: Type.Object({
			source: Type.String({ description: "mermaid 源码，不含 ``` 围栏" }),
		}),
		async execute(_id, params) {
			const problems = lintMermaid(params.source);
			if (!problems.length) return { content: [{ type: "text", text: "检查通过。" }], details: { ok: true, problems } };
			const text = problems.map((p) => (p.line ? `第 ${p.line} 行：${p.message}` : p.message)).join("\n");
			return { content: [{ type: "text", text: `发现 ${problems.length} 个问题：\n${text}` }], details: { ok: false, problems } };
		},
	});
}
