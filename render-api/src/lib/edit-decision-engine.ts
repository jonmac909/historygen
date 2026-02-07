/**
 * Edit Decision Engine - Generate edit decisions using Claude + templates
 */

import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient } from './anthropic-client';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const anthropic = createAnthropicClient();

let supabase: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (!supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Supabase credentials not configured');
    supabase = createClient(url, key);
  }
  return supabase;
}

export interface VideoAnalysis {
  duration: number;
  scenes: SceneInfo[];
  transcript: TranscriptSegment[];
  keyMoments: KeyMoment[];
  audioBeats?: number[];
}

export interface SceneInfo {
  start: number;
  end: number;
  description: string;
}

export interface TranscriptSegment {
  text: string;
  start: number;
  end: number;
}

export interface KeyMoment {
  timestamp: number;
  type: 'hook' | 'highlight' | 'cta' | 'transition' | 'emphasis';
  description?: string;
}

export interface EditDecision {
  id: string;
  type: 'cut' | 'text' | 'broll' | 'transition' | 'effect';
  startFrame: number;
  endFrame: number;
  params: Record<string, any>;
  layer?: number;
}

export interface EditingTemplate {
  id: string;
  name: string;
  text_styles: any[];
  transitions: any;
  pacing: any;
  broll_patterns: any;
}

/**
 * Generate edit decisions using Claude AI
 */
export async function generateEditDecisions(
  videoAnalysis: VideoAnalysis,
  template: EditingTemplate,
  fps: number = 30
): Promise<EditDecision[]> {
  const prompt = buildEditDecisionPrompt(videoAnalysis, template, fps);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 16000,
    temperature: 0.7,
    system: EDIT_DECISION_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected response format from Claude');
  }

  // Parse JSON response
  const editDecisions = parseEditDecisions(content.text);
  return editDecisions;
}

/**
 * Build prompt for Claude
 */
function buildEditDecisionPrompt(
  analysis: VideoAnalysis,
  template: EditingTemplate,
  fps: number
): string {
  return `You are a professional video editor. Generate edit decisions for this video based on the provided template.

**Video Analysis:**
- Duration: ${analysis.duration} seconds (${analysis.duration * fps} frames @ ${fps} FPS)
- Scenes: ${analysis.scenes.length} scenes detected
- Transcript: ${analysis.transcript.length} segments
- Key Moments: ${analysis.keyMoments.length} highlights

**Scenes:**
${analysis.scenes.map((s, i) => `${i + 1}. ${s.start}s-${s.end}s: ${s.description}`).join('\n')}

**Transcript:**
${analysis.transcript.map((t) => `${t.start}s: "${t.text}"`).join('\n')}

**Key Moments:**
${analysis.keyMoments.map((k) => `${k.timestamp}s [${k.type}]: ${k.description || 'N/A'}`).join('\n')}

**Template Style:**
- Name: ${template.name}
- Text Styles: ${JSON.stringify(template.text_styles, null, 2)}
- Pacing: ${JSON.stringify(template.pacing, null, 2)}
- Transitions: ${JSON.stringify(template.transitions, null, 2)}

**Instructions:**
Generate edit decisions that apply this template's style to the raw video. Focus on:
1. Text overlays at key moments (introductions, highlights, CTAs)
2. Scene transitions matching the template's pacing
3. Emphasis on hook points (first 5 seconds)
4. Apply text styles from the template

Return a JSON array of edit decisions in this format:
[
  {
    "id": "1",
    "type": "text",
    "startFrame": 90,
    "endFrame": 270,
    "params": {
      "text": "Welcome to the video!",
      "style": {
        "font": "Arial Black, sans-serif",
        "size": 64,
        "color": "#ffffff",
        "position": "center",
        "animation": "fadeIn",
        "timing": { "inDuration": 15, "holdDuration": 150, "outDuration": 15 },
        "backgroundColor": "rgba(0, 0, 0, 0.8)",
        "padding": 30,
        "borderRadius": 12
      }
    },
    "layer": 10
  },
  {
    "id": "2",
    "type": "transition",
    "startFrame": 600,
    "endFrame": 620,
    "params": {
      "type": "fade"
    },
    "layer": 5
  }
]

Generate 5-10 text overlays and appropriate transitions. Return ONLY the JSON array, no other text.`;
}

const EDIT_DECISION_SYSTEM_PROMPT = `You are an expert video editor AI. Your job is to generate precise edit decisions (EDL - Edit Decision List) for programmatic video editing.

Key principles:
1. **Timing is critical** - All frame numbers must be accurate based on FPS
2. **Text placement** - Add text at key moments (hooks, highlights, CTAs)
3. **Style consistency** - Use the template's fonts, colors, and animations
4. **Pacing** - Match the template's energy level and cut frequency
5. **Layer management** - Higher layers render on top (text=10, effects=5, transitions=3)

Text overlay guidelines:
- Hook (0-5s): Bold, attention-grabbing title
- Mid-video: Supporting text, emphasis points
- End (last 10s): Call-to-action or summary

Return valid JSON only. No markdown, no explanations.`;

/**
 * Parse edit decisions from Claude's response
 */
function parseEditDecisions(text: string): EditDecision[] {
  try {
    // Remove markdown code blocks if present
    let jsonText = text.trim();
    if (jsonText.startsWith('```json')) {
      jsonText = jsonText.slice(7);
    }
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.slice(3);
    }
    if (jsonText.endsWith('```')) {
      jsonText = jsonText.slice(0, -3);
    }
    jsonText = jsonText.trim();

    const decisions = JSON.parse(jsonText);

    if (!Array.isArray(decisions)) {
      throw new Error('Expected array of edit decisions');
    }

    // Validate each decision
    decisions.forEach((d, i) => {
      if (!d.id) d.id = String(i + 1);
      if (!d.type) throw new Error(`Decision ${i} missing type`);
      if (d.startFrame === undefined) throw new Error(`Decision ${i} missing startFrame`);
      if (d.endFrame === undefined) throw new Error(`Decision ${i} missing endFrame`);
      if (!d.params) throw new Error(`Decision ${i} missing params`);
      if (d.layer === undefined) d.layer = d.type === 'text' ? 10 : 5;
    });

    return decisions;
  } catch (error: any) {
    console.error('Failed to parse edit decisions:', error);
    console.error('Raw text:', text);
    throw new Error(`Failed to parse edit decisions: ${error.message}`);
  }
}

/**
 * Save edit decisions to a project
 */
export async function saveEditDecisions(
  projectId: string,
  editDecisions: EditDecision[]
): Promise<void> {
  const supabase = getSupabase();

  const { error } = await supabase
    .from('editor_projects')
    .update({
      edit_decisions: editDecisions,
      updated_at: new Date().toISOString(),
    })
    .eq('id', projectId);

  if (error) throw error;
}
