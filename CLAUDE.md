# CLAUDE.md

HistoryGen AI - AI-powered historical video generation from YouTube transcripts.

## Stack
- Frontend: React + TypeScript + Vite + shadcn-ui (Vercel)
- Backend: Express + TypeScript (Railway)
- Storage: Supabase
- TTS: RunPod Fish Speech | Images: RunPod Z-Image | Video: Seedance 1.5 Pro

## URLs
- Frontend: https://autoaigen.com
- API: https://marvelous-blessing-staging.up.railway.app
- Supabase: https://udqfdeoullsxttqguupz.supabase.co

## Commands
```bash
# Frontend
npm i && npm run dev          # Dev server at :8080
npm run build                 # Production build

# Backend (render-api/)
cd render-api && npm i && npm run dev

# Deploy Supabase function
npx supabase functions deploy <name> --project-ref udqfdeoullsxttqguupz
```

## Key Files
- `src/pages/Index.tsx` - Main pipeline UI
- `src/lib/api.ts` - API client
- `render-api/src/routes/` - All backend endpoints
- `render-api/src/lib/` - Shared utilities

## Docs
See `docs/` folder for detailed architecture, troubleshooting, deployment guides.
