import Anthropic from '@anthropic-ai/sdk';

type SystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

/**
 * Creates an Anthropic client.
 *
 * Auto-detects OAuth tokens (sk-ant-oat) vs regular API keys (sk-ant-api)
 * and configures the client accordingly.
 */
export function createAnthropicClient(apiKey?: string): Anthropic {
  const key = (apiKey || process.env.ANTHROPIC_API_KEY || '').trim();

  if (!key) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  if (key.includes('sk-ant-oat')) {
    return new Anthropic({
      apiKey: null as unknown as string,
      authToken: key,
      defaultHeaders: {
        'accept': 'application/json',
        'anthropic-dangerous-direct-browser-access': 'true',
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
        'user-agent': 'claude-cli/2.1.19 (external, cli)',
        'x-app': 'cli',
      },
    });
  }

  return new Anthropic({ apiKey: key });
}

/**
 * Wraps a system prompt with the required Claude Code prefix.
 * Required for OAuth tokens — without the prefix, the API returns 400.
 * Safe to use with regular API keys (just passes through).
 */
export function formatSystemPrompt(
  prompt?: string | SystemBlock[]
): string | SystemBlock[] | undefined {
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();

  if (!key.includes('sk-ant-oat')) {
    return prompt;
  }

  const prefixBlock: SystemBlock = {
    type: 'text',
    text: "You are Claude Code, Anthropic's official CLI for Claude.",
    cache_control: { type: 'ephemeral' },
  };

  // If already an array of SystemBlocks, prepend the prefix block
  if (Array.isArray(prompt)) {
    return [prefixBlock, ...prompt];
  }

  const blocks: SystemBlock[] = [prefixBlock];

  if (prompt) {
    blocks.push({ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } });
  }

  return blocks;
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
