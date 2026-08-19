/**
 * rpc/types.ts —— pi RPC 协议里本插件用到的子集（见 pi 文档 docs/rpc.md）。
 * 只声明实际消费的字段，其余保留为宽松类型。
 */

export interface TextContent {
	type: "text";
	text: string;
}
export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}
export interface ThinkingContent {
	type: "thinking";
	thinking: string;
}
export interface ToolCallContent {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface UserMessage {
	role: "user";
	content: string | Array<TextContent | ImageContent>;
	timestamp?: number;
}
export interface AssistantMessage {
	role: "assistant";
	content: Array<TextContent | ThinkingContent | ToolCallContent>;
	model?: string;
	provider?: string;
	stopReason?: string;
	errorMessage?: string;
	timestamp?: number;
}
export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: Array<TextContent | ImageContent>;
	isError?: boolean;
	timestamp?: number;
}
export interface CustomMessage {
	role: "custom";
	customType: string;
	content: string | Array<TextContent | ImageContent>;
	display: boolean;
	timestamp?: number;
}
export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage | CustomMessage | { role: string; [k: string]: unknown };

export interface ModelInfo {
	id: string;
	name?: string;
	provider: string;
}

export interface RpcState {
	model: ModelInfo | null;
	thinkingLevel?: string;
	isStreaming: boolean;
	isCompacting?: boolean;
	sessionFile?: string;
	sessionId?: string;
	sessionName?: string;
	messageCount?: number;
	pendingMessageCount?: number;
}

export interface RpcCommandInfo {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
}

/** 流式增量（message_update.assistantMessageEvent） */
export type AssistantDelta =
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; content: string }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number; content: string }
	| { type: "toolcall_start"; contentIndex: number }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCallContent };

/** 从 stdout 读到的、不是命令响应的行：事件与扩展 UI 请求 */
export type RpcEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[]; willRetry?: boolean }
	| { type: "agent_settled" }
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_update"; assistantMessageEvent: AssistantDelta }
	| { type: "message_end"; message: AgentMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; partialResult?: unknown }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: { content?: Array<TextContent | ImageContent>; details?: unknown }; isError?: boolean }
	| { type: "entry_appended"; entry: { type: string; customType?: string; data?: unknown; id: string } }
	| { type: "extension_error"; extensionPath?: string; event?: string; error: string }
	| { type: "auto_retry_start"; attempt?: number; maxAttempts?: number; delayMs?: number; errorMessage?: string }
	| { type: "auto_retry_end"; success?: boolean; finalError?: string }
	| { type: "compaction_start" }
	| { type: "compaction_end" }
	| { type: "queue_update"; [k: string]: unknown }
	| { type: "turn_start" | "turn_end" | "tool_execution_update" | "bash_execution_update" | "auto_retry_end" | "compaction_start" | "compaction_end"; [k: string]: unknown };

export type UiDialogMethod = "select" | "confirm" | "input" | "editor";
export interface UiRequest {
	type: "extension_ui_request";
	id: string;
	method: UiDialogMethod | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text";
	title?: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	timeout?: number;
	notifyType?: "info" | "warning" | "error";
	statusKey?: string;
	statusText?: string;
	widgetKey?: string;
	widgetLines?: string[];
	widgetPlacement?: "aboveEditor" | "belowEditor";
	text?: string;
}
/** 对话框方法的回应：值 / 确认 / 取消 */
export type UiResponse = { value: string } | { confirmed: boolean } | { cancelled: true };

export interface RpcResponse<T = unknown> {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: T;
	error?: string;
}
