// Request/response shapes mirror Anthropic SDK's messages.create() surface
// so the existing 15 caller files work unchanged through the bridge client.

export interface ContentBlockText {
  type: 'text';
  text: string;
}

export interface ContentBlockImage {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    data: string;
  };
}

export type ContentBlock = ContentBlockText | ContentBlockImage;

export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface SystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface CreateRequest {
  model?: string;
  max_tokens?: number;
  system?: string | SystemBlock[];
  messages: Message[];
  stream?: boolean;
  response_schema?: Record<string, unknown>;
  response_format?: { type: 'json' };
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface CreateResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: [ContentBlockText];
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';
  stop_sequence: null;
  usage: Usage;
}

// CLI stream-json event shapes (stdout NDJSON, one per line).

export interface CliSystemEvent {
  type: 'system';
  subtype: 'init' | 'hook_started' | 'hook_response';
  session_id: string;
  [k: string]: unknown;
}

export interface CliAssistantEvent {
  type: 'assistant';
  message: {
    id: string;
    role: 'assistant';
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'thinking'; thinking: string }
    >;
    usage?: Usage;
  };
  session_id: string;
  uuid: string;
}

export interface CliRateLimitEvent {
  type: 'rate_limit_event';
  rate_limit_info: {
    status: 'allowed' | 'throttled' | 'overage_throttled' | string;
    resetsAt: number;
    rateLimitType: string;
    overageStatus?: string;
    isUsingOverage?: boolean;
  };
  session_id: string;
}

export interface CliResultEvent {
  type: 'result';
  subtype: 'success' | 'error';
  is_error: boolean;
  result: string;
  stop_reason: 'end_turn' | string;
  session_id: string;
  usage: Usage & { [k: string]: unknown };
  duration_ms: number;
  num_turns: number;
}

export type CliEvent =
  | CliSystemEvent
  | CliAssistantEvent
  | CliRateLimitEvent
  | CliResultEvent
  | { type: string; [k: string]: unknown };
