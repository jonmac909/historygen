/**
 * TextOverlay - Animated text component
 */
import { AbsoluteFill, interpolate, spring } from 'remotion';
import { EditDecision } from '../../types';

interface TextOverlayProps {
  decision: EditDecision;
  currentFrame: number;
  fps: number;
}

export const TextOverlay: React.FC<TextOverlayProps> = ({
  decision,
  currentFrame,
  fps,
}) => {
  const { text, style } = decision.params as {
    text: string;
    style: {
      font?: string;
      size?: number;
      color?: string;
      position?: string;
      animation?: string;
      timing?: { inDuration: number; holdDuration: number; outDuration: number };
      fontWeight?: string;
      textAlign?: string;
      backgroundColor?: string;
      padding?: number;
      borderRadius?: number;
    };
  };

  const relativeFrame = currentFrame - decision.startFrame;
  const totalFrames = decision.endFrame - decision.startFrame;

  // Default timings
  const inDuration = style.timing?.inDuration || 15;
  const outDuration = style.timing?.outDuration || 15;

  // Animation progress
  let opacity = 1;
  let translateY = 0;
  let translateX = 0;
  let scale = 1;

  // In animation
  if (relativeFrame < inDuration) {
    switch (style.animation) {
      case 'fadeIn':
        opacity = interpolate(relativeFrame, [0, inDuration], [0, 1]);
        break;
      case 'slideUp':
        opacity = interpolate(relativeFrame, [0, inDuration], [0, 1]);
        translateY = interpolate(relativeFrame, [0, inDuration], [50, 0]);
        break;
      case 'slideDown':
        opacity = interpolate(relativeFrame, [0, inDuration], [0, 1]);
        translateY = interpolate(relativeFrame, [0, inDuration], [-50, 0]);
        break;
      case 'slideLeft':
        opacity = interpolate(relativeFrame, [0, inDuration], [0, 1]);
        translateX = interpolate(relativeFrame, [0, inDuration], [100, 0]);
        break;
      case 'slideRight':
        opacity = interpolate(relativeFrame, [0, inDuration], [0, 1]);
        translateX = interpolate(relativeFrame, [0, inDuration], [-100, 0]);
        break;
      case 'bounce':
        {
          opacity = interpolate(relativeFrame, [0, inDuration], [0, 1]);
          const bounceProgress = spring({
            frame: relativeFrame,
            fps,
            config: { damping: 8, stiffness: 200 },
          });
          scale = 0.8 + bounceProgress * 0.2;
          break;
        }
      case 'scale':
        opacity = interpolate(relativeFrame, [0, inDuration], [0, 1]);
        scale = interpolate(relativeFrame, [0, inDuration], [0.5, 1]);
        break;
      case 'typewriter':
        // For typewriter, we'll handle this differently
        opacity = 1;
        break;
      default:
        opacity = 1;
    }
  }
  // Out animation
  else if (relativeFrame > totalFrames - outDuration) {
    const outProgress = relativeFrame - (totalFrames - outDuration);
    opacity = interpolate(outProgress, [0, outDuration], [1, 0]);
  }

  // Position
  let justifyContent = 'center';
  let alignItems = 'center';

  switch (style.position) {
    case 'topLeft':
      justifyContent = 'flex-start';
      alignItems = 'flex-start';
      break;
    case 'topRight':
      justifyContent = 'flex-start';
      alignItems = 'flex-end';
      break;
    case 'bottomLeft':
      justifyContent = 'flex-end';
      alignItems = 'flex-start';
      break;
    case 'bottomRight':
      justifyContent = 'flex-end';
      alignItems = 'flex-end';
      break;
    case 'lowerThird':
      justifyContent = 'flex-end';
      alignItems = 'flex-start';
      break;
  }

  // Typewriter effect
  let displayText = text;
  if (style.animation === 'typewriter' && relativeFrame < inDuration) {
    const charsToShow = Math.floor(
      interpolate(relativeFrame, [0, inDuration], [0, text.length])
    );
    displayText = text.slice(0, charsToShow);
  }

  return (
    <AbsoluteFill
      style={{
        display: 'flex',
        justifyContent,
        alignItems,
        padding: 40,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          fontFamily: style.font || 'Arial, sans-serif',
          fontSize: style.size || 48,
          color: style.color || 'white',
          fontWeight: style.fontWeight || 'bold',
          textAlign: (style.textAlign as any) || 'center',
          backgroundColor: style.backgroundColor || 'rgba(0, 0, 0, 0.7)',
          padding: style.padding || 20,
          borderRadius: style.borderRadius || 8,
          opacity,
          transform: `translateY(${translateY}px) translateX(${translateX}px) scale(${scale})`,
          maxWidth: '80%',
          textShadow: '2px 2px 4px rgba(0, 0, 0, 0.8)',
        }}
      >
        {displayText}
      </div>
    </AbsoluteFill>
  );
};
