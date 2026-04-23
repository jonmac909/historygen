# Supabase Edge Functions

This directory contains Supabase Edge Functions for the HistoryVidGen application. These serverless functions handle AI generation tasks including audio synthesis, image generation, transcription, and more.

## Environment Variables

All functions run on Deno and use `Deno.env.get()` to access environment variables. Set these in your Supabase project dashboard under **Project Settings > Edge Functions > Secrets**.

### Required Environment Variables

#### Supabase (Auto-injected)

These are automatically available in all edge functions:

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key for server-side operations |

#### RunPod Configuration

| Variable | Description | Used By |
|----------|-------------|---------|
| `RUNPOD_API_KEY` | RunPod API key for authentication | `generate-audio`, `generate-images` |
| `RUNPOD_ENDPOINT_ID` | RunPod endpoint ID for Fish Speech TTS audio generation | `generate-audio` |
| `RUNPOD_ZIMAGE_ENDPOINT_ID` | RunPod endpoint ID for Z-Image generation | `generate-images` |

#### AI Service API Keys

| Variable | Description | Used By |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Anthropic (Claude) API key for script rewriting and image prompt generation | `rewrite-script`, `generate-image-prompts` |
| `OPENAI_API_KEY` | OpenAI API key for Whisper transcription | `generate-captions` |
| `ELEVENLABS_API_KEY` | ElevenLabs API key for voice listing | `get-elevenlabs-voices` |
| `SUPADATA_API_KEY` | Supadata API key for YouTube transcript fetching | `get-youtube-transcript` |

### Optional Environment Variables

| Variable | Description | Default | Used By |
|----------|-------------|---------|---------|
| `DEBUG` | Enable debug logging (`'true'` to enable) | `'false'` | `generate-audio` |

## Functions Overview

### `generate-audio`

Generates voiceover audio using Fish Speech TTS via RunPod.

**Features:**
- Text-to-speech with automatic chunking (250 char limit per chunk)
- Voice cloning support via reference audio
- Streaming and non-streaming modes
- Automatic WAV concatenation for multi-chunk audio
- SSRF protection for voice sample URLs

**Required Secrets:**
- `RUNPOD_API_KEY`
- `RUNPOD_ENDPOINT_ID`
- `SUPABASE_URL` (auto-injected)
- `SUPABASE_SERVICE_ROLE_KEY` (auto-injected)

### `generate-images`

Generates images using Z-Image via RunPod.

**Features:**
- Batch image generation with parallel processing
- Support for timing-based filenames
- Streaming progress updates
- Configurable quality and aspect ratio

**Required Secrets:**
- `RUNPOD_API_KEY`
- `RUNPOD_ZIMAGE_ENDPOINT_ID`
- `SUPABASE_URL` (auto-injected)
- `SUPABASE_SERVICE_ROLE_KEY` (auto-injected)

### `generate-captions`

Generates SRT captions from audio using OpenAI Whisper.

**Features:**
- Automatic audio chunking for large files (25MB Whisper limit)
- Segment splitting for readable captions (8 words max)
- SRT file generation and upload

**Required Secrets:**
- `OPENAI_API_KEY`
- `SUPABASE_URL` (auto-injected)
- `SUPABASE_SERVICE_ROLE_KEY` (auto-injected)

### `generate-image-prompts`

Generates image prompts from script and SRT content using Claude.

**Features:**
- Time-coded prompt generation
- Scene description extraction
- Style prompt integration

**Required Secrets:**
- `ANTHROPIC_API_KEY`

### `rewrite-script`

Rewrites transcripts into documentary narration using Claude.

**Features:**
- Streaming and non-streaming modes
- Automatic continuation for long scripts
- Configurable word count targets

**Required Secrets:**
- `ANTHROPIC_API_KEY`

### `generate-video`

Generates video timeline metadata from images and captions.

**Features:**
- EDL (Edit Decision List) generation
- CSV timeline export
- Automatic timing calculation

**Required Secrets:**
- `SUPABASE_URL` (auto-injected)
- `SUPABASE_SERVICE_ROLE_KEY` (auto-injected)

### `get-elevenlabs-voices`

Fetches available voices from ElevenLabs.

**Required Secrets:**
- `ELEVENLABS_API_KEY`

### `get-youtube-transcript`

Fetches YouTube video transcripts via Supadata API.

**Required Secrets:**
- `SUPADATA_API_KEY`

### `download-images-zip`

Proxies image downloads from Supabase storage with SSRF protection.

**Required Secrets:**
- None (uses Supabase storage publicly)

## Local Development

### Prerequisites

1. Install [Deno](https://deno.land/)
2. Install [Supabase CLI](https://supabase.com/docs/guides/cli)

### Running Locally

```bash
# Start Supabase locally
supabase start

# Serve functions locally
supabase functions serve

# Serve a specific function
supabase functions serve generate-audio
```

### Setting Local Secrets

Create a `.env.local` file in the `supabase/functions` directory:

```env
RUNPOD_API_KEY=your_runpod_key
RUNPOD_ENDPOINT_ID=your_tts_endpoint_id
RUNPOD_ZIMAGE_ENDPOINT_ID=your_image_endpoint_id
ANTHROPIC_API_KEY=your_anthropic_key
OPENAI_API_KEY=your_openai_key
ELEVENLABS_API_KEY=your_elevenlabs_key
SUPADATA_API_KEY=your_supadata_key
```

Then run:

```bash
supabase functions serve --env-file ./supabase/functions/.env.local
```

## Deployment

### Setting Production Secrets

```bash
# Set individual secrets
supabase secrets set RUNPOD_API_KEY=your_key
supabase secrets set RUNPOD_ENDPOINT_ID=your_endpoint_id
supabase secrets set RUNPOD_ZIMAGE_ENDPOINT_ID=your_image_endpoint_id
supabase secrets set ANTHROPIC_API_KEY=your_key
supabase secrets set OPENAI_API_KEY=your_key
supabase secrets set ELEVENLABS_API_KEY=your_key
supabase secrets set SUPADATA_API_KEY=your_key

# Or set from file
supabase secrets set --env-file ./path/to/secrets.env
```

### Deploying Functions

```bash
# Deploy all functions
supabase functions deploy

# Deploy a specific function
supabase functions deploy generate-audio
```

## CORS Configuration

All functions include CORS headers allowing all origins:

```typescript
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
```

For production, consider restricting `Access-Control-Allow-Origin` to your specific domain.

## Error Handling

All functions return consistent error responses:

```json
{
  "error": "Error message here",
  "success": false
}
```

HTTP status codes:
- `400` - Bad request (missing/invalid parameters)
- `401` - Unauthorized (invalid API key)
- `403` - Forbidden (SSRF protection triggered)
- `429` - Rate limited
- `500` - Internal server error

## Security Considerations

1. **SSRF Protection**: Functions that fetch external URLs validate against allowed domains (Supabase storage only)
2. **Input Validation**: All functions validate required parameters before processing
3. **API Key Protection**: All API keys are stored as Supabase secrets, never in code
4. **URL Validation**: Voice sample and image URLs must be from trusted Supabase storage domains
