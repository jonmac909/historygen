/**
 * Seed default editing templates into Supabase
 * Run with: npx tsx scripts/seed-editor-templates.ts
 */
import { createClient } from '@supabase/supabase-js';
import { defaultTemplates } from '../src/editor/lib/defaultTemplates.js';

// Read env vars directly (make sure to set them before running)
const supabaseUrl = process.env.VITE_SUPABASE_URL || 'https://udqfdeoullsxttqguupz.supabase.co';
const supabaseKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing Supabase credentials');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function seedTemplates() {
  console.log('🌱 Seeding default editing templates...\n');

  for (const template of defaultTemplates) {
    try {
      // Check if template already exists
      const { data: existing } = await supabase
        .from('editing_templates')
        .select('id')
        .eq('name', template.name)
        .single();

      if (existing) {
        console.log(`⏭️  Skipping "${template.name}" - already exists`);
        continue;
      }

      // Insert new template
      const { data, error } = await supabase
        .from('editing_templates')
        .insert({
          name: template.name,
          description: template.description,
          text_styles: template.textStyles,
          transitions: template.transitions,
          broll_patterns: template.brollPatterns,
          pacing: template.pacing,
        })
        .select()
        .single();

      if (error) throw error;

      console.log(`✅ Created template: "${template.name}"`);
    } catch (error: any) {
      console.error(`❌ Failed to create "${template.name}":`, error.message);
    }
  }

  console.log('\n✨ Seeding complete!');
}

seedTemplates();
