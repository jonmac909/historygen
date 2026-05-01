import { Router, Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient, formatSystemPrompt } from '../lib/anthropic-client';

const router = Router();

interface YouTubeMetadataRequest {
  title: string;
  script: string;
  projectId?: string;
}

interface YouTubeMetadataResponse {
  success: boolean;
  titles?: string[];
  description?: string;
  tags?: string[];
  error?: string;
}

router.post('/', async (req: Request, res: Response) => {
  const startTime = Date.now();
  console.log('[generate-youtube-metadata] Starting metadata generation');

  try {
    const { title, script, projectId } = req.body as YouTubeMetadataRequest;

    if (!script || script.trim().length === 0) {
      console.error('[generate-youtube-metadata] No script provided');
      return res.status(400).json({
        success: false,
        error: 'Script content is required',
      } as YouTubeMetadataResponse);
    }

    // Initialize Anthropic client
    const anthropic = createAnthropicClient();

    // Truncate script if too long (keep first 8000 chars for context)
    const truncatedScript = script.length > 8000
      ? script.substring(0, 8000) + '...[truncated]'
      : script;

    const systemPrompt = `You are an expert YouTube SEO specialist and content strategist. Your task is to generate optimized YouTube metadata that will maximize views and engagement for historical documentary content.

Generate metadata that:
- Uses proven YouTube SEO techniques
- Includes power words and emotional hooks
- Is historically accurate
- Appeals to history enthusiasts and general audiences
- Maximizes click-through rate (CTR)

IMPORTANT: Return your response in valid JSON format only, with no additional text or markdown.`;

    const userPrompt = `Based on this historical video script, generate YouTube metadata.

Video Title (for context): ${title || 'Historical Documentary'}

Script Content:
${truncatedScript}

Generate the following JSON with these requirements:

TITLES (exactly 10 options, max 100 characters each):
- 2-3 curiosity-driven titles with questions or mystery
- 2-3 dramatic/emotional titles
- 2-3 educational/informative titles
- 2 clickbait-style (but still accurate) titles
- Include relevant years/dates when applicable
- Use power words: secrets, hidden, untold, forgotten, shocking, etc.

DESCRIPTION (500-1000 characters):
- Start with a hook that creates curiosity
- Summarize the key historical content
- Include relevant keywords naturally
- End with a call-to-action
- Use \\n for line breaks

TAGS (15-20 lowercase tags):
- 3-4 specific topic keywords (e.g., "roman empire", "medieval history")
- 3-4 era/time period tags (e.g., "ancient history", "15th century")
- 3-4 key figures/places mentioned (e.g., "julius caesar", "constantinople")
- 3-4 broader category tags (e.g., "history documentary", "educational")
- 2-3 trending history tags (e.g., "dark history", "untold stories")
- DO NOT include generic tags like "video" or "youtube"

Return ONLY this JSON structure (no markdown, no code blocks):
{"titles": ["title1", "title2", ...], "description": "...", "tags": ["tag1", "tag2", ...]}`;

    console.log('[generate-youtube-metadata] Calling Claude API...');

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: userPrompt,
        },
      ],
      system: formatSystemPrompt(systemPrompt) as Anthropic.MessageCreateParams['system'],
    });

    // Extract text content
    const textContent = response.content.find(block => block.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text response from Claude');
    }

    // Parse JSON response
    let metadata: { titles: string[]; description: string; tags: string[] };
    try {
      // Clean up response - remove markdown code blocks if present
      let jsonText = textContent.text.trim();
      console.log('[generate-youtube-metadata] Raw response (first 500 chars):', jsonText.slice(0, 500));

      if (jsonText.startsWith('```json')) {
        jsonText = jsonText.slice(7);
      }
      if (jsonText.startsWith('```')) {
        jsonText = jsonText.slice(3);
      }
      if (jsonText.endsWith('```')) {
        jsonText = jsonText.slice(0, -3);
      }
      jsonText = jsonText.trim();

      metadata = JSON.parse(jsonText);
      console.log('[generate-youtube-metadata] Parsed - titles:', metadata.titles?.length, 'description:', !!metadata.description, 'tags:', metadata.tags?.length);
    } catch (parseError) {
      console.error('[generate-youtube-metadata] Failed to parse JSON:', textContent.text);
      throw new Error('Failed to parse Claude response as JSON');
    }

    // Validate response structure
    if (!Array.isArray(metadata.titles) || metadata.titles.length === 0) {
      throw new Error('Invalid titles in response');
    }
    if (typeof metadata.description !== 'string') {
      throw new Error('Invalid description in response');
    }
    if (!Array.isArray(metadata.tags)) {
      metadata.tags = [];
    }

    // Ensure we have exactly 10 titles, truncate if too long
    const titles = metadata.titles.slice(0, 10).map(t =>
      t.length > 100 ? t.substring(0, 97) + '...' : t
    );

    const duration = Date.now() - startTime;
    console.log(`[generate-youtube-metadata] Generated ${titles.length} titles in ${duration}ms`);

    return res.json({
      success: true,
      titles,
      description: metadata.description,
      tags: metadata.tags,
    } as YouTubeMetadataResponse);

  } catch (error) {
    console.error('[generate-youtube-metadata] Error:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to generate metadata',
    } as YouTubeMetadataResponse);
  }
});

export default router;
