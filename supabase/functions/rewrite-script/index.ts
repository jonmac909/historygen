// DEPRECATED — 2026-04-17.
// The frontend no longer invokes this function. Script rewriting is served by
// render-api at POST /rewrite-script, which routes through the Claude Code
// CLI bridge so requests bill against the user's Claude.ai subscription
// instead of api.anthropic.com (see plan humming-munching-platypus.md).
//
// This file still calls api.anthropic.com directly. Do NOT re-wire any
// caller to this edge function. When convenient, run:
//   supabase functions delete rewrite-script --project-ref udqfdeoullsxttqguupz
// to remove the deployed version.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Expose-Headers': 'X-Timeout-Ms, X-Max-Iterations, X-Keepalive-Interval-Ms',
};

// Claude Sonnet 4.5 has a max output of ~16k tokens per call
const MAX_TOKENS_PER_CALL = 16000;

// Timeout for each Claude API call (20 minutes - Claude needs time for very long outputs)
const API_CALL_TIMEOUT = 1200000;

// Maximum iterations for script generation
const MAX_ITERATIONS = 10;

// Keepalive ping interval (3 seconds)
const KEEPALIVE_INTERVAL_MS = 3000;

async function generateScriptChunk(
  apiKey: string,
  model: string,
  systemPrompt: string,
  messages: { role: string; content: string }[]
): Promise<{ text: string; stopReason: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_CALL_TIMEOUT);
  
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS_PER_CALL,
        system: systemPrompt,
        messages,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Claude API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return {
      text: data.content[0]?.text || '',
      stopReason: data.stop_reason || 'end_turn',
    };
  } finally {
    clearTimeout(timeoutId);
  }
}


serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { transcript, template, title, model, stream, wordCount } = await req.json();
    
    if (!transcript) {
      return new Response(
        JSON.stringify({ error: 'Transcript is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
    if (!ANTHROPIC_API_KEY) {
      return new Response(
        JSON.stringify({ error: 'Anthropic API key not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const selectedModel = model || 'claude-sonnet-4-5';
    console.log(`Rewriting script with ${selectedModel}...`);

    const systemPrompt = template || `You are an expert scriptwriter specializing in historical documentary narration. 
Your task is to transform content into compelling, well-structured scripts suitable for history videos.

CRITICAL RULES:
- Write ONLY pure prose narration - no headers, no scene markers, no formatting
- The output should be word-for-word narration that can be read aloud directly
- Make it dramatic, captivating, and educational
- Use vivid descriptions and emotional storytelling
- When continuing a script, seamlessly continue from where you left off`;

    const targetWords = wordCount || 3000; // Frontend sends 3k chunks to avoid timeout
    console.log(`Target word count: ${targetWords}`);

    if (stream) {
      // Streaming mode with continuation loop
      const encoder = new TextEncoder();
      
      const responseStream = new ReadableStream({
        async start(controller) {
          try {
            let fullScript = '';
            let currentWordCount = 0;
            let iteration = 0;
            
            // Optimize for 5k chunks: aim for 3-4 iterations (1.5k words per iteration)
            // This keeps each Claude API call under 2-3 minutes (well within Supabase 5-min limit)
            const wordsPerIteration = Math.min(1500, Math.ceil(targetWords / 3));
            
            while (currentWordCount < targetWords && iteration < MAX_ITERATIONS) {
              iteration++;
              const wordsRemaining = targetWords - currentWordCount;
              console.log(`Iteration ${iteration}: Have ${currentWordCount} words, need ${wordsRemaining} more`);
              
              let messages: { role: string; content: string }[];
              
              if (iteration === 1) {
                // First iteration: start fresh
                messages = [
                  {
                    role: 'user',
                    content: `Write a ${targetWords}-word documentary narration based on this transcript. This is for a ${Math.round(targetWords / 150)}-minute video.

TRANSCRIPT:
${transcript}

TITLE: ${title || 'Historical Documentary'}

REQUIREMENTS:
- Write ${targetWords} words of pure prose narration
- No headers, no formatting, no scene markers
- Dramatic, cinematic, educational style
- Expand with rich historical context and vivid descriptions
- Write as much as you possibly can in this response

Begin the ${targetWords}-word narration now:`
                  }
                ];
              } else {
                // Continuation: ask to continue from where we left off
                // Truncate the context to avoid token limits
                const contextWords = fullScript.split(/\s+/);
                const lastPortion = contextWords.slice(-500).join(' '); // Keep last 500 words for context
                
                messages = [
                  {
                    role: 'user',
                    content: `Continue this documentary narration. You've written ${currentWordCount} words. Write ${Math.min(wordsRemaining, 5000)} more words.

TRANSCRIPT CONTEXT:
${transcript.substring(0, 3000)}...

TITLE: ${title || 'Historical Documentary'}

THE SCRIPT SO FAR ENDS WITH:
...${lastPortion}

CONTINUE SEAMLESSLY from where you left off. Write as much as you can. Do not repeat anything. Do not add headers or formatting. Just continue the narration.

Continue now:`
                  }
                ];
              }

              // Send progress update at start of each iteration
              const startProgress = Math.min(Math.round((currentWordCount / targetWords) * 100), 95);
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ 
                type: 'progress', 
                progress: startProgress,
                wordCount: currentWordCount,
                message: `Writing... ${currentWordCount}/${targetWords} words (pass ${iteration})`
              })}\n\n`));
              
              // Start keepalive pings while waiting for Claude
              let pingCount = 0;
              const keepaliveInterval = setInterval(() => {
                pingCount++;
                // Send simulated progress during API call
                const estimatedNewWords = Math.min(pingCount * 200, wordsPerIteration);
                const estimatedTotal = currentWordCount + estimatedNewWords;
                const simulatedProgress = Math.min(Math.round((estimatedTotal / targetWords) * 100), 95);
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ 
                  type: 'progress', 
                  progress: simulatedProgress,
                  wordCount: estimatedTotal,
                  message: `Writing... ~${estimatedTotal}/${targetWords} words`
                })}\n\n`));
              }, KEEPALIVE_INTERVAL_MS);
              
              let result;
              try {
                result = await generateScriptChunk(
                  ANTHROPIC_API_KEY,
                  selectedModel,
                  systemPrompt,
                  messages
                );
              } catch (apiError) {
                clearInterval(keepaliveInterval);
                console.error(`API error on iteration ${iteration}:`, apiError);
                
                // If we have some content, return what we have
                if (currentWordCount > 500) {
                  console.log(`Returning partial script with ${currentWordCount} words after error`);
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ 
                    type: 'complete', 
                    success: true,
                    script: fullScript,
                    wordCount: currentWordCount,
                    progress: 100,
                    partial: true,
                    message: `Generated ${currentWordCount} words (target was ${targetWords})`
                  })}\n\n`));
                  controller.close();
                  return;
                }
                throw apiError;
              } finally {
                clearInterval(keepaliveInterval);
              }

              if (iteration === 1) {
                fullScript = result.text;
              } else {
                // Append the continuation
                fullScript += '\n\n' + result.text;
              }
              
              currentWordCount = fullScript.split(/\s+/).filter(w => w.length > 0).length;
              console.log(`After iteration ${iteration}: ${currentWordCount} words (stop: ${result.stopReason})`);
              
              // If the model stopped naturally and we're close enough, break
              if (result.stopReason === 'end_turn' && currentWordCount >= targetWords * 0.85) {
                console.log('Model finished naturally and we have enough words');
                break;
              }
              
              // If we got very little new content, break to avoid infinite loop
              if (iteration > 1 && result.text.split(/\s+/).length < 100) {
                console.log('Got too little new content, stopping');
                break;
              }
            }

            console.log(`Script complete: ${currentWordCount} words after ${iteration} iterations`);
            
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ 
              type: 'complete', 
              success: true,
              script: fullScript,
              wordCount: currentWordCount,
              progress: 100
            })}\n\n`));
            
          } catch (error) {
            console.error('Script generation error:', error);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ 
              type: 'error', 
              error: error instanceof Error ? error.message : 'Generation failed'
            })}\n\n`));
          } finally {
            controller.close();
          }
        }
      });

      return new Response(responseStream, {
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Timeout-Ms': API_CALL_TIMEOUT.toString(),
          'X-Max-Iterations': MAX_ITERATIONS.toString(),
          'X-Keepalive-Interval-Ms': KEEPALIVE_INTERVAL_MS.toString(),
        }
      });
    } else {
      // Non-streaming mode with continuation loop
      let fullScript = '';
      let currentWordCount = 0;
      let iteration = 0;

      while (currentWordCount < targetWords && iteration < MAX_ITERATIONS) {
        iteration++;
        const wordsRemaining = targetWords - currentWordCount;
        console.log(`Iteration ${iteration}: Have ${currentWordCount} words, need ${wordsRemaining} more`);

        let messages: { role: string; content: string }[];
        
        if (iteration === 1) {
          messages = [
            {
              role: 'user',
              content: `Write a ${targetWords}-word documentary narration based on this transcript.

TRANSCRIPT:
${transcript}

TITLE: ${title || 'Historical Documentary'}

Write ${targetWords} words of pure prose narration. Begin now:`
            }
          ];
        } else {
          messages = [
            {
              role: 'user',
              content: `Write a ${targetWords}-word documentary narration based on this transcript.

TRANSCRIPT:
${transcript}`
            },
            {
              role: 'assistant',
              content: fullScript
            },
            {
              role: 'user',
              content: `Continue writing ${wordsRemaining} more words. Continue seamlessly:`
            }
          ];
        }

        const result = await generateScriptChunk(
          ANTHROPIC_API_KEY,
          selectedModel,
          systemPrompt,
          messages
        );

        if (iteration === 1) {
          fullScript = result.text;
        } else {
          fullScript += '\n\n' + result.text;
        }
        
        currentWordCount = fullScript.split(/\s+/).filter(w => w.length > 0).length;
        
        if (result.stopReason === 'end_turn' && currentWordCount >= targetWords * 0.9) {
          break;
        }
        
        if (iteration > 1 && result.text.split(/\s+/).length < 100) {
          break;
        }
      }

      console.log(`Script complete: ${currentWordCount} words`);

      return new Response(
        JSON.stringify({ 
          success: true,
          script: fullScript,
          wordCount: currentWordCount
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

  } catch (error) {
    console.error('Error rewriting script:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to rewrite script' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
