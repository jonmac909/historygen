/**
 * DynamicVideo - Main Remotion Composition
 * Data-driven video composition that renders based on edit decisions
 */
import { AbsoluteFill, Video, useVideoConfig, useCurrentFrame } from 'remotion';
import { RemotionVideoProps } from '../types';
import { TextOverlay } from './components/TextOverlay';
import { TransitionEffect } from './components/TransitionEffect';

export const DynamicVideo: React.FC<RemotionVideoProps> = ({
  rawVideoUrl,
  editDecisions,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Filter edit decisions that are active at current frame
  const activeTextDecisions = editDecisions.filter(
    (ed) =>
      ed.type === 'text' &&
      frame >= ed.startFrame &&
      frame <= ed.endFrame
  );

  const activeTransitions = editDecisions.filter(
    (ed) =>
      ed.type === 'transition' &&
      frame >= ed.startFrame &&
      frame <= ed.endFrame
  );

  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {/* Base video layer */}
      {rawVideoUrl && (
        <Video
          src={rawVideoUrl}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          startFrom={0}
        />
      )}

      {/* Text overlays */}
      {activeTextDecisions.map((decision) => (
        <TextOverlay
          key={decision.id}
          decision={decision}
          currentFrame={frame}
          fps={fps}
        />
      ))}

      {/* Transitions */}
      {activeTransitions.map((decision) => (
        <TransitionEffect
          key={decision.id}
          decision={decision}
          currentFrame={frame}
        />
      ))}
    </AbsoluteFill>
  );
};
