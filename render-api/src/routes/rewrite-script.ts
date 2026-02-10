import { Router, Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient, formatSystemPrompt } from '../lib/anthropic-client';
import { saveCost } from '../lib/cost-tracker';
import { saveScriptToProject } from '../lib/supabase-project';

const router = Router();

// Constants
const MAX_TOKENS = 16000;  // Sonnet supports 16k output tokens
const API_CALL_TIMEOUT = 1200000; // 20 minutes
const MAX_ITERATIONS = 10;
const KEEPALIVE_INTERVAL_MS = 15000; // Reduced keepalive frequency (was 3s, now 15s)
const WORDS_PER_ITERATION = 12000; // ~75% of 16k token capacity

interface GenerateScriptChunkOptions {
  apiKey: string;
  model: string;
  systemPrompt: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens: number; // Model-specific max tokens (Haiku: 8k, Sonnet: 16k)
  usePromptCaching?: boolean;
  onToken?: (text: string) => void; // Callback for streaming tokens
}

// Non-streaming version (for non-streaming endpoint)
async function generateScriptChunk(options: GenerateScriptChunkOptions): Promise<{ text: string; stopReason: string }> {
  const { apiKey, model, systemPrompt, messages, maxTokens, usePromptCaching } = options;

  const anthropic = createAnthropicClient(apiKey);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_CALL_TIMEOUT);

  try {
    // OPTIMIZATION: Use prompt caching to avoid re-sending transcript every iteration
    const systemConfig = usePromptCaching
      ? [
          {
            type: 'text' as const,
            text: systemPrompt,
            cache_control: { type: 'ephemeral' as const }
          }
        ]
      : systemPrompt;

    const response = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      system: formatSystemPrompt(systemConfig) as Anthropic.MessageCreateParams['system'],
      messages,
    }, {
      signal: controller.signal as any
    });

    return {
      text: response.content[0]?.type === 'text' ? response.content[0].text : '',
      stopReason: response.stop_reason || 'end_turn',
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// Streaming version (for streaming endpoint)
async function generateScriptChunkStreaming(options: GenerateScriptChunkOptions): Promise<{ text: string; stopReason: string; inputTokens: number; outputTokens: number }> {
  const { apiKey, model, systemPrompt, messages, maxTokens, usePromptCaching, onToken } = options;

  const anthropic = createAnthropicClient(apiKey);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_CALL_TIMEOUT);

  try {
    // OPTIMIZATION: Use prompt caching to avoid re-sending transcript every iteration
    const systemConfig = usePromptCaching
      ? [
          {
            type: 'text' as const,
            text: systemPrompt,
            cache_control: { type: 'ephemeral' as const }
          }
        ]
      : systemPrompt;

    let fullText = '';
    let stopReason = 'end_turn';
    let inputTokens = 0;
    let outputTokens = 0;

    // OPTIMIZATION: Token streaming for real-time progress
    const stream = await anthropic.messages.stream({
      model,
      max_tokens: maxTokens,
      system: formatSystemPrompt(systemConfig) as Anthropic.MessageCreateParams['system'],
      messages,
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        const text = chunk.delta.text;
        fullText += text;
        if (onToken) {
          onToken(text); // Stream tokens to client in real-time
        }
      } else if (chunk.type === 'message_stop') {
        stopReason = 'end_turn';
      } else if (chunk.type === 'message_delta' && (chunk as any).usage) {
        // Capture usage from message_delta event
        outputTokens = (chunk as any).usage.output_tokens || 0;
      }
    }

    // Get final message for usage stats
    const finalMessage = await stream.finalMessage();
    if (finalMessage?.usage) {
      inputTokens = finalMessage.usage.input_tokens || 0;
      outputTokens = finalMessage.usage.output_tokens || outputTokens;
    }

    return { text: fullText, stopReason, inputTokens, outputTokens };
  } finally {
    clearTimeout(timeoutId);
  }
}

router.post('/', async (req: Request, res: Response) => {
  try {
    const { transcript, template, title, topic, model, stream, wordCount, projectId } = req.body;

    if (!transcript) {
      return res.status(400).json({ error: 'Transcript is required' });
    }

    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'Anthropic API key not configured' });
    }

    // Always use Sonnet 4.5 for best quality
    const selectedModel = model || 'claude-sonnet-4-5';

    // Use topic if provided, otherwise fall back to title
    const topicFocus = topic || title || 'Historical Documentary';

    console.log(`🚀 Rewriting script with ${selectedModel}...`);
    console.log(`📊 Max tokens: ${MAX_TOKENS} | Words/iteration: ${WORDS_PER_ITERATION}`);
    console.log(`📝 Transcript length: ${transcript?.length || 0} chars`);
    console.log(`📝 Transcript preview: ${transcript?.substring(0, 200)}...`);
    console.log(`📝 Title: ${title}`);
    console.log(`📝 Topic: ${topicFocus}`);

    const systemPrompt = template || `You are an expert scriptwriter specializing in historical documentary narration.
Your task is to transform content into compelling, well-structured scripts suitable for history videos.

ABSOLUTE FORMATTING RULES - VIOLATION WILL CAUSE TTS FAILURE:
This script will be read aloud by text-to-speech software. ANY non-prose content will cause awkward robotic speech.

FORBIDDEN (will break TTS):
❌ Titles or headlines at the start (no "The Fall of Rome", no topic names as headers)
❌ Markdown formatting (no #, ##, *, **, ***, etc.)
❌ Hashtags (no #History, #Rome, etc.)
❌ Section labels (no "OPENING", "INTRODUCTION", "ACT 1", "CONCLUSION", etc.)
❌ Scene markers (no [SCENE 1], no brackets of any kind)
❌ Chapter numbers or dividers
❌ Any line that isn't meant to be spoken aloud

REQUIRED:
✓ Start immediately with narration prose (first word should be spoken content)
✓ Pure flowing narrative from first word to last
✓ Every single word must be speakable by a human narrator
✓ Dramatic, captivating, educational storytelling
✓ Vivid descriptions and emotional connection
✓ Write as if you're speaking directly to the listener

Example of WRONG start: "The Medieval Tavern\n\nIn the heart of medieval Europe..."
Example of CORRECT start: "In the heart of medieval Europe, where candlelight flickered..."

When continuing a script, seamlessly continue from where you left off.`;

    const targetWords = wordCount || 3000;
    console.log(`Target word count: ${targetWords}`);

    if (stream) {
      // Streaming mode - NO TIMEOUT LIMITS on Render!
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Timeout-Ms': API_CALL_TIMEOUT.toString(),
        'X-Max-Iterations': MAX_ITERATIONS.toString(),
        'X-Keepalive-Interval-Ms': KEEPALIVE_INTERVAL_MS.toString(),
      });

      const sendEvent = (data: any) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      try {
        let fullScript = '';
        let currentWordCount = 0;
        let iteration = 0;
        let maxProgressSent = 0; // Track max progress to prevent going backward
        let totalInputTokens = 0;
        let totalOutputTokens = 0;

        while (currentWordCount < targetWords && iteration < MAX_ITERATIONS) {
          iteration++;
          const wordsRemaining = targetWords - currentWordCount;
          console.log(`Iteration ${iteration}: Have ${currentWordCount} words, need ${wordsRemaining} more`);

          let messages: { role: 'user' | 'assistant'; content: string }[];

          if (iteration === 1) {
            // First iteration: start fresh
            const wordLimit = Math.min(WORDS_PER_ITERATION, targetWords);
            messages = [{
              role: 'user',
              content: `CRITICAL: You MUST rewrite the following transcript into a documentary script about "${topicFocus}".

=== TOPIC ENFORCEMENT ===
Your script MUST focus ONLY on: ${topicFocus}

If the transcript contains off-topic content (content NOT related to ${topicFocus}):
- SKIP that content entirely
- Do NOT include it in your script
- Expand the ON-TOPIC content to reach the word count instead
- If the transcript mostly discusses unrelated topics, extract ONLY the parts about ${topicFocus}

=== PACING FOR SLEEP-FRIENDLY CONTENT ===
This is a SLEEP-FRIENDLY documentary. The audience listens while falling asleep.

FIRST 20-30 MINUTES (the "Opening"): Make this section especially well-crafted
- Use rich sensory details: smells, sounds, textures, light, warmth
- Paint vivid, immersive scenes that transport the listener
- High-quality prose with careful word choices
- Still calm and sleep-friendly - NOT exciting or dramatic
- Draw the viewer into the world of ${topicFocus} with beautiful writing

REMAINDER OF SCRIPT: Maintain quality, prioritize calm flow
- Keep the content on-topic and historically rich
- Use a more meditative, flowing rhythm
- Content can be simpler and more repetitive
- Viewers are drifting to sleep - be their gentle companion

=== TRANSCRIPT START ===
${transcript}
=== TRANSCRIPT END ===

Transform this transcript into ${wordLimit} words of polished documentary narration about "${topicFocus}".
- ONLY include content directly related to ${topicFocus}
- If the transcript drifts to other topics, IGNORE those sections
- Expand and elaborate on the on-topic content to reach the word count
- Make the first ~3000 words especially well-crafted with rich sensory details`
            }];
          } else {
            // Continuation iterations - now in the "calm flow" section
            const wordLimit = Math.min(WORDS_PER_ITERATION, wordsRemaining);
            messages = [
              {
                role: 'user',
                content: `CRITICAL: You MUST rewrite the following transcript into a documentary script about "${topicFocus}".

=== TOPIC ENFORCEMENT ===
Your script MUST focus ONLY on: ${topicFocus}
IGNORE any off-topic content in the transcript.

=== PACING ===
We are now in the CALM FLOW section of this sleep-friendly documentary.
- Keep content on-topic and historically rich
- Use meditative, flowing rhythm
- Content can be simpler and more repetitive
- Viewers are drifting to sleep - be their gentle companion

=== TRANSCRIPT START ===
${transcript}
=== TRANSCRIPT END ===

Write ${wordLimit} words of pure narration about "${topicFocus}" based ONLY on the relevant parts of the transcript.`
              },
              {
                role: 'assistant',
                content: fullScript
              },
              {
                role: 'user',
                content: `Continue the script from where you left off. Stay focused on ${topicFocus}.

CRITICAL - DO NOT REPEAT ANY CONTENT:
- Your previous response ended with the last few sentences shown above
- Start your continuation with NEW content only
- Do NOT rewrite or paraphrase sentences you already wrote
- If you're unsure, skip ahead to genuinely new material
- Keep ALL content focused on ${topicFocus}
- Use calm, meditative pacing - viewers are drifting to sleep

Write EXACTLY ${wordLimit} more words. Stop when you reach ${wordLimit} words.`
              }
            ];
          }

          // Send initial progress for this iteration (actual progress only)
          const currentProgress = Math.max(maxProgressSent, Math.round((currentWordCount / targetWords) * 100));
          maxProgressSent = currentProgress;
          const estimatedIterations = Math.ceil(targetWords / WORDS_PER_ITERATION);
          sendEvent({
            type: 'progress',
            progress: currentProgress,
            wordCount: currentWordCount,
            message: `Writing iteration ${iteration}/${estimatedIterations}... ${currentWordCount}/${targetWords} words`
          });

          // OPTIMIZATION: Token streaming means we don't need frequent keepalive pings
          // Tokens stream in real-time, so only occasional keepalive needed
          const keepaliveInterval = setInterval(() => {
            sendEvent({
              type: 'keepalive',
              message: `Generating... (streaming tokens)`
            });
          }, KEEPALIVE_INTERVAL_MS);

          let result;
          try {
            const useCaching = true; // Always use caching for faster response
            console.log(`💾 Using prompt cache for iteration ${iteration} (90% cost reduction + faster!)`);

            // Track tokens for incremental progress updates
            let iterationTokens = '';
            let lastProgressUpdate = Date.now();
            const PROGRESS_UPDATE_INTERVAL = 2000; // Update progress every 2 seconds

            // OPTIMIZATION: Use streaming with token callbacks + prompt caching
            result = await generateScriptChunkStreaming({
              apiKey: ANTHROPIC_API_KEY,
              model: selectedModel,
              systemPrompt,
              messages,
              maxTokens: MAX_TOKENS,
              usePromptCaching: useCaching, // Cache transcript on subsequent iterations
              onToken: (text) => {
                // Stream tokens to client in real-time for better UX
                sendEvent({
                  type: 'token',
                  text,
                });

                // Accumulate tokens and send incremental progress updates
                iterationTokens += text;
                const now = Date.now();
                if (now - lastProgressUpdate >= PROGRESS_UPDATE_INTERVAL) {
                  lastProgressUpdate = now;

                  // Estimate current words in this iteration
                  const iterationWords = iterationTokens.split(/\s+/).filter(w => w.length > 0).length;
                  const estimatedTotal = currentWordCount + iterationWords;
                  // Only send progress if it's higher than what we've sent before (prevent backward movement)
                  const estimatedProgress = Math.max(maxProgressSent, Math.min(Math.round((estimatedTotal / targetWords) * 100), 99));

                  if (estimatedProgress > maxProgressSent) {
                    maxProgressSent = estimatedProgress;
                    sendEvent({
                      type: 'progress',
                      progress: estimatedProgress,
                      wordCount: estimatedTotal,
                      message: `Writing... ${estimatedTotal}/${targetWords} words`
                    });
                  }
                }
              }
            });
          } catch (apiError) {
            clearInterval(keepaliveInterval);
            console.error(`API error on iteration ${iteration}:`, apiError);

            // If we have some content, return what we have
            if (currentWordCount > 500) {
              console.log(`Returning partial script with ${currentWordCount} words after error`);
              sendEvent({
                type: 'complete',
                success: true,
                script: fullScript,
                wordCount: currentWordCount,
                progress: 100,
                partial: true,
                message: `Generated ${currentWordCount} words (target was ${targetWords})`
              });
              res.end();
              return;
            }
            throw apiError;
          } finally {
            clearInterval(keepaliveInterval);
          }

          // Accumulate token usage for cost tracking
          totalInputTokens += result.inputTokens || 0;
          totalOutputTokens += result.outputTokens || 0;

          if (iteration === 1) {
            fullScript = result.text;
          } else {
            fullScript += '\n\n' + result.text;
          }

          currentWordCount = fullScript.split(/\s+/).filter(w => w.length > 0).length;
          console.log(`After iteration ${iteration}: ${currentWordCount} words (stop: ${result.stopReason}), tokens: +${result.inputTokens}/${result.outputTokens}`);

          // Send REAL progress update after iteration completes (only if higher than previous)
          const realProgress = Math.max(maxProgressSent, Math.min(Math.round((currentWordCount / targetWords) * 100), 99));
          if (realProgress > maxProgressSent) {
            maxProgressSent = realProgress;
            sendEvent({
              type: 'progress',
              progress: realProgress,
              wordCount: currentWordCount,
              message: `Completed iteration ${iteration} - ${currentWordCount}/${targetWords} words`
            });
          }

          // If the model stopped naturally and we're close enough, break
          if (result.stopReason === 'end_turn' && currentWordCount >= targetWords * 0.85) {
            console.log('Model finished naturally and we have enough words');

            // Truncate if we significantly exceeded the target (>10% overshoot)
            if (currentWordCount > targetWords * 1.1) {
              console.log(`Truncating script from ${currentWordCount} to ~${targetWords} words`);
              const words = fullScript.split(/\s+/);
              const truncatedWords = words.slice(0, targetWords);
              fullScript = truncatedWords.join(' ');

              // Ensure we end with a complete sentence
              const lastPeriod = fullScript.lastIndexOf('.');
              const lastQuestion = fullScript.lastIndexOf('?');
              const lastExclamation = fullScript.lastIndexOf('!');
              const lastSentenceEnd = Math.max(lastPeriod, lastQuestion, lastExclamation);

              if (lastSentenceEnd > fullScript.length * 0.9) {
                fullScript = fullScript.substring(0, lastSentenceEnd + 1);
              }

              currentWordCount = fullScript.split(/\s+/).filter(w => w.length > 0).length;
              console.log(`Truncated to ${currentWordCount} words`);
            }

            break;
          }

          // If we got very little new content, break to avoid infinite loop
          if (iteration > 1 && result.text.split(/\s+/).length < 100) {
            console.log('Got too little new content, stopping');
            break;
          }
        }

        console.log(`Script complete: ${currentWordCount} words after ${iteration} iterations`);
        console.log(`Total tokens: ${totalInputTokens} input, ${totalOutputTokens} output`);

        // Save costs to Supabase if projectId provided
        if (projectId) {
          try {
            await Promise.all([
              saveCost({
                projectId,
                source: 'manual',
                step: 'script',
                service: 'claude',
                units: totalInputTokens,
                unitType: 'input_tokens',
              }),
              saveCost({
                projectId,
                source: 'manual',
                step: 'script',
                service: 'claude',
                units: totalOutputTokens,
                unitType: 'output_tokens',
              }),
            ]);
          } catch (costError) {
            console.error('[rewrite-script] Error saving costs:', costError);
          }
        }

        // Save to project database (fire-and-forget - allows user to close browser)
        if (projectId && fullScript) {
          saveScriptToProject(projectId, fullScript)
            .then(result => {
              if (result.success) {
                console.log(`[Script] Saved to project ${projectId}`);
              } else {
                console.warn(`[Script] Failed to save to project: ${result.error}`);
              }
            })
            .catch(err => console.error(`[Script] Error saving to project:`, err));
        }

        sendEvent({
          type: 'complete',
          success: true,
          script: fullScript,
          wordCount: currentWordCount,
          progress: 100
        });

        res.end();
      } catch (error) {
        console.error('Script generation error:', error);
        sendEvent({
          type: 'error',
          error: error instanceof Error ? error.message : 'Generation failed'
        });
        res.end();
      }
    } else {
      // Non-streaming mode
      let fullScript = '';
      let currentWordCount = 0;
      let iteration = 0;

      while (currentWordCount < targetWords && iteration < MAX_ITERATIONS) {
        iteration++;
        const wordsRemaining = targetWords - currentWordCount;
        console.log(`Iteration ${iteration}: Have ${currentWordCount} words, need ${wordsRemaining} more`);

        let messages: { role: 'user' | 'assistant'; content: string }[];

        if (iteration === 1) {
          const wordLimit = Math.min(WORDS_PER_ITERATION, targetWords);
          messages = [{
            role: 'user',
            content: `Create a historical documentary script based on this content:\n\n${transcript}\n\nTitle: ${title || 'Historical Documentary'}\n\nIMPORTANT: Write EXACTLY ${wordLimit} words of pure narration. Do not exceed ${wordLimit} words. Stop writing when you reach ${wordLimit} words.`
          }];
        } else {
          const wordLimit = Math.min(WORDS_PER_ITERATION, wordsRemaining);
          messages = [
            {
              role: 'user',
              content: `Create a historical documentary script based on this content:\n\n${transcript}\n\nTitle: ${title || 'Historical Documentary'}\n\nWrite ${wordLimit} words of pure narration.`
            },
            {
              role: 'assistant',
              content: fullScript
            },
            {
              role: 'user',
              content: `Continue the script from where you left off.

CRITICAL - DO NOT REPEAT ANY CONTENT:
- Your previous response ended with the last few sentences shown above
- Start your continuation with NEW content only
- Do NOT rewrite or paraphrase sentences you already wrote
- If you're unsure, skip ahead to genuinely new material

Write EXACTLY ${wordLimit} more words. Stop when you reach ${wordLimit} words.`
            }
          ];
        }

        // OPTIMIZATION: Use prompt caching on subsequent iterations
        const result = await generateScriptChunk({
          apiKey: ANTHROPIC_API_KEY,
          model: selectedModel,
          systemPrompt,
          messages,
          maxTokens: MAX_TOKENS,
          usePromptCaching: iteration > 1 // Cache transcript on subsequent iterations
        });

        if (iteration === 1) {
          fullScript = result.text;
        } else {
          fullScript += '\n\n' + result.text;
        }

        currentWordCount = fullScript.split(/\s+/).filter(w => w.length > 0).length;
        console.log(`After iteration ${iteration}: ${currentWordCount} words`);

        if (result.stopReason === 'end_turn' && currentWordCount >= targetWords * 0.85) {
          // Truncate if we significantly exceeded the target (>10% overshoot)
          if (currentWordCount > targetWords * 1.1) {
            console.log(`Truncating script from ${currentWordCount} to ~${targetWords} words`);
            const words = fullScript.split(/\s+/);
            const truncatedWords = words.slice(0, targetWords);
            fullScript = truncatedWords.join(' ');

            // Ensure we end with a complete sentence
            const lastPeriod = fullScript.lastIndexOf('.');
            const lastQuestion = fullScript.lastIndexOf('?');
            const lastExclamation = fullScript.lastIndexOf('!');
            const lastSentenceEnd = Math.max(lastPeriod, lastQuestion, lastExclamation);

            if (lastSentenceEnd > fullScript.length * 0.9) {
              fullScript = fullScript.substring(0, lastSentenceEnd + 1);
            }

            currentWordCount = fullScript.split(/\s+/).filter(w => w.length > 0).length;
            console.log(`Truncated to ${currentWordCount} words`);
          }

          break;
        }

        if (iteration > 1 && result.text.split(/\s+/).length < 100) {
          break;
        }
      }

      res.json({
        success: true,
        script: fullScript,
        wordCount: currentWordCount
      });
    }
  } catch (error) {
    console.error('Script generation error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Generation failed'
    });
  }
});

// Rate a script and provide feedback
router.post('/rate', async (req: Request, res: Response) => {
  try {
    const { script, template, title, topic } = req.body;

    if (!script) {
      return res.status(400).json({ error: 'Script is required' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'API key not configured' });
    }

    // Use topic if provided, otherwise fall back to title
    const topicFocus = topic || title || 'History Documentary';

    const anthropic = createAnthropicClient(apiKey);

    const systemPrompt = `You are an expert script evaluator for SLEEP-FRIENDLY long-form history documentary narration. These are 2-3 hour videos designed to help viewers drift peacefully through history while falling asleep.

CONTEXT - SLEEP-FRIENDLY HISTORY CONTENT:
- These scripts are meant to be calming, meditative, and dreamy
- They should NOT be dramatic, exciting, or tension-filled
- The tone should be contemplative, reverent, and time-travelly
- Viewers listen to drift off to sleep, not to stay alert
- Long, flowing sentences that create a hypnotic rhythm are GOOD
- Repetitive anchoring phrases and philosophical breathers are GOOD

GRADING CRITERIA (be generous - most scripts should be A or B):
- A: Excellent - Good sleep-friendly content, flows well, historically rich
- B: Good but has minor issues - Mostly good but could use some tweaks
- C: Reserved for SERIOUS problems only - Major formatting issues (headers, markdown) or completely wrong tone

IMPORTANT: Only give C for egregious issues like markdown headers or extremely jarring content. Most scripts should be A or B.

EVALUATION ASPECTS:
1. Sleep-Friendly Tone: Is it calming and meditative, NOT dramatic or exciting?
2. Narrative Flow: Do sentences flow like water, creating a hypnotic rhythm?
3. Sensory Immersion: Are there rich sensory details (smell, sound, texture, light)?
4. Historical Depth: Is the content historically rich and educational?
5. TTS Compatibility: Is it ONLY plain prose with NO formatting, headers, or markers?
6. Pacing: Is it slow and contemplative, not rushed or urgent?

WHAT IS GOOD (don't flag these):
- Long, flowing sentences
- Philosophical reflections
- Repetitive anchor phrases
- Second-person immersion ("you could walk...", "imagine yourself...")
- Sensory descriptions
- Slow, meandering narrative

WHAT IS BAD (flag these):
- Dramatic tension, cliffhangers, urgency
- Headers, titles, markdown formatting, hashtags
- Short punchy sentences meant to excite
- Modern slang or anachronisms
- Questions that demand engagement

TOPIC DRIFT DETECTION (CRITICAL):
You MUST analyze the script for topic consistency. The title tells you the intended topic.
- Identify ALL distinct topics/subjects covered in the script
- Flag ANY topic that doesn't belong to the main subject indicated by the title
- Topic drift is a MAJOR issue - it confuses viewers and breaks the narrative

Example: If title is "Viking Winters" but script discusses Roman sanitation, Confederate America, or Medieval plagues - these are OFF-TOPIC sections that must be flagged.

RESPONSE FORMAT:
You must respond with valid JSON in this exact format:
{
  "grade": "A" | "B" | "C",
  "summary": "One sentence overall assessment",
  "issues": [
    { "text": "Description of issue", "severity": "major" | "minor" }
  ],
  "fixPrompt": "If grade is B or C, provide a specific instruction to fix the script",
  "topicAnalysis": {
    "expectedTopic": "The main topic from the title",
    "topicsFound": ["Topic 1", "Topic 2", "Topic 3"],
    "offTopicSections": ["Description of off-topic section 1", "Description of off-topic section 2"],
    "hasDrift": true | false
  }
}

SEVERITY RULES:
- "major" (shown with !) = TTS-breaking issues: headers, markdown, titles, hashtags, TOPIC DRIFT, off-topic content
- "minor" (shown with ?) = Quality suggestions: pacing, tone tweaks, missing sensory details, style improvements

Example response with topic drift:
{
  "grade": "C",
  "summary": "Script drifts significantly off-topic from Viking Winters to unrelated subjects",
  "issues": [
    { "text": "Script shifts to discussing Roman sanitation (unrelated to Viking Winters)", "severity": "major" },
    { "text": "Section about Confederate America is completely off-topic", "severity": "major" }
  ],
  "fixPrompt": "Remove all content about Roman sanitation and Confederate America. Expand the Viking Winters content to fill the full word count with more details about Norse winter survival, food preservation, shelter, clothing, and cultural practices.",
  "topicAnalysis": {
    "expectedTopic": "Viking Winters",
    "topicsFound": ["Viking Winters", "Roman sanitation", "Confederate America"],
    "offTopicSections": ["Paragraphs 5-8 discuss Roman sanitation systems", "Final third covers Confederate America"],
    "hasDrift": true
  }
}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1000,
      system: formatSystemPrompt(systemPrompt) as Anthropic.MessageCreateParams['system'],
      messages: [
        {
          role: 'user',
          content: `Please evaluate this script for a YouTube documentary.

EXPECTED TOPIC: "${topicFocus}"
${title && title !== topicFocus ? `VIDEO TITLE: "${title}"` : ''}

The script should focus ONLY on: ${topicFocus}
Flag any content that discusses topics NOT related to ${topicFocus} as topic drift.

Template guidance used for generation:
${template ? template.substring(0, 500) + '...' : 'No template provided'}

SCRIPT TO EVALUATE:
${script.substring(0, 10000)}${script.length > 10000 ? '...[truncated]' : ''}`
        }
      ]
    });

    const responseText = response.content[0]?.type === 'text' ? response.content[0].text : '';

    // Parse JSON response
    try {
      // Extract JSON from response (handle markdown code blocks if present)
      let jsonStr = responseText;
      const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
      }

      const rating = JSON.parse(jsonStr);

      // Validate response structure
      if (!rating.grade || !['A', 'B', 'C'].includes(rating.grade)) {
        throw new Error('Invalid grade in response');
      }

      res.json({
        success: true,
        grade: rating.grade,
        summary: rating.summary || '',
        issues: rating.issues || [],
        fixPrompt: rating.fixPrompt || '',
        topicAnalysis: rating.topicAnalysis || null
      });
    } catch (parseError) {
      console.error('Failed to parse rating response:', responseText);
      // Fallback - try to extract grade from text
      const gradeMatch = responseText.match(/grade["\s:]+([ABC])/i);
      res.json({
        success: true,
        grade: gradeMatch ? gradeMatch[1].toUpperCase() : 'B',
        summary: 'Could not parse detailed feedback',
        issues: ['Review manually'],
        fixPrompt: ''
      });
    }
  } catch (error) {
    console.error('Script rating error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Rating failed'
    });
  }
});

// Quick edit a script (targeted fixes, not full regeneration)
router.post('/quick-edit', async (req: Request, res: Response) => {
  try {
    const { script, fixPrompt } = req.body;

    if (!script || !fixPrompt) {
      return res.status(400).json({ error: 'Script and fixPrompt are required' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'API key not configured' });
    }

    const anthropic = createAnthropicClient(apiKey);

    console.log(`🔧 Quick-editing script (${script.length} chars)...`);
    console.log(`📝 Fix prompt: ${fixPrompt}`);

    // Detect if this is a topic drift fix (needs major rewrite) vs minor edit
    const isTopicDriftFix = /off-topic|topic drift|only.*about|remove.*content|expand/i.test(fixPrompt);
    const originalWordCount = script.split(/\s+/).filter((w: string) => w.length > 0).length;
    const minWordCount = Math.floor(originalWordCount * 0.85); // Must be at least 85% of original

    console.log(`[Quick Edit] Mode: ${isTopicDriftFix ? 'TOPIC DRIFT FIX' : 'TARGETED EDIT'}`);
    console.log(`[Quick Edit] Original word count: ${originalWordCount}, minimum required: ${minWordCount}`);

    const systemPrompt = isTopicDriftFix
      ? `You are an expert scriptwriter for SLEEP-FRIENDLY long-form history documentaries.

YOUR TASK: COMPLETELY REWRITE the script to focus ONLY on the specified topic. This is a MAJOR rewrite, not a small edit.

⚠️ CRITICAL LENGTH REQUIREMENT ⚠️
The original script is ${originalWordCount} words. Your output MUST be at least ${minWordCount} words (85% of original).
DO NOT return a shorter script. If you remove off-topic content, you MUST add new on-topic content to replace it.

CRITICAL RULES:
1. REMOVE ALL off-topic content entirely - do not try to preserve it
2. REPLACE removed content with NEW, EXPANDED on-topic content - DO NOT just delete
3. Add rich historical details, sensory descriptions, and contemplative narrative
4. Maintain the dreamy, meditative, sleep-friendly tone throughout
5. Ensure ALL output is pure prose - no headers, markdown, or formatting
6. The result should be a complete, cohesive script about ONLY the intended topic

OUTPUT FORMAT:
Return ONLY the rewritten script. No explanations, no comments, just the new script text.
The script MUST be at least ${minWordCount} words long.`
      : `You are an expert script editor for SLEEP-FRIENDLY long-form history documentaries.

YOUR TASK: Make TARGETED EDITS to fix specific issues while preserving the original script as much as possible.

⚠️ CRITICAL LENGTH REQUIREMENT ⚠️
The original script is ${originalWordCount} words. Your output MUST be at least ${minWordCount} words (85% of original).
DO NOT significantly shorten the script.

CRITICAL RULES:
1. PRESERVE the vast majority of the original script - only change what's necessary
2. Keep the same length (don't add or remove significant content)
3. Maintain the dreamy, meditative, sleep-friendly tone throughout
4. Ensure ALL output is pure prose - no headers, markdown, or formatting
5. The edited script should feel like a natural improvement, not a rewrite

OUTPUT FORMAT:
Return ONLY the edited script. No explanations, no comments, just the improved script text.
The script MUST be at least ${minWordCount} words long.`;

    const userMessage = isTopicDriftFix
      ? `REWRITE THIS SCRIPT to focus ONLY on the specified topic. Remove ALL off-topic content and REPLACE it with expanded on-topic content.

⚠️ LENGTH REQUIREMENT: Output MUST be at least ${minWordCount} words. Original is ${originalWordCount} words.

INSTRUCTIONS:
${fixPrompt}

ORIGINAL SCRIPT (contains off-topic content that must be REMOVED and REPLACED):
${script}

REMEMBER: Do NOT just delete content. Replace off-topic sections with NEW content about the correct topic. Final word count must be at least ${minWordCount} words.`
      : `Please make targeted edits to fix these issues:

FIX REQUIRED:
${fixPrompt}

ORIGINAL SCRIPT:
${script}

Return the edited script with the issues fixed. Preserve the original as much as possible - only change what's necessary to fix the specific issues mentioned.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 16000,
      system: formatSystemPrompt(systemPrompt) as Anthropic.MessageCreateParams['system'],
      messages: [
        {
          role: 'user',
          content: userMessage
        }
      ]
    });

    const editedScript = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const editedWordCount = editedScript?.split(/\s+/).filter(w => w.length > 0).length || 0;

    console.log(`[Quick Edit] Response received: ${editedWordCount} words (original: ${originalWordCount} words, min required: ${minWordCount})`);
    console.log(`[Quick Edit] First 200 chars of response:`, editedScript?.substring(0, 200) || 'EMPTY');

    if (!editedScript) {
      console.error('[Quick Edit] Empty response from Claude');
      throw new Error('Edit produced empty result');
    }

    if (editedWordCount < minWordCount) {
      console.error(`[Quick Edit] Response too short: ${editedWordCount} words < ${minWordCount} words (85% threshold)`);
      throw new Error(`Edit produced too-short result: ${editedWordCount} words vs required minimum ${minWordCount} words (original was ${originalWordCount})`);
    }

    console.log(`✅ Quick edit complete: ${editedWordCount} words (was ${originalWordCount} words)`);

    res.json({
      success: true,
      script: editedScript,
      wordCount: editedScript.split(/\s+/).filter(w => w.length > 0).length
    });
  } catch (error) {
    console.error('Quick edit error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Quick edit failed'
    });
  }
});

export default router;
