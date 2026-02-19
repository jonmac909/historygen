import { supabase } from "@/integrations/supabase/client";

const renderApiKey = import.meta.env.VITE_INTERNAL_API_KEY;
const renderAuthHeader = renderApiKey ? { 'X-Internal-Api-Key': renderApiKey } : {};
const withRenderAuth = (headers: Record<string, string> = {}) => ({
  ...headers,
  ...renderAuthHeader,
});

/**
 * Calculate dynamic timeout based on target word count
 * Formula: min(1800000, (targetWords / 150) * 60000)
 * Assumes ~150 words/minute generation rate (conservative estimate)
 * Caps at 30 minutes max to support very long script generation
 *
 * @param targetWords - The target word count for script generation
 * @returns Timeout in milliseconds, capped at 1800000 (30 minutes)
 */
export function calculateDynamicTimeout(targetWords: number): number {
  // Ensure minimum timeout of 2 minutes for any request
  const MIN_TIMEOUT_MS = 120000;
  // Cap at 30 minutes to support very long script generation
  const MAX_TIMEOUT_MS = 1800000;

  // Estimate generation time: ~150 words per minute
  const estimatedMinutes = Math.ceil(targetWords / 150);
  const timeoutMs = estimatedMinutes * 60000;

  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, timeoutMs));
}

export interface TranscriptResult {
  success: boolean;
  videoId?: string;
  title?: string;
  transcript?: string | null;
  message?: string;
  error?: string;
}

export interface ScriptResult {
  success: boolean;
  script?: string;
  wordCount?: number;
  error?: string;
}

export interface AudioSegment {
  index: number;
  audioUrl: string;
  duration: number;
  size: number;
  text: string;
}

export interface AudioResult {
  success: boolean;
  audioUrl?: string;
  audioBase64?: string;
  duration?: number;
  size?: number;
  segments?: AudioSegment[];
  totalDuration?: number;
  error?: string;
}

export interface CaptionsResult {
  success: boolean;
  captionsUrl?: string;
  srtContent?: string;
  segmentCount?: number;
  estimatedDuration?: number;
  error?: string;
}

export interface ImageGenerationResult {
  success: boolean;
  images?: string[];
  error?: string;
}

export interface ImagePromptWithTiming {
  index: number;
  startTime: string;
  endTime: string;
  startSeconds: number;
  endSeconds: number;
  prompt: string;
  sceneDescription: string;
}

export interface ImagePromptsResult {
  success: boolean;
  prompts?: ImagePromptWithTiming[];
  totalDuration?: number;
  error?: string;
}

// ============================================================================
// Video Clip Types (LTX-2)
// ============================================================================

export interface ClipPrompt {
  index: number;
  startSeconds: number;
  endSeconds: number;
  prompt: string;
  sceneDescription: string;
  imageUrl?: string;  // Source image for I2V video generation
}

export interface ClipPromptsResult {
  success: boolean;
  prompts?: ClipPrompt[];
  totalDuration?: number;
  clipCount?: number;
  clipDuration?: number;
  error?: string;
}

export interface GeneratedClip {
  index: number;
  videoUrl: string;
  filename?: string;
  startSeconds: number;
  endSeconds: number;
}

export interface VideoClipsResult {
  success: boolean;
  clips?: GeneratedClip[];
  total?: number;
  failed?: number;
  clipDuration?: number;
  totalDuration?: number;
  error?: string;
}

export interface GeneratedAssets {
  projectId: string;
  script: string;
  scriptUrl?: string;
  audioUrl?: string;
  captionsUrl?: string;
  audioDuration?: number;
}

export async function getYouTubeTranscript(url: string): Promise<TranscriptResult> {
  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return {
      success: false,
      error: 'Render API URL not configured. Please set VITE_RENDER_API_URL in .env'
    };
  }

  try {
    const response = await fetch(`${renderUrl}/get-youtube-transcript`, {
      method: 'POST',
      headers: withRenderAuth({
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ url })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Transcript error:', response.status, errorText);
      return { success: false, error: `Failed to fetch transcript: ${response.status}` };
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Transcript error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to fetch transcript' };
  }
}

export async function rewriteScript(transcript: string, template: string, title: string): Promise<ScriptResult> {
  const { data, error } = await supabase.functions.invoke('rewrite-script', {
    body: { transcript, template, title }
  });

  if (error) {
    console.error('Script error:', error);
    return { success: false, error: error.message };
  }

  return data;
}

export async function rewriteScriptStreaming(
  transcript: string,
  template: string,
  title: string,
  aiModel: string,
  wordCount: number,
  onProgress: (progress: number, wordCount: number) => void,
  onToken?: (token: string) => void, // Real-time token streaming callback
  topic?: string // Specific topic focus to prevent drift (e.g., "Viking Winters")
): Promise<ScriptResult> {
  const CHUNK_SIZE = 30000; // Render has no timeout limit - can generate full scripts in one call!

  // For large scripts, split into chunks to avoid Supabase 5-minute timeout
  if (wordCount > CHUNK_SIZE) {
    if (import.meta.env.DEV) {
      console.log(`[Script Generation] Chunking ${wordCount} words into ${Math.ceil(wordCount / CHUNK_SIZE)} chunks of ${CHUNK_SIZE} words`);
    }

    const numChunks = Math.ceil(wordCount / CHUNK_SIZE);
    let fullScript = '';
    let totalWordsGenerated = 0;

    for (let i = 0; i < numChunks; i++) {
      const chunkWordCount = Math.min(CHUNK_SIZE, wordCount - totalWordsGenerated);
      const chunkStartProgress = (i / numChunks) * 100;
      const chunkEndProgress = ((i + 1) / numChunks) * 100;

      if (import.meta.env.DEV) {
        console.log(`[Script Generation] Generating chunk ${i + 1}/${numChunks}: ${chunkWordCount} words (${chunkStartProgress.toFixed(0)}% - ${chunkEndProgress.toFixed(0)}%)`);
      }

      // Modify template for continuation chunks
      let chunkTemplate = template;
      if (fullScript) {
        chunkTemplate = `${template}

CRITICAL: You are continuing an existing script. Here is what has been written so far:

${fullScript}

Continue the narrative seamlessly from where this left off. DO NOT repeat any content. DO NOT add headers, titles, or scene markers. Write as if this is a natural continuation of the existing script.`;
      }

      // Generate this chunk with progress mapping
      const chunkResult = await generateSingleChunk(
        transcript,
        chunkTemplate,
        title,
        aiModel,
        chunkWordCount,
        (chunkProgress, chunkWords) => {
          // Map chunk progress to overall progress
          const overallProgress = chunkStartProgress + (chunkProgress / 100) * (chunkEndProgress - chunkStartProgress);
          const overallWords = totalWordsGenerated + chunkWords;
          onProgress(Math.round(overallProgress), overallWords);
        },
        onToken, // Pass through token callback
        topic // Pass topic for drift prevention
      );

      if (!chunkResult.success) {
        // If chunk failed but we have partial script, return what we have
        if (fullScript && totalWordsGenerated > 500) {
          return {
            success: true,
            script: fullScript,
            wordCount: totalWordsGenerated
          };
        }
        return chunkResult;
      }

      fullScript += (fullScript ? '\n\n' : '') + chunkResult.script;
      totalWordsGenerated += chunkResult.wordCount || 0;

      if (import.meta.env.DEV) {
        console.log(`[Script Generation] Chunk ${i + 1}/${numChunks} complete: ${chunkResult.wordCount} words generated (total: ${totalWordsGenerated})`);
      }
    }

    return {
      success: true,
      script: fullScript,
      wordCount: totalWordsGenerated
    };
  }

  // For scripts <= 5000 words, use single-chunk generation
  return generateSingleChunk(transcript, template, title, aiModel, wordCount, onProgress, onToken, topic);
}

/**
 * Internal function to generate a single chunk of script
 * Handles the actual API call and streaming logic
 */
async function generateSingleChunk(
  transcript: string,
  template: string,
  title: string,
  aiModel: string,
  wordCount: number,
  onProgress: (progress: number, wordCount: number) => void,
  onToken?: (token: string) => void, // Real-time token streaming
  topic?: string // Specific topic focus to prevent drift
): Promise<ScriptResult> {
  // Use Render API for script generation (no timeout limits!)
  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return {
      success: false,
      error: 'Render API URL not configured. Please set VITE_RENDER_API_URL in .env'
    };
  }

  // Add timeout and retry logic for long-running generations
  const controller = new AbortController();
  const timeoutMs = calculateDynamicTimeout(wordCount);
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // Log timeout configuration for development debugging
  if (import.meta.env.DEV) {
    console.log('[Script Generation] Using Render API (unlimited timeout):', {
      targetWordCount: wordCount,
      renderUrl,
      overallTimeoutMs: timeoutMs,
      overallTimeoutMinutes: (timeoutMs / 60000).toFixed(1),
    });
  }

  try {
    const response = await fetch(`${renderUrl}/rewrite-script`, {
      method: 'POST',
      headers: withRenderAuth({
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ transcript, template, title, topic, model: aiModel, wordCount, stream: true }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Script streaming error:', response.status, errorText);
      return { success: false, error: `Failed to rewrite script: ${response.status}` };
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return { success: false, error: 'No response body' };
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let result: ScriptResult = { success: false, error: 'No response received from AI' };
    let lastWordCount = 0;
    let lastScript = '';
    let lastEventTime = Date.now();
    const eventTimeout = 600000; // 10 minute timeout between events (for very long API calls)

    try {
      while (true) {
        // Check if we've been waiting too long for an event
        if (Date.now() - lastEventTime > eventTimeout) {
          if (import.meta.env.DEV) {
            console.warn('[Script Generation] Event timeout triggered - no data received for 10 minutes', {
              lastEventTime: new Date(lastEventTime).toISOString(),
              elapsedMs: Date.now() - lastEventTime,
              lastWordCount,
            });
          } else {
            console.warn('Event timeout - no data received for 10 minutes');
          }
          break;
        }

        const { done, value } = await reader.read();
        if (done) break;
        
        lastEventTime = Date.now();
        buffer += decoder.decode(value, { stream: true });
        
        // Process complete SSE events
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const event of events) {
          if (!event.trim()) continue;
          
          const dataMatch = event.match(/^data: (.+)$/m);
          if (dataMatch) {
            try {
              const parsed = JSON.parse(dataMatch[1]);
              
              if (parsed.type === 'progress') {
                lastWordCount = parsed.wordCount;
                onProgress(parsed.progress, parsed.wordCount);
              } else if (parsed.type === 'token') {
                // NEW: Stream tokens in real-time for better UX
                if (onToken && parsed.text) {
                  onToken(parsed.text);
                }
              } else if (parsed.type === 'complete') {
                lastScript = parsed.script;
                lastWordCount = parsed.wordCount;
                result = {
                  success: parsed.success,
                  script: parsed.script,
                  wordCount: parsed.wordCount
                };
                onProgress(100, parsed.wordCount);
              } else if (parsed.type === 'error' || parsed.error) {
                result = {
                  success: false,
                  error: parsed.error || parsed.message || 'AI generation failed'
                };
              }
            } catch (e) {
              // Skip invalid JSON
            }
          }
        }
      }
    } catch (streamError) {
      console.error('Stream reading error:', streamError);
      
      // If we have partial content, return it
      if (lastScript && lastWordCount > 500) {
        console.log(`Returning partial script with ${lastWordCount} words after stream error`);
        return {
          success: true,
          script: lastScript,
          wordCount: lastWordCount
        };
      }
      
      // Check if it's an abort error
      if (streamError instanceof Error && streamError.name === 'AbortError') {
        if (import.meta.env.DEV) {
          console.error('[Script Generation] Request aborted due to timeout', {
            targetWordCount: wordCount,
            timeoutMs,
            lastWordCount,
            hasPartialScript: !!lastScript,
          });
        }
        return {
          success: false,
          error: 'Request timed out. Scripts up to 30,000 words are supported (up to 30 minutes generation time). For very long content, ensure stable internet connection.'
        };
      }
      
      return { 
        success: false, 
        error: streamError instanceof Error ? streamError.message : 'Stream reading failed' 
      };
    }

    // If we got progress but no complete event, something went wrong
    if (!result.success && lastWordCount > 0) {
      // If we have a partial script, return it as success
      if (lastScript && lastWordCount > 500) {
        if (import.meta.env.DEV) {
          console.log('[Script Generation] Returning partial script after incomplete stream', {
            wordCount: lastWordCount,
            scriptLength: lastScript.length,
          });
        }
        return {
          success: true,
          script: lastScript,
          wordCount: lastWordCount
        };
      }
      result.error = 'Script generation was interrupted before completing. The connection may have been lost. Please try again.';
    }

    // Log successful completion in development mode
    if (import.meta.env.DEV && result.success) {
      console.log('[Script Generation] Stream completed successfully', {
        targetWordCount: wordCount,
        actualWordCount: result.wordCount,
        scriptLength: result.script?.length,
      });
    }

    return result;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Script issue with severity
export interface ScriptIssue {
  text: string;
  severity: 'major' | 'minor';
}

// Topic analysis for detecting topic drift
export interface TopicAnalysis {
  expectedTopic: string;
  topicsFound: string[];
  offTopicSections: string[];
  hasDrift: boolean;
}

// Script rating result interface
export interface ScriptRatingResult {
  success: boolean;
  grade?: 'A' | 'B' | 'C';
  summary?: string;
  issues?: ScriptIssue[];
  fixPrompt?: string;
  topicAnalysis?: TopicAnalysis;
  error?: string;
}

// Rate a script and get feedback
export async function rateScript(
  script: string,
  template?: string,
  title?: string,
  topic?: string // Specific topic focus for drift detection
): Promise<ScriptRatingResult> {
  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return {
      success: false,
      error: 'Render API URL not configured. Please set VITE_RENDER_API_URL in .env'
    };
  }

  try {
    const response = await fetch(`${renderUrl}/rewrite-script/rate`, {
      method: 'POST',
      headers: withRenderAuth({
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ script, template, title, topic })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Script rating error:', response.status, errorText);
      return { success: false, error: `Failed to rate script: ${response.status}` };
    }

    const data = await response.json();

    if (!data.success) {
      return { success: false, error: data.error || 'Rating failed' };
    }

    return {
      success: true,
      grade: data.grade,
      summary: data.summary,
      issues: data.issues,
      fixPrompt: data.fixPrompt
    };
  } catch (error) {
    console.error('Script rating error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to rate script'
    };
  }
}

// Quick edit a script (targeted fixes, much faster than full regeneration)
export async function quickEditScript(
  script: string,
  fixPrompt: string
): Promise<{ success: boolean; script?: string; wordCount?: number; error?: string }> {
  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return {
      success: false,
      error: 'Render API URL not configured'
    };
  }

  try {
    const response = await fetch(`${renderUrl}/rewrite-script/quick-edit`, {
      method: 'POST',
      headers: withRenderAuth({
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ script, fixPrompt })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Quick edit error:', response.status, errorText);
      return { success: false, error: `Failed to edit script: ${response.status}` };
    }

    const data = await response.json();

    if (!data.success) {
      return { success: false, error: data.error || 'Edit failed' };
    }

    return {
      success: true,
      script: data.script,
      wordCount: data.wordCount
    };
  } catch (error) {
    console.error('Quick edit error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to edit script'
    };
  }
}

export async function generateAudio(script: string, voiceSampleUrl: string, projectId: string): Promise<AudioResult> {
  console.log('Generating audio with voice cloning...');
  console.log('Voice sample URL:', voiceSampleUrl);
  console.log('Script length:', script.length, 'chars');

  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return {
      success: false,
      error: 'Render API URL not configured. Please set VITE_RENDER_API_URL in .env'
    };
  }

  try {
    const response = await fetch(`${renderUrl}/generate-audio`, {
      method: 'POST',
      headers: withRenderAuth({
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ script, voiceSampleUrl, projectId })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Audio generation error:', response.status, errorText);
      return { success: false, error: `Failed to generate audio: ${response.status}` };
    }

    const data = await response.json();

    if (data?.error) {
      console.error('Audio generation returned error:', data.error);

      // Provide more helpful error messages
      let errorMessage = data.error;
      if (errorMessage.includes('Voice sample not accessible')) {
        errorMessage = 'Cannot access your voice sample. Please try re-uploading it in Settings.';
      } else if (errorMessage.includes('TTS job failed')) {
        errorMessage = 'Voice cloning failed. This may be due to an issue with the voice sample or the TTS service. Try a different voice sample or contact support.';
      } else if (errorMessage.includes('timed out')) {
        errorMessage = 'Audio generation timed out. The script might be too long, or the service is experiencing delays. Try again in a moment.';
      }

      return { success: false, error: errorMessage };
    }

    console.log('Audio generated successfully:', data);
    return data;
  } catch (error) {
    console.error('Audio generation error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to generate audio' };
  }
}

export interface TTSSettings {
  emotionMarker?: string;
  temperature?: number;
  topP?: number;
  repetitionPenalty?: number;
}

export async function generateAudioStreaming(
  script: string,
  voiceSampleUrl: string,
  projectId: string,
  onProgress: (progress: number, message?: string) => void,
  speed: number = 1.0,
  ttsSettings?: TTSSettings
): Promise<AudioResult> {
  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return {
      success: false,
      error: 'Render API URL not configured. Please set VITE_RENDER_API_URL in .env'
    };
  }

  // Add timeout for very large audio generations with voice cloning (60 minutes max)
  const controller = new AbortController();
  const AUDIO_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes (voice cloning takes longer)
  const timeoutId = setTimeout(() => controller.abort(), AUDIO_TIMEOUT_MS);

  try {
    const response = await fetch(`${renderUrl}/generate-audio`, {
      method: 'POST',
      headers: withRenderAuth({
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({
        script,
        voiceSampleUrl,
        projectId,
        speed,
        stream: true,
        ttsSettings: ttsSettings || {}
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Audio streaming error:', response.status, errorText);
      return { success: false, error: `Failed to generate audio: ${response.status}` };
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return { success: false, error: 'No response body' };
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let result: AudioResult = { success: false, error: 'No response received' };
    let lastEventTime = Date.now();
    const EVENT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes between events (voice cloning takes longer)

    try {
      while (true) {
        // Check if we've been waiting too long for an event
        if (Date.now() - lastEventTime > EVENT_TIMEOUT_MS) {
          console.error('[Audio Generation] Event timeout - no data received for 10 minutes');
          result.error = 'Audio generation timed out - no progress received for 10 minutes. Please try again.';
          break;
        }

        const { done, value } = await reader.read();
        if (done) break;

        lastEventTime = Date.now(); // Reset timeout on each chunk
        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE events
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const event of events) {
          if (!event.trim()) continue;

          // Skip keepalive comments
          if (event.startsWith(':')) continue;

          const dataMatch = event.match(/^data: (.+)$/m);
          if (dataMatch) {
            try {
              const parsed = JSON.parse(dataMatch[1]);

              if (parsed.type === 'progress') {
                onProgress(parsed.progress, parsed.message);
              } else if (parsed.type === 'complete') {
                // Parse segments if present
                const segments = parsed.segments && Array.isArray(parsed.segments)
                  ? parsed.segments as AudioSegment[]
                  : undefined;

                result = {
                  success: true,
                  // Prefer combined audioUrl, fallback to first segment URL
                  audioUrl: parsed.audioUrl || segments?.[0]?.audioUrl,
                  duration: parsed.duration ?? parsed.totalDuration ?? (segments?.reduce((sum, seg) => sum + seg.duration, 0)),
                  size: parsed.size ?? (segments?.reduce((sum, seg) => sum + seg.size, 0)),
                  segments: segments,
                  totalDuration: parsed.totalDuration,
                };
                onProgress(100, 'Complete!');
              } else if (parsed.type === 'error' || parsed.error) {
                result = {
                  success: false,
                  error: parsed.error || 'Audio generation failed'
                };
              }
            } catch (e) {
              // Skip invalid JSON
            }
          }
        }
      }
    } catch (streamError) {
      console.error('Stream reading error:', streamError);

      // Check if it's an abort error from timeout
      if (streamError instanceof Error && streamError.name === 'AbortError') {
        return {
          success: false,
          error: 'Audio generation timed out after 60 minutes. This may happen with very long scripts or large voice samples. Please try again with a shorter script or smaller voice sample.'
        };
      }

      return {
        success: false,
        error: streamError instanceof Error ? streamError.message : 'Stream reading failed'
      };
    } finally {
      // Always clear the timeout to prevent memory leaks
      clearTimeout(timeoutId);
    }

    return result;
  } catch (error) {
    // Outer catch for fetch errors
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === 'AbortError') {
      return {
        success: false,
        error: 'Audio generation timed out after 60 minutes. This may happen with very long scripts. Please try again or contact support.'
      };
    }

    console.error('Audio generation fetch error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to start audio generation'
    };
  }
}

// Regenerate a single audio segment (with optional pronunciation fix)
export async function regenerateAudioSegment(
  segmentText: string,
  segmentIndex: number,
  voiceSampleUrl: string,
  projectId: string,
  pronunciationFix?: { word: string; phonetic: string }
): Promise<{ success: boolean; segment?: AudioSegment; error?: string }> {
  const renderApiUrl = import.meta.env.VITE_RENDER_API_URL || 'https://history-gen-ai-production-f1d4.up.railway.app';

  try {
    const response = await fetch(`${renderApiUrl}/generate-audio/segment`, {
      method: 'POST',
      headers: withRenderAuth({
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({
        segmentText,
        segmentIndex,
        voiceSampleUrl,
        projectId,
        pronunciationFix
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Segment regeneration error:', response.status, errorText);
      return { success: false, error: `Failed to regenerate segment: ${response.status}` };
    }

    const data = await response.json();

    if (data.error) {
      return { success: false, error: data.error };
    }

    return {
      success: true,
      segment: data.segment
    };
  } catch (error) {
    console.error('Segment regeneration error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Segment regeneration failed'
    };
  }
}

export async function recombineAudioSegments(
  projectId: string,
  segmentCount: number = 10
): Promise<{ success: boolean; audioUrl?: string; duration?: number; size?: number; error?: string }> {
  const renderApiUrl = import.meta.env.VITE_RENDER_API_URL || 'https://history-gen-ai-production-f1d4.up.railway.app';

  try {
    const response = await fetch(`${renderApiUrl}/generate-audio/recombine`, {
      method: 'POST',
      headers: withRenderAuth({
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({
        projectId,
        segmentCount
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Recombine error:', response.status, errorText);
      return { success: false, error: `Failed to recombine: ${response.status}` };
    }

    const data = await response.json();

    if (data.error) {
      return { success: false, error: data.error };
    }

    return {
      success: true,
      audioUrl: data.audioUrl,
      duration: data.duration,
      size: data.size
    };
  } catch (error) {
    console.error('Recombine error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Recombine failed'
    };
  }
}

export async function generateImagePrompts(
  script: string,
  srtContent: string,
  imageCount: number,
  stylePrompt: string,
  modernKeywordFilter: boolean,
  audioDuration?: number,
  topic?: string,
  onProgress?: (progress: number, message: string) => void
): Promise<ImagePromptsResult> {
  console.log('Generating AI-powered image prompts from script and captions...');
  console.log(`Script length: ${script.length}, SRT length: ${srtContent.length}, imageCount: ${imageCount}`);
  if (topic) {
    console.log(`Topic/Era anchor: ${topic}`);
  }
  if (audioDuration) {
    console.log(`Audio duration: ${audioDuration.toFixed(2)}s - images will be evenly distributed across full audio`);
  }

  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  // Use Railway API with streaming for progress
  if (renderUrl && onProgress) {
    try {
      const response = await fetch(`${renderUrl}/generate-image-prompts`, {
        method: 'POST',
        headers: withRenderAuth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ script, srtContent, imageCount, stylePrompt, modernKeywordFilter, audioDuration, topic, stream: true })
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let result: ImagePromptsResult = { success: false, error: 'No response received' };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === 'progress') {
                onProgress(data.progress, data.message || `${data.progress}%`);
              } else if (data.type === 'complete') {
                result = {
                  success: true,
                  prompts: data.prompts,
                  totalDuration: data.totalDuration
                };
              } else if (data.type === 'error') {
                result = { success: false, error: data.error };
              }
            } catch (e) {
              // Ignore parse errors for keepalive comments
            }
          }
        }
      }

      return result;
    } catch (error) {
      console.error('Streaming image prompts error:', error);
      // Fall back to Supabase function
    }
  }

  // Fallback to Supabase Edge Function (no streaming)
  const { data, error } = await supabase.functions.invoke('generate-image-prompts', {
    body: { script, srtContent, imageCount, stylePrompt, modernKeywordFilter, audioDuration, topic }
  });

  if (error) {
    console.error('Image prompt generation error:', error);
    const errorMessage = error.message || 'Unknown error';
    console.error('Error details:', JSON.stringify(error, null, 2));
    return { success: false, error: errorMessage };
  }

  if (!data) {
    return { success: false, error: 'No data returned from image prompt generation' };
  }

  return data;
}

// ============================================================================
// Video Clip Prompts (LTX-2)
// ============================================================================

export async function generateClipPrompts(
  script: string,
  srtContent: string,
  stylePrompt: string,
  onProgress?: (progress: number, message: string) => void
): Promise<ClipPromptsResult> {
  console.log('Generating AI-powered video clip prompts from script...');

  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return {
      success: false,
      error: 'Render API URL not configured. Please set VITE_RENDER_API_URL in .env'
    };
  }

  try {
    const response = await fetch(`${renderUrl}/generate-clip-prompts`, {
      method: 'POST',
      headers: withRenderAuth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ script, srtContent, stylePrompt, stream: !!onProgress })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Clip prompts error:', response.status, errorText);
      return { success: false, error: `Failed to generate clip prompts: ${response.status}` };
    }

    // Handle streaming response
    if (onProgress) {
      const reader = response.body?.getReader();
      if (!reader) {
        return { success: false, error: 'No response body' };
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let result: ClipPromptsResult = { success: false, error: 'No response received' };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === 'progress') {
                onProgress(data.progress, data.message || `${data.progress}%`);
              } else if (data.type === 'complete') {
                result = {
                  success: true,
                  prompts: data.prompts,
                  totalDuration: data.totalDuration,
                  clipCount: data.clipCount,
                  clipDuration: data.clipDuration
                };
              } else if (data.type === 'error') {
                result = { success: false, error: data.error };
              }
            } catch (e) {
              // Ignore parse errors
            }
          }
        }
      }

      return result;
    }

    // Non-streaming response
    const data = await response.json();
    return data;

  } catch (error) {
    console.error('Clip prompts error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to generate clip prompts' };
  }
}

// ============================================================================
// Video Clip Generation (LTX-2)
// ============================================================================

export async function generateVideoClipsStreaming(
  projectId: string,
  clips: ClipPrompt[],
  onProgress: (completed: number, total: number, message: string, latestClip?: GeneratedClip) => void
): Promise<VideoClipsResult> {
  console.log(`Generating ${clips.length} video clips with LTX-2...`);

  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return {
      success: false,
      error: 'Render API URL not configured. Please set VITE_RENDER_API_URL in .env'
    };
  }

  try {
    const response = await fetch(`${renderUrl}/generate-video-clips`, {
      method: 'POST',
      headers: withRenderAuth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ projectId, clips, stream: true })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Video clips error:', response.status, errorText);
      return { success: false, error: `Failed to generate video clips: ${response.status}` };
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return { success: false, error: 'No response body' };
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let result: VideoClipsResult = { success: false, error: 'No response received' };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split('\n\n');
      buffer = events.pop() || '';

      for (const event of events) {
        if (!event.trim()) continue;

        // Skip keepalive comments
        if (event.startsWith(':')) continue;

        const dataMatch = event.match(/^data: (.+)$/m);
        if (dataMatch) {
          try {
            const parsed = JSON.parse(dataMatch[1]);

            if (parsed.type === 'progress') {
              const latestClip = parsed.latestClip ? {
                index: parsed.latestClip.index,
                videoUrl: parsed.latestClip.videoUrl,
                filename: parsed.latestClip.filename
              } : undefined;

              onProgress(parsed.completed, parsed.total, parsed.message, latestClip);
            } else if (parsed.type === 'complete') {
              result = {
                success: parsed.success,
                clips: parsed.clips,
                total: parsed.total,
                failed: parsed.failed,
                clipDuration: parsed.clipDuration,
                totalDuration: parsed.totalDuration
              };
              onProgress(parsed.total, parsed.total, `${parsed.total} clips generated`);
            } else if (parsed.type === 'error' || parsed.error) {
              result = {
                success: false,
                error: parsed.error || 'Video clip generation failed'
              };
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }
      }
    }

    return result;

  } catch (error) {
    console.error('Video clips error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to generate video clips' };
  }
}

export async function generateImages(
  prompts: string[] | ImagePromptWithTiming[],
  quality: string,
  aspectRatio: string = "16:9",
  projectId?: string
): Promise<ImageGenerationResult> {
  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return {
      success: false,
      error: 'Render API URL not configured. Please set VITE_RENDER_API_URL in .env'
    };
  }

  try {
    const response = await fetch(`${renderUrl}/generate-images`, {
      method: 'POST',
      headers: withRenderAuth({
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ prompts, quality, aspectRatio, projectId })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Image generation error:', response.status, errorText);
      return { success: false, error: `Failed to generate images: ${response.status}` };
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Image generation error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to generate images' };
  }
}

export async function generateImagesStreaming(
  prompts: string[] | ImagePromptWithTiming[],
  quality: string,
  aspectRatio: string = "16:9",
  onProgress: (completed: number, total: number, message: string) => void,
  projectId?: string
): Promise<ImageGenerationResult> {
  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return {
      success: false,
      error: 'Render API URL not configured. Please set VITE_RENDER_API_URL in .env'
    };
  }

  const response = await fetch(`${renderUrl}/generate-images`, {
    method: 'POST',
    headers: withRenderAuth({
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify({ prompts, quality, aspectRatio, stream: true, projectId })
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Image streaming error:', response.status, errorText);
    return { success: false, error: `Failed to generate images: ${response.status}` };
  }

  const reader = response.body?.getReader();
  if (!reader) {
    return { success: false, error: 'No response body' };
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let result: ImageGenerationResult = { success: false, error: 'No response received' };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';

      for (const event of events) {
        if (!event.trim()) continue;
        
        const dataMatch = event.match(/^data: (.+)$/m);
        if (dataMatch) {
          try {
            const parsed = JSON.parse(dataMatch[1]);
            
            if (parsed.type === 'progress') {
              onProgress(parsed.completed, parsed.total, parsed.message);
            } else if (parsed.type === 'complete') {
              result = {
                success: parsed.success,
                images: parsed.images
              };
              onProgress(parsed.total, parsed.total, `${parsed.total}/${parsed.total} done`);
            } else if (parsed.type === 'error' || parsed.error) {
              result = {
                success: false,
                error: parsed.error || 'Image generation failed'
              };
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }
      }
    }
  } catch (streamError) {
    console.error('Stream reading error:', streamError);
    return { 
      success: false, 
      error: streamError instanceof Error ? streamError.message : 'Stream reading failed' 
    };
  }

  return result;
}

export async function generateCaptions(
  audioUrl: string,
  projectId: string,
  onProgress?: (progress: number, message?: string) => void
): Promise<CaptionsResult> {
  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return {
      success: false,
      error: 'Render API URL not configured. Please set VITE_RENDER_API_URL in .env'
    };
  }

  // Use streaming if onProgress callback is provided
  if (onProgress) {
    return generateCaptionsStreaming(audioUrl, projectId, onProgress);
  }

  try {
    const response = await fetch(`${renderUrl}/generate-captions`, {
      method: 'POST',
      headers: withRenderAuth({
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ audioUrl, projectId })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Captions error:', response.status, errorText);
      return { success: false, error: `Failed to generate captions: ${response.status}` };
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Captions error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to generate captions' };
  }
}

async function generateCaptionsStreaming(
  audioUrl: string,
  projectId: string,
  onProgress: (progress: number, message?: string) => void
): Promise<CaptionsResult> {
  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  try {
    const response = await fetch(`${renderUrl}/generate-captions`, {
      method: 'POST',
      headers: withRenderAuth({
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({
        audioUrl,
        projectId,
        stream: true
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Captions streaming error:', response.status, errorText);
      return { success: false, error: `Failed to generate captions: ${response.status}` };
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return { success: false, error: 'No response body' };
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let result: CaptionsResult = { success: false, error: 'No response received' };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE events
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';

      for (const event of events) {
        if (!event.trim()) continue;

        const dataMatch = event.match(/^data: (.+)$/m);
        if (dataMatch) {
          try {
            const parsed = JSON.parse(dataMatch[1]);

            if (parsed.type === 'progress') {
              onProgress(parsed.progress, parsed.message);
            } else if (parsed.type === 'complete') {
              result = {
                success: true,
                captionsUrl: parsed.captionsUrl,
                srtContent: parsed.srtContent,
                segmentCount: parsed.segmentCount,
                audioDuration: parsed.audioDuration
              };
              onProgress(100);
            } else if (parsed.type === 'error' || parsed.error) {
              result = {
                success: false,
                error: parsed.error || 'Caption generation failed'
              };
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }
      }
    }

    return result;
  } catch (error) {
    console.error('Captions streaming error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to generate captions' };
  }
}

export interface VideoResult {
  success: boolean;
  error?: string;
  edlUrl?: string;
  edlContent?: string;
  csvUrl?: string;
  csvContent?: string;
  totalDuration?: number;
  totalDurationFormatted?: string;
  segments?: {
    imageUrl: string;
    index: number;
    startTime: number;
    endTime: number;
    duration: number;
    startTimeFormatted: string;
    endTimeFormatted: string;
    durationFormatted: string;
  }[];
}

export async function generateVideoTimeline(imageUrls: string[], srtContent: string, projectId: string): Promise<VideoResult> {
  const { data, error } = await supabase.functions.invoke('generate-video', {
    body: { imageUrls, srtContent, projectId }
  });

  if (error) {
    console.error('Video timeline error:', error);
    return { success: false, error: error.message };
  }

  return data;
}

export async function saveScriptToStorage(script: string, projectId: string): Promise<string | null> {
  const fileName = `${projectId}/script.md`;
  
  const { data, error } = await supabase.storage
    .from('generated-assets')
    .upload(fileName, new Blob([script], { type: 'text/markdown' }), {
      contentType: 'text/markdown',
      upsert: true
    });

  if (error) {
    console.error('Script upload error:', error);
    return null;
  }

  const { data: urlData } = supabase.storage
    .from('generated-assets')
    .getPublicUrl(fileName);

  return urlData.publicUrl;
}

export function downloadFile(url: string, filename: string) {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.target = '_blank';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export function downloadText(content: string, filename: string, mimeType: string = 'text/plain') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  downloadFile(url, filename);
  URL.revokeObjectURL(url);
}

export interface RenderVideoResult {
  success: boolean;
  videoUrl?: string;
  videoUrlCaptioned?: string;
  size?: number;
  sizeCaptioned?: number;
  error?: string;
}

export interface RenderVideoProgress {
  stage: 'downloading' | 'preparing' | 'rendering' | 'muxing' | 'uploading';
  percent: number;
  message: string;
  frames?: number;
}

export interface RenderVideoCallbacks {
  onProgress: (progress: RenderVideoProgress) => void;
  onVideoReady?: (videoUrl: string) => void;
  onCaptionError?: (error: string) => void;
}

export interface VideoEffects {
  embers?: boolean;
  smoke_embers?: boolean;
}

// Render job status from Supabase
interface RenderJobStatus {
  id: string;
  project_id: string;
  status: 'queued' | 'downloading' | 'rendering' | 'muxing' | 'uploading' | 'complete' | 'failed';
  progress: number;
  message: string | null;
  video_url: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

// Helper to wait
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Render video using background job with polling
 * This replaces the SSE streaming approach for better reliability
 */
export async function renderVideoStreaming(
  projectId: string,
  audioUrl: string,
  imageUrls: string[],
  imageTimings: { startSeconds: number; endSeconds: number }[],
  srtContent: string,
  projectTitle: string,
  callbacks: RenderVideoCallbacks | ((progress: RenderVideoProgress) => void),
  effects?: VideoEffects,
  useGpu?: boolean,  // Use RunPod GPU rendering (faster)
  introClips?: { index: number; url: string; startSeconds: number; endSeconds: number }[]  // Intro video clips (60s)
): Promise<RenderVideoResult> {
  // Support both old callback style and new object style
  const { onProgress } = typeof callbacks === 'function'
    ? { onProgress: callbacks, onVideoReady: undefined, onCaptionError: undefined }
    : callbacks;

  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return {
      success: false,
      error: 'Render API URL not configured. Please set VITE_RENDER_API_URL in .env'
    };
  }

  try {
    // Step 1: Start the render job
    onProgress({
      stage: 'preparing',
      percent: 0,
      message: 'Starting render job...'
    });

    const startResponse = await fetch(`${renderUrl}/render-video`, {
      method: 'POST',
      headers: withRenderAuth({
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({
        projectId,
        audioUrl,
        imageUrls,
        imageTimings,
        srtContent,
        projectTitle,
        effects,
        useGpu,
        introClips
      })
    });

    if (!startResponse.ok) {
      const errorText = await startResponse.text();
      console.error('Failed to start render job:', startResponse.status, errorText);
      const serverError = (() => { try { return JSON.parse(errorText)?.error; } catch { return errorText; } })();
      return { success: false, error: serverError || `Failed to start render: ${startResponse.status}` };
    }

    const startResult = await startResponse.json();
    const jobId = startResult.jobId;

    if (!jobId) {
      return { success: false, error: 'No job ID returned from server' };
    }

    console.log(`[Render Video] Job started: ${jobId}`);

    // Step 2: Poll for progress
    const POLL_INTERVAL_MS = 3000; // Poll every 3 seconds
    const MAX_POLL_TIME_MS = 60 * 60 * 1000; // 1 hour max
    const startTime = Date.now();

    while (true) {
      // Check timeout
      if (Date.now() - startTime > MAX_POLL_TIME_MS) {
        return {
          success: false,
          error: 'Video rendering timed out after 1 hour. The job may still be processing - check back later.'
        };
      }

      // Poll for status
      const statusResponse = await fetch(`${renderUrl}/render-video/status/${jobId}`, {
        headers: withRenderAuth(),
      });

      if (!statusResponse.ok) {
        console.error('Failed to poll job status:', statusResponse.status);
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const job: RenderJobStatus = await statusResponse.json();

      // Update progress
      const stage = job.status === 'queued' ? 'preparing' : job.status;
      onProgress({
        stage: stage as RenderVideoProgress['stage'],
        percent: job.progress,
        message: job.message || `${job.status}...`
      });

      // Check for completion
      if (job.status === 'complete') {
        console.log(`[Render Video] Job complete: ${job.video_url}`);
        onProgress({
          stage: 'uploading',
          percent: 100,
          message: 'Complete!'
        });
        return {
          success: true,
          videoUrl: job.video_url || undefined
        };
      }

      // Check for failure
      if (job.status === 'failed') {
        console.error(`[Render Video] Job failed: ${job.error}`);
        return {
          success: false,
          error: job.error || 'Video rendering failed'
        };
      }

      // Wait before next poll
      await sleep(POLL_INTERVAL_MS);
    }

  } catch (error) {
    console.error('Render video error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to render video'
    };
  }
}

// ============================================================================
// Thumbnail Generation
// ============================================================================

export interface ThumbnailGenerationProgress {
  stage: 'analyzing' | 'generating';
  percent: number;
  message: string;
}

export interface ThumbnailGenerationResult {
  success: boolean;
  thumbnails?: string[];
  error?: string;
}

export interface ThumbnailContentSuggestionResult {
  success: boolean;
  contentPrompt?: string;
  error?: string;
}

// Suggest thumbnail content based on script
export async function suggestThumbnailContent(
  script: string,
  title?: string
): Promise<ThumbnailContentSuggestionResult> {
  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return {
      success: false,
      error: 'Render API URL not configured. Please set VITE_RENDER_API_URL in .env'
    };
  }

  try {
    const response = await fetch(`${renderUrl}/generate-thumbnails/suggest-content`, {
      method: 'POST',
      headers: withRenderAuth({
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ script, title })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Thumbnail content suggestion error:', response.status, errorText);
      return { success: false, error: `Failed to suggest content: ${response.status}` };
    }

    const data = await response.json();
    return {
      success: data.success,
      contentPrompt: data.contentPrompt,
      error: data.error
    };
  } catch (error) {
    console.error('Thumbnail content suggestion error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to suggest thumbnail content'
    };
  }
}

// Expand a topic into a detailed character/subject description
export async function expandTopicToDescription(
  topic: string
): Promise<{ success: boolean; description?: string; error?: string }> {
  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return { success: false, error: 'Render API URL not configured' };
  }

  try {
    const response = await fetch(`${renderUrl}/generate-thumbnails/expand-topic`, {
      method: 'POST',
      headers: withRenderAuth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ topic })
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `Failed: ${response.status} ${errorText}` };
    }

    const data = await response.json();
    return { success: data.success, description: data.description, error: data.error };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to expand topic'
    };
  }
}

// Suggest thumbnail prompts from a simple topic name
export async function suggestThumbnailPrompts(
  topic: string
): Promise<{ success: boolean; prompts?: string[]; error?: string }> {
  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return { success: false, error: 'Render API URL not configured' };
  }

  try {
    const response = await fetch(`${renderUrl}/generate-thumbnails/suggest-prompts`, {
      method: 'POST',
      headers: withRenderAuth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ topic })
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `Failed: ${response.status} ${errorText}` };
    }

    const data = await response.json();
    return { success: data.success, prompts: data.prompts, error: data.error };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to suggest prompts'
    };
  }
}

export async function generateThumbnailsStreaming(
  exampleImageBase64: string,
  prompt: string,
  thumbnailCount: number,
  projectId: string,
  onProgress: (progress: ThumbnailGenerationProgress) => void
): Promise<ThumbnailGenerationResult> {
  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return {
      success: false,
      error: 'Render API URL not configured. Please set VITE_RENDER_API_URL in .env'
    };
  }

  try {
    const response = await fetch(`${renderUrl}/generate-thumbnails`, {
      method: 'POST',
      headers: withRenderAuth({
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({
        exampleImageBase64,
        prompt,
        thumbnailCount,
        projectId,
        stream: true
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Thumbnail generation error:', response.status, errorText);
      return { success: false, error: `Failed to generate thumbnails: ${response.status}` };
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return { success: false, error: 'No response body' };
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let result: ThumbnailGenerationResult = { success: false, error: 'No response received' };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split('\n\n');
      buffer = events.pop() || '';

      for (const event of events) {
        if (!event.trim()) continue;

        const dataMatch = event.match(/^data: (.+)$/m);
        if (dataMatch) {
          try {
            const parsed = JSON.parse(dataMatch[1]);

            if (parsed.type === 'progress') {
              onProgress({
                stage: parsed.stage,
                percent: parsed.percent,
                message: parsed.message
              });
            } else if (parsed.type === 'complete') {
              result = {
                success: parsed.success,
                thumbnails: parsed.thumbnails
              };
              onProgress({
                stage: 'generating',
                percent: 100,
                message: `${parsed.total} thumbnails generated`
              });
            } else if (parsed.type === 'error' || parsed.error) {
              result = {
                success: false,
                error: parsed.error || 'Thumbnail generation failed'
              };
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }
      }
    }

    return result;

  } catch (error) {
    console.error('Thumbnail generation error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to generate thumbnails'
    };
  }
}

// ============================================================================
// YouTube Upload
// ============================================================================

export interface YouTubeUploadProgress {
  stage: 'downloading' | 'initializing' | 'uploading' | 'complete';
  percent: number;
  message: string;
}

export interface YouTubeUploadParams {
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

export interface YouTubeUploadResult {
  success: boolean;
  videoId?: string;
  youtubeUrl?: string;
  studioUrl?: string;
  error?: string;
}

export async function uploadToYouTube(
  params: YouTubeUploadParams,
  onProgress: (progress: YouTubeUploadProgress) => void
): Promise<YouTubeUploadResult> {
  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return {
      success: false,
      error: 'Render API URL not configured. Please set VITE_RENDER_API_URL in .env'
    };
  }

  try {
    const response = await fetch(`${renderUrl}/youtube-upload`, {
      method: 'POST',
      headers: withRenderAuth({
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify(params)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('YouTube upload error:', response.status, errorText);
      return { success: false, error: `Failed to upload to YouTube: ${response.status}` };
    }

    // Handle SSE streaming response
    const reader = response.body?.getReader();
    if (!reader) {
      return { success: false, error: 'No response body' };
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let result: YouTubeUploadResult = { success: false, error: 'No response received' };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE events
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';

      for (const event of events) {
        if (!event.trim()) continue;

        // Skip keepalive comments
        if (event.startsWith(':')) continue;

        const dataMatch = event.match(/^data: (.+)$/m);
        if (dataMatch) {
          try {
            const parsed = JSON.parse(dataMatch[1]);

            if (parsed.type === 'progress') {
              onProgress({
                stage: parsed.stage,
                percent: parsed.percent,
                message: parsed.message
              });
            } else if (parsed.type === 'complete') {
              result = {
                success: parsed.success,
                videoId: parsed.videoId,
                youtubeUrl: parsed.youtubeUrl,
                studioUrl: parsed.studioUrl
              };
              onProgress({
                stage: 'complete',
                percent: 100,
                message: 'Upload complete!'
              });
            } else if (parsed.type === 'error' || parsed.error) {
              result = {
                success: false,
                error: parsed.error || 'YouTube upload failed'
              };
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }
      }
    }

    return result;

  } catch (error) {
    console.error('YouTube upload error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to upload to YouTube'
    };
  }
}

// YouTube Metadata Generation Types
export interface YouTubeMetadataResult {
  success: boolean;
  titles?: string[];
  description?: string;
  tags?: string[];
  error?: string;
}

export async function generateYouTubeMetadata(
  title: string,
  script: string
): Promise<YouTubeMetadataResult> {
  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return {
      success: false,
      error: 'Render API URL not configured. Please set VITE_RENDER_API_URL in .env'
    };
  }

  try {
    const response = await fetch(`${renderUrl}/generate-youtube-metadata`, {
      method: 'POST',
      headers: withRenderAuth({
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ title, script })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('YouTube metadata generation error:', response.status, errorText);
      return { success: false, error: `Failed to generate metadata: ${response.status}` };
    }

    const result = await response.json();
    return result;

  } catch (error) {
    console.error('YouTube metadata generation error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to generate metadata'
    };
  }
}

// ==================== YouTube Channel Stats / Outlier Finder ====================

export interface OutlierVideo {
  videoId: string;
  title: string;
  thumbnailUrl: string;
  publishedAt: string;
  duration: string;
  durationFormatted: string;
  durationSeconds: number;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  outlierMultiplier: number;
  viewsPerSubscriber: number;
  zScore: number;
  isPositiveOutlier: boolean;
  isNegativeOutlier: boolean;
  // TubeLab-specific fields
  monetization?: {
    rpmEstimationFrom?: number;
    rpmEstimationTo?: number;
    revenueEstimationFrom?: number;
    revenueEstimationTo?: number;
  };
  classification?: {
    isFaceless?: boolean;
    quality?: 'negative' | 'neutral' | 'positive';
  };
}

export interface ChannelStats {
  id: string;
  title: string;
  handle?: string;
  subscriberCount: number;
  subscriberCountFormatted: string;
  thumbnailUrl: string;
  averageViews: number;
  averageViewsFormatted: string;
  standardDeviation: number;
  standardDeviationFormatted: string;
  positiveOutliersCount: number;
  negativeOutliersCount: number;
  totalVideosInDatabase?: number;
}

export interface ChannelStatsResult {
  success: boolean;
  channel?: ChannelStats;
  videos?: OutlierVideo[];
  error?: string;
}

export async function getChannelOutliers(
  channelInput: string,
  maxResults: number = 50,
  sortBy: 'outlier' | 'views' | 'uploaded' = 'outlier',
  forceRefresh: boolean = false
): Promise<ChannelStatsResult> {
  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return {
      success: false,
      error: 'API URL not configured. Please set VITE_RENDER_API_URL in .env'
    };
  }

  try {
    const response = await fetch(`${renderUrl}/youtube-channel-stats`, {
      method: 'POST',
      headers: withRenderAuth({
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ channelInput, maxResults, sortBy, forceRefresh })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('Channel stats error:', response.status, errorData);
      return {
        success: false,
        error: errorData.error || `Failed to analyze channel: ${response.status}`
      };
    }

    const result = await response.json();
    return result;

  } catch (error) {
    console.error('Channel stats error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to analyze channel'
    };
  }
}

// ==================== Niche Analyzer ====================

export interface NicheChannel {
  id: string;
  title: string;
  handle?: string;
  thumbnailUrl: string;
  subscriberCount: number;
  subscriberCountFormatted: string;
  viewCount: number;
  videoCount: number;
  viewsToSubsRatio: number;
  isBreakout: boolean;
  createdAt?: string;
  // TubeLab-specific fields
  avgViews?: number;
  avgViewsFormatted?: string;
  monetization?: {
    adsense: boolean;
    rpmEstimationFrom?: number;
    rpmEstimationTo?: number;
  };
}

export interface NicheMetrics {
  channelCount: number;
  avgSubscribers: number;
  avgViewsPerVideo: number;
  avgViewsToSubsRatio: number;
  saturationLevel: 'low' | 'medium' | 'high';
  saturationScore: number;
}

export interface NicheAnalysisResult {
  success: boolean;
  topic?: string;
  metrics?: NicheMetrics;
  channels?: NicheChannel[];
  totalInDatabase?: number;
  error?: string;
}

export async function analyzeNiche(
  topic: string,
  subscriberMin?: number,
  subscriberMax?: number
): Promise<NicheAnalysisResult> {
  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return {
      success: false,
      error: 'API URL not configured. Please set VITE_RENDER_API_URL in .env'
    };
  }

  try {
    const response = await fetch(`${renderUrl}/niche-analyze`, {
      method: 'POST',
      headers: withRenderAuth({
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ topic, subscriberMin, subscriberMax })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('Niche analyze error:', response.status, errorData);
      return {
        success: false,
        error: errorData.error || `Failed to analyze niche: ${response.status}`
      };
    }

    const result = await response.json();
    return result;

  } catch (error) {
    console.error('Niche analyze error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to analyze niche'
    };
  }
}

// ==================== Apify Channel Scraper (for View All) ====================

/**
 * Scrape channel outliers using Apify YouTube Scraper
 * Used for View All feature - works with ANY YouTube channel, no rate limits
 * TubeLab is still used for Niche Analysis (pre-computed breakout channels)
 */
export async function getChannelOutliersApify(
  channelInput: string,
  maxResults: number = 50,
  sortBy: 'outlier' | 'views' | 'uploaded' = 'outlier',
  forceRefresh: boolean = false
): Promise<ChannelStatsResult> {
  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return {
      success: false,
      error: 'API URL not configured. Please set VITE_RENDER_API_URL in .env'
    };
  }

  try {
    const response = await fetch(`${renderUrl}/youtube-channel-apify`, {
      method: 'POST',
      headers: withRenderAuth({
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ channelInput, maxResults, sortBy, forceRefresh })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('Apify channel stats error:', response.status, errorData);
      return {
        success: false,
        error: errorData.error || `Failed to analyze channel: ${response.status}`
      };
    }

    const result = await response.json();
    return result;

  } catch (error) {
    console.error('Apify channel stats error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to analyze channel'
    };
  }
}

// ==================== Invidious Channel Scraper (for View All) ====================

/**
 * Scrape channel outliers using Invidious API (free YouTube frontend)
 * Used for View All feature - faster than Apify, no rate limits
 */
export async function getChannelOutliersInvidious(
  channelInput: string,
  maxResults: number = 50,
  sortBy: 'outlier' | 'views' | 'uploaded' = 'outlier',
  forceRefresh: boolean = false
): Promise<ChannelStatsResult> {
  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return {
      success: false,
      error: 'API URL not configured. Please set VITE_RENDER_API_URL in .env'
    };
  }

  try {
    const response = await fetch(`${renderUrl}/youtube-channel-invidious`, {
      method: 'POST',
      headers: withRenderAuth({
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ channelInput, maxResults, sortBy, forceRefresh })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('Invidious channel stats error:', response.status, errorData);
      return {
        success: false,
        error: errorData.error || `Failed to analyze channel: ${response.status}`
      };
    }

    const result = await response.json();
    return result;

  } catch (error) {
    console.error('Invidious channel stats error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to analyze channel'
    };
  }
}

/**
 * Scrape channel outliers using yt-dlp (local binary)
 * Most reliable method - uses yt-dlp to scrape YouTube directly
 */
export async function getChannelOutliersYtdlp(
  channelInput: string,
  maxResults: number = 50,
  sortBy: 'outlier' | 'views' | 'uploaded' = 'outlier',
  forceRefresh: boolean = false
): Promise<ChannelStatsResult> {
  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return {
      success: false,
      error: 'API URL not configured. Please set VITE_RENDER_API_URL in .env'
    };
  }

  try {
    const response = await fetch(`${renderUrl}/youtube-channel-ytdlp`, {
      method: 'POST',
      headers: withRenderAuth({
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ channelInput, maxResults, sortBy, forceRefresh })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('yt-dlp channel stats error:', response.status, errorData);
      return {
        success: false,
        error: errorData.error || `Failed to analyze channel: ${response.status}`
      };
    }

    const result = await response.json();
    return result;

  } catch (error) {
    console.error('yt-dlp channel stats error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to analyze channel'
    };
  }
}

// ============================================================================
// Project Costs
// ============================================================================

export interface ProjectCostStep {
  step: string;
  totalCost: number;
  breakdown: Array<{
    service: string;
    units: number;
    unitType: string;
    cost: number;
  }>;
}

export interface ProjectCostsResult {
  success: boolean;
  costs?: {
    steps: ProjectCostStep[];
    totalCost: number;
  };
  error?: string;
}

/**
 * Fetch costs for a project from the database
 */
export async function fetchProjectCosts(projectId: string): Promise<ProjectCostsResult> {
  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return {
      success: false,
      error: 'Render API URL not configured. Please set VITE_RENDER_API_URL in .env'
    };
  }

  try {
    const response = await fetch(`${renderUrl}/costs/${projectId}?byStep=true`, {
      headers: withRenderAuth(),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('Fetch costs error:', response.status, errorData);
      return {
        success: false,
        error: errorData.error || `Failed to fetch costs: ${response.status}`
      };
    }

    const result = await response.json();
    return {
      success: true,
      costs: result.costs
    };

  } catch (error) {
    console.error('Fetch costs error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch costs'
    };
  }
}
/**
 * Reconnect orphaned images from Supabase storage
 * Scans storage for images matching projectId and saves URLs to project
 */
export async function reconnectOrphanedImages(projectId: string): Promise<{ success: boolean; imageUrls?: string[]; error?: string }> {
  try {
    console.log(`[reconnectOrphanedImages] Scanning storage for project ${projectId}`);
    
    // List all files in the project's images folder
    const { data: files, error: listError } = await supabase.storage
      .from('generated-assets')
      .list(`${projectId}/images`, {
        limit: 500,
        sortBy: { column: 'name', order: 'asc' }
      });

    if (listError) {
      console.error('[reconnectOrphanedImages] List error:', listError);
      return { success: false, error: listError.message };
    }

    if (!files || files.length === 0) {
      console.log('[reconnectOrphanedImages] No images found in storage');
      return { success: false, error: 'No images found in storage for this project' };
    }

    // Get public URLs for all image files
    const imageUrls = files
      .filter(file => file.name.endsWith('.png') || file.name.endsWith('.jpg') || file.name.endsWith('.jpeg'))
      .map(file => {
        const { data } = supabase.storage
          .from('generated-assets')
          .getPublicUrl(`${projectId}/images/${file.name}`);
        return data.publicUrl;
      });

    console.log(`[reconnectOrphanedImages] Found ${imageUrls.length} images in storage`);

    // Return the image URLs - the caller will handle updating state
    // (Database update will happen via autoSave when user navigates)
    console.log(`[reconnectOrphanedImages] Successfully retrieved ${imageUrls.length} images from storage`);
    return { success: true, imageUrls };

  } catch (error) {
    console.error('[reconnectOrphanedImages] Error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to reconnect images'
    };
  }
}

// ============================================================================
// Full Pipeline (Server-Side Automation)
// ============================================================================

export interface FullPipelineConfig {
  projectId: string;
  youtubeUrl?: string;  // Optional - either youtubeUrl or script must be provided
  script?: string;      // Direct script input - skips transcript extraction and rewriting
  title?: string;
  topic?: string;
  template?: string;
  wordCount?: number;
  imageCount?: number;
  generateClips?: boolean;
  clipCount?: number;
  clipDuration?: number;
  effects?: {
    embers?: boolean;
    smoke_embers?: boolean;
  };
}

export interface FullPipelineResult {
  success: boolean;
  message?: string;
  projectId?: string;
  error?: string;
}

export interface PipelineStatusResult {
  projectId: string;
  currentStep: string;
  status: string;
  videoUrl?: string;
  smokeEmbersVideoUrl?: string;
}

/**
 * Start a full pipeline run on the server.
 * Returns immediately - pipeline runs in background.
 * User can close browser and come back to finished project.
 */
export async function startFullPipeline(config: FullPipelineConfig): Promise<FullPipelineResult> {
  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return {
      success: false,
      error: 'Render API URL not configured'
    };
  }

  try {
    const response = await fetch(`${renderUrl}/full-pipeline`, {
      method: 'POST',
      headers: withRenderAuth({
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify(config)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Full pipeline error:', response.status, errorText);
      return { success: false, error: `Failed to start pipeline: ${response.status}` };
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Full pipeline error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to start pipeline'
    };
  }
}

/**
 * Check the status of a running pipeline.
 */
export async function getPipelineStatus(projectId: string): Promise<PipelineStatusResult | null> {
  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return null;
  }

  try {
    const response = await fetch(`${renderUrl}/full-pipeline/status/${projectId}`, {
      method: 'GET',
      headers: withRenderAuth({}),
    });

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error('Pipeline status error:', error);
    return null;
  }
}

export interface StopPipelineResult {
  success: boolean;
  message?: string;
  projectId?: string;
  currentStep?: string;
  error?: string;
}

/**
 * Stop a running pipeline.
 * The pipeline will stop at the next step boundary.
 */
export async function stopPipeline(projectId: string): Promise<StopPipelineResult> {
  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return {
      success: false,
      error: 'Render API URL not configured'
    };
  }

  try {
    const response = await fetch(`${renderUrl}/full-pipeline/${projectId}`, {
      method: 'DELETE',
      headers: withRenderAuth({}),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Stop pipeline error:', response.status, errorText);
      return { success: false, error: `Failed to stop pipeline: ${response.status}` };
    }

    return await response.json();
  } catch (error) {
    console.error('Stop pipeline error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to stop pipeline'
    };
  }
}

export interface RunningPipeline {
  projectId: string;
  currentStep: string;
}

export interface RunningPipelinesResult {
  count: number;
  pipelines: RunningPipeline[];
}

/**
 * Get the list of currently running pipelines from the server.
 * This is the authoritative source for what's actually running.
 */
export async function getRunningPipelines(): Promise<RunningPipelinesResult> {
  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return { count: 0, pipelines: [] };
  }

  try {
    const response = await fetch(`${renderUrl}/full-pipeline/running`, {
      method: 'GET',
      headers: withRenderAuth({}),
    });

    if (!response.ok) {
      console.error('Get running pipelines error:', response.status);
      return { count: 0, pipelines: [] };
    }

    return await response.json();
  } catch (error) {
    console.error('Get running pipelines error:', error);
    return { count: 0, pipelines: [] };
  }
}
