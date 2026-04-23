import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Lazy load sharp - it has native dependencies that may fail on some platforms
let sharp: typeof import('sharp') | null = null;
const loadSharp = async () => {
  if (sharp) return sharp;
  try {
    const mod = await import('sharp');
    sharp = (mod.default ?? mod) as typeof import('sharp');
    return sharp;
  } catch (e) {
    console.warn('[youtube-upload] sharp not available, thumbnail compression disabled:', e);
    return null;
  }
};

// Set ffmpeg path for metadata scrubbing
if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

const router = Router();

// YouTube API configuration
const YOUTUBE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const YOUTUBE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const YOUTUBE_UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
// youtube.upload = upload videos, youtube = full access including playlists
const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube';
const YOUTUBE_CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels';

interface YouTubeChannel {
  id: string;
  title: string;
  thumbnailUrl?: string;
}

interface UploadRequest {
  videoUrl: string;
  accessToken: string;
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  privacyStatus: 'private' | 'unlisted' | 'public';
  publishAt?: string; // ISO 8601 date for scheduled publish
  thumbnailUrl?: string; // URL of custom thumbnail to set
  isAlteredContent?: boolean; // AI-generated/altered content declaration
  playlistId?: string; // Optional playlist to add video to after upload
}

interface AuthCodeExchangeRequest {
  code: string;
  redirectUri: string;
}

// Exchange authorization code for tokens
router.post('/auth', async (req: Request, res: Response) => {
  try {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return res.status(500).json({ error: 'Google OAuth credentials not configured' });
    }

    const { code, redirectUri }: AuthCodeExchangeRequest = req.body;

    if (!code) {
      return res.status(400).json({ error: 'Authorization code is required' });
    }

    if (!redirectUri) {
      return res.status(400).json({ error: 'Redirect URI is required' });
    }

    console.log('Exchanging authorization code for tokens...');

    const tokenResponse = await fetch(YOUTUBE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    const tokenData = await tokenResponse.json() as any;

    if (!tokenResponse.ok) {
      console.error('Token exchange failed:', tokenData);
      return res.status(400).json({
        error: 'Failed to exchange authorization code',
        details: tokenData.error_description || tokenData.error
      });
    }

    console.log('Token exchange successful');

    // Store refresh token in Supabase for later use
    if (tokenData.refresh_token) {
      const supabaseUrl = process.env.SUPABASE_URL;
      const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

      if (supabaseUrl && supabaseKey) {
        const supabase = createClient(supabaseUrl, supabaseKey);

        // Upsert - update existing or insert new
        const { error } = await supabase
          .from('youtube_tokens')
          .upsert({
            id: '00000000-0000-0000-0000-000000000001', // Single row for single-user app
            refresh_token: tokenData.refresh_token,
            updated_at: new Date().toISOString()
          }, { onConflict: 'id' });

        if (error) {
          console.error('Failed to store refresh token:', error);
          // Don't fail the request, just log the error
        } else {
          console.log('Refresh token stored successfully');
        }
      }
    }

    return res.json({
      success: true,
      accessToken: tokenData.access_token,
      expiresIn: tokenData.expires_in, // Usually 3600 seconds (1 hour)
      tokenType: tokenData.token_type,
    });
  } catch (error) {
    console.error('Error in auth code exchange:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to exchange authorization code'
    });
  }
});

// Refresh access token using stored refresh token
router.get('/token', async (req: Request, res: Response) => {
  try {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!clientId || !clientSecret) {
      return res.status(500).json({ error: 'Google OAuth credentials not configured' });
    }

    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({ error: 'Supabase configuration missing' });
    }

    // Get stored refresh token
    const supabase = createClient(supabaseUrl, supabaseKey);
    const { data, error } = await supabase
      .from('youtube_tokens')
      .select('refresh_token')
      .eq('id', '00000000-0000-0000-0000-000000000001')
      .single();

    if (error || !data?.refresh_token) {
      return res.status(401).json({
        error: 'No stored refresh token found',
        needsAuth: true
      });
    }

    console.log('Refreshing access token...');

    const tokenResponse = await fetch(YOUTUBE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        refresh_token: data.refresh_token,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
      }),
    });

    const tokenData = await tokenResponse.json() as any;

    if (!tokenResponse.ok) {
      console.error('Token refresh failed:', tokenData);

      // If refresh token is invalid, clear it
      if (tokenData.error === 'invalid_grant') {
        await supabase
          .from('youtube_tokens')
          .delete()
          .eq('id', '00000000-0000-0000-0000-000000000001');
      }

      return res.status(401).json({
        error: 'Failed to refresh access token',
        needsAuth: true,
        details: tokenData.error_description || tokenData.error
      });
    }

    console.log('Access token refreshed successfully');

    return res.json({
      success: true,
      accessToken: tokenData.access_token,
      expiresIn: tokenData.expires_in,
      tokenType: tokenData.token_type,
    });
  } catch (error) {
    console.error('Error refreshing token:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to refresh token'
    });
  }
});

// Get list of channels for the authenticated user
router.get('/channels', async (req: Request, res: Response) => {
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');

    if (!accessToken) {
      return res.status(401).json({ error: 'Access token required' });
    }

    console.log('Fetching YouTube channels...');

    // Fetch channels the user owns or manages
    const response = await fetch(
      `${YOUTUBE_CHANNELS_URL}?part=snippet,contentDetails&mine=true`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Failed to fetch channels:', response.status, errorText);

      if (response.status === 401) {
        return res.status(401).json({ error: 'Access token expired', needsAuth: true });
      }

      return res.status(response.status).json({ error: 'Failed to fetch channels' });
    }

    const data = await response.json() as any;

    const channels: YouTubeChannel[] = (data.items || []).map((item: any) => ({
      id: item.id,
      title: item.snippet?.title || 'Unknown Channel',
      thumbnailUrl: item.snippet?.thumbnails?.default?.url,
    }));

    console.log(`Found ${channels.length} channel(s)`);

    return res.json({ channels });
  } catch (error) {
    console.error('Error fetching channels:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to fetch channels'
    });
  }
});

// Get list of playlists for the authenticated user
router.get('/playlists', async (req: Request, res: Response) => {
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');

    if (!accessToken) {
      return res.status(401).json({ error: 'Access token required' });
    }

    console.log('Fetching YouTube playlists...');

    // Fetch playlists the user owns (paginated)
    let allPlaylists: { id: string; title: string; thumbnailUrl?: string; itemCount: number }[] = [];
    let nextPageToken: string | undefined;

    do {
      const url = new URL('https://www.googleapis.com/youtube/v3/playlists');
      url.searchParams.set('part', 'snippet,contentDetails');
      url.searchParams.set('mine', 'true');
      url.searchParams.set('maxResults', '50');
      if (nextPageToken) {
        url.searchParams.set('pageToken', nextPageToken);
      }

      const response = await fetch(url.toString(), {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Failed to fetch playlists:', response.status, errorText);

        if (response.status === 401) {
          return res.status(401).json({ error: 'Access token expired', needsAuth: true });
        }

        return res.status(response.status).json({ error: 'Failed to fetch playlists' });
      }

      const data = await response.json() as any;

      const playlists = (data.items || []).map((item: any) => ({
        id: item.id,
        title: item.snippet?.title || 'Unknown Playlist',
        thumbnailUrl: item.snippet?.thumbnails?.default?.url,
        itemCount: item.contentDetails?.itemCount || 0,
      }));

      allPlaylists = allPlaylists.concat(playlists);
      nextPageToken = data.nextPageToken;
    } while (nextPageToken);

    console.log(`Found ${allPlaylists.length} playlist(s)`);

    return res.json({ playlists: allPlaylists });
  } catch (error) {
    console.error('Error fetching playlists:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to fetch playlists'
    });
  }
});

// Add video to a playlist
router.post('/playlists/add', async (req: Request, res: Response) => {
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    const { playlistId, videoId } = req.body;

    if (!accessToken) {
      return res.status(401).json({ error: 'Access token required' });
    }

    if (!playlistId || !videoId) {
      return res.status(400).json({ error: 'playlistId and videoId are required' });
    }

    console.log(`Adding video ${videoId} to playlist ${playlistId}...`);

    const response = await fetch('https://www.googleapis.com/youtube/v3/playlistItems?part=snippet', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        snippet: {
          playlistId,
          resourceId: {
            kind: 'youtube#video',
            videoId,
          },
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Failed to add video to playlist:', response.status, errorText);

      if (response.status === 401) {
        return res.status(401).json({ error: 'Access token expired', needsAuth: true });
      }

      return res.status(response.status).json({ error: 'Failed to add video to playlist', details: errorText });
    }

    const data = await response.json() as any;
    console.log('Video added to playlist successfully:', data.id);

    return res.json({ success: true, playlistItemId: data.id });
  } catch (error) {
    console.error('Error adding video to playlist:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to add video to playlist'
    });
  }
});

// Check if we have a valid refresh token stored
router.get('/status', async (req: Request, res: Response) => {
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({ error: 'Supabase configuration missing' });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const { data, error } = await supabase
      .from('youtube_tokens')
      .select('updated_at')
      .eq('id', '00000000-0000-0000-0000-000000000001')
      .single();

    if (error || !data) {
      return res.json({
        authenticated: false,
        message: 'YouTube account not connected'
      });
    }

    return res.json({
      authenticated: true,
      lastUpdated: data.updated_at
    });
  } catch (error) {
    console.error('Error checking auth status:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to check auth status'
    });
  }
});

// Upload video to YouTube with SSE progress
router.post('/', async (req: Request, res: Response) => {
  const {
    videoUrl,
    accessToken,
    title,
    description,
    tags,
    categoryId,
    privacyStatus,
    publishAt,
    thumbnailUrl,
    isAlteredContent,
    playlistId
  }: UploadRequest = req.body;

  // Log received metadata for debugging
  console.log('[youtube-upload] Received upload request:', {
    categoryId,
    playlistId,
    title: title?.substring(0, 50),
    privacyStatus,
    hasThumbnail: !!thumbnailUrl,
    isAlteredContent
  });

  // Validate required fields
  if (!videoUrl) {
    return res.status(400).json({ error: 'Video URL is required' });
  }
  if (!accessToken) {
    return res.status(400).json({ error: 'Access token is required' });
  }
  if (!title) {
    return res.status(400).json({ error: 'Title is required' });
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const heartbeatInterval = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15000);

  const cleanup = () => {
    clearInterval(heartbeatInterval);
  };

  const sendEvent = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // Phase 1: Download video from Supabase
    sendEvent({
      type: 'progress',
      stage: 'downloading',
      percent: 5,
      message: 'Downloading video from storage...'
    });

    console.log(`Downloading video from: ${videoUrl}`);

    const videoResponse = await fetch(videoUrl);
    if (!videoResponse.ok) {
      throw new Error(`Failed to download video: ${videoResponse.status}`);
    }

    let videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
    let videoSize = videoBuffer.length;

    console.log(`Video downloaded: ${(videoSize / 1024 / 1024).toFixed(2)} MB`);

    sendEvent({
      type: 'progress',
      stage: 'downloading',
      percent: 15,
      message: `Video downloaded (${(videoSize / 1024 / 1024).toFixed(1)} MB)`
    });

    // Phase 1.5: Scrub FFmpeg metadata to prevent YouTube bot flagging
    // YouTube flags videos with Lavf/Lavc muxer metadata as "Programmatic Mass Content"
    sendEvent({
      type: 'progress',
      stage: 'processing',
      percent: 18,
      message: 'Removing bot fingerprint metadata...'
    });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-upload-'));
    const inputPath = path.join(tempDir, 'input.mp4');
    const outputPath = path.join(tempDir, 'clean.mp4');

    try {
      // Write video to temp file
      fs.writeFileSync(inputPath, videoBuffer);

      // Run FFmpeg to strip metadata (instant - no re-encoding)
      await new Promise<void>((resolve, reject) => {
        ffmpeg(inputPath)
          .outputOptions([
            '-map_metadata', '-1',      // Strip ALL metadata
            '-bsf:v', 'filter_units=remove_types=6',  // Remove SEI NAL units (x264 encoder string)
            '-fflags', '+bitexact',     // Don't write FFmpeg version to container
            '-flags:v', '+bitexact',    // Don't write encoder info to video stream
            '-flags:a', '+bitexact',    // Don't write encoder info to audio stream
            '-c:v', 'copy',             // Copy video stream without re-encoding
            '-c:a', 'copy',             // Copy audio stream without re-encoding
            '-movflags', '+faststart',  // Optimize for streaming
            '-y'
          ])
          .output(outputPath)
          .on('start', (cmd) => {
            console.log('[Metadata scrub] FFmpeg:', cmd);
          })
          .on('error', (err) => {
            console.error('[Metadata scrub] FFmpeg error:', err);
            reject(err);
          })
          .on('end', () => {
            console.log('[Metadata scrub] Metadata stripped successfully');
            resolve();
          })
          .run();
      });

      // Read the clean video back
      videoBuffer = fs.readFileSync(outputPath);
      videoSize = videoBuffer.length;

      console.log(`Clean video: ${(videoSize / 1024 / 1024).toFixed(2)} MB (metadata stripped)`);
    } catch (scrubError) {
      console.error('[Metadata scrub] Failed, using original:', scrubError);
      // Continue with original video if scrubbing fails
    } finally {
      // Clean up temp files
      try {
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
      } catch (cleanupError) {
        console.warn('[Metadata scrub] Cleanup error:', cleanupError);
      }
    }

    sendEvent({
      type: 'progress',
      stage: 'processing',
      percent: 22,
      message: 'Metadata cleaned, preparing upload...'
    });

    // Phase 2: Initialize resumable upload
    sendEvent({
      type: 'progress',
      stage: 'initializing',
      percent: 25,
      message: 'Initializing YouTube upload...'
    });

    // Build video metadata
    const videoMetadata: any = {
      snippet: {
        title: title.substring(0, 100), // YouTube title limit
        description: description || '',
        tags: tags || [],
        categoryId: categoryId || '22', // Default: People & Blogs
      },
      status: {
        privacyStatus: privacyStatus || 'private',
        selfDeclaredMadeForKids: false,
        notifySubscribers: true,  // Notify subscribers to avoid bot flagging
        // AI-generated/altered content disclosure (required by YouTube since 2024)
        containsSyntheticMedia: isAlteredContent !== false, // Default to true for AI-generated videos
      }
    };

    // Add scheduled publish time if provided
    if (publishAt && privacyStatus === 'private') {
      videoMetadata.status.publishAt = publishAt;
    }

    console.log('[youtube-upload] Initializing resumable upload with metadata:', JSON.stringify(videoMetadata, null, 2));
    console.log('[youtube-upload] ⚠️ CATEGORY DEBUG - Sending categoryId:', categoryId, '→', videoMetadata.snippet.categoryId);

    const initResponse = await fetch(
      `${YOUTUBE_UPLOAD_URL}?uploadType=resumable&part=snippet,status`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-Upload-Content-Length': String(videoSize),
          'X-Upload-Content-Type': 'video/mp4',
        },
        body: JSON.stringify(videoMetadata),
      }
    );

    if (!initResponse.ok) {
      const errorText = await initResponse.text();
      console.error('YouTube upload init failed:', initResponse.status, errorText);

      // Check for specific errors
      if (initResponse.status === 401) {
        throw new Error('YouTube authentication expired. Please reconnect your account.');
      }
      if (initResponse.status === 403) {
        throw new Error('YouTube upload permission denied. Please check your account permissions.');
      }

      throw new Error(`YouTube upload initialization failed: ${initResponse.status}`);
    }

    const uploadUrl = initResponse.headers.get('location');
    if (!uploadUrl) {
      throw new Error('No upload URL returned from YouTube');
    }

    console.log('Resumable upload initialized, upload URL received');

    sendEvent({
      type: 'progress',
      stage: 'uploading',
      percent: 30,
      message: 'Uploading to YouTube...'
    });

    // Phase 3: Upload video in chunks with progress
    const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks
    let uploadedBytes = 0;
    let chunkNumber = 0;

    console.log(`Starting chunked upload: ${videoSize} bytes in ${Math.ceil(videoSize / CHUNK_SIZE)} chunks`);

    while (uploadedBytes < videoSize) {
      chunkNumber++;
      const chunkStart = uploadedBytes;
      const chunkEnd = Math.min(uploadedBytes + CHUNK_SIZE, videoSize);
      const chunk = videoBuffer.slice(chunkStart, chunkEnd);

      console.log(`[Chunk ${chunkNumber}] Uploading bytes ${chunkStart}-${chunkEnd - 1}/${videoSize} (${chunk.length} bytes)`);

      const uploadResponse = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': String(chunk.length),
          'Content-Range': `bytes ${chunkStart}-${chunkEnd - 1}/${videoSize}`,
        },
        body: chunk,
      });

      console.log(`[Chunk ${chunkNumber}] Response status: ${uploadResponse.status}`);

      if (uploadResponse.status === 308) {
        // Resume incomplete - continue uploading
        const rangeHeader = uploadResponse.headers.get('range');
        if (rangeHeader) {
          const match = rangeHeader.match(/bytes=0-(\d+)/);
          if (match) {
            uploadedBytes = parseInt(match[1], 10) + 1;
          } else {
            uploadedBytes = chunkEnd;
          }
        } else {
          uploadedBytes = chunkEnd;
        }
        console.log(`[Chunk ${chunkNumber}] Resume incomplete, next upload from byte ${uploadedBytes}`);
      } else if (uploadResponse.ok) {
        // Upload complete
        uploadedBytes = videoSize;

        const result = await uploadResponse.json() as any;
        const videoId = result.id;

        // Log full YouTube response for debugging stuck uploads
        console.log('YouTube upload complete:', videoId);
        console.log('[youtube-upload] Full YouTube response:', JSON.stringify(result, null, 2));
        console.log('[youtube-upload] Upload status from YouTube:', result.status);
        console.log('[youtube-upload] Processing status:', result.processingDetails || 'not available');

        // If thumbnail URL provided, upload it
        if (thumbnailUrl) {
          sendEvent({
            type: 'progress',
            stage: 'uploading',
            percent: 96,
            message: 'Uploading thumbnail...'
          });

          try {
            // Download thumbnail image
            const thumbResponse = await fetch(thumbnailUrl);
            if (thumbResponse.ok) {
              let thumbBuffer = Buffer.from(await thumbResponse.arrayBuffer());
              let contentType = thumbResponse.headers.get('content-type') || 'image/png';

              const MAX_THUMB_SIZE = 2 * 1024 * 1024; // 2MB YouTube limit
              const originalBuffer = thumbBuffer; // Keep original for recompression

              const sharpInstance = await loadSharp();

              // If thumbnail is larger than 2MB, compress it (requires sharp)
              if (thumbBuffer.length > MAX_THUMB_SIZE && sharpInstance) {
                console.log(`[Thumbnail] Original size: ${(thumbBuffer.length / 1024 / 1024).toFixed(2)}MB, compressing...`);

                let quality = 90;
                let width = 1280; // YouTube recommended thumbnail width

                // Try progressively lower quality until under 2MB
                while (thumbBuffer.length > MAX_THUMB_SIZE && quality > 10) {
                  const compressed = await sharpInstance(originalBuffer)
                    .resize(width, null, { withoutEnlargement: true })
                    .jpeg({ quality })
                    .toBuffer();
                  thumbBuffer = Buffer.from(compressed);

                  console.log(`[Thumbnail] Compressed to ${(thumbBuffer.length / 1024 / 1024).toFixed(2)}MB at quality=${quality}`);

                  if (thumbBuffer.length > MAX_THUMB_SIZE) {
                    quality -= 10;
                    if (quality <= 20 && width > 640) {
                      width = Math.round(width * 0.8);
                      quality = 80; // Reset quality and try smaller dimensions
                    }
                  }
                }

                contentType = 'image/jpeg';
                console.log(`[Thumbnail] Final size: ${(thumbBuffer.length / 1024 / 1024).toFixed(2)}MB`);
              } else if (thumbBuffer.length > MAX_THUMB_SIZE) {
                console.warn(`[Thumbnail] Image is ${(thumbBuffer.length / 1024 / 1024).toFixed(2)}MB but sharp not available for compression`);
              }

              // Upload thumbnail to YouTube
              const thumbUploadResponse = await fetch(
                `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}`,
                {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': contentType,
                    'Content-Length': String(thumbBuffer.length),
                  },
                  body: thumbBuffer,
                }
              );

              if (thumbUploadResponse.ok) {
                console.log('Thumbnail uploaded successfully');
              } else {
                const thumbError = await thumbUploadResponse.text();
                console.error('Thumbnail upload failed:', thumbUploadResponse.status, thumbError);
                // Don't fail the whole upload, just log the error
              }
            } else {
              console.error('Failed to download thumbnail:', thumbResponse.status);
            }
          } catch (thumbError) {
            console.error('Thumbnail upload error:', thumbError);
            // Don't fail the whole upload, just log the error
          }
        }

        // Add video to playlist if playlistId provided
        console.log(`[youtube-upload] Playlist add check: playlistId=${playlistId ? 'provided' : 'not provided'}`);
        if (playlistId) {
          sendEvent({
            type: 'progress',
            stage: 'uploading',
            percent: 98,
            message: 'Adding to playlist...'
          });

          try {
            console.log(`[youtube-upload] Adding video ${videoId} to playlist ${playlistId}...`);
            const playlistResponse = await fetch('https://www.googleapis.com/youtube/v3/playlistItems?part=snippet', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                snippet: {
                  playlistId,
                  resourceId: {
                    kind: 'youtube#video',
                    videoId,
                  },
                },
              }),
            });

            if (playlistResponse.ok) {
              const playlistResult = await playlistResponse.json() as any;
              console.log(`[youtube-upload] ✓ Video added to playlist: playlistItemId=${playlistResult.id}`);
            } else {
              const playlistError = await playlistResponse.text();
              console.error(`[youtube-upload] ✗ Failed to add video to playlist (${playlistResponse.status}):`, playlistError);
              // Don't fail the whole upload, just log the error
            }
          } catch (playlistError) {
            console.error('[youtube-upload] ✗ Playlist add error:', playlistError);
            // Don't fail the whole upload, just log the error
          }
        } else {
          console.log('[youtube-upload] Skipping playlist add - no playlistId provided');
        }

        sendEvent({
          type: 'progress',
          stage: 'complete',
          percent: 100,
          message: 'Upload complete!'
        });

        sendEvent({
          type: 'complete',
          success: true,
          videoId: videoId,
          youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
          studioUrl: `https://studio.youtube.com/video/${videoId}/edit`,
        });

        cleanup();
        return res.end();
      } else {
        const errorText = await uploadResponse.text();
        console.error('Chunk upload failed:', uploadResponse.status, errorText);
        throw new Error(`Upload failed at ${Math.round(uploadedBytes / videoSize * 100)}%: ${uploadResponse.status}`);
      }

      // Update progress
      const percent = 30 + Math.round((uploadedBytes / videoSize) * 65);
      sendEvent({
        type: 'progress',
        stage: 'uploading',
        percent,
        message: `Uploading... ${Math.round(uploadedBytes / videoSize * 100)}%`
      });
    }

  } catch (error) {
    console.error('YouTube upload error:', error);
    sendEvent({
      type: 'error',
      error: error instanceof Error ? error.message : 'YouTube upload failed'
    });
    cleanup();
    res.end();
  }
});

// Disconnect YouTube account (revoke and delete stored token)
router.post('/disconnect', async (req: Request, res: Response) => {
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({ error: 'Supabase configuration missing' });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get the refresh token first
    const { data } = await supabase
      .from('youtube_tokens')
      .select('refresh_token')
      .eq('id', '00000000-0000-0000-0000-000000000001')
      .single();

    // Try to revoke the token with Google
    if (data?.refresh_token) {
      try {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${data.refresh_token}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
      } catch (e) {
        // Ignore revocation errors
        console.log('Token revocation failed (may already be revoked)');
      }
    }

    // Delete the stored token
    await supabase
      .from('youtube_tokens')
      .delete()
      .eq('id', '00000000-0000-0000-0000-000000000001');

    console.log('YouTube account disconnected');

    return res.json({ success: true, message: 'YouTube account disconnected' });
  } catch (error) {
    console.error('Error disconnecting YouTube:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to disconnect YouTube account'
    });
  }
});

export default router;
