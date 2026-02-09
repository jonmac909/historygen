import { Router, Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient, formatSystemPrompt } from '../lib/anthropic-client';
import { fetch, ProxyAgent } from 'undici';

const router = Router();

// Proxy for YouTube URLs (same as youtube-scraper)
const PROXY_URL = process.env.YTDLP_PROXY_URL || '';
function getProxyAgent() {
  if (!PROXY_URL) return undefined;
  return new ProxyAgent(PROXY_URL);
}

interface AnalyzeThumbnailRequest {
  thumbnailUrl: string;
  videoTitle?: string;
}

interface ThumbnailAnalysis {
  composition: string;
  colorPalette: string[];
  textStyle: string;
  mood: string;
  keyElements: string[];
  recreationPrompt: string;
}

// Analyze a YouTube thumbnail and generate a recreation prompt
router.post('/', async (req: Request, res: Response) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
    }

    const { thumbnailUrl, videoTitle }: AnalyzeThumbnailRequest = req.body;

    if (!thumbnailUrl) {
      return res.status(400).json({ error: 'thumbnailUrl is required' });
    }

    console.log(`[AnalyzeThumbnail] Analyzing: ${thumbnailUrl}`);

    // Download thumbnail image (use proxy for YouTube URLs)
    const isYouTubeUrl = thumbnailUrl.includes('ytimg.com') || thumbnailUrl.includes('youtube.com');
    const agent = isYouTubeUrl ? getProxyAgent() : undefined;
    if (isYouTubeUrl && agent) {
      console.log(`[AnalyzeThumbnail] Using proxy for YouTube thumbnail`);
    }

    const imageResponse = await fetch(thumbnailUrl, agent ? { dispatcher: agent } : undefined);
    if (!imageResponse.ok) {
      return res.status(400).json({ error: `Failed to fetch thumbnail: ${imageResponse.status}` });
    }

    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
    const base64Image = imageBuffer.toString('base64');
    const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';

    // Determine media type for Claude
    let mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' = 'image/jpeg';
    if (contentType.includes('png')) mediaType = 'image/png';
    else if (contentType.includes('gif')) mediaType = 'image/gif';
    else if (contentType.includes('webp')) mediaType = 'image/webp';

    const anthropic = createAnthropicClient(apiKey);

    const systemPrompt = `You are an expert thumbnail designer analyzing YouTube thumbnails.
Your job is to extract the visual style and composition so it can be recreated for a similar video.

Focus on:
1. Layout and composition (rule of thirds, focal points, text placement)
2. Color palette (dominant colors, contrast, mood)
3. Text style (font type, size, effects like outlines/shadows)
4. Visual mood (dramatic, mysterious, educational, exciting)
5. Key visual elements (faces, objects, symbols)

Output a detailed recreation prompt that could be used to generate a similar thumbnail.`;

    const userPrompt = videoTitle
      ? `Analyze this YouTube thumbnail for a video titled "${videoTitle}". Describe its visual style in detail and provide a recreation prompt.`
      : `Analyze this YouTube thumbnail. Describe its visual style in detail and provide a recreation prompt.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: formatSystemPrompt(systemPrompt) as Anthropic.MessageCreateParams['system'],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: base64Image,
              },
            },
            {
              type: 'text',
              text: userPrompt + `

Respond in this exact JSON format:
{
  "composition": "Description of layout, focal points, rule of thirds usage",
  "colorPalette": ["#hex1", "#hex2", "#hex3", "#hex4", "#hex5"],
  "textStyle": "Description of text fonts, sizes, effects",
  "mood": "Overall emotional tone",
  "keyElements": ["element1", "element2", "element3"],
  "recreationPrompt": "A detailed prompt to recreate a similar thumbnail style"
}`,
            },
          ],
        },
      ],
    });

    // Extract text from response
    const textContent = response.content.find(c => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text response from Claude');
    }

    // Parse JSON from response
    let analysis: ThumbnailAnalysis;
    try {
      // Extract JSON from response (might be wrapped in markdown code blocks)
      let jsonStr = textContent.text;
      const jsonMatch = jsonStr.match(/```json\s*([\s\S]*?)\s*```/) || jsonStr.match(/```\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
      }
      // Also try to find raw JSON object
      const rawJsonMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (rawJsonMatch) {
        jsonStr = rawJsonMatch[0];
      }
      analysis = JSON.parse(jsonStr);
    } catch (parseError) {
      console.error('[AnalyzeThumbnail] Failed to parse JSON:', textContent.text);
      // Return raw analysis if JSON parsing fails
      return res.json({
        success: true,
        analysis: {
          composition: 'Unable to parse structured analysis',
          colorPalette: [],
          textStyle: 'Unknown',
          mood: 'Unknown',
          keyElements: [],
          recreationPrompt: textContent.text,
        },
        rawResponse: textContent.text,
      });
    }

    console.log(`[AnalyzeThumbnail] Analysis complete. Mood: ${analysis.mood}`);

    return res.json({
      success: true,
      analysis,
    });

  } catch (error) {
    console.error('[AnalyzeThumbnail] Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({ success: false, error: errorMessage });
  }
});

export default router;
