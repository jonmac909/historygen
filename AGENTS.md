# Hosting and release policy

Hosting: Cloudflare only. Never Vercel or Netlify.

Use the Docker gate (`docker build -f Dockerfile.gate .`), then a PR and verified
green checks. Do not run GitHub Actions for releases. Deploy only the tested
merged source through the existing Cloudflare project and verify it live.

Follow CLAUDE.md's data and paid-provider safeguards. Never read, copy or change
application secrets for JON-24. Repository configuration cleanup does not deploy
application assets or change domains, backend functions, data or provider jobs.
