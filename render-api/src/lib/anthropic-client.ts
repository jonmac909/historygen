import Anthropic from '@anthropic-ai/sdk';

/**
 * Creates an Anthropic client that supports both regular API keys and OAuth tokens.
 * OAuth tokens (sk-ant-oat01-*) use Bearer auth + beta header instead of x-api-key.
 */
export function createAnthropicClient(apiKey?: string): Anthropic {
  const key = apiKey || process.env.ANTHROPIC_API_KEY || '';
  const isOAuthToken = key.startsWith('sk-ant-oat01-');

  if (isOAuthToken) {
    return new Anthropic({
      apiKey: 'placeholder',
      fetch: (url: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        // Remove the default x-api-key header
        headers.delete('x-api-key');
        // Use Bearer auth for OAuth tokens
        headers.set('Authorization', `Bearer ${key}`);
        // Required beta header for OAuth
        headers.set('anthropic-beta', [
          'oauth-2025-04-20',
          headers.get('anthropic-beta') || ''
        ].filter(Boolean).join(','));
        return globalThis.fetch(url, { ...init, headers });
      },
    });
  }

  return new Anthropic({ apiKey: key });
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
