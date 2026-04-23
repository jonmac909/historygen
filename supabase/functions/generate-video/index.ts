import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Helper function to safely get Supabase credentials
function getSupabaseCredentials(): { url: string; key: string } | null {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!url || !key) {
    console.error('Supabase credentials not configured');
    return null;
  }

  return { url, key };
}

interface CaptionSegment {
  index: number;
  startTime: number;
  endTime: number;
  text: string;
}

// Parse SRT content into segments
function parseSRT(srtContent: string): CaptionSegment[] {
  const segments: CaptionSegment[] = [];
  const blocks = srtContent.trim().split(/\n\s*\n/);
  
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length >= 3) {
      const index = parseInt(lines[0], 10);
      const timeMatch = lines[1].match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
      
      if (timeMatch) {
        const startTime = 
          parseInt(timeMatch[1]) * 3600 + 
          parseInt(timeMatch[2]) * 60 + 
          parseInt(timeMatch[3]) + 
          parseInt(timeMatch[4]) / 1000;
        
        const endTime = 
          parseInt(timeMatch[5]) * 3600 + 
          parseInt(timeMatch[6]) * 60 + 
          parseInt(timeMatch[7]) + 
          parseInt(timeMatch[8]) / 1000;
        
        const text = lines.slice(2).join(' ');
        
        segments.push({ index, startTime, endTime, text });
      }
    }
  }
  
  return segments;
}

// Calculate image timings based on caption segments and image count
function calculateImageTimings(segments: CaptionSegment[], imageCount: number): { startTime: number; endTime: number; duration: number }[] {
  if (segments.length === 0) return [];
  
  const totalDuration = segments[segments.length - 1].endTime;
  const segmentDuration = totalDuration / imageCount;
  
  const timings: { startTime: number; endTime: number; duration: number }[] = [];
  
  for (let i = 0; i < imageCount; i++) {
    const startTime = i * segmentDuration;
    const endTime = (i + 1) * segmentDuration;
    timings.push({
      startTime,
      endTime,
      duration: endTime - startTime
    });
  }
  
  return timings;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { imageUrls, srtContent, projectId } = await req.json();
    
    if (!imageUrls || !Array.isArray(imageUrls) || imageUrls.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No images provided' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    if (!srtContent) {
      return new Response(
        JSON.stringify({ error: 'No SRT content provided' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Processing ${imageUrls.length} images with captions`);
    
    // Parse SRT and calculate timings
    const segments = parseSRT(srtContent);
    const timings = calculateImageTimings(segments, imageUrls.length);
    
    console.log(`Parsed ${segments.length} caption segments`);
    console.log(`Calculated ${timings.length} image timings`);
    
    // Create video segments data - this is metadata for the client
    // Actual video generation would require FFmpeg or a video API
    // For now, we return the timing data so client can use it with a video editor
    const videoSegments = imageUrls.map((url, index) => ({
      imageUrl: url,
      index: index + 1,
      startTime: timings[index]?.startTime || 0,
      endTime: timings[index]?.endTime || 0,
      duration: timings[index]?.duration || 0,
      startTimeFormatted: formatTime(timings[index]?.startTime || 0),
      endTimeFormatted: formatTime(timings[index]?.endTime || 0),
      durationFormatted: formatDuration(timings[index]?.duration || 0)
    }));

    // Generate EDL (Edit Decision List) for video editors
    const edlContent = generateEDL(videoSegments);
    
    // Generate CSV for easy import
    const csvContent = generateCSV(videoSegments);
    
    // Upload EDL and CSV to storage
    const credentials = getSupabaseCredentials();
    if (!credentials) {
      return new Response(
        JSON.stringify({ error: 'Supabase credentials not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(credentials.url, credentials.key);
    
    const edlFileName = `${projectId || crypto.randomUUID()}/timeline.edl`;
    const csvFileName = `${projectId || crypto.randomUUID()}/timeline.csv`;
    
    const [edlUpload, csvUpload] = await Promise.all([
      supabase.storage.from('generated-assets').upload(edlFileName, edlContent, {
        contentType: 'text/plain',
        upsert: true
      }),
      supabase.storage.from('generated-assets').upload(csvFileName, csvContent, {
        contentType: 'text/csv',
        upsert: true
      })
    ]);

    const edlUrl = edlUpload.error ? null : 
      supabase.storage.from('generated-assets').getPublicUrl(edlFileName).data.publicUrl;
    const csvUrl = csvUpload.error ? null : 
      supabase.storage.from('generated-assets').getPublicUrl(csvFileName).data.publicUrl;

    return new Response(
      JSON.stringify({ 
        success: true,
        segments: videoSegments,
        edlUrl,
        edlContent,
        csvUrl,
        csvContent,
        totalDuration: segments[segments.length - 1]?.endTime || 0,
        totalDurationFormatted: formatTime(segments[segments.length - 1]?.endTime || 0)
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Video generation error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Video generation failed' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

function formatTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const frames = Math.floor((seconds % 1) * 30); // Assuming 30fps
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(1);
  return `${mins}m ${secs}s`;
}

function generateEDL(segments: { imageUrl: string; index: number; startTime: number; endTime: number; duration: number }[]): string {
  let edl = 'TITLE: Generated Video Timeline\n';
  edl += 'FCM: NON-DROP FRAME\n\n';
  
  segments.forEach((seg, i) => {
    const editNum = (i + 1).toString().padStart(3, '0');
    edl += `${editNum}  AX       V     C        ${formatTime(seg.startTime)} ${formatTime(seg.endTime)} ${formatTime(seg.startTime)} ${formatTime(seg.endTime)}\n`;
    edl += `* FROM CLIP NAME: Image_${seg.index}.png\n`;
    edl += `* SOURCE FILE: ${seg.imageUrl}\n\n`;
  });
  
  return edl;
}

function generateCSV(segments: { imageUrl: string; index: number; startTimeFormatted: string; endTimeFormatted: string; durationFormatted: string; duration: number }[]): string {
  let csv = 'Index,Image URL,Start Time,End Time,Duration (seconds),Duration (formatted)\n';
  
  segments.forEach(seg => {
    csv += `${seg.index},"${seg.imageUrl}",${seg.startTimeFormatted},${seg.endTimeFormatted},${seg.duration.toFixed(2)},${seg.durationFormatted}\n`;
  });
  
  return csv;
}
