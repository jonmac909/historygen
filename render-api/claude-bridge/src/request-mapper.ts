import { randomUUID } from 'crypto';
import type { CreateRequest, CreateResponse, Message, SystemBlock } from './types';
import { SessionTurnResult } from './session';

// Caller sends an Anthropic SDK-shape request. The bridge must:
//  - flatten the system prompt (string | SystemBlock[] | undefined) into a
//    single string for Claude Code's --system-prompt flag
//  - append a JSON-hygiene instruction when the caller wants structured output
//  - convert messages[] into a single user-message content payload (the CLI
//    session carries assistant turns via its own memory; we only send the
//    newest user turn)
//
// Response remaps SessionTurnResult into the SDK's messages.create() shape.

const JSON_APPENDIX =
  '\n\nRespond with ONLY a valid JSON object matching the requested structure. No prose, no markdown fences.';

export function flattenSystem(system: CreateRequest['system']): string {
  if (!system) return 'You are a helpful assistant.';
  if (typeof system === 'string') return system;
  return system.map((b: SystemBlock) => b.text).join('\n\n');
}

export function wantsJson(req: CreateRequest): boolean {
  return req.response_format?.type === 'json' || !!req.response_schema;
}

export function buildSystemPrompt(req: CreateRequest): string {
  const base = flattenSystem(req.system);
  return wantsJson(req) ? base + JSON_APPENDIX : base;
}

/**
 * Extract the newest user-turn content. We only push one user message per
 * bridge call; prior assistant turns live inside the Claude session's memory
 * already. For SDK parity, if the caller sends [user, assistant, user], we
 * take the last user block.
 */
export function extractUserContent(messages: Message[]): string | unknown[] {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) throw new Error('no user message in request');
  return lastUser.content as string | unknown[];
}

export function toSdkResponse(
  turn: SessionTurnResult,
  model: string,
): CreateResponse {
  return {
    id: `msg_bridge_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: turn.text }],
    model,
    stop_reason:
      turn.stopReason === 'end_turn' ||
      turn.stopReason === 'max_tokens' ||
      turn.stopReason === 'stop_sequence' ||
      turn.stopReason === 'tool_use'
        ? turn.stopReason
        : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: turn.usage.input_tokens ?? 0,
      output_tokens: turn.usage.output_tokens ?? 0,
      cache_read_input_tokens: turn.usage.cache_read_input_tokens,
      cache_creation_input_tokens: turn.usage.cache_creation_input_tokens,
    },
  };
}
