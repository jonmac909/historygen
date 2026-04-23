/**
 * Remotion Root - Composition Registry
 */
import { Composition } from 'remotion';
import { DynamicVideo } from './DynamicVideo';
import { RemotionVideoProps } from '../types';

// Default composition settings
export const defaultProps: RemotionVideoProps = {
  rawVideoUrl: '',
  editDecisions: [],
  fps: 30,
  durationInFrames: 300, // 10 seconds at 30fps
  width: 1920,
  height: 1080,
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="DynamicVideo"
        component={DynamicVideo}
        durationInFrames={defaultProps.durationInFrames}
        fps={defaultProps.fps}
        width={defaultProps.width}
        height={defaultProps.height}
        defaultProps={defaultProps}
      />
    </>
  );
};
