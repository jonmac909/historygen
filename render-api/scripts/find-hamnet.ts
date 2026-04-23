/**
 * Find Hamnet project and check for stored images
 * Run with: npx tsx scripts/find-hamnet.ts
 */

import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function findHamnet() {
  console.log('🔍 Searching for Hamnet projects...\n');

  // Search by title
  const { data: projects, error } = await supabase
    .from('generation_projects')
    .select('id, video_title, image_urls, created_at, updated_at, settings')
    .or('video_title.ilike.%hamnet%,video_title.ilike.%shakespeare%')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error:', error);
    return;
  }

  if (!projects || projects.length === 0) {
    console.log('No Hamnet/Shakespeare projects found in database.');
    return;
  }

  console.log(`Found ${projects.length} project(s):\n`);

  for (const project of projects) {
    console.log('━'.repeat(60));
    console.log(`📁 Project: ${project.video_title}`);
    console.log(`   ID: ${project.id}`);
    console.log(`   Created: ${project.created_at}`);
    console.log(`   Updated: ${project.updated_at}`);

    if (project.image_urls && project.image_urls.length > 0) {
      console.log(`   Images: ${project.image_urls.length} stored`);
      console.log(`   First image: ${project.image_urls[0]?.substring(0, 80)}...`);
    } else {
      console.log(`   Images: NONE stored in database`);
    }
    console.log('');
  }

  // Also check storage bucket for any hamnet-related files
  console.log('\n🗄️  Checking storage for hamnet-related files...\n');

  const { data: files, error: storageError } = await supabase
    .storage
    .from('project-files')
    .list('', { limit: 100, sortBy: { column: 'created_at', order: 'desc' } });

  if (storageError) {
    console.log('Storage error:', storageError.message);
    return;
  }

  // Look for folders that might contain hamnet images
  const projectFolders = files?.filter(f => f.id) || [];
  console.log(`Found ${projectFolders.length} project folders in storage.`);

  // Check first few project folders for images
  for (const folder of projectFolders.slice(0, 10)) {
    const { data: folderFiles } = await supabase
      .storage
      .from('project-files')
      .list(folder.name, { limit: 5 });

    if (folderFiles && folderFiles.length > 0) {
      console.log(`  📂 ${folder.name}: ${folderFiles.length} files`);
    }
  }
}

findHamnet().catch(console.error);
