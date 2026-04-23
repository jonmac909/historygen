/**
 * Template Extractor - Extract editing styles from example videos
 * Analyzes video to learn text styles, transitions, pacing, etc.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { preprocessVideo } from './video-preprocessor';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { randomUUID } from 'crypto';
import sharp from 'sharp';

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

export interface TemplateExtractionResult {
  templateId: string;
  textStyles: TextStyleAnalysis[];
  transitions: TransitionAnalysis;
  pacing: PacingAnalysis;
  brollPatterns: BRollAnalysis;
  colorPalette: string[];
}

export interface TextStyleAnalysis {
  id: string;
  name: string;
  font: string;
  size: number;
  color: string;
  position: string;
  animation: string;
  timing: { inDuration: number; holdDuration: number; outDuration: number };
  sampleText?: string;
}

export interface TransitionAnalysis {
  type: 'cut' | 'fade' | 'dissolve' | 'wipe';
  duration: number;
  frequency: number; // cuts per minute
}

export interface PacingAnalysis {
  avgSceneDuration: number;
  cutOnBeat: boolean;
  energyLevel: 'slow' | 'medium' | 'fast';
  totalScenes: number;
  totalDuration: number;
}

export interface BRollAnalysis {
  insertFrequency: number;
  duration: number;
  transitionIn: string;
  transitionOut: string;
}

/**
 * Extract editing template from an example video
 */
export async function extractTemplate(
  videoUrl: string,
  templateName: string,
  onProgress?: (progress: number, message: string) => void
): Promise<TemplateExtractionResult> {
  try {
    // Step 1: Preprocess video (download + frames + scenes) (0-60%)
    onProgress?.(0, 'Processing video...');
    
    const videoId = extractVideoId(videoUrl);
    const preprocessResult = await preprocessVideo(videoId, videoUrl, {
      uploadFrames: false,
      onDownloadProgress: (percent) => {
        onProgress?.(Math.round(percent * 0.4), 'Downloading video...');
      },
      onProgress: async (_status, percent, message) => {
        const normalizedPercent = Math.min(50, Math.max(40, percent));
        const overall = Math.round(40 + (normalizedPercent - 40) * 2);
        onProgress?.(overall, message || 'Processing video...');
      },
    });
    
    const { duration, scenes, framePaths } = preprocessResult;
    onProgress?.(60, `Processed ${framePaths.length} frames, ${scenes.length} scenes`);

    // Step 2: Analyze frames for text (60-70%)
    onProgress?.(60, 'Analyzing text overlays...');
    const frameAnalysis = await analyzeFramesForText(framePaths);
    onProgress?.(70, 'Text analysis complete');

    // Step 3: Color analysis (70-75%)
    onProgress?.(70, 'Analyzing color palette...');
    const colorPalette = await extractColorPalette(framePaths);
    onProgress?.(75, 'Color analysis complete');

    // Step 4: Calculate pacing metrics (75-85%)
    onProgress?.(75, 'Calculating pacing...');
    const pacing = calculatePacing(scenes, duration);
    const transitions = analyzeTransitions(scenes, duration);
    onProgress?.(85, 'Pacing analysis complete');

    // Step 5: Extract text styles (85-90%)
    onProgress?.(85, 'Extracting text styles...');
    const textStyles = extractTextStyles(frameAnalysis);
    onProgress?.(90, 'Text styles extracted');

    // Step 6: Estimate B-roll patterns (90-95%)
    onProgress?.(90, 'Analyzing B-roll patterns...');
    const brollPatterns = estimateBRollPatterns(scenes, duration);
    onProgress?.(95, 'B-roll analysis complete');

    // Step 7: Save to database (95-100%)
    onProgress?.(95, 'Saving template...');
    const templateId = await saveTemplate({
      name: templateName,
      source: videoUrl,
      textStyles,
      transitions,
      pacing,
      brollPatterns,
      colorPalette,
    });
    onProgress?.(100, 'Template saved!');

    return {
      templateId,
      textStyles,
      transitions,
      pacing,
      brollPatterns,
      colorPalette,
    };
  } catch (error: any) {
    console.error('Template extraction failed:', error);
    throw new Error(`Template extraction failed: ${error.message}`);
  }
}

/**
 * Extract YouTube video ID from URL
 */
function sanitizeVideoId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function extractVideoId(url: string): string {
  // Support various YouTube URL formats
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/,
    /youtube\.com\/embed\/([^&\n?#]+)/,
    /youtube\.com\/v\/([^&\n?#]+)/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return sanitizeVideoId(match[1]);
  }

  // If not a YouTube URL, use a hash of the URL as ID
  return sanitizeVideoId(Buffer.from(url).toString('base64').slice(0, 16));
}

/**
 * Analyze frames for text overlays (simplified - no LLaVA for now)
 */
async function analyzeFramesForText(framePaths: string[]): Promise<any[]> {
  // For now, return empty analysis
  // TODO: Integrate with LLaVA or other vision model
  return [];
}

/**
 * Calculate pacing metrics from scene detection
 */
function calculatePacing(scenes: any[], duration: number): PacingAnalysis {
  const totalScenes = scenes.length;
  const avgSceneDuration = duration / totalScenes;
  const cutsPerMinute = (totalScenes / duration) * 60;

  // Classify energy level based on cuts per minute
  let energyLevel: 'slow' | 'medium' | 'fast';
  if (cutsPerMinute < 3) energyLevel = 'slow';
  else if (cutsPerMinute < 5) energyLevel = 'medium';
  else energyLevel = 'fast';

  return {
    avgSceneDuration,
    cutOnBeat: false, // Would need audio analysis to detect
    energyLevel,
    totalScenes,
    totalDuration: duration,
  };
}

/**
 * Analyze transition patterns
 */
function analyzeTransitions(scenes: any[], duration: number): TransitionAnalysis {
  // For now, assume cuts (most common)
  // TODO: Detect fades by analyzing frame similarity at scene boundaries
  const cutsPerMinute = (scenes.length / duration) * 60;

  return {
    type: 'cut',
    duration: 0, // Cuts have no duration
    frequency: cutsPerMinute,
  };
}

/**
 * Extract text styles from LLaVA analysis results
 */
function extractTextStyles(frameAnalysis: any[]): TextStyleAnalysis[] {
  const textStyles: TextStyleAnalysis[] = [];

  // Filter frames that have text overlays
  const framesWithText = frameAnalysis.filter(
    (frame) => frame.description && !frame.description.toLowerCase().includes('no text')
  );

  if (framesWithText.length === 0) {
    // No text detected - return default style
    return [
      {
        id: '1',
        name: 'Default Text',
        font: 'Arial, sans-serif',
        size: 48,
        color: '#ffffff',
        position: 'center',
        animation: 'fadeIn',
        timing: { inDuration: 15, holdDuration: 60, outDuration: 15 },
      },
    ];
  }

  // TODO: Parse LLaVA descriptions to extract structured text style data
  // For now, create a generic style based on analysis
  textStyles.push({
    id: '1',
    name: 'Main Text',
    font: 'Arial, sans-serif', // Would parse from description
    size: 48,
    color: '#ffffff',
    position: 'center',
    animation: 'fadeIn',
    timing: { inDuration: 15, holdDuration: 60, outDuration: 15 },
    sampleText: framesWithText[0]?.description?.substring(0, 100),
  });

  return textStyles;
}

/**
 * Estimate B-roll patterns (this is heuristic-based)
 */
function estimateBRollPatterns(scenes: any[], duration: number): BRollAnalysis {
  // Default B-roll pattern estimates
  return {
    insertFrequency: 30, // Every 30 seconds
    duration: 5, // 5 second B-roll clips
    transitionIn: 'fade',
    transitionOut: 'fade',
  };
}

/**
 * Extract dominant color palette from frames
 */
async function extractColorPalette(framePaths: string[]): Promise<string[]> {
  if (framePaths.length === 0) return ['#000000'];

  try {
    // Sample a few frames for color analysis
    const samples = framePaths.filter((_, i) => i % 10 === 0).slice(0, 5);
    const palette = new Set<string>();

    for (const framePath of samples) {
      const { dominant } = await sharp(framePath)
        .stats();
      
      // Convert dominant color to hex
      const hex = `#${dominant.r.toString(16).padStart(2, '0')}${dominant.g.toString(16).padStart(2, '0')}${dominant.b.toString(16).padStart(2, '0')}`;
      palette.add(hex);
    }

    return Array.from(palette).slice(0, 10);
  } catch (error) {
    console.error('Color analysis failed:', error);
    return ['#000000'];
  }
}

/**
 * Save extracted template to Supabase
 */
async function saveTemplate(data: {
  name: string;
  source: string;
  textStyles: TextStyleAnalysis[];
  transitions: TransitionAnalysis;
  pacing: PacingAnalysis;
  brollPatterns: BRollAnalysis;
  colorPalette: string[];
}): Promise<string> {
  const supabase = getSupabase();

  const { data: template, error } = await supabase
    .from('editing_templates')
    .insert({
      name: data.name,
      source: data.source,
      description: `Auto-extracted from video. ${data.pacing.totalScenes} scenes, ${data.pacing.energyLevel} energy level`,
      text_styles: data.textStyles,
      transitions: data.transitions,
      pacing: data.pacing,
      broll_patterns: data.brollPatterns,
    })
    .select('id')
    .single();

  if (error) throw error;
  return template.id;
}
