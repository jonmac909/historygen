/**
 * SimplePreview - Basic Remotion preview component for testing
 */
import { Player } from '@remotion/player';
import { RemotionVideoProps } from '../types';
import { DynamicVideo } from '../remotion/DynamicVideo';

interface SimplePreviewProps {
  videoProps: RemotionVideoProps;
  width?: number;
  height?: number;
}

export function SimplePreview({ videoProps, width = 1280, height = 720 }: SimplePreviewProps) {
  return (
    <div className="w-full">
      <Player
        component={DynamicVideo}
        inputProps={videoProps}
        durationInFrames={videoProps.durationInFrames}
        fps={videoProps.fps}
        compositionWidth={videoProps.width}
        compositionHeight={videoProps.height}
        style={{
          width: '100%',
          maxWidth: `${width}px`,
          aspectRatio: `${videoProps.width}/${videoProps.height}`,
        }}
        controls
        loop
      />
    </div>
  );
}
