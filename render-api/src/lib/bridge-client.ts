// Thin client that speaks to the local claude-bridge sidecar. Mirrors the
// shape of @anthropic-ai/sdk's Anthropic.messages so existing callers — which
// all go through createAnthropicClient() — work unchanged.

import Anthropic from '@anthropic-ai/sdk';

const BRIDGE_URL = process.env.CLAUDE_BRIDGE_URL ?? 'http://127.0.0.1:9001';

type MessageCreateParams = Anthropic.MessageCreateParams;
type Message = Anthropic.Message;
type MessageStreamEvent = Anthropic.MessageStreamEvent;

async function createMessage(req: MessageCreateParams): Promise<Message> {
  const body = stripCacheControl(req);
  const res = await fetch(`${BRIDGE_URL}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`bridge ${res.status}: ${text.slice(0, 500)}`);
  }
  return (await res.json()) as Message;
}

// Async-iterable that mirrors Anthropic SDK's stream surface. Callers use:
//   const stream = anthropic.messages.stream(...);
//   for await (const event of stream) { ... }
// The SDK also exposes helpers like .finalMessage(); we support finalMessage()
// (it's used in a few places) but not the full class API.
class BridgeStream implements AsyncIterable<MessageStreamEvent> {
  private bodyPromise: Promise<Response>;
  private finalText = '';
  private stopReason: string | null = null;
  private usage: Anthropic.Usage | null = null;
  private modelId: string;

  constructor(req: MessageCreateParams) {
    const body = stripCacheControl(req);
    this.modelId = typeof req.model === 'string' ? req.model : 'claude-opus-4-7';
    this.bodyPromise = fetch(`${BRIDGE_URL}/messages/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<MessageStreamEvent> {
    const res = await this.bodyPromise;
    if (!res.ok || !res.body) {
      const text = res.body ? await res.text() : 'no body';
      throw new Error(`bridge stream ${res.status}: ${text.slice(0, 500)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE frames are delimited by \n\n
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        const json = line.slice('data: '.length);
        let ev: any;
        try { ev = JSON.parse(json); } catch { continue; }

        if (ev.type === 'error') {
          if (ev.error?.type === 'rate_limit') {
            throw new Anthropic.RateLimitError(429, { type: 'error', error: ev.error }, ev.error.message, {});
          }
          throw new Error(`bridge stream error: ${ev.error?.message ?? 'unknown'}`);
        }

        // Track state for finalMessage().
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          this.finalText += ev.delta.text ?? '';
        } else if (ev.type === 'message_delta') {
          this.stopReason = ev.delta?.stop_reason ?? null;
          if (ev.usage) this.usage = { ...(this.usage ?? {}), ...ev.usage } as Anthropic.Usage;
        }

        yield ev as MessageStreamEvent;
      }
    }
  }

  async finalMessage(): Promise<Message> {
    // Drain the stream if the caller never iterated it.
    for await (const _ of this) {
      // intentionally empty
    }
    return {
      id: `msg_bridge_${Math.random().toString(36).slice(2)}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: this.finalText }],
      model: this.modelId,
      stop_reason: (this.stopReason ?? 'end_turn') as Message['stop_reason'],
      stop_sequence: null,
      usage: (this.usage ?? { input_tokens: 0, output_tokens: 0 }) as Anthropic.Usage,
    };
  }
}

/** Remove `cache_control` fields — Claude Code CLI auto-manages caching. */
function stripCacheControl(req: MessageCreateParams): MessageCreateParams {
  const clone: any = { ...req };
  if (Array.isArray(clone.system)) {
    clone.system = clone.system.map((b: any) => {
      const { cache_control, ...rest } = b;
      return rest;
    });
  }
  if (Array.isArray(clone.messages)) {
    clone.messages = clone.messages.map((m: any) => {
      if (Array.isArray(m.content)) {
        return {
          ...m,
          content: m.content.map((c: any) => {
            const { cache_control, ...rest } = c;
            return rest;
          }),
        };
      }
      return m;
    });
  }
  return clone;
}

/**
 * Minimum surface of Anthropic that render-api callers use:
 *   client.messages.create(params) → Message
 *   client.messages.stream(params) → BridgeStream (async-iterable)
 *
 * Typed as `Anthropic` so existing call sites type-check without edits.
 */
export function createBridgeClient(): Anthropic {
  const client = {
    messages: {
      create: createMessage as Anthropic['messages']['create'],
      stream: ((req: MessageCreateParams) => new BridgeStream(req)) as unknown as Anthropic['messages']['stream'],
    },
  };
  return client as Anthropic;
}
