import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { imageUrl } = await req.json();

    if (!imageUrl) {
      return new Response(
        JSON.stringify({ error: "No image URL provided" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // SECURITY: Validate URL to prevent SSRF attacks
    // Only allow Supabase storage URLs
    const allowedDomains = [
      'supabase.co',
      'supabase.com',
      // Add your specific Supabase project domain
      'udqfdeoullsxttqguupz.supabase.co'
    ];

    let url;
    try {
      url = new URL(imageUrl);
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid URL format" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const isAllowed = allowedDomains.some(domain =>
      url.hostname.endsWith(domain) || url.hostname === domain
    );

    if (!isAllowed) {
      return new Response(
        JSON.stringify({ error: "URL domain not allowed. Only Supabase storage URLs are permitted." }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("Fetching image:", imageUrl);

    // Fetch the single image
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    
    // Return the image as binary
    return new Response(arrayBuffer, {
      headers: {
        ...corsHeaders,
        "Content-Type": response.headers.get("Content-Type") || "image/png",
      }
    });
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
