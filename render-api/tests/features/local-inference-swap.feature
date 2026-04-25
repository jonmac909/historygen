# Layer 2 — Gherkin behavioral spec for local-inference-swap.
# Read by validate-plan.sh; not directly executed by vitest.

Feature: Local inference swap (LOCAL_INFERENCE flag)
  Replace remote VoxCPM2 / Z-Image / Kie.ai I2V / R2 with localhost servers
  and local-disk asset storage when LOCAL_INFERENCE=true. Default-off keeps
  the production RunPod + Kie.ai + R2 path intact.

  Background:
    Given the render-api has loaded runtime-config from environment
    And the three local Python servers (VoxCPM2, Z-Image, LTX-2) are reachable
    And LOCAL_ASSETS_DIR exists with subdirs images/, audio/, clips/, renders/, fx/

  @local-inference-swap @critical
  Scenario: Local image generation produces a PNG under local-assets/images/
    Given LOCAL_INFERENCE=true
    When the client POSTs /generate-images with a valid prompt
    Then render-api forwards the request to LOCAL_ZIMAGE_URL/generate
    And the response body has imageUrl matching "http://localhost:3000/assets/images/<uuid>.png"
    And a file exists on disk at LOCAL_ASSETS_DIR/images/<uuid>.png

  @local-inference-swap @critical
  Scenario: Local audio generation produces a WAV under local-assets/audio/
    Given LOCAL_INFERENCE=true
    When the client POSTs /generate-audio with valid text
    Then render-api forwards the request to LOCAL_VOXCPM2_URL/tts
    And the response body has audioUrl matching "http://localhost:3000/assets/audio/<uuid>.wav"
    And a file exists on disk at LOCAL_ASSETS_DIR/audio/<uuid>.wav

  @local-inference-swap @critical
  Scenario: Local clip generation produces an MP4 under local-assets/clips/
    Given LOCAL_INFERENCE=true
    When the client POSTs /generate-video-clips with one image+prompt clip
    Then render-api forwards the request to LOCAL_LTX2_URL/i2v
    And the response body has clipUrl matching "http://localhost:3000/assets/clips/<uuid>.mp4"

  @local-inference-swap @critical
  Scenario: Final render uses h264_nvenc encoder in local mode
    Given LOCAL_INFERENCE=true
    When render-video.ts invokes ffmpeg
    Then getEncoderArgs(true) returns ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "23"]
    And the spawned ffmpeg command line contains "h264_nvenc"

  @local-inference-swap @critical
  Scenario: Cost tracker writes cost_usd=0 for local services
    Given LOCAL_INFERENCE=true
    When render-api records a cost for service "z_image" with units=1
    Then the project_costs row has unit_cost=0
    And the project_costs row has total_cost=0

  @local-inference-swap @critical
  Scenario: LOCAL_INFERENCE=false falls back to RunPod path unchanged
    Given LOCAL_INFERENCE is unset or "false"
    When the client POSTs /generate-images with a valid prompt
    Then the outgoing request goes to api.runpod.ai
    And the request body uses snake_case fields (e.g. reference_audio_base64)
    And the response shape matches the legacy contract (imageUrl, audioUrl, clipUrl, videoUrl keys)

  @local-inference-swap @critical
  Scenario: SSE events fire in order during a local-mode pipeline run
    Given LOCAL_INFERENCE=true
    When the client opens an SSE stream for the pipeline
    Then events arrive in order: "started", "in_progress", "completed"
    And LTX-2 stage emits "in_progress" heartbeats every 30 seconds
    And the "completed" event payload includes the resulting URL

  @local-inference-swap @critical
  Scenario: Stage transitions fire POST /unload to non-needed servers
    Given LOCAL_INFERENCE=true
    And the image stage just completed
    When render-api begins the audio stage
    Then it sends POST /unload to LOCAL_VOXCPM2_URL is skipped (currently needed)
    And it sends POST /unload to LOCAL_ZIMAGE_URL (no longer needed)
    And it sends POST /unload to LOCAL_LTX2_URL (not yet needed)
    And 409 BUSY responses are treated as benign skip

  @local-inference-swap @critical
  Scenario: GET /config returns localInferenceMode unauthenticated
    Given the render-api is running
    When the client GETs /config without an X-Internal-Api-Key header
    Then the response is 200
    And the body matches { localInferenceMode: <flag value> }
    And the body does NOT include URLs, secrets, or model paths

  @local-inference-swap @critical
  Scenario: GET /health returns { ok: true }
    Given the render-api is running
    When the client GETs /health
    Then the response is 200
    And the body equals { ok: true }

  @error-case
  Scenario: Local server returns error envelope on bad request
    Given LOCAL_INFERENCE=true
    When the client POSTs /generate-audio with an empty text field
    Then render-api returns 400
    And the response body equals { error: { code: "VALIDATION_ERROR", message: <string>, details: <object> } }

  @error-case
  Scenario: Local Python server timeout returns INTERNAL_ERROR envelope
    Given LOCAL_INFERENCE=true
    And LOCAL_LTX2_URL is unreachable (connection refused)
    When the client POSTs /generate-video-clips
    Then render-api returns 500 within LTX2_TIMEOUT_MS + 5s
    And the response body has error.code = "INTERNAL_ERROR"

  @error-case
  Scenario: /unload during model loading returns 409 BUSY
    Given LOCAL_INFERENCE=true
    And LOCAL_LTX2_URL is in status="loading"
    When render-api fires POST /unload to LOCAL_LTX2_URL
    Then the response is 409
    And the response body has error.code = "BUSY"
    And render-api proceeds without retry
