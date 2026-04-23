/**
 * Script Generation API Tests
 *
 * These tests verify the script generation functionality including:
 * - YouTube transcript fetching
 * - Script rewriting (non-streaming and streaming)
 * - Error handling
 * - Progress callback handling for streaming
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TranscriptResult, ScriptResult } from "@/lib/api";

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
  getYouTubeTranscript,
  rewriteScript,
  rewriteScriptStreaming,
} from "@/lib/api";

describe("Script Generation API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getYouTubeTranscript", () => {
    it("should successfully fetch a YouTube transcript", async () => {
      // Arrange
      const mockTranscript: TranscriptResult = {
        success: true,
        videoId: "dQw4w9WgXcQ",
        title: "Test Video Title",
        transcript: "This is the video transcript content.",
      };

      vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
        data: mockTranscript,
        error: null,
      });

      // Act
      const result = await getYouTubeTranscript(
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
      );

      // Assert
      expect(result).toEqual(mockTranscript);
      expect(supabase.functions.invoke).toHaveBeenCalledWith(
        "get-youtube-transcript",
        {
          body: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
        }
      );
    });

    it("should handle Supabase function errors", async () => {
      // Arrange
      vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
        data: null,
        error: { message: "Function execution failed" },
      });

      // Act
      const result = await getYouTubeTranscript(
        "https://www.youtube.com/watch?v=invalid"
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe("Function execution failed");
    });

    it("should handle videos with no transcript available", async () => {
      // Arrange
      const mockResult: TranscriptResult = {
        success: true,
        videoId: "abc123",
        title: "Video Without Captions",
        transcript: null,
        message: "No captions available for this video",
      };

      vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
        data: mockResult,
        error: null,
      });

      // Act
      const result = await getYouTubeTranscript(
        "https://www.youtube.com/watch?v=abc123"
      );

      // Assert
      expect(result.success).toBe(true);
      expect(result.transcript).toBeNull();
      expect(result.message).toBe("No captions available for this video");
    });

    it("should handle invalid URL formats", async () => {
      // Arrange
      vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
        data: null,
        error: { message: "Invalid YouTube URL" },
      });

      // Act
      const result = await getYouTubeTranscript("not-a-valid-url");

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid YouTube URL");
    });
  });

  describe("rewriteScript", () => {
    it("should successfully rewrite a script", async () => {
      // Arrange
      const mockResult: ScriptResult = {
        success: true,
        script: "This is the rewritten script content.",
        wordCount: 500,
      };

      vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
        data: mockResult,
        error: null,
      });

      // Act
      const result = await rewriteScript(
        "Original transcript content",
        "Documentary template",
        "Video Title"
      );

      // Assert
      expect(result).toEqual(mockResult);
      expect(supabase.functions.invoke).toHaveBeenCalledWith("rewrite-script", {
        body: {
          transcript: "Original transcript content",
          template: "Documentary template",
          title: "Video Title",
        },
      });
    });

    it("should handle rewrite errors", async () => {
      // Arrange
      vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
        data: null,
        error: { message: "AI service unavailable" },
      });

      // Act
      const result = await rewriteScript(
        "Transcript",
        "Template",
        "Title"
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe("AI service unavailable");
    });

    it("should handle empty transcript input", async () => {
      // Arrange
      vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
        data: null,
        error: { message: "Transcript cannot be empty" },
      });

      // Act
      const result = await rewriteScript("", "Template", "Title");

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe("Transcript cannot be empty");
    });
  });

  describe("rewriteScriptStreaming", () => {
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
      const progressUpdates: Array<{ progress: number; wordCount: number }> = [];
      const onProgress = (progress: number, wordCount: number) => {
        progressUpdates.push({ progress, wordCount });
      };

      // Create a mock ReadableStream that emits SSE events
      const sseEvents = [
        'data: {"type":"progress","progress":25,"wordCount":250}\n\n',
        'data: {"type":"progress","progress":50,"wordCount":500}\n\n',
        'data: {"type":"progress","progress":75,"wordCount":750}\n\n',
        'data: {"type":"complete","success":true,"script":"Final script content","wordCount":1000}\n\n',
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
      const result = await rewriteScriptStreaming(
        "Transcript content",
        "Template",
        "Title",
        "gpt-4",
        1000,
        onProgress
      );

      // Assert
      expect(result.success).toBe(true);
      expect(result.script).toBe("Final script content");
      expect(result.wordCount).toBe(1000);
      expect(progressUpdates).toHaveLength(4); // 3 progress + 1 complete
      expect(progressUpdates[0]).toEqual({ progress: 25, wordCount: 250 });
      expect(progressUpdates[3]).toEqual({ progress: 100, wordCount: 1000 });
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
      const result = await rewriteScriptStreaming(
        "Transcript",
        "Template",
        "Title",
        "gpt-4",
        1000,
        onProgress
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe("Failed to rewrite script: 500");
    });

    it("should handle missing response body", async () => {
      // Arrange
      const onProgress = vi.fn();

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        body: null,
      });

      // Act
      const result = await rewriteScriptStreaming(
        "Transcript",
        "Template",
        "Title",
        "gpt-4",
        1000,
        onProgress
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe("No response body");
    });

    it("should handle error events in stream without prior progress", async () => {
      // Arrange
      const onProgress = vi.fn();

      // Error event without any prior progress events
      const sseEvents = [
        'data: {"type":"error","error":"AI model rate limited"}\n\n',
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
      const result = await rewriteScriptStreaming(
        "Transcript",
        "Template",
        "Title",
        "gpt-4",
        1000,
        onProgress
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe("AI model rate limited");
    });

    it("should handle error events after progress with interruption message", async () => {
      // Arrange
      // When error occurs after progress was made (lastWordCount > 0),
      // the implementation provides a helpful interruption message
      const onProgress = vi.fn();

      const sseEvents = [
        'data: {"type":"progress","progress":25,"wordCount":250}\n\n',
        'data: {"type":"error","error":"AI model rate limited"}\n\n',
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
      const result = await rewriteScriptStreaming(
        "Transcript",
        "Template",
        "Title",
        "gpt-4",
        1000,
        onProgress
      );

      // Assert - the implementation overwrites error with interruption message
      // when lastWordCount > 0 to provide more helpful user guidance
      expect(result.success).toBe(false);
      expect(result.error).toContain("Script generation was interrupted");
    });

    it("should handle stream reading errors with partial content recovery", async () => {
      // Arrange
      const onProgress = vi.fn();

      // Mock reader that throws after some events
      let readCount = 0;
      const mockReader = {
        read: vi.fn().mockImplementation(() => {
          if (readCount === 0) {
            readCount++;
            return Promise.resolve({
              done: false,
              value: new TextEncoder().encode(
                'data: {"type":"progress","progress":50,"wordCount":600}\n\n'
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
      const result = await rewriteScriptStreaming(
        "Transcript",
        "Template",
        "Title",
        "gpt-4",
        1000,
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
      await rewriteScriptStreaming(
        "Transcript",
        "Template",
        "Title",
        "claude-3",
        2000,
        onProgress
      );

      // Assert
      expect(global.fetch).toHaveBeenCalledWith(
        "https://test.supabase.co/functions/v1/rewrite-script",
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test-api-key",
            apikey: "test-api-key",
          },
          body: JSON.stringify({
            transcript: "Transcript",
            template: "Template",
            title: "Title",
            model: "claude-3",
            wordCount: 2000,
            stream: true,
          }),
        })
      );
    });

    it("should handle malformed JSON in SSE events gracefully", async () => {
      // Arrange
      const progressUpdates: Array<{ progress: number; wordCount: number }> = [];
      const onProgress = (progress: number, wordCount: number) => {
        progressUpdates.push({ progress, wordCount });
      };

      const sseEvents = [
        'data: {"type":"progress","progress":25,"wordCount":250}\n\n',
        'data: {invalid json}\n\n', // Malformed JSON
        'data: {"type":"complete","success":true,"script":"Final","wordCount":500}\n\n',
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
      const result = await rewriteScriptStreaming(
        "Transcript",
        "Template",
        "Title",
        "gpt-4",
        500,
        onProgress
      );

      // Assert - should skip malformed JSON and continue
      expect(result.success).toBe(true);
      expect(result.script).toBe("Final");
      expect(progressUpdates).toHaveLength(2); // First progress + complete
    });
  });
});

describe("Script Generation Result Types", () => {
  describe("TranscriptResult interface", () => {
    it("should correctly type a successful transcript result", () => {
      // Arrange
      const result: TranscriptResult = {
        success: true,
        videoId: "abc123",
        title: "Test Video",
        transcript: "Video content here",
      };

      // Assert
      expect(result.success).toBe(true);
      expect(result.videoId).toBeDefined();
      expect(result.title).toBeDefined();
      expect(result.transcript).toBeDefined();
    });

    it("should correctly type an error transcript result", () => {
      // Arrange
      const result: TranscriptResult = {
        success: false,
        error: "Something went wrong",
      };

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("ScriptResult interface", () => {
    it("should correctly type a successful script result", () => {
      // Arrange
      const result: ScriptResult = {
        success: true,
        script: "Generated script content",
        wordCount: 1500,
      };

      // Assert
      expect(result.success).toBe(true);
      expect(result.script).toBeDefined();
      expect(result.wordCount).toBeDefined();
    });

    it("should correctly type an error script result", () => {
      // Arrange
      const result: ScriptResult = {
        success: false,
        error: "Generation failed",
      };

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
