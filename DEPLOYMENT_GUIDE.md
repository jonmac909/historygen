# Deployment Guide for Voice Cloning Fix

## Quick Start: 3 Ways to Deploy

### Method 1: CLI Deployment (Fastest)
1. Get your Supabase access token: https://supabase.com/dashboard/account/tokens
2. Run:
   ```bash
   export SUPABASE_ACCESS_TOKEN='your-token-here'
   ./deploy-function.sh deploy
   ```

### Method 2: Manual via Supabase Dashboard
1. Go to https://supabase.com/dashboard/project/crrgvodgeqayidluzqwz/functions
2. Click on "generate-audio" function
3. Click "Edit function"
4. Copy the entire contents of `supabase/functions/generate-audio/index.ts`
5. Paste into the editor
6. Click "Deploy"

### Method 3: Git Push (If using Lovable)
1. Commit changes: `git add . && git commit -m "Fix voice cloning with enhanced diagnostics"`
2. Push: `git push`
3. Function should auto-deploy

## After Deployment: Testing

1. **Check Function Logs**:
   - Go to: https://supabase.com/dashboard/project/crrgvodgeqayidluzqwz/logs/edge-functions
   - Look for "generate-audio" function logs

2. **Upload Voice Sample**:
   - Open your app
   - Go to Settings
   - Upload a 5-10 second WAV or MP3 voice sample

3. **Generate Audio**:
   - Enter a YouTube URL
   - Generate script
   - Confirm script
   - Watch for audio generation

4. **Check Browser Console** (F12):
   - Look for: "Generating audio with voice cloning..."
   - Shows voice sample URL and script details

5. **Check Supabase Logs**:
   - Look for: "=== Starting TTS Job ==="
   - Shows if voice cloning is enabled
   - Shows base64 encoding details
   - Shows RunPod API responses

## What to Look For in Logs

### Success Pattern:
```
Voice cloning detected - using non-streaming mode
Voice sample URL: https://...
Pre-validating voice sample accessibility...
Voice sample is accessible
=== Starting TTS Job ===
Voice Cloning: ENABLED
Reference audio base64 length: XXXXX chars
TTS job created successfully
Job completed successfully!
```

### Common Errors:

**Error 1: Voice sample not accessible**
```
Voice sample not accessible: HTTP 403
```
Fix: Check storage bucket permissions - `voice-samples` must be public

**Error 2: TTS job failed**
```
!!! TTS Job FAILED !!!
Error: [specific error from RunPod]
```
Fix: Check RunPod worker configuration for `reference_audio_base64` support

**Error 3: Empty voice sample**
```
Voice sample is empty (0 bytes)
```
Fix: Re-upload the voice sample

## Storage Bucket Permissions

Ensure your `voice-samples` bucket is publicly readable:

1. Go to: https://supabase.com/dashboard/project/crrgvodgeqayidluzqwz/storage/buckets
2. Click on "voice-samples" bucket
3. Go to "Configuration" tab
4. Set "Public bucket" to ON

## Environment Variables

Verify these are set in Supabase:

1. Go to: https://supabase.com/dashboard/project/crrgvodgeqayidluzqwz/settings/functions
2. Check environment variables:
   - `RUNPOD_API_KEY` - Your RunPod API key
   - `SUPABASE_URL` - Auto-set by Supabase
   - `SUPABASE_SERVICE_ROLE_KEY` - Auto-set by Supabase

## Next Steps After Successful Test

If voice cloning still doesn't work after seeing "Voice Cloning: ENABLED":

1. The issue is likely in the RunPod worker
2. Check that the worker properly handles `reference_audio_base64` field
3. The worker should:
   - Decode base64 to audio bytes
   - Load the audio file
   - Pass it to `tts.synthesize()` as `reference_audio` parameter

