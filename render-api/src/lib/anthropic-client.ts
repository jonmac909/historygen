import Anthropic from '@anthropic-ai/sdk';

const OPENCLAW_URL = process.env.OPENCLAW_GATEWAY_URL || 'https://jons-mac-mini.tail01c962.ts.net';
const OPENCLAW_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';

/**
 * Creates an Anthropic client.
 * 
 * When OPENCLAW_GATEWAY_URL is set, routes all requests through OpenClaw's
 * gateway which handles Claude subscription OAuth authentication.
 * Otherwise, uses a standard API key directly.
 */
export function createAnthropicClient(apiKey?: string): Anthropic {
  const key = apiKey || process.env.ANTHROPIC_API_KEY || '';

  // If OpenClaw gateway is configured, proxy through it
  if (OPENCLAW_URL && OPENCLAW_TOKEN) {
    return createOpenClawProxiedClient(key);
  }

  return new Anthropic({ apiKey: key });
}

/**
 * Creates an Anthropic client that proxies through OpenClaw gateway.
 * Intercepts fetch calls and translates Anthropic format <-> OpenAI format.
 */
function createOpenClawProxiedClient(modelOverride?: string): Anthropic {
  return new Anthropic({
    apiKey: 'openclaw-proxy',
    fetch: async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const urlStr = typeof url === 'string' ? url : url.toString();

      // Only intercept /v1/messages calls (the main Anthropic API endpoint)
      if (!urlStr.includes('/v1/messages')) {
        return globalThis.fetch(url, init);
      }

      const body = JSON.parse(init?.body as string || '{}');
      const isStreaming = body.stream === true;

      // Translate Anthropic request -> OpenAI format
      const openaiMessages = translateAnthropicToOpenAI(body);
      const openaiBody = {
        model: `anthropic/${body.model || 'claude-sonnet-4-5-20250929'}`,
        messages: openaiMessages,
        max_tokens: body.max_tokens || 4096,
        temperature: body.temperature,
        stream: isStreaming,
      };

      const openclawUrl = `${OPENCLAW_URL}/v1/chat/completions`;
      const openclawResponse = await globalThis.fetch(openclawUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENCLAW_TOKEN}`,
        },
        body: JSON.stringify(openaiBody),
      });

      if (!openclawResponse.ok) {
        const errorText = await openclawResponse.text();
        throw new Error(`OpenClaw gateway error (${openclawResponse.status}): ${errorText}`);
      }

      if (isStreaming) {
        // Translate OpenAI SSE stream -> Anthropic SSE stream
        return translateStreamResponse(openclawResponse, body.model);
      }

      // Translate OpenAI response -> Anthropic format
      const openaiResult = await openclawResponse.json();
      const anthropicResponse = translateOpenAIToAnthropic(openaiResult, body.model);

      return new Response(JSON.stringify(anthropicResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
}

/** Translate Anthropic message format to OpenAI format */
function translateAnthropicToOpenAI(body: any): any[] {
  const messages: any[] = [];

  // Handle system prompt
  if (body.system) {
    const systemText = typeof body.system === 'string'
      ? body.system
      : Array.isArray(body.system)
        ? body.system.map((b: any) => b.text || '').join('\n')
        : '';
    if (systemText) {
      messages.push({ role: 'system', content: systemText });
    }
  }

  // Handle messages
  for (const msg of body.messages || []) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      // Anthropic content blocks -> concatenate text
      const text = msg.content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('\n');
      if (text) {
        messages.push({ role: msg.role, content: text });
      }
    }
  }

  return messages;
}

/** Translate OpenAI response to Anthropic response format */
function translateOpenAIToAnthropic(openaiResult: any, model: string): any {
  const choice = openaiResult.choices?.[0];
  const content = choice?.message?.content || '';

  return {
    id: openaiResult.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: model || 'claude-sonnet-4-5-20250929',
    content: [{ type: 'text', text: content }],
    stop_reason: choice?.finish_reason === 'stop' ? 'end_turn' : 'max_tokens',
    stop_sequence: null,
    usage: {
      input_tokens: openaiResult.usage?.prompt_tokens || 0,
      output_tokens: openaiResult.usage?.completion_tokens || 0,
    },
  };
}

/** Translate OpenAI SSE stream to Anthropic SSE stream */
function translateStreamResponse(openclawResponse: Response, model: string): Response {
  const reader = openclawResponse.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let messageId = `msg_${Date.now()}`;
  let sentStart = false;

  const stream = new ReadableStream({
    async pull(controller) {
      const encoder = new TextEncoder();

      // Send message_start event first
      if (!sentStart) {
        sentStart = true;
        const startEvent = {
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model: model || 'claude-sonnet-4-5-20250929',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        };
        controller.enqueue(encoder.encode(`event: message_start\ndata: ${JSON.stringify(startEvent)}\n\n`));
        // Send content_block_start
        const blockStart = {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        };
        controller.enqueue(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`));
      }

      try {
        const { done, value } = await reader.read();
        if (done) {
          // Send content_block_stop and message_stop
          const blockStop = { type: 'content_block_stop', index: 0 };
          controller.enqueue(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`));
          const msgStop = { type: 'message_stop' };
          controller.enqueue(encoder.encode(`event: message_stop\ndata: ${JSON.stringify(msgStop)}\n\n`));
          controller.close();
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
          try {
            const chunk = JSON.parse(line.slice(6));
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) {
              const textDelta = {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: delta.content },
              };
              controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify(textDelta)}\n\n`));
            }
          } catch {
            // skip malformed chunks
          }
        }
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

/**
 * Gets the configured Anthropic API key from environment.
 */
export function getAnthropicApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }
  return key;
}
