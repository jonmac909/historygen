/**
 * Audio Processing API Tests
 *
 * These tests verify the audio processing functionality including:
 * - Audio generation with voice cloning
 * - Streaming audio generation with progress updates
 * - Caption generation
 * - Error handling for voice samples and TTS service
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AudioResult, CaptionsResult } from "@/lib/api";

// Mock the Supabase client module
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: {
      invoke: vi.fn(),
    },
  },
}));

// Import after mocking
import { supabase } from "@/integrations/supabase/client";
import {
  generateAudio,
  generateAudioStreaming,
  generateCaptions,
} from "@/lib/api";

describe("Audio Processing API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("generateAudio", () => {
    it("should successfully generate audio with voice cloning", async () => {
      // Arrange
      const mockResult: AudioResult = {
        success: true,
        audioUrl: "https://storage.supabase.co/audio/test-audio.mp3",
        duration: 120,
        size: 1048576,
      };

      vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
        data: mockResult,
        error: null,
      });

      // Act
      const result = await generateAudio(
        "This is the script to convert to audio.",
        "https://storage.supabase.co/voice-samples/sample.mp3",
        "project-123"
      );

      // Assert
      expect(result).toEqual(mockResult);
      expect(supabase.functions.invoke).toHaveBeenCalledWith("generate-audio", {
        body: {
          script: "This is the script to convert to audio.",
          voiceSampleUrl: "https://storage.supabase.co/voice-samples/sample.mp3",
          projectId: "project-123",
        },
      });
    });

    it("should handle voice sample not accessible error", async () => {
      // Arrange
      vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
        data: null,
        error: { message: "Voice sample not accessible" },
      });

      // Act
      const result = await generateAudio(
        "Script content",
        "https://invalid-url.com/sample.mp3",
        "project-123"
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe(
        "Cannot access your voice sample. Please try re-uploading it in Settings."
      );
    });

    it("should handle TTS job failed error", async () => {
      // Arrange
      vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
        data: null,
        error: { message: "TTS job failed with error" },
      });

      // Act
      const result = await generateAudio(
        "Script content",
        "https://storage.supabase.co/voice-samples/sample.mp3",
        "project-123"
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain("Voice cloning failed");
    });

    it("should handle timeout error", async () => {
      // Arrange
      vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
        data: null,
        error: { message: "Request timed out after 30000ms" },
      });

      // Act
      const result = await generateAudio(
        "Very long script content...",
        "https://storage.supabase.co/voice-samples/sample.mp3",
        "project-123"
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain("timed out");
    });

    it("should handle error in response data", async () => {
      // Arrange
      vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
        data: { error: "Audio processing failed" },
        error: null,
      });

      // Act
      const result = await generateAudio(
        "Script content",
        "https://storage.supabase.co/voice-samples/sample.mp3",
        "project-123"
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe("Audio processing failed");
    });

    it("should handle generic Supabase function error", async () => {
      // Arrange
      vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
        data: null,
        error: { message: "Unknown error occurred" },
      });

      // Act
      const result = await generateAudio(
        "Script content",
        "https://storage.supabase.co/voice-samples/sample.mp3",
        "project-123"
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe("Unknown error occurred");
    });
  });

  describe("generateAudioStreaming", () => {
    // Store original fetch
    const originalFetch = global.fetch;

    beforeEach(() => {
      // Mock environment variables
      vi.stubEnv("VITE_SUPABASE_URL", "https://test.supabase.co");
      vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "test-api-key");
    });

    afterEach(() => {
      global.fetch = originalFetch;
      vi.unstubAllEnvs();
    });

    it("should handle successful streaming response with progress updates", async () => {
      // Arrange
      const progressUpdates: number[] = [];
      const onProgress = (progress: number) => {
        progressUpdates.push(progress);
      };

      // Create a mock ReadableStream that emits SSE events
      const sseEvents = [
        'data: {"type":"progress","progress":10}\n\n',
        'data: {"type":"progress","progress":30}\n\n',
        'data: {"type":"progress","progress":60}\n\n',
        'data: {"type":"progress","progress":90}\n\n',
        'data: {"type":"complete","audioUrl":"https://storage.supabase.co/audio/generated.mp3","duration":120,"size":2097152}\n\n',
      ];

      let eventIndex = 0;
      const mockReader = {
        read: vi.fn().mockImplementation(() => {
          if (eventIndex < sseEvents.length) {
            const event = sseEvents[eventIndex++];
            return Promise.resolve({
              done: false,
              value: new TextEncoder().encode(event),
            });
          }
          return Promise.resolve({ done: true, value: undefined });
        }),
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        body: { getReader: () => mockReader },
      });

      // Act
      const result = await generateAudioStreaming(
        "Script content for audio generation",
        "https://storage.supabase.co/voice-samples/sample.mp3",
        "project-123",
        onProgress
      );

      // Assert
      expect(result.success).toBe(true);
      expect(result.audioUrl).toBe(
        "https://storage.supabase.co/audio/generated.mp3"
      );
      expect(result.duration).toBe(120);
      expect(result.size).toBe(2097152);
      expect(progressUpdates).toHaveLength(5); // 4 progress + 1 complete (100)
      expect(progressUpdates[0]).toBe(10);
      expect(progressUpdates[4]).toBe(100);
    });

    it("should handle HTTP error response", async () => {
      // Arrange
      const onProgress = vi.fn();

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      });

      // Act
      const result = await generateAudioStreaming(
        "Script",
        "https://storage.supabase.co/voice-samples/sample.mp3",
        "project-123",
        onProgress
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe("Failed to generate audio: 500");
    });

    it("should handle missing response body", async () => {
      // Arrange
      const onProgress = vi.fn();

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        body: null,
      });

      // Act
      const result = await generateAudioStreaming(
        "Script",
        "https://storage.supabase.co/voice-samples/sample.mp3",
        "project-123",
        onProgress
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe("No response body");
    });

    it("should handle error events in stream", async () => {
      // Arrange
      const onProgress = vi.fn();

      const sseEvents = [
        'data: {"type":"progress","progress":20}\n\n',
        'data: {"type":"error","error":"Voice cloning service unavailable"}\n\n',
      ];

      let eventIndex = 0;
      const mockReader = {
        read: vi.fn().mockImplementation(() => {
          if (eventIndex < sseEvents.length) {
            const event = sseEvents[eventIndex++];
            return Promise.resolve({
              done: false,
              value: new TextEncoder().encode(event),
            });
          }
          return Promise.resolve({ done: true, value: undefined });
        }),
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        body: { getReader: () => mockReader },
      });

      // Act
      const result = await generateAudioStreaming(
        "Script",
        "https://storage.supabase.co/voice-samples/sample.mp3",
        "project-123",
        onProgress
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe("Voice cloning service unavailable");
    });

    it("should handle stream reading errors", async () => {
      // Arrange
      const onProgress = vi.fn();

      let readCount = 0;
      const mockReader = {
        read: vi.fn().mockImplementation(() => {
          if (readCount === 0) {
            readCount++;
            return Promise.resolve({
              done: false,
              value: new TextEncoder().encode(
                'data: {"type":"progress","progress":30}\n\n'
              ),
            });
          }
          throw new Error("Network connection lost");
        }),
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        body: { getReader: () => mockReader },
      });

      // Act
      const result = await generateAudioStreaming(
        "Script",
        "https://storage.supabase.co/voice-samples/sample.mp3",
        "project-123",
        onProgress
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe("Network connection lost");
    });

    it("should include correct headers in fetch request", async () => {
      // Arrange
      const onProgress = vi.fn();

      const mockReader = {
        read: vi.fn().mockResolvedValue({ done: true, value: undefined }),
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        body: { getReader: () => mockReader },
      });

      // Act
      await generateAudioStreaming(
        "Script content",
        "https://storage.supabase.co/voice-samples/sample.mp3",
        "project-456",
        onProgress
      );

      // Assert
      expect(global.fetch).toHaveBeenCalledWith(
        "https://test.supabase.co/functions/v1/generate-audio",
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test-api-key",
            apikey: "test-api-key",
          },
          body: JSON.stringify({
            script: "Script content",
            voiceSampleUrl:
              "https://storage.supabase.co/voice-samples/sample.mp3",
            projectId: "project-456",
            stream: true,
          }),
        })
      );
    });

    it("should handle malformed JSON in SSE events gracefully", async () => {
      // Arrange
      const progressUpdates: number[] = [];
      const onProgress = (progress: number) => {
        progressUpdates.push(progress);
      };

      const sseEvents = [
        'data: {"type":"progress","progress":25}\n\n',
        'data: {invalid json}\n\n', // Malformed JSON
        'data: {"type":"complete","audioUrl":"https://example.com/audio.mp3","duration":60,"size":1024}\n\n',
      ];

      let eventIndex = 0;
      const mockReader = {
        read: vi.fn().mockImplementation(() => {
          if (eventIndex < sseEvents.length) {
            const event = sseEvents[eventIndex++];
            return Promise.resolve({
              done: false,
              value: new TextEncoder().encode(event),
            });
          }
          return Promise.resolve({ done: true, value: undefined });
        }),
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        body: { getReader: () => mockReader },
      });

      // Act
      const result = await generateAudioStreaming(
        "Script",
        "https://storage.supabase.co/voice-samples/sample.mp3",
        "project-123",
        onProgress
      );

      // Assert - should skip malformed JSON and continue
      expect(result.success).toBe(true);
      expect(result.audioUrl).toBe("https://example.com/audio.mp3");
      expect(progressUpdates).toHaveLength(2); // First progress + complete (100)
    });

    it("should handle no complete event received", async () => {
      // Arrange
      const onProgress = vi.fn();

      const sseEvents = [
        'data: {"type":"progress","progress":50}\n\n',
      ];

      let eventIndex = 0;
      const mockReader = {
        read: vi.fn().mockImplementation(() => {
          if (eventIndex < sseEvents.length) {
            const event = sseEvents[eventIndex++];
            return Promise.resolve({
              done: false,
              value: new TextEncoder().encode(event),
            });
          }
          return Promise.resolve({ done: true, value: undefined });
        }),
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        body: { getReader: () => mockReader },
      });

      // Act
      const result = await generateAudioStreaming(
        "Script",
        "https://storage.supabase.co/voice-samples/sample.mp3",
        "project-123",
        onProgress
      );

      // Assert - returns default error message
      expect(result.success).toBe(false);
      expect(result.error).toBe("No response received");
    });
  });

  describe("generateCaptions", () => {
    it("should successfully generate captions from audio", async () => {
      // Arrange
      const mockResult: CaptionsResult = {
        success: true,
        captionsUrl:
          "https://storage.supabase.co/captions/project-123/captions.srt",
        srtContent: "1\n00:00:00,000 --> 00:00:05,000\nHello world\n\n",
        segmentCount: 15,
        estimatedDuration: 120,
      };

      vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
        data: mockResult,
        error: null,
      });

      // Act
      const result = await generateCaptions(
        "https://storage.supabase.co/audio/test-audio.mp3",
        "project-123"
      );

      // Assert
      expect(result).toEqual(mockResult);
      expect(supabase.functions.invoke).toHaveBeenCalledWith(
        "generate-captions",
        {
          body: {
            audioUrl: "https://storage.supabase.co/audio/test-audio.mp3",
            projectId: "project-123",
          },
        }
      );
    });

    it("should handle Supabase function errors", async () => {
      // Arrange
      vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
        data: null,
        error: { message: "Transcription service unavailable" },
      });

      // Act
      const result = await generateCaptions(
        "https://storage.supabase.co/audio/test-audio.mp3",
        "project-123"
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe("Transcription service unavailable");
    });

    it("should handle invalid audio URL", async () => {
      // Arrange
      vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
        data: null,
        error: { message: "Audio file not found or inaccessible" },
      });

      // Act
      const result = await generateCaptions(
        "https://invalid-url.com/audio.mp3",
        "project-123"
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe("Audio file not found or inaccessible");
    });
  });
});

describe("Audio Processing Result Types", () => {
  describe("AudioResult interface", () => {
    it("should correctly type a successful audio result", () => {
      // Arrange
      const result: AudioResult = {
        success: true,
        audioUrl: "https://example.com/audio.mp3",
        duration: 180,
        size: 3145728,
      };

      // Assert
      expect(result.success).toBe(true);
      expect(result.audioUrl).toBeDefined();
      expect(result.duration).toBeDefined();
      expect(result.size).toBeDefined();
    });

    it("should correctly type an audio result with base64", () => {
      // Arrange
      const result: AudioResult = {
        success: true,
        audioBase64: "SGVsbG8gV29ybGQ=",
        duration: 30,
        size: 102400,
      };

      // Assert
      expect(result.success).toBe(true);
      expect(result.audioBase64).toBeDefined();
    });

    it("should correctly type an error audio result", () => {
      // Arrange
      const result: AudioResult = {
        success: false,
        error: "Audio generation failed",
      };

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("CaptionsResult interface", () => {
    it("should correctly type a successful captions result", () => {
      // Arrange
      const result: CaptionsResult = {
        success: true,
        captionsUrl: "https://example.com/captions.srt",
        srtContent: "1\n00:00:00,000 --> 00:00:01,000\nTest\n\n",
        segmentCount: 10,
        estimatedDuration: 60,
      };

      // Assert
      expect(result.success).toBe(true);
      expect(result.captionsUrl).toBeDefined();
      expect(result.srtContent).toBeDefined();
      expect(result.segmentCount).toBeDefined();
      expect(result.estimatedDuration).toBeDefined();
    });

    it("should correctly type an error captions result", () => {
      // Arrange
      const result: CaptionsResult = {
        success: false,
        error: "Captions generation failed",
      };

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
