import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// RunPod Z-Image endpoint configuration
const RUNPOD_ENDPOINT_ID = Deno.env.get('RUNPOD_ZIMAGE_ENDPOINT_ID');
const RUNPOD_API_URL = RUNPOD_ENDPOINT_ID ? `https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}` : null;

interface ImagePromptWithTiming {
  index: number;
  prompt: string;
  startTime: string;  // HH-MM-SS format
  endTime: string;    // HH-MM-SS format
}

interface GenerateImagesRequest {
  prompts: string[] | ImagePromptWithTiming[];
  quality: string;
  aspectRatio?: string;
  stream?: boolean;
  projectId?: string;
}

interface JobStatus {
  jobId: string;
  index: number;
  state: 'pending' | 'success' | 'fail';
  imageUrl?: string;
  error?: string;
  filename?: string;  // Timing-based filename
}

/**
 * Start a RunPod job for Z-Image generation
 */
async function startImageJob(apiKey: string, prompt: string, quality: string, aspectRatio: string): Promise<string> {
  console.log(`Starting RunPod job for: ${prompt.substring(0, 50)}...`);

  const response = await fetch(`${RUNPOD_API_URL}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input: {
        prompt,
        quality: quality === "high" ? "high" : "basic",
        aspectRatio,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('RunPod job creation error:', response.status, errorText);
    throw new Error(`Failed to start image job: ${response.status}`);
  }

  const data = await response.json();

  if (!data.id) {
    throw new Error('RunPod job creation failed: no job ID returned');
  }

  console.log(`RunPod job created: ${data.id}`);
  return data.id;
}

/**
 * Check RunPod job status and upload image if complete
 */
async function checkJobStatus(
  apiKey: string,
  jobId: string,
  supabaseUrl: string,
  supabaseKey: string,
  customFilename?: string,
  projectId?: string
): Promise<{ state: string; imageUrl?: string; error?: string }> {
  try {
    const response = await fetch(`${RUNPOD_API_URL}/status/${jobId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      console.error(`RunPod status check failed: ${response.status}`);
      return { state: 'pending' };
    }

    const data = await response.json();

    // RunPod statuses: IN_QUEUE, IN_PROGRESS, COMPLETED, FAILED, CANCELLED, TIMED_OUT
    if (data.status === 'COMPLETED' && data.output) {
      // Z-Image handler returns: { image_base64, width, height, steps }
      if (data.output.error) {
        console.error(`Job ${jobId} completed with error:`, data.output.error);
        return { state: 'fail', error: data.output.error };
      }

      const imageBase64 = data.output.image_base64;
      if (!imageBase64) {
        console.error(`Job ${jobId} completed but no image_base64 in output`);
        return { state: 'fail', error: 'No image data returned' };
      }

      // Upload to Supabase storage with timing-based filename
      try {
        const imageUrl = await uploadImageToStorage(imageBase64, supabaseUrl, supabaseKey, customFilename, projectId);
        console.log(`Job ${jobId} completed, uploaded to: ${imageUrl}`);
        return { state: 'success', imageUrl };
      } catch (uploadErr) {
        console.error(`Failed to upload image for job ${jobId}:`, uploadErr);
        return { state: 'fail', error: `Upload failed: ${uploadErr instanceof Error ? uploadErr.message : 'Unknown error'}` };
      }
    } else if (data.status === 'FAILED') {
      const errorMsg = data.error || data.output?.error || 'Job failed';
      console.error(`Job ${jobId} failed:`, errorMsg);
      return { state: 'fail', error: errorMsg };
    } else if (data.status === 'CANCELLED' || data.status === 'TIMED_OUT') {
      console.error(`Job ${jobId} ${data.status.toLowerCase()}`);
      return { state: 'fail', error: `Job ${data.status.toLowerCase()}` };
    }

    // IN_QUEUE or IN_PROGRESS
    return { state: 'pending' };
  } catch (err) {
    console.error(`Error checking job ${jobId}:`, err);
    return { state: 'pending' };
  }
}

/**
 * Upload base64 image to Supabase storage with optional custom filename
 */
async function uploadImageToStorage(
  base64: string,
  supabaseUrl: string,
  supabaseKey: string,
  customFilename?: string,
  projectId?: string
): Promise<string> {
  const supabase = createClient(supabaseUrl, supabaseKey);

  // Decode base64 to Uint8Array
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  // Generate filename - use custom timing-based name if provided
  let fileName: string;
  if (customFilename && projectId) {
    fileName = `${projectId}/images/${customFilename}`;
  } else if (customFilename) {
    fileName = `generated-images/${customFilename}`;
  } else {
    fileName = `generated-images/${crypto.randomUUID()}.png`;
  }

  console.log(`Uploading image to storage: ${fileName} (${bytes.length} bytes)`);

  // Upload to storage bucket
  const { error } = await supabase.storage
    .from('generated-assets')
    .upload(fileName, bytes, {
      contentType: 'image/png',
      upsert: true,
    });

  if (error) {
    console.error('Supabase storage upload error:', error);
    throw new Error(`Storage upload failed: ${error.message}`);
  }

  // Get public URL
  const { data } = supabase.storage
    .from('generated-assets')
    .getPublicUrl(fileName);

  if (!data?.publicUrl) {
    throw new Error('Failed to get public URL for uploaded image');
  }

  return data.publicUrl;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const runpodApiKey = Deno.env.get('RUNPOD_API_KEY');
    if (!runpodApiKey) {
      throw new Error('RUNPOD_API_KEY not configured');
    }

    if (!RUNPOD_ENDPOINT_ID || !RUNPOD_API_URL) {
      throw new Error('RUNPOD_ZIMAGE_ENDPOINT_ID not configured - set this secret in Supabase dashboard');
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase configuration missing');
    }

    const { prompts, quality, aspectRatio = "16:9", stream = false, projectId }: GenerateImagesRequest = await req.json();

    if (!prompts || prompts.length === 0) {
      throw new Error('No prompts provided');
    }

    // Normalize prompts - support both simple strings and objects with timing
    const isTimedPrompts = typeof prompts[0] === 'object' && 'prompt' in prompts[0];
    const normalizedPrompts: { prompt: string; filename: string }[] = isTimedPrompts
      ? (prompts as ImagePromptWithTiming[]).map(p => ({
          prompt: p.prompt,
          filename: `image_${String(p.index).padStart(3, '0')}_${p.startTime}_to_${p.endTime}.png`
        }))
      : (prompts as string[]).map((prompt, i) => ({
          prompt,
          filename: `image_${String(i + 1).padStart(3, '0')}.png`
        }));

    const total = normalizedPrompts.length;
    console.log(`Generating ${total} images with Z-Image (quality: ${quality}, aspect: ${aspectRatio}, stream: ${stream}, timed: ${isTimedPrompts})`);

    if (stream) {
      const encoder = new TextEncoder();

      const responseStream = new ReadableStream({
        async start(controller) {
          try {
            // Step 1: Create ALL RunPod jobs in parallel upfront
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              type: 'progress',
              completed: 0,
              total,
              message: `Creating ${total} image jobs...`
            })}\n\n`));

            const createPromises = normalizedPrompts.map(async (item, index) => {
              try {
                const jobId = await startImageJob(runpodApiKey, item.prompt, quality, aspectRatio);
                return { index, jobId, filename: item.filename, error: null };
              } catch (err) {
                console.error(`Failed to create job for prompt ${index}:`, err);
                return { index, jobId: null, filename: item.filename, error: err instanceof Error ? err.message : 'Failed to create job' };
              }
            });

            const createResults = await Promise.all(createPromises);

            // Build job list with filenames
            const jobs: JobStatus[] = createResults.map(r => ({
              jobId: r.jobId || '',
              index: r.index,
              state: r.jobId ? 'pending' : 'fail',
              error: r.error || undefined,
              filename: r.filename
            }));

            console.log(`Created ${jobs.filter(j => j.state === 'pending').length}/${total} jobs`);

            // Step 2: Poll ALL jobs in parallel until all complete
            const maxPollingTime = 5 * 60 * 1000; // 5 minutes max
            const pollInterval = 3000; // 3 seconds
            const startTime = Date.now();

            while (Date.now() - startTime < maxPollingTime) {
              const pendingJobs = jobs.filter(j => j.state === 'pending');

              if (pendingJobs.length === 0) {
                console.log('All jobs completed');
                break;
              }

              // Check all pending jobs in parallel - pass filename for storage
              const checkPromises = pendingJobs.map(async (job) => {
                const status = await checkJobStatus(runpodApiKey, job.jobId, supabaseUrl, supabaseKey, job.filename, projectId);
                return { job, status };
              });

              const results = await Promise.all(checkPromises);

              for (const { job, status } of results) {
                if (status.state === 'success') {
                  job.state = 'success';
                  job.imageUrl = status.imageUrl;
                  console.log(`Job ${job.index + 1}/${total} completed (${job.filename}): ${status.imageUrl}`);
                } else if (status.state === 'fail') {
                  job.state = 'fail';
                  job.error = status.error;
                  console.log(`Job ${job.index + 1}/${total} failed: ${status.error}`);
                }
              }

              const completed = jobs.filter(j => j.state !== 'pending').length;

              // Send progress update
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                type: 'progress',
                completed,
                total,
                message: `${completed}/${total} images done`
              })}\n\n`));

              if (pendingJobs.length > 0) {
                await new Promise(resolve => setTimeout(resolve, pollInterval));
              }
            }

            // Collect all successful images (sorted by index to maintain order)
            const sortedJobs = [...jobs].sort((a, b) => a.index - b.index);
            const allImages = sortedJobs
              .filter(j => j.state === 'success' && j.imageUrl)
              .map(j => j.imageUrl!);

            const failedCount = jobs.filter(j => j.state === 'fail').length;

            console.log(`Z-Image generation complete: ${allImages.length} images, ${failedCount} failed`);

            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              type: 'complete',
              success: true,
              images: allImages,
              total: allImages.length,
              failed: failedCount
            })}\n\n`));

          } catch (err) {
            console.error('Stream error:', err);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              type: 'error',
              error: err instanceof Error ? err.message : 'Generation failed'
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
          'Cache-Control': 'no-cache'
        }
      });
    } else {
      // Non-streaming mode - parallel creation and polling with timing support
      const jobData = await Promise.all(
        normalizedPrompts.map(async (item, index) => {
          const jobId = await startImageJob(runpodApiKey, item.prompt, quality, aspectRatio);
          return { jobId, filename: item.filename, index };
        })
      );

      // Poll all in parallel
      const maxPollingTime = 5 * 60 * 1000;
      const pollInterval = 3000;
      const startTime = Date.now();
      const results: (string | null)[] = new Array(jobData.length).fill(null);
      const completed: boolean[] = new Array(jobData.length).fill(false);

      while (Date.now() - startTime < maxPollingTime) {
        const pendingIndices = completed.map((c, i) => c ? -1 : i).filter(i => i >= 0);

        if (pendingIndices.length === 0) break;

        const checks = await Promise.all(
          pendingIndices.map(async (i) => {
            const { jobId, filename } = jobData[i];
            const status = await checkJobStatus(runpodApiKey, jobId, supabaseUrl, supabaseKey, filename, projectId);
            return { index: i, status };
          })
        );

        for (const { index, status } of checks) {
          if (status.state === 'success' || status.state === 'fail') {
            completed[index] = true;
            results[index] = status.imageUrl || null;
          }
        }

        if (pendingIndices.length > 0) {
          await new Promise(resolve => setTimeout(resolve, pollInterval));
        }
      }

      const imageUrls = results.filter((url): url is string => url !== null);
      console.log(`Z-Image generated ${imageUrls.length} images`);

      return new Response(
        JSON.stringify({ success: true, images: imageUrls }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  } catch (error: unknown) {
    console.error('Error in generate-images:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
