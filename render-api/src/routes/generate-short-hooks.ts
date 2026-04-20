import { Router, Request, Response } from 'express';
import { createAnthropicClient, formatSystemPrompt } from '../lib/anthropic-client';
import { saveCost } from '../lib/cost-tracker';

const router = Router();

// Hook styles for YouTube Shorts
type HookStyle = 'story' | 'didyouknow' | 'question' | 'contrast';

interface HookOption {
  style: HookStyle;
  label: string;
  preview: string;  // First ~100 chars of the hook
  fullScript: string;  // Full ~26-second script with subscribe CTA
}

interface GenerateHooksRequest {
  projectId: string;
  fullScript: string;
}

interface GenerateHooksResponse {
  success: boolean;
  hooks?: HookOption[];
  error?: string;
}

// System prompt for generating Short hooks
const HOOKS_SYSTEM_PROMPT = `You are an expert at creating engaging YouTube Shorts from historical content.

Your task: Given a full historical script, create 4 different SHORT scripts (~150 words each, ~26 seconds when spoken) using different hook styles. Each Short should:
1. Open with a compelling hook in the specified style
2. Contain the most interesting/engaging content from the full script
3. End with "Subscribe for more history"

The 4 hook styles are:
1. STORY HOOK: Start with a dramatic narrative opening
   Example: "In 1347, a ship arrived in Sicily carrying passengers no one expected..."

2. DID YOU KNOW HOOK: Start with a surprising fact
   Example: "Did you know that Vikings never actually wore horned helmets?"

3. QUESTION HOOK: Start with an intriguing question
   Example: "What really caused the fall of Rome?"

4. CONTRAST HOOK: Start by challenging a common belief
   Example: "Everyone thinks Marie Antoinette said 'let them eat cake'... but she never did."

IMPORTANT:
- Each script should be ~150 words (26 seconds when spoken at natural pace)
- Pick the MOST engaging content from the full script
- The hook should grab attention in the first 3 seconds
- End each script with exactly: "Subscribe for more history"
- Return valid JSON only`;

const USER_PROMPT_TEMPLATE = `Here is the full script. Create 4 Short scripts using the 4 different hook styles:

<full_script>
{SCRIPT}
</full_script>

Return a JSON array with exactly 4 objects, one for each hook style:
[
  {
    "style": "story",
    "label": "Story Hook",
    "preview": "First ~100 characters of the script...",
    "fullScript": "Full ~150 word script ending with Subscribe for more history"
  },
  {
    "style": "didyouknow",
    "label": "Did You Know",
    "preview": "First ~100 characters...",
    "fullScript": "Full script..."
  },
  {
    "style": "question",
    "label": "Question Hook",
    "preview": "First ~100 characters...",
    "fullScript": "Full script..."
  },
  {
    "style": "contrast",
    "label": "Contrast Hook",
    "preview": "First ~100 characters...",
    "fullScript": "Full script..."
  }
]

Return ONLY the JSON array, no other text.`;

// POST /generate-short-hooks
router.post('/', async (req: Request, res: Response) => {
  const startTime = Date.now();
  console.log('[GenerateShortHooks] Starting hook generation...');

  try {
    const { projectId, fullScript } = req.body as GenerateHooksRequest;

    if (!fullScript || fullScript.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Full script is required',
      } as GenerateHooksResponse);
    }

    // Get API key
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey && process.env.USE_CLAUDE_BRIDGE !== 'true') {
      throw new Error('ANTHROPIC_API_KEY not configured');
    }

    const anthropic = createAnthropicClient(apiKey);

    // Generate hooks using Claude
    const userPrompt = USER_PROMPT_TEMPLATE.replace('{SCRIPT}', fullScript);

    console.log('[GenerateShortHooks] Calling Claude to generate 4 hooks...');
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: formatSystemPrompt(HOOKS_SYSTEM_PROMPT),
      messages: [
        { role: 'user', content: userPrompt }
      ],
    });

    // Extract text from response
    const responseText = response.content[0]?.type === 'text'
      ? response.content[0].text
      : '';

    // Parse JSON response
    let hooks: HookOption[];
    try {
      // Try to extract JSON from response (handle markdown code blocks)
      let jsonStr = responseText.trim();
      if (jsonStr.startsWith('```json')) {
        jsonStr = jsonStr.slice(7);
      }
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.slice(3);
      }
      if (jsonStr.endsWith('```')) {
        jsonStr = jsonStr.slice(0, -3);
      }
      hooks = JSON.parse(jsonStr.trim());

      // Validate structure
      if (!Array.isArray(hooks) || hooks.length !== 4) {
        throw new Error('Expected array of 4 hooks');
      }

      // Validate each hook
      for (const hook of hooks) {
        if (!hook.style || !hook.label || !hook.preview || !hook.fullScript) {
          throw new Error('Invalid hook structure');
        }
      }
    } catch (parseError) {
      console.error('[GenerateShortHooks] Failed to parse response:', responseText);
      throw new Error('Failed to parse hook options from Claude response');
    }

    // Track cost
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;

    if (projectId) {
      // Track input tokens
      await saveCost({
        projectId,
        source: 'manual',
        step: 'short_hooks',
        service: 'claude',
        units: inputTokens,
        unitType: 'input_tokens',
      });
      // Track output tokens
      await saveCost({
        projectId,
        source: 'manual',
        step: 'short_hooks',
        service: 'claude',
        units: outputTokens,
        unitType: 'output_tokens',
      });
    }

    const cost = (inputTokens * 0.003 / 1000) + (outputTokens * 0.015 / 1000);
    const duration = Date.now() - startTime;
    console.log(`[GenerateShortHooks] Generated 4 hooks in ${duration}ms, cost: $${cost.toFixed(4)}`);

    return res.json({
      success: true,
      hooks,
    } as GenerateHooksResponse);

  } catch (error) {
    console.error('[GenerateShortHooks] Error:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    } as GenerateHooksResponse);
  }
});

export default router;
