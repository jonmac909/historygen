# HistoryVidGen

A modern web application for generating history video assets from YouTube content. Transform any YouTube video into production-ready assets including AI-rewritten scripts, voice-cloned audio, auto-generated captions, and AI-generated images.

## Features

- **YouTube Transcript Extraction** - Automatically fetch transcripts from YouTube videos
- **AI Script Rewriting** - Transform transcripts into engaging scripts using Claude AI models
- **Voice Cloning Audio** - Generate voiceover audio with your cloned voice via Fish Speech TTS
- **AI Image Generation** - Create scene images with AI-generated visual prompts
- **Caption Generation** - Auto-generate SRT captions from audio
- **Step-by-Step Workflow** - Review and edit each asset before proceeding
- **Bulk Download** - Download all generated assets as a package

## Prerequisites

- Node.js 18+
- npm
- Supabase project with Edge Functions deployed

## Setup

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd HistoryVidGen
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Copy environment template:
   ```bash
   cp .env.example .env
   ```

4. Configure environment variables in `.env`:
   ```env
   VITE_SUPABASE_PROJECT_ID="your-project-id"
   VITE_SUPABASE_PUBLISHABLE_KEY="your-publishable-key"
   VITE_SUPABASE_URL="https://your-project-id.supabase.co"
   ```

5. Start the development server:
   ```bash
   npm run dev
   ```

6. Open http://localhost:8080 in your browser

## Configuration

### Required Environment Variables

| Variable | Description |
|----------|-------------|
| `VITE_SUPABASE_PROJECT_ID` | Your Supabase project identifier |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Supabase public API key (anon key) |
| `VITE_SUPABASE_URL` | Supabase project endpoint URL |

All client-side environment variables must use the `VITE_` prefix to be accessible in the browser.

### Supabase Edge Functions

This application requires the following Edge Functions deployed to your Supabase project:

- `get-youtube-transcript` - Fetches YouTube video transcripts
- `rewrite-script` - AI-powered script rewriting with streaming
- `generate-audio` - Voice cloning audio generation via RunPod
- `generate-captions` - SRT caption generation from audio
- `generate-image-prompts` - AI scene description generation
- `generate-images` - Image generation via RunPod
- `generate-video` - Video timeline generation
- `download-images-zip` - Bulk image download

See `supabase/functions/README.md` for Edge Function configuration details.

## Development

### Available Scripts

```bash
# Start development server with hot reload
npm run dev

# Run unit tests in watch mode
npm test

# Run tests once (for CI)
npm run test:run

# Run tests with coverage
npm run test:coverage

# Run tests with UI
npm run test:ui

# Build for production
npm run build

# Preview production build
npm run preview

# Lint code
npm run lint
```

### Running Tests

The project uses Vitest for unit testing and React Testing Library for component tests:

```bash
# Watch mode (recommended during development)
npm test

# Single run
npm run test:run

# With coverage report
npm run test:coverage
```

### Building for Production

```bash
npm run build
```

Production files are output to the `dist/` directory.

## Architecture

```
src/
├── components/        # React UI components
│   ├── ui/           # shadcn/ui components
│   └── *.tsx         # Feature-specific components
├── data/             # Static data (templates, etc.)
├── hooks/            # Custom React hooks
├── integrations/     # External service integrations
│   └── supabase/     # Supabase client configuration
├── lib/              # Utility functions and API client
├── pages/            # Page components
└── test/             # Test configuration and utilities

supabase/
└── functions/        # Supabase Edge Functions
```

### Key Components

- **Index.tsx** - Main application page with video generation workflow
- **api.ts** - Client-side API functions for Supabase Edge Function calls
- **ProcessingModal** - Step-by-step progress display
- **ScriptReviewModal** - Script editing before audio generation
- **AudioPreviewModal** - Audio review before caption generation
- **ImagesPreviewModal** - Image review with regeneration capability

## Tech Stack

- **Frontend**: React 18, TypeScript
- **Build Tool**: Vite
- **Styling**: Tailwind CSS
- **UI Components**: shadcn/ui (Radix UI primitives)
- **Backend**: Supabase Edge Functions (Deno)
- **Testing**: Vitest, React Testing Library
- **AI Models**: Claude (script writing), Fish Speech (TTS), RunPod (images)

## Workflow

1. **Input** - Paste a YouTube URL or enter a video title
2. **Configure** - Set script template, AI model, voice sample, and preferences
3. **Generate Script** - AI rewrites the transcript into your preferred format
4. **Review Script** - Edit the generated script before proceeding
5. **Generate Audio** - Create voice-cloned audio from the script
6. **Review Audio** - Listen and optionally regenerate
7. **Generate Captions** - Create SRT captions from the audio
8. **Review Captions** - Edit timing and text if needed
9. **Generate Images** - Create AI images for each scene
10. **Review Images** - Regenerate individual images as needed
11. **Download** - Get all assets packaged together

## License

Private project - All rights reserved.
