# CLAUDE.md

HistoryGen AI - AI-powered historical video generation from YouTube transcripts.

---

## Augmented Coding Patterns (ACP)

> Teaching AI what you would do - externalizing reasoning step by step.

### Ground Rules

**Communication:**
- Be extremely succinct - avoid verbose explanations
- One question at a time
- Warn proactively if you detect issues

**Process:**
- Work in small, verifiable steps
- State expectations before running code (Hypothesize pattern)
- Run tests before AND after changes
- Commit frequently at stable checkpoints
- Ask "what would you recommend?" before proposing solutions

**Context Management:**
- When context gets large, summarize and save to files
- Focus on one task at a time
- Track progress using TodoWrite tool

### Key Patterns

| Pattern | Description |
|---------|-------------|
| **Hypothesize** | State expectations before running code |
| **Reverse Direction** | Ask "what would you recommend?" |
| **Test First** | No production code without failing test |
| **One Problem at a Time** | Break big steps into smaller ones |
| **Cross-Context Memory** | Use persistent files for state |
| **Stop** | When things go wrong, stop immediately |
| **Refactor Guard** | Make smallest change → AI review → run tests → commit |
| **Algorithmify** | Automate repetitive tasks with scripts |
| **CLI First** | Prefer command-line tools |

### Process Files

Reference these for structured workflows:
- `process/tdd.md` - TDD red-green-refactor cycle
- `process/feature.md` - New feature workflow
- `process/bugfix.md` - Bug investigation workflow

### Memory Files

Update these as work progresses:
- `memory/goal.md` - Current objective and task list
- `memory/state.md` - TDD phase, blockers, current task
- `memory/learnings/` - Decisions and knowledge to preserve

---

## Project Overview

HistoryGen AI generates AI-powered historical video content from YouTube URLs. It processes transcripts, rewrites scripts, generates voice-cloned audio (10 segments), creates captions, and produces AI images.

**Stack:**
- Frontend: React + TypeScript + Vite + shadcn-ui + Tailwind CSS
- Backend API: Express + TypeScript on Railway
- Storage: Supabase
- TTS: RunPod with Fish Speech OpenAudio S1-mini
- Image Generation: RunPod with Z-Image-Turbo
- Deployment: Vercel (frontend), Railway (API)

**Live URLs:**
- Frontend: https://autoaigen.com
- Railway API: https://marvelous-blessing-staging.up.railway.app
- Supabase: https://udqfdeoullsxttqguupz.supabase.co

**Note:** `render-api/` folder retains "render" name for historical reasons (originally on Render.com, now on Railway).

---

## Development Commands

### Frontend
```bash
npm i                    # Install dependencies
npm run dev              # Start dev server (http://localhost:8080)
npm run build            # Production build
npm test                 # Run unit tests (watch mode)
npx playwright test      # Run E2E tests
```

**RunPod Monitoring:**
```bash
npm run monitor:runpod              # One-time log fetch
npm run monitor:runpod:watch        # Continuous monitoring
npm run monitor:runpod:errors       # Show errors only
```

### Railway API (`render-api/`)
```bash
cd render-api
npm install              # Install dependencies
npm run dev              # Start dev server with hot reload
npm run build            # Compile TypeScript
npm start                # Start production server
```

### Supabase Functions
```bash
export SUPABASE_ACCESS_TOKEN='your-token'
npx supabase functions deploy <function-name> --project-ref udqfdeoullsxttqguupz
```

---

## Documentation

For detailed information, see:

- **[Architecture](docs/architecture/)** - System design, pipelines, API routes
  - [Backend Design](docs/architecture/backend.md) - Railway API, Supabase functions
  - [Frontend Pipeline](docs/architecture/frontend.md) - UI flow, modals, features
  - [Audio Generation](docs/architecture/audio.md) - Fish Speech TTS, segments, quality
  - [Image Generation](docs/architecture/images.md) - Z-Image, prompts, rolling concurrency
  - [Video Rendering](docs/architecture/video.md) - FFmpeg, overlays, parallel chunks
  - [Video Clips](docs/architecture/clips.md) - Seedance 1.5 Pro, frame continuity
  - [Video Analysis](docs/architecture/analysis.md) - LLaVA-NeXT, VideoRAG, outliers
  - [YouTube Upload](docs/architecture/youtube.md) - OAuth, resumable uploads
  - [Auto Poster](docs/architecture/auto-poster.md) - Automated daily pipeline
  - [RunPod Workers](docs/architecture/runpod.md) - Endpoints, rebuilds, allocation

- **[Troubleshooting](docs/troubleshooting.md)** - Common issues and solutions

- **[Deployment](docs/deployment.md)** - Railway, Cloudflare Pages, environment variables

- **[Reference](docs/reference.md)** - File naming, defaults, gotchas, security

---

## Quick Start

1. Clone repo
2. Copy `.env.example` to `.env` and fill in keys
3. `npm i && cd render-api && npm install`
4. `npm run dev` (frontend) + `cd render-api && npm run dev` (API)
5. Open http://localhost:8080

For production deployment, see [Deployment Guide](docs/deployment.md).
