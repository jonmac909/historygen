import { Router, Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient } from '../lib/anthropic-client';

const router = Router();

interface RewriteTitleRequest {
  originalTitle: string;
  channelName?: string;
  videoTopic?: string;
}

interface TitleVariation {
  title: string;
  reasoning: string;
}

interface RewriteTitleResponse {
  success: boolean;
  originalTitle: string;
  recommendedTitle: string;
  variations: TitleVariation[];
}

// Rewrite a video title to be similar but unique
router.post('/', async (req: Request, res: Response) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
    }

    const { originalTitle, channelName, videoTopic }: RewriteTitleRequest = req.body;

    if (!originalTitle) {
      return res.status(400).json({ error: 'originalTitle is required' });
    }

    console.log(`[RewriteTitle] Rewriting: "${originalTitle}"`);

    const anthropic = createAnthropicClient(apiKey);

    const systemPrompt = `You are an expert YouTube title writer specializing in history and educational content.
Your job is to rewrite video titles to be similar in style and appeal but unique enough to avoid duplication.

Guidelines:
1. Maintain the same emotional hook and curiosity gap
2. Keep similar length (under 70 characters ideally)
3. Preserve the historical topic and time period
4. Use power words that drive clicks
5. Avoid clickbait but maintain intrigue
6. Make it unique - not just synonym substitution

Examples of good rewrites:
- "The Dark Secret of Medieval Castles" → "What Medieval Castles Were Hiding"
- "Why Rome Really Fell" → "The True Reason Rome Collapsed"
- "The Untold Story of the Vikings" → "Vikings: What History Books Don't Tell You"`;

    const contextInfo = [
      channelName ? `Channel: ${channelName}` : null,
      videoTopic ? `Topic: ${videoTopic}` : null,
    ].filter(Boolean).join('\n');

    const userPrompt = `Rewrite this YouTube video title:

Original: "${originalTitle}"
${contextInfo ? `\n${contextInfo}` : ''}

Provide 5 variations with reasoning for each, then recommend the best one.

Respond in this exact JSON format:
{
  "variations": [
    {"title": "Variation 1", "reasoning": "Why this works"},
    {"title": "Variation 2", "reasoning": "Why this works"},
    {"title": "Variation 3", "reasoning": "Why this works"},
    {"title": "Variation 4", "reasoning": "Why this works"},
    {"title": "Variation 5", "reasoning": "Why this works"}
  ],
  "recommendedTitle": "The best variation",
  "recommendedReasoning": "Why this is the best choice"
}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: userPrompt,
        },
      ],
    });

    // Extract text from response
    const textContent = response.content.find(c => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text response from Claude');
    }

    // Parse JSON from response
    let result: any;
    try {
      let jsonStr = textContent.text;
      const jsonMatch = jsonStr.match(/```json\s*([\s\S]*?)\s*```/) || jsonStr.match(/```\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
      }
      const rawJsonMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (rawJsonMatch) {
        jsonStr = rawJsonMatch[0];
      }
      result = JSON.parse(jsonStr);
    } catch (parseError) {
      console.error('[RewriteTitle] Failed to parse JSON:', textContent.text);
      // Fallback: extract first line as title
      const lines = textContent.text.split('\n').filter(l => l.trim());
      return res.json({
        success: true,
        originalTitle,
        recommendedTitle: lines[0] || originalTitle,
        variations: [],
        rawResponse: textContent.text,
      });
    }

    console.log(`[RewriteTitle] Recommended: "${result.recommendedTitle}"`);

    return res.json({
      success: true,
      originalTitle,
      recommendedTitle: result.recommendedTitle,
      variations: result.variations || [],
      reasoning: result.recommendedReasoning,
    });

  } catch (error) {
    console.error('[RewriteTitle] Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({ success: false, error: errorMessage });
  }
});

export default router;
