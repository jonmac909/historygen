require('dotenv').config();
const { createClient } = require("@supabase/supabase-js");

async function main() {
  const supabase = createClient(
    "https://udqfdeoullsxttqguupz.supabase.co",
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // List all folders in generated-assets bucket
  const { data: folders, error: foldersError } = await supabase.storage
    .from("generated-assets")
    .list("", { limit: 100 });

  if (foldersError) {
    console.error("Error listing folders:", foldersError);
    return;
  }

  console.log("Found", folders.length, "project folders");

  // Find folders with clips
  for (const folder of folders) {
    if (!folder.id) continue; // Skip files

    const { data: clipFiles } = await supabase.storage
      .from("generated-assets")
      .list(folder.name + "/clips", { limit: 20 });

    if (clipFiles && clipFiles.length > 0) {
      const mp4s = clipFiles.filter(f => f.name.endsWith(".mp4"));
      if (mp4s.length > 0) {
        console.log("\nProject:", folder.name, "has", mp4s.length, "clips");
        for (const clip of mp4s.sort((a,b) => a.name.localeCompare(b.name))) {
          const { data } = supabase.storage.from("generated-assets").getPublicUrl(folder.name + "/clips/" + clip.name);
          console.log("CLIP_URL=" + data.publicUrl);
        }
      }
    }
  }
}

main();
