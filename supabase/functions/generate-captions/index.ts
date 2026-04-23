import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
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

// WAV file constants
const SAMPLE_RATE = 44100;
const BITS_PER_SAMPLE = 16;
const NUM_CHANNELS = 1;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;
const BYTES_PER_SECOND = SAMPLE_RATE * NUM_CHANNELS * BYTES_PER_SAMPLE;

// Whisper API has 25MB limit, we'll use 20MB chunks to be safe
const MAX_CHUNK_BYTES = 20 * 1024 * 1024;
const MAX_CHUNK_DURATION = Math.floor(MAX_CHUNK_BYTES / BYTES_PER_SECOND); // ~227 seconds

// Format time for SRT (HH:MM:SS,mmm)
function formatSrtTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
}

// Split segment text into smaller chunks while preserving punctuation
function splitSegmentIntoChunks(segment: { text: string; start: number; end: number }, maxWords: number = 8): { text: string; start: number; end: number }[] {
  const words = segment.text.split(/\s+/).filter(w => w.length > 0);
  if (words.length <= maxWords) {
    return [segment];
  }
  
  const chunks: { text: string; start: number; end: number }[] = [];
  const totalDuration = segment.end - segment.start;
  const durationPerWord = totalDuration / words.length;
  
  for (let i = 0; i < words.length; i += maxWords) {
    const chunkWords = words.slice(i, i + maxWords);
    chunks.push({
      text: chunkWords.join(' '),
      start: segment.start + (i * durationPerWord),
      end: segment.start + ((i + chunkWords.length) * durationPerWord),
    });
  }
  
  return chunks;
}

// Create a WAV header for a chunk of PCM data
function createWavHeader(dataSize: number): Uint8Array {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  
  // "RIFF" chunk descriptor
  view.setUint8(0, 0x52); // R
  view.setUint8(1, 0x49); // I
  view.setUint8(2, 0x46); // F
  view.setUint8(3, 0x46); // F
  view.setUint32(4, 36 + dataSize, true); // File size - 8
  view.setUint8(8, 0x57);  // W
  view.setUint8(9, 0x41);  // A
  view.setUint8(10, 0x56); // V
  view.setUint8(11, 0x45); // E
  
  // "fmt " sub-chunk
  view.setUint8(12, 0x66); // f
  view.setUint8(13, 0x6d); // m
  view.setUint8(14, 0x74); // t
  view.setUint8(15, 0x20); // (space)
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true);  // AudioFormat (1 for PCM)
  view.setUint16(22, NUM_CHANNELS, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, BYTES_PER_SECOND, true); // ByteRate
  view.setUint16(32, NUM_CHANNELS * BYTES_PER_SAMPLE, true); // BlockAlign
  view.setUint16(34, BITS_PER_SAMPLE, true);
  
  // "data" sub-chunk
  view.setUint8(36, 0x64); // d
  view.setUint8(37, 0x61); // a
  view.setUint8(38, 0x74); // t
  view.setUint8(39, 0x61); // a
  view.setUint32(40, dataSize, true);
  
  return new Uint8Array(header);
}

// Extract PCM data from WAV file (skip header)
function extractPcmFromWav(wavData: Uint8Array): Uint8Array {
  // WAV header is 44 bytes
  return wavData.slice(44);
}

// Create a WAV file from PCM data
function createWavFromPcm(pcmData: Uint8Array): Uint8Array {
  const header = createWavHeader(pcmData.length);
  const wavData = new Uint8Array(header.length + pcmData.length);
  wavData.set(header, 0);
  wavData.set(pcmData, header.length);
  return wavData;
}

// Transcribe a single audio chunk
async function transcribeChunk(audioData: Uint8Array, openaiApiKey: string, chunkIndex: number): Promise<{ segments: Array<{ text: string; start: number; end: number }>; duration: number }> {
  const formData = new FormData();
  formData.append('file', new Blob([audioData.buffer as ArrayBuffer], { type: 'audio/wav' }), 'audio.wav');
  formData.append('model', 'whisper-1');
  formData.append('response_format', 'verbose_json');
  formData.append('timestamp_granularities[]', 'segment');

  console.log(`Transcribing chunk ${chunkIndex + 1}, size: ${audioData.length} bytes`);
  
  const whisperResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openaiApiKey}`,
    },
    body: formData,
  });

  if (!whisperResponse.ok) {
    const errorText = await whisperResponse.text();
    console.error('Whisper API error:', whisperResponse.status, errorText);
    throw new Error(`Whisper API error: ${whisperResponse.status}`);
  }

  const result = await whisperResponse.json();
  console.log(`Chunk ${chunkIndex + 1} transcribed, duration: ${result.duration}s, segments: ${result.segments?.length || 0}`);
  
  return {
    segments: result.segments || [],
    duration: result.duration || 0,
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { audioUrl, projectId } = await req.json();
    
    if (!audioUrl) {
      return new Response(
        JSON.stringify({ error: 'Audio URL is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const openaiApiKey = Deno.env.get('OPENAI_API_KEY');
    if (!openaiApiKey) {
      return new Response(
        JSON.stringify({ error: 'OPENAI_API_KEY is not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('Fetching audio from:', audioUrl);
    
    // Download the audio file
    const audioResponse = await fetch(audioUrl);
    if (!audioResponse.ok) {
      throw new Error(`Failed to fetch audio: ${audioResponse.status}`);
    }
    const audioArrayBuffer = await audioResponse.arrayBuffer();
    const audioData = new Uint8Array(audioArrayBuffer);
    console.log('Audio size:', audioData.length, 'bytes');

    // Extract PCM data from WAV
    const pcmData = extractPcmFromWav(audioData);
    const totalDuration = pcmData.length / BYTES_PER_SECOND;
    console.log('Total audio duration:', totalDuration, 's');

    // Calculate chunk size in bytes (based on duration)
    const chunkSizeBytes = MAX_CHUNK_DURATION * BYTES_PER_SECOND;
    const numChunks = Math.ceil(pcmData.length / chunkSizeBytes);
    console.log(`Splitting into ${numChunks} chunks of ~${MAX_CHUNK_DURATION}s each`);

    // Process each chunk and collect segments
    const allSegments: Array<{ text: string; start: number; end: number }> = [];
    let timeOffset = 0;

    for (let i = 0; i < numChunks; i++) {
      const startByte = i * chunkSizeBytes;
      const endByte = Math.min((i + 1) * chunkSizeBytes, pcmData.length);
      const chunkPcm = pcmData.slice(startByte, endByte);
      
      // Create WAV from chunk PCM
      const chunkWav = createWavFromPcm(chunkPcm);
      
      // Transcribe the chunk
      const { segments, duration } = await transcribeChunk(chunkWav, openaiApiKey, i);
      
      // Adjust timestamps and add to all segments
      for (const seg of segments) {
        allSegments.push({
          text: seg.text.trim(),
          start: seg.start + timeOffset,
          end: seg.end + timeOffset,
        });
      }
      
      // Update time offset for next chunk
      timeOffset += duration;
    }

    console.log('Total segments from all chunks:', allSegments.length);

    // Split segments into smaller chunks for captions
    const allChunks: { text: string; start: number; end: number }[] = [];
    for (const seg of allSegments) {
      const chunks = splitSegmentIntoChunks(seg, 8);
      allChunks.push(...chunks);
    }
    console.log('Generated', allChunks.length, 'caption segments');

    // Generate SRT content
    let srtContent = '';
    allChunks.forEach((segment: { text: string; start: number; end: number }, index: number) => {
      srtContent += `${index + 1}\n`;
      srtContent += `${formatSrtTime(segment.start)} --> ${formatSrtTime(segment.end)}\n`;
      srtContent += `${segment.text}\n\n`;
    });

    // Upload to Supabase Storage
    const credentials = getSupabaseCredentials();
    if (!credentials) {
      return new Response(
        JSON.stringify({ error: 'Supabase credentials not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(credentials.url, credentials.key);

    const fileName = `${projectId || crypto.randomUUID()}/captions.srt`;
    
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('generated-assets')
      .upload(fileName, new TextEncoder().encode(srtContent), {
        contentType: 'text/plain',
        upsert: true,
      });

    if (uploadError) {
      console.error('Upload error:', uploadError);
      return new Response(
        JSON.stringify({ error: 'Failed to upload captions file' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { data: urlData } = supabase.storage
      .from('generated-assets')
      .getPublicUrl(fileName);

    console.log('Captions uploaded successfully:', urlData.publicUrl);

    return new Response(
      JSON.stringify({ 
        success: true,
        captionsUrl: urlData.publicUrl,
        srtContent,
        segmentCount: allChunks.length,
        audioDuration: totalDuration,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error generating captions:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to generate captions' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
