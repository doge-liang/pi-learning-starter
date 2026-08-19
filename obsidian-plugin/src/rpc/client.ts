/**
 * rpc/client.ts —— 以子进程方式驱动 `pi --mode rpc` 的客户端。
 *
 * 参照 pi 自带的 rpc-client（MIT）重写，增加了扩展 UI 子协议的处理：
 * 扩展调用 ctx.ui.confirm / select / input / editor 时，pi 在 stdout 发出 extension_ui_request，
 * 本客户端把它交给 onUiRequest（由 Obsidian 侧渲染为模态框），拿到结果后写回 extension_ui_response。
 * 与 Obsidian 无关，可在 Node 里对真实 pi 做测试。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { AgentMessage, RpcCommandInfo, RpcEvent, RpcResponse, RpcState, UiRequest, UiResponse } from "./types.ts";

export interface PiRpcOptions {
	/** 启动命令：node + [dist/cli.js]，或 pi 可执行文件 + []（见 locate.ts） */
	command: string;
	commandArgs: string[];
	/** 学习项目目录（含 .pi/extensions/learning 与 blackboard/） */
	cwd: string;
	/** 追加给 pi 的命令行参数，例如 ["--model", "deepseek/deepseek-v4-pro"] */
	args?: string[];
	env?: Record<string, string>;
	onEvent?: (event: RpcEvent) => void;
	/** 对话框方法必须返回回应；fire-and-forget 方法返回 undefined */
	onUiRequest?: (req: UiRequest) => Promise<UiResponse | undefined> | UiResponse | undefined;
	onStderr?: (text: string) => void;
	onExit?: (info: { code: number | null; signal: string | null; stderr: string }) => void;
	/** 单条命令的响应超时（毫秒） */
	requestTimeoutMs?: number;
}

type Pending = { resolve: (r: RpcResponse) => void; reject: (e: Error) => void };

export class PiRpcClient {
	private proc: ChildProcess | null = null;
	private pending = new Map<string, Pending>();
	private seq = 0;
	private stderr = "";
	private exitError: Error | null = null;
	readonly options: PiRpcOptions;

	constructor(options: PiRpcOptions) {
		this.options = options;
	}

	get running(): boolean {
		return !!this.proc && this.proc.exitCode === null && !this.exitError;
	}

	async start(): Promise<void> {
		if (this.proc) throw new Error("客户端已启动");
		this.exitError = null;
		this.stderr = "";
		const args = [...this.options.commandArgs, "--mode", "rpc", ...(this.options.args ?? [])];
		const child = spawn(this.options.command, args, {
			cwd: this.options.cwd,
			env: { ...process.env, ...(this.options.env ?? {}) },
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.proc = child;

		child.stderr?.on("data", (d: Buffer | string) => {
			const s = d.toString();
			this.stderr = (this.stderr + s).slice(-20000);
			this.options.onStderr?.(s);
		});
		child.once("exit", (code, signal) => {
			if (this.proc !== child) return;
			this.exitError = new Error(`pi 进程已退出（code=${code} signal=${signal}）。${this.stderr.slice(-500)}`);
			this.rejectAll(this.exitError);
			this.options.onExit?.({ code, signal, stderr: this.stderr });
		});
		child.once("error", (err) => {
			if (this.proc !== child) return;
			this.exitError = new Error(`无法启动 pi：${err.message}`);
			this.rejectAll(this.exitError);
			this.options.onExit?.({ code: null, signal: null, stderr: `${err.message}\n${this.stderr}` });
		});
		child.stdin?.on("error", (err) => {
			if (this.proc !== child) return;
			this.exitError ??= new Error(`pi stdin 错误：${err.message}`);
		});
		attachJsonlReader(child.stdout!, (line) => this.handleLine(line));

		// 等待进程就绪：用 get_state 探测，最多 15 秒
		const deadline = Date.now() + 15000;
		let lastErr: unknown;
		while (Date.now() < deadline) {
			if (child.exitCode !== null || this.exitError) throw this.exitError ?? new Error(`pi 启动失败：${this.stderr.slice(-500)}`);
			try {
				await this.send({ type: "get_state" }, 3000);
				return;
			} catch (e) {
				lastErr = e;
				await sleep(200);
			}
		}
		throw new Error(`pi 未在 15 秒内就绪：${String((lastErr as Error)?.message ?? lastErr)}`);
	}

	async stop(): Promise<void> {
		const child = this.proc;
		if (!child) return;
		this.proc = null;
		this.rejectAll(new Error("客户端已停止"));
		try {
			child.stdin?.end();
		} catch {
			/* ignore */
		}
		const exited = new Promise<void>((resolve) => {
			if (child.exitCode !== null) return resolve();
			child.once("exit", () => resolve());
		});
		const timer = sleep(1500).then(() => {
			if (child.exitCode === null) child.kill();
		});
		await Promise.race([exited, timer.then(() => exited)]);
	}

	// ---------- 命令 ----------

	async send(command: Record<string, unknown>, timeoutMs = this.options.requestTimeoutMs ?? 30000): Promise<RpcResponse> {
		const child = this.proc;
		if (!child || !child.stdin) throw new Error("客户端未启动");
		if (this.exitError) throw this.exitError;
		if (child.exitCode !== null) throw new Error("pi 进程已退出");
		const id = `req_${++this.seq}`;
		const line = `${JSON.stringify({ ...command, id })}\n`;
		return new Promise<RpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`等待 ${String(command.type)} 响应超时`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (r) => {
					clearTimeout(timer);
					resolve(r);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
			child.stdin!.write(line, (err) => {
				if (err) {
					this.pending.delete(id);
					clearTimeout(timer);
					reject(err);
				}
			});
		});
	}

	private data<T>(r: RpcResponse): T {
		if (!r.success) throw new Error(r.error ?? `${r.command} 失败`);
		return r.data as T;
	}

	/** 发送用户消息或斜杠命令；正在流式输出时以 steer 排队 */
	async prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<void> {
		const cmd: Record<string, unknown> = { type: "prompt", message };
		if (streamingBehavior) cmd.streamingBehavior = streamingBehavior;
		this.data(await this.send(cmd));
	}
	async abort(): Promise<void> {
		this.data(await this.send({ type: "abort" }));
	}
	async newSession(): Promise<{ cancelled: boolean }> {
		return this.data(await this.send({ type: "new_session" }));
	}
	async getState(): Promise<RpcState> {
		return this.data(await this.send({ type: "get_state" }));
	}
	async getMessages(): Promise<AgentMessage[]> {
		return this.data<{ messages: AgentMessage[] }>(await this.send({ type: "get_messages" })).messages;
	}
	async getCommands(): Promise<RpcCommandInfo[]> {
		return this.data<{ commands: RpcCommandInfo[] }>(await this.send({ type: "get_commands" })).commands;
	}
	async setSessionName(name: string): Promise<void> {
		this.data(await this.send({ type: "set_session_name", name }));
	}
	async getAvailableModels(): Promise<Array<{ id: string; provider: string; name?: string }>> {
		return this.data<{ models: Array<{ id: string; provider: string; name?: string }> }>(await this.send({ type: "get_available_models" })).models;
	}
	async setModel(provider: string, modelId: string): Promise<void> {
		this.data(await this.send({ type: "set_model", provider, modelId }));
	}
	async getAvailableThinkingLevels(): Promise<string[]> {
		return this.data<{ levels: string[] }>(await this.send({ type: "get_available_thinking_levels" })).levels;
	}
	async setThinkingLevel(level: string): Promise<void> {
		this.data(await this.send({ type: "set_thinking_level", level }));
	}

	// ---------- 入站 ----------

	private handleLine(line: string): void {
		let data: any;
		try {
			data = JSON.parse(line);
		} catch {
			return; // 非 JSON 行（pi 偶尔会打印诊断信息）
		}
		if (data?.type === "response" && typeof data.id === "string" && this.pending.has(data.id)) {
			const p = this.pending.get(data.id)!;
			this.pending.delete(data.id);
			p.resolve(data as RpcResponse);
			return;
		}
		if (data?.type === "extension_ui_request") {
			void this.handleUiRequest(data as UiRequest);
			return;
		}
		this.options.onEvent?.(data as RpcEvent);
	}

	private async handleUiRequest(req: UiRequest): Promise<void> {
		const isDialog = req.method === "select" || req.method === "confirm" || req.method === "input" || req.method === "editor";
		let response: UiResponse | undefined;
		try {
			response = (await this.options.onUiRequest?.(req)) ?? undefined;
		} catch {
			response = undefined;
		}
		if (!isDialog) return;
		// 对话框必须有回应，否则扩展会一直挂起；缺省视为取消
		const payload = response ?? { cancelled: true };
		this.writeRaw({ type: "extension_ui_response", id: req.id, ...payload });
	}

	private writeRaw(obj: Record<string, unknown>): void {
		try {
			this.proc?.stdin?.write(`${JSON.stringify(obj)}\n`);
		} catch {
			/* 进程已退出 */
		}
	}

	private rejectAll(err: Error): void {
		for (const p of this.pending.values()) p.reject(err);
		this.pending.clear();
	}
}

/** 严格按 LF 切分的 JSONL 读取器（Node readline 会在 U+2028/2029 处错误切分，不能用） */
export function attachJsonlReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): () => void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	const emit = (line: string) => onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	const onData = (chunk: Buffer | string) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
		let idx: number;
		while ((idx = buffer.indexOf("\n")) !== -1) {
			emit(buffer.slice(0, idx));
			buffer = buffer.slice(idx + 1);
		}
	};
	const onEnd = () => {
		buffer += decoder.end();
		if (buffer.length) {
			emit(buffer);
			buffer = "";
		}
	};
	stream.on("data", onData);
	stream.on("end", onEnd);
	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
