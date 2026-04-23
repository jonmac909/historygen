import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SUPADATA_API_URL = "https://api.supadata.ai/v1/youtube/transcript";

const RE_YOUTUBE = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;

function extractVideoId(urlOrId: string): string | null {
  if (urlOrId.length === 11 && /^[a-zA-Z0-9_-]+$/.test(urlOrId)) {
    return urlOrId;
  }
  const match = urlOrId.match(RE_YOUTUBE);
  return match ? match[1] : null;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { url, lang } = await req.json();

    if (!url) {
      return new Response(
        JSON.stringify({ success: false, error: 'URL is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid YouTube URL' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`=== Fetching transcript for video: ${videoId} via Supadata ===`);

    const apiKey = Deno.env.get('SUPADATA_API_KEY');
    if (!apiKey) {
      throw new Error('SUPADATA_API_KEY is not configured');
    }

    // Build request URL with parameters
    const requestUrl = new URL(SUPADATA_API_URL);
    requestUrl.searchParams.set('videoId', videoId);
    if (lang) {
      requestUrl.searchParams.set('lang', lang);
    }

    console.log(`Calling Supadata API...`);

    const response = await fetch(requestUrl.toString(), {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Supadata API error: ${response.status} - ${errorText}`);
      
      if (response.status === 404) {
        throw new Error('No transcript available for this video');
      }
      if (response.status === 401) {
        throw new Error('Invalid Supadata API key');
      }
      if (response.status === 429) {
        throw new Error('API rate limit exceeded. Please try again later.');
      }
      
      throw new Error(`Supadata API error: ${response.status}`);
    }

    const data = await response.json();
    console.log(`Supadata response received`);

    // Supadata returns content array with text segments
    if (!data.content || !Array.isArray(data.content)) {
      console.error('Unexpected response format:', JSON.stringify(data).substring(0, 200));
      throw new Error('Unexpected response format from Supadata');
    }

    // Combine all text segments
    const transcript = data.content.map((segment: any) => segment.text).join(' ');
    const language = data.lang || lang || 'en';
    
    // Try to get the video title (Supadata may include it)
    const title = data.title || 'Unknown Title';

    console.log(`=== Success: ${transcript.length} chars, language: ${language} ===`);

    return new Response(
      JSON.stringify({
        success: true,
        videoId,
        title,
        transcript,
        language,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error:', error);
    
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    
    return new Response(
      JSON.stringify({ 
        success: false, 
        videoId: '', 
        title: '', 
        transcript: null, 
        error: errorMessage 
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
