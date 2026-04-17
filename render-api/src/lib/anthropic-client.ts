import Anthropic from '@anthropic-ai/sdk';
import { createBridgeClient } from './bridge-client';

type SystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

/**
 * Creates a client with the Anthropic.messages surface used across render-api.
 *
 * Routing (see plan humming-munching-platypus.md):
 *  - USE_CLAUDE_BRIDGE=true  → route through the local Claude Code CLI sidecar
 *                              (subscription billing, no api.anthropic.com)
 *  - USE_CLAUDE_BRIDGE=false → direct SDK (OAuth token or API key); break-glass
 *                              fallback kept permanently.
 *
 * Default is OFF until Phase 2 flips it on Railway.
 */
export function createAnthropicClient(apiKey?: string): Anthropic {
  if (process.env.USE_CLAUDE_BRIDGE === 'true') {
    return createBridgeClient();
  }

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
 * Wraps a system prompt with the required Claude Code OAuth prefix when using
 * the direct SDK on an OAuth token. Under the bridge, the CLI owns its own
 * identity — no prefix needed and cache_control is stripped inside the bridge
 * client — so this becomes a passthrough.
 */
export function formatSystemPrompt(
  prompt?: string | SystemBlock[]
): string | SystemBlock[] | undefined {
  if (process.env.USE_CLAUDE_BRIDGE === 'true') {
    return prompt;
  }

  const key = (process.env.ANTHROPIC_API_KEY || '').trim();

  if (!key.includes('sk-ant-oat')) {
    return prompt;
  }

  const prefixBlock: SystemBlock = {
    type: 'text',
    text: "You are Claude Code, Anthropic's official CLI for Claude.",
    cache_control: { type: 'ephemeral' },
  };

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
