/**
 * TransitionEffect - Scene transition effects
 */
import { AbsoluteFill, interpolate } from 'remotion';
import { EditDecision } from '../../types';

interface TransitionEffectProps {
  decision: EditDecision;
  currentFrame: number;
}

export const TransitionEffect: React.FC<TransitionEffectProps> = ({
  decision,
  currentFrame,
}) => {
  const { type } = decision.params as { type: string };
  const relativeFrame = currentFrame - decision.startFrame;
  const totalFrames = decision.endFrame - decision.startFrame;
  const progress = relativeFrame / totalFrames;

  // Fade transition
  if (type === 'fade') {
    const opacity = interpolate(progress, [0, 1], [0, 1]);
    return (
      <AbsoluteFill
        style={{
          backgroundColor: 'black',
          opacity,
        }}
      />
    );
  }

  // Wipe transition
  if (type === 'wipe') {
    const wipeProgress = interpolate(progress, [0, 1], [0, 100]);
    return (
      <AbsoluteFill
        style={{
          background: `linear-gradient(to right, black ${wipeProgress}%, transparent ${wipeProgress}%)`,
        }}
      />
    );
  }

  // Slide transition
  if (type === 'slide') {
    const slideX = interpolate(progress, [0, 1], [-100, 0]);
    return (
      <AbsoluteFill
        style={{
          backgroundColor: 'black',
          transform: `translateX(${slideX}%)`,
        }}
      />
    );
  }

  return null;
};
