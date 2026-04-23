import { Router, Request, Response } from 'express';

const router = Router();

const SUPADATA_API_URL = "https://api.supadata.ai/v1/youtube/transcript";
const RE_YOUTUBE = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;

function extractVideoId(urlOrId: string): string | null {
  if (urlOrId.length === 11 && /^[a-zA-Z0-9_-]+$/.test(urlOrId)) {
    return urlOrId;
  }
  const match = urlOrId.match(RE_YOUTUBE);
  return match ? match[1] : null;
}

router.post('/', async (req: Request, res: Response) => {
  try {
    const { url, lang } = req.body;

    if (!url) {
      return res.status(400).json({ success: false, error: 'URL is required' });
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      return res.status(400).json({ success: false, error: 'Invalid YouTube URL' });
    }

    console.log(`=== Fetching transcript for video: ${videoId} via Supadata ===`);

    const apiKey = process.env.SUPADATA_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ success: false, error: 'SUPADATA_API_KEY is not configured' });
    }

    // Build request URL with parameters
    const requestUrl = new URL(SUPADATA_API_URL);
    requestUrl.searchParams.set('videoId', videoId);
    if (lang) {
      requestUrl.searchParams.set('lang', lang);
    }

    console.log(`Calling Supadata API...`);

    const response = await fetch(requestUrl.toString(), {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Supadata API error: ${response.status} - ${errorText}`);

      if (response.status === 404) {
        return res.status(404).json({ success: false, error: 'No transcript available for this video' });
      }
      if (response.status === 401) {
        return res.status(401).json({ success: false, error: 'Invalid Supadata API key' });
      }
      if (response.status === 429) {
        return res.status(429).json({ success: false, error: 'API rate limit exceeded. Please try again later.' });
      }

      return res.status(response.status).json({ success: false, error: `Supadata API error: ${response.status}` });
    }

    const data = await response.json() as any;
    console.log(`Supadata response received`);

    // Check for error in response body (Supadata returns 200 with error object for some errors)
    if (data.error) {
      console.error('Supadata error:', data.error, data.message);
      if (data.error === 'transcript-unavailable') {
        return res.status(404).json({
          success: false,
          error: 'No transcript available for this video. The video may not have captions enabled.',
        });
      }
      return res.status(400).json({
        success: false,
        error: data.message || data.error || 'Supadata API error',
      });
    }

    // Supadata returns content array with text segments
    if (!data.content || !Array.isArray(data.content)) {
      console.error('Unexpected response format:', JSON.stringify(data).substring(0, 200));
      return res.status(500).json({ success: false, error: 'Unexpected response format from Supadata' });
    }

    // Combine all text segments
    const transcript = data.content.map((segment: any) => segment.text).join(' ');
    const language = data.lang || lang || 'en';

    // Try to get the video title (Supadata may include it)
    const title = data.title || 'Unknown Title';

    console.log(`=== Success: ${transcript.length} chars, language: ${language} ===`);

    return res.json({
      success: true,
      videoId,
      title,
      transcript,
      language,
    });
  } catch (error) {
    console.error('Error:', error);

    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

    return res.json({
      success: false,
      videoId: '',
      title: '',
      transcript: null,
      error: errorMessage
    });
  }
});

export default router;
