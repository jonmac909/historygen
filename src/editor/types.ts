/**
 * Video Editor Type Definitions
 */

export interface EditingTemplate {
  id: string;
  name: string;
  description?: string;
  source?: string; // Example video URL
  created_at: string;
  updated_at: string;

  textStyles: TextStyle[];
  transitions: TransitionStyle;
  brollPatterns: BRollPattern;
  pacing: PacingStyle;
}

export interface TextStyle {
  id: string;
  name: string;
  font: string;
  size: number;
  color: string;
  position: 'center' | 'lowerThird' | 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight' | 'custom';
  customPosition?: { x: number; y: number };
  animation: 'fadeIn' | 'typewriter' | 'slideUp' | 'slideDown' | 'slideLeft' | 'slideRight' | 'bounce' | 'scale' | 'none';
  timing: {
    inDuration: number; // frames
    holdDuration: number; // frames
    outDuration: number; // frames
  };
  fontWeight?: 'normal' | 'bold' | 'light';
  textAlign?: 'left' | 'center' | 'right';
  backgroundColor?: string;
  padding?: number;
  borderRadius?: number;
}

export interface TransitionStyle {
  type: 'cut' | 'fade' | 'dissolve' | 'wipe' | 'slide' | 'zoom';
  duration: number; // frames
  frequency: number; // Average cuts per minute
}

export interface BRollPattern {
  insertFrequency: number; // Seconds between B-roll
  duration: number; // Typical B-roll clip length (seconds)
  transitionIn: string;
  transitionOut: string;
}

export interface PacingStyle {
  avgSceneDuration: number; // seconds
  cutOnBeat: boolean;
  energyLevel: 'slow' | 'medium' | 'fast';
}

export interface VideoAnalysis {
  id: string;
  video_url: string;
  duration: number;
  scenes: SceneInfo[];
  transcript: TranscriptSegment[];
  keyMoments: KeyMoment[];
  audioBeats: number[]; // Timestamps for beat-sync cuts
  created_at: string;
}

export interface SceneInfo {
  start: number; // seconds
  end: number; // seconds
  description: string;
  thumbnailUrl?: string;
}

export interface TranscriptSegment {
  text: string;
  start: number; // seconds
  end: number; // seconds
  confidence?: number;
}

export interface KeyMoment {
  timestamp: number; // seconds
  type: 'hook' | 'highlight' | 'cta' | 'transition' | 'emphasis';
  description?: string;
}

export interface EditDecision {
  id: string;
  type: 'cut' | 'text' | 'broll' | 'transition' | 'effect';
  startFrame: number;
  endFrame: number;
  params: Record<string, any>; // Template-specific params
  layer?: number; // Render layer (higher = on top)
}

export interface EditorProject {
  id: string;
  name: string;
  raw_video_url: string;
  template_id?: string;
  analysis?: VideoAnalysis;
  edit_decisions: EditDecision[];
  rendered_video_url?: string;
  created_at: string;
  updated_at: string;
}

export interface RemotionVideoProps {
  rawVideoUrl: string;
  editDecisions: EditDecision[];
  fps: number;
  durationInFrames: number;
  width: number;
  height: number;
}
