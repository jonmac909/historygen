#!/bin/bash
# Test 30-second Ken Burns effects (zoom and pan)

set -e
cd /Users/jacquelineyeung/AutoAiGen/history-gen-ai/render-api/scripts

# Use the existing test image or download one
if [ ! -f /tmp/test_img.jpg ]; then
  curl -s -o /tmp/test_img.jpg "https://upload.wikimedia.org/wikipedia/commons/thumb/6/6a/Mona_Lisa.jpg/800px-Mona_Lisa.jpg"
fi

echo "=== Generating 30-second ZOOM test ==="
echo "First 15s: Zoom IN (1.0 → 1.12)"
echo "Last 15s: Zoom OUT (1.12 → 1.0)"
echo ""

# Zoom parameters (12% total zoom over 15 seconds = 450 frames)
HALF_FRAMES=450
ZOOM_INC="0.000267"  # 0.12 / 450
END_ZOOM="1.12"

# Zoom IN (first 15 seconds)
ffmpeg -y -loop 1 -i /tmp/test_img.jpg \
  -vf "scale=8000:-1,zoompan=z='zoom+${ZOOM_INC}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${HALF_FRAMES}:s=1920x1080:fps=30" \
  -t 15 -c:v libx264 -pix_fmt yuv420p /tmp/zoom_in.mp4 2>&1 | grep -E "(time=|speed=)" || true

# Zoom OUT (last 15 seconds)
ffmpeg -y -loop 1 -i /tmp/test_img.jpg \
  -vf "scale=8000:-1,zoompan=z='${END_ZOOM}-${ZOOM_INC}*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${HALF_FRAMES}:s=1920x1080:fps=30" \
  -t 15 -c:v libx264 -pix_fmt yuv420p /tmp/zoom_out.mp4 2>&1 | grep -E "(time=|speed=)" || true

# Concatenate zoom clips
echo "file '/tmp/zoom_in.mp4'" > /tmp/zoom_list.txt
echo "file '/tmp/zoom_out.mp4'" >> /tmp/zoom_list.txt
ffmpeg -y -f concat -safe 0 -i /tmp/zoom_list.txt -c copy test_zoom_30sec.mp4

echo ""
echo "=== Generating 30-second PAN test ==="
echo "First 15s: Pan LEFT → RIGHT"
echo "Last 15s: Pan RIGHT → LEFT"
echo ""

# Pan parameters (crop-based smooth pan)
HALF_DURATION=15

# Pan L→R (first 15 seconds)
ffmpeg -y -loop 1 -i /tmp/test_img.jpg \
  -vf "scale=2500:-1,crop=1920:1080:'(in_w-1920)*t/${HALF_DURATION}':0" \
  -c:v libx264 -t ${HALF_DURATION} -r 30 -pix_fmt yuv420p /tmp/pan_lr.mp4 2>&1 | grep -E "(time=|speed=)" || true

# Pan R→L (last 15 seconds)
ffmpeg -y -loop 1 -i /tmp/test_img.jpg \
  -vf "scale=2500:-1,crop=1920:1080:'(in_w-1920)*(1-t/${HALF_DURATION})':0" \
  -c:v libx264 -t ${HALF_DURATION} -r 30 -pix_fmt yuv420p /tmp/pan_rl.mp4 2>&1 | grep -E "(time=|speed=)" || true

# Concatenate pan clips
echo "file '/tmp/pan_lr.mp4'" > /tmp/pan_list.txt
echo "file '/tmp/pan_rl.mp4'" >> /tmp/pan_list.txt
ffmpeg -y -f concat -safe 0 -i /tmp/pan_list.txt -c copy test_pan_30sec.mp4

echo ""
echo "=== Done! ==="
echo "Zoom: test_zoom_30sec.mp4"
echo "Pan: test_pan_30sec.mp4"
echo ""

# Open both videos
open test_zoom_30sec.mp4
sleep 1
open test_pan_30sec.mp4
