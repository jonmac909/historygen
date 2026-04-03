#!/bin/bash
# Test Ken Burns effect on a sample image
# This uses the same zoompan FFmpeg filter that will be used in render-video.ts

# Create temp directory
TEMP_DIR=$(mktemp -d)
echo "Working in: $TEMP_DIR"

# Download a sample historical image (public domain)
echo "Downloading sample image..."
curl -s -o "$TEMP_DIR/sample.jpg" "https://upload.wikimedia.org/wikipedia/commons/thumb/6/6a/Mona_Lisa.jpg/800px-Mona_Lisa.jpg"

# Ken Burns parameters (same as plan: 8% zoom for landscape)
# Alternates between zoom-in and zoom-out
DURATION=5  # 5 seconds per image
FPS=30
FRAMES=$((DURATION * FPS))

# Zoom IN effect (1.0 -> 1.08)
echo "Generating Ken Burns ZOOM IN (5 seconds)..."
ffmpeg -y -loop 1 -i "$TEMP_DIR/sample.jpg" -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,zoompan=z='if(lte(on,1),1.0,min(1.08,1.0+(0.08)*on/$FRAMES))':d=$FRAMES:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=$FPS" -t $DURATION -c:v libx264 -pix_fmt yuv420p "$TEMP_DIR/zoom_in.mp4" 2>/dev/null

# Zoom OUT effect (1.08 -> 1.0)
echo "Generating Ken Burns ZOOM OUT (5 seconds)..."
ffmpeg -y -loop 1 -i "$TEMP_DIR/sample.jpg" -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,zoompan=z='if(lte(on,1),1.08,max(1.0,1.08-(0.08)*on/$FRAMES))':d=$FRAMES:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=$FPS" -t $DURATION -c:v libx264 -pix_fmt yuv420p "$TEMP_DIR/zoom_out.mp4" 2>/dev/null

# Combine both into one demo
echo "Combining into demo video..."
echo "file 'zoom_in.mp4'" > "$TEMP_DIR/list.txt"
echo "file 'zoom_out.mp4'" >> "$TEMP_DIR/list.txt"
ffmpeg -y -f concat -safe 0 -i "$TEMP_DIR/list.txt" -c copy "$TEMP_DIR/ken_burns_demo.mp4" 2>/dev/null

# Copy to accessible location
OUTPUT_PATH="/Users/jacquelineyeung/AutoAiGen/history-gen-ai/render-api/scripts/ken_burns_demo.mp4"
cp "$TEMP_DIR/ken_burns_demo.mp4" "$OUTPUT_PATH"

echo ""
echo "=== Ken Burns Demo Generated ==="
echo "Output: $OUTPUT_PATH"
echo ""
echo "The video shows:"
echo "  - First 5 seconds: Slow ZOOM IN (1.0x -> 1.08x)"
echo "  - Next 5 seconds: Slow ZOOM OUT (1.08x -> 1.0x)"
echo ""
echo "This alternating pattern would be applied to each image in the documentary."
echo ""

# Cleanup
rm -rf "$TEMP_DIR"

# Open the video (macOS)
open "$OUTPUT_PATH"
