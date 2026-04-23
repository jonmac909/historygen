# Scripts

This directory contains utility scripts for the HistoryVidGen project.

## Available Scripts

### deploy-function.sh

Deploys Supabase Edge Functions to production.

#### Purpose

This script automates the deployment of Supabase Edge Functions, specifically the `generate-audio` function that handles audio generation via RunPod integration.

#### Prerequisites

1. **Supabase CLI**: Install via npm (already in project dependencies)
2. **Supabase Access Token**: Required for authentication

#### Getting Your Access Token

1. Navigate to [Supabase Account Tokens](https://supabase.com/dashboard/account/tokens)
2. Click "Generate new token"
3. Copy the token securely

#### Usage

**Interactive Mode** (shows instructions):
```bash
./scripts/deploy-function.sh
```

**Deployment Mode**:
```bash
# Set the token
export SUPABASE_ACCESS_TOKEN='your-token-here'

# Run deployment
./scripts/deploy-function.sh deploy
```

**One-liner**:
```bash
SUPABASE_ACCESS_TOKEN='your-token' ./scripts/deploy-function.sh deploy
```

#### What It Does

1. Links the local project to the Supabase project (project-ref: `crrgvodgeqayidluzqwz`)
2. Deploys the `generate-audio` Edge Function

#### Security Notes

- Never commit your `SUPABASE_ACCESS_TOKEN` to version control
- Use environment variables or secure secret management for CI/CD
- Tokens can be revoked at any time from the Supabase dashboard

#### Troubleshooting

**"Error: SUPABASE_ACCESS_TOKEN not set"**
- Ensure you've exported the token before running with the `deploy` argument
- Verify the token is valid and hasn't expired

**Link fails**
- Verify you have appropriate permissions on the Supabase project
- Check that the project-ref matches your Supabase project

## Adding New Scripts

When adding new scripts to this directory:

1. Make the script executable: `chmod +x scripts/your-script.sh`
2. Add documentation to this README
3. Use relative paths within scripts for portability
4. Include help/usage information when run without arguments
