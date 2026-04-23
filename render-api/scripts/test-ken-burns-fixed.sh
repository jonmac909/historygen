#!/bin/bash
# Test Ken Burns effects with FIXED parameters

TEMP_DIR=$(mktemp -d)
echo "Working in: $TEMP_DIR"

# Download a sample image
echo "Downloading sample image..."
curl -s -o "$TEMP_DIR/sample.jpg" "https://upload.wikimedia.org/wikipedia/commons/thumb/6/6a/Mona_Lisa.jpg/800px-Mona_Lisa.jpg"

DURATION=5  # 5 seconds per effect
FRAMES=$((DURATION * 30))  # 150 frames

# Calculate 12% zoom over duration (matching fixed code)
TOTAL_ZOOM=0.12
ZOOM_INCREMENT=$(echo "scale=6; $TOTAL_ZOOM / $FRAMES" | bc)
END_ZOOM=$(echo "1 + $TOTAL_ZOOM" | bc)

echo "Zoom params: increment=$ZOOM_INCREMENT, end=$END_ZOOM, frames=$FRAMES"

# === ZOOM IN ===
echo "Generating ZOOM IN (12% over 5 seconds)..."
ffmpeg -y -loop 1 -i "$TEMP_DIR/sample.jpg" \
  -vf "scale=8000:-1,zoompan=z='zoom+$ZOOM_INCREMENT':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=$FRAMES:s=1920x1080:fps=30" \
  -t $DURATION -c:v libx264 -pix_fmt yuv420p "$TEMP_DIR/zoom_in.mp4" 2>/dev/null

# === ZOOM OUT ===
echo "Generating ZOOM OUT (1.12 → 1.0 over 5 seconds)..."
ffmpeg -y -loop 1 -i "$TEMP_DIR/sample.jpg" \
  -vf "scale=8000:-1,zoompan=z='$END_ZOOM-$ZOOM_INCREMENT*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=$FRAMES:s=1920x1080:fps=30" \
  -t $DURATION -c:v libx264 -pix_fmt yuv420p "$TEMP_DIR/zoom_out.mp4" 2>/dev/null

# === PAN LEFT TO RIGHT ===
echo "Generating PAN L→R (5 seconds)..."
ffmpeg -y -loop 1 -i "$TEMP_DIR/sample.jpg" \
  -vf "scale=2500:-1,crop=1920:1080:'(in_w-1920)*t/$DURATION':0" \
  -t $DURATION -c:v libx264 -r 30 -pix_fmt yuv420p "$TEMP_DIR/pan_lr.mp4" 2>/dev/null

# === PAN RIGHT TO LEFT ===
echo "Generating PAN R→L (5 seconds)..."
ffmpeg -y -loop 1 -i "$TEMP_DIR/sample.jpg" \
  -vf "scale=2500:-1,crop=1920:1080:'(in_w-1920)*(1-t/$DURATION)':0" \
  -t $DURATION -c:v libx264 -r 30 -pix_fmt yuv420p "$TEMP_DIR/pan_rl.mp4" 2>/dev/null

# Copy outputs
OUTPUT_DIR="/Users/jacquelineyeung/AutoAiGen/history-gen-ai/render-api/scripts"
cp "$TEMP_DIR/zoom_in.mp4" "$OUTPUT_DIR/test_zoom_in.mp4"
cp "$TEMP_DIR/zoom_out.mp4" "$OUTPUT_DIR/test_zoom_out.mp4"
cp "$TEMP_DIR/pan_lr.mp4" "$OUTPUT_DIR/test_pan_lr.mp4"
cp "$TEMP_DIR/pan_rl.mp4" "$OUTPUT_DIR/test_pan_rl.mp4"

echo ""
echo "=== Test Videos Generated ==="
echo "Zoom IN:  $OUTPUT_DIR/test_zoom_in.mp4"
echo "Zoom OUT: $OUTPUT_DIR/test_zoom_out.mp4"
echo "Pan L→R:  $OUTPUT_DIR/test_pan_lr.mp4"
echo "Pan R→L:  $OUTPUT_DIR/test_pan_rl.mp4"

# Cleanup
rm -rf "$TEMP_DIR"

# Open the zoom and pan examples
open "$OUTPUT_DIR/test_zoom_in.mp4"
sleep 1
open "$OUTPUT_DIR/test_pan_lr.mp4"
