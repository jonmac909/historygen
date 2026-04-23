---
name: youtube-transcript
description: "Fetch YouTube video transcripts using Supadata API. Use when you need to extract transcript/captions from any YouTube video. Triggers on: get transcript, fetch captions, youtube transcript, video text. Returns full transcript text with metadata."
---

# YouTube Transcript Fetcher

This skill fetches transcripts/captions from YouTube videos using the Supadata API.

**Use this skill when:** You need to extract the transcript or captions from a YouTube video.

---

## Setup Requirements

### Environment Variable
```
SUPADATA_API_KEY=<your-supadata-api-key>
```

Get your API key from [Supadata](https://supadata.ai).

---

## API Endpoint

### Supadata Transcript API
```
GET https://api.supadata.ai/v1/youtube/transcript
```

**Headers:**
```
x-api-key: <SUPADATA_API_KEY>
```

**Query Parameters:**
| Parameter | Required | Description |
|-----------|----------|-------------|
| `videoId` | Yes | YouTube video ID (11 characters) |
| `lang` | No | Language code (e.g., "en", "es") |

---

## Video ID Extraction

YouTube URLs come in multiple formats. Extract the 11-character video ID:

```typescript
const RE_YOUTUBE = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;

function extractVideoId(urlOrId: string): string | null {
  // Handle direct video ID
  if (urlOrId.length === 11 && /^[a-zA-Z0-9_-]+$/.test(urlOrId)) {
    return urlOrId;
  }
  // Extract from URL
  const match = urlOrId.match(RE_YOUTUBE);
  return match ? match[1] : null;
}
```

**Supported URL Formats:**
- `https://www.youtube.com/watch?v=VIDEO_ID`
- `https://youtu.be/VIDEO_ID`
- `https://www.youtube.com/embed/VIDEO_ID`
- `https://www.youtube.com/v/VIDEO_ID`
- Direct video ID: `VIDEO_ID`

---

## Implementation

### TypeScript/Express Route

```typescript
import { Router, Request, Response } from 'express';

const router = Router();
const SUPADATA_API_URL = "https://api.supadata.ai/v1/youtube/transcript";

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

    const apiKey = process.env.SUPADATA_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ success: false, error: 'SUPADATA_API_KEY not configured' });
    }

    // Build request URL
    const requestUrl = new URL(SUPADATA_API_URL);
    requestUrl.searchParams.set('videoId', videoId);
    if (lang) {
      requestUrl.searchParams.set('lang', lang);
    }

    const response = await fetch(requestUrl.toString(), {
      method: 'GET',
      headers: { 'x-api-key': apiKey },
    });

    if (!response.ok) {
      // Handle specific error codes
      if (response.status === 404) {
        return res.status(404).json({ success: false, error: 'No transcript available' });
      }
      if (response.status === 401) {
        return res.status(401).json({ success: false, error: 'Invalid API key' });
      }
      if (response.status === 429) {
        return res.status(429).json({ success: false, error: 'Rate limit exceeded' });
      }
      return res.status(response.status).json({ success: false, error: `API error: ${response.status}` });
    }

    const data = await response.json();

    // Check for error in response body
    if (data.error) {
      if (data.error === 'transcript-unavailable') {
        return res.status(404).json({
          success: false,
          error: 'No transcript available. Video may not have captions enabled.',
        });
      }
      return res.status(400).json({ success: false, error: data.message || data.error });
    }

    // Supadata returns content array with text segments
    if (!data.content || !Array.isArray(data.content)) {
      return res.status(500).json({ success: false, error: 'Unexpected response format' });
    }

    // Combine all text segments
    const transcript = data.content.map((segment: any) => segment.text).join(' ');

    return res.json({
      success: true,
      videoId,
      title: data.title || 'Unknown Title',
      transcript,
      language: data.lang || lang || 'en',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return res.json({ success: false, error: errorMessage });
  }
});

export default router;
```

### Standalone Function (Node.js)

```typescript
interface TranscriptResult {
  success: boolean;
  videoId?: string;
  title?: string;
  transcript?: string;
  language?: string;
  error?: string;
}

async function getYouTubeTranscript(
  urlOrId: string, 
  lang?: string
): Promise<TranscriptResult> {
  const videoId = extractVideoId(urlOrId);
  if (!videoId) {
    return { success: false, error: 'Invalid YouTube URL' };
  }

  const apiKey = process.env.SUPADATA_API_KEY;
  if (!apiKey) {
    return { success: false, error: 'SUPADATA_API_KEY not configured' };
  }

  const requestUrl = new URL('https://api.supadata.ai/v1/youtube/transcript');
  requestUrl.searchParams.set('videoId', videoId);
  if (lang) requestUrl.searchParams.set('lang', lang);

  const response = await fetch(requestUrl.toString(), {
    method: 'GET',
    headers: { 'x-api-key': apiKey },
  });

  if (!response.ok) {
    return { success: false, error: `API error: ${response.status}` };
  }

  const data = await response.json();
  
  if (data.error) {
    return { success: false, error: data.message || data.error };
  }

  if (!data.content || !Array.isArray(data.content)) {
    return { success: false, error: 'Unexpected response format' };
  }

  return {
    success: true,
    videoId,
    title: data.title || 'Unknown Title',
    transcript: data.content.map((s: any) => s.text).join(' '),
    language: data.lang || lang || 'en',
  };
}
```

---

## Response Format

### Supadata API Response
```json
{
  "content": [
    { "text": "First segment of transcript...", "offset": 0, "duration": 5000 },
    { "text": "Second segment...", "offset": 5000, "duration": 4500 }
  ],
  "lang": "en",
  "title": "Video Title"
}
```

### Processed Response
```json
{
  "success": true,
  "videoId": "dQw4w9WgXcQ",
  "title": "Video Title",
  "transcript": "Combined text from all segments...",
  "language": "en"
}
```

---

## Error Handling

| Status | Error | Meaning |
|--------|-------|---------|
| 400 | Invalid YouTube URL | URL format not recognized |
| 401 | Invalid API key | SUPADATA_API_KEY is wrong |
| 404 | No transcript available | Video has no captions |
| 429 | Rate limit exceeded | Too many requests |
| 500 | Unexpected response | API returned unexpected format |

### Error Response Format
```json
{
  "success": false,
  "error": "Description of what went wrong"
}
```

---

## Usage Examples

### cURL
```bash
curl -X POST http://localhost:10000/get-youtube-transcript \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```

### JavaScript Fetch
```javascript
const response = await fetch('/get-youtube-transcript', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ 
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    lang: 'en'  // optional
  })
});
const data = await response.json();
if (data.success) {
  console.log(data.transcript);
}
```

---

## Limitations

- **Captions required**: Only works on videos with captions (auto-generated or manual)
- **Rate limits**: Supadata has usage limits based on your plan
- **Language**: Not all videos have transcripts in all languages

---

## Cost

Supadata pricing varies by plan. Check [supadata.ai](https://supadata.ai) for current pricing.

---

## Alternatives Considered

| Service | Pros | Cons |
|---------|------|------|
| **Supadata** (used) | Fast, reliable, simple API | Paid service |
| YouTube Data API | Official, free tier | Complex, no direct transcript endpoint |
| yt-dlp | Free, self-hosted | Requires binary, YouTube blocks datacenters |
| youtube-transcript npm | Free | Unreliable, breaks with YouTube changes |

Supadata chosen for reliability and simple REST API.
