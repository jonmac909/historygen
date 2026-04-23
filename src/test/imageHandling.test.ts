/**
 * Image Handling API Tests
 *
 * These tests verify the image handling functionality including:
 * - Image prompt generation with timing
 * - Image generation (non-streaming and streaming)
 * - Error handling
 * - Progress callback handling for streaming
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  ImageGenerationResult,
  ImagePromptsResult,
  ImagePromptWithTiming,
} from "@/lib/api";

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
  generateImagePrompts,
  generateImages,
  generateImagesStreaming,
} from "@/lib/api";

describe("Image Handling API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("generateImagePrompts", () => {
    it("should successfully generate image prompts with timing", async () => {
      // Arrange
      const mockPrompts: ImagePromptWithTiming[] = [
        {
          index: 0,
          startTime: "00:00:00,000",
          endTime: "00:00:10,000",
          startSeconds: 0,
          endSeconds: 10,
          prompt: "A dramatic scene of ancient Rome",
          sceneDescription: "Introduction to the Roman Empire",
        },
        {
          index: 1,
          startTime: "00:00:10,000",
          endTime: "00:00:20,000",
          startSeconds: 10,
          endSeconds: 20,
          prompt: "Roman soldiers marching through a city",
          sceneDescription: "The military power of Rome",
        },
      ];

      const mockResult: ImagePromptsResult = {
        success: true,
        prompts: mockPrompts,
        totalDuration: 120,
      };

      vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
        data: mockResult,
        error: null,
      });

      // Act
      const result = await generateImagePrompts(
        "This is the script about ancient Rome...",
        "1\n00:00:00,000 --> 00:00:10,000\nIntroduction\n\n",
        5,
        "cinematic, photorealistic"
      );

      // Assert
      expect(result).toEqual(mockResult);
      expect(supabase.functions.invoke).toHaveBeenCalledWith(
        "generate-image-prompts",
        {
          body: {
            script: "This is the script about ancient Rome...",
            srtContent: "1\n00:00:00,000 --> 00:00:10,000\nIntroduction\n\n",
            imageCount: 5,
            stylePrompt: "cinematic, photorealistic",
          },
        }
      );
    });

    it("should handle Supabase function errors", async () => {
      // Arrange
      vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
        data: null,
        error: { message: "AI service unavailable" },
      });

      // Act
      const result = await generateImagePrompts(
        "Script content",
        "SRT content",
        5,
        "style"
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe("AI service unavailable");
    });

    it("should handle empty script input", async () => {
      // Arrange
      vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
        data: null,
        error: { message: "Script cannot be empty" },
      });

      // Act
      const result = await generateImagePrompts("", "SRT content", 5, "style");

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe("Script cannot be empty");
    });

    it("should handle invalid SRT content", async () => {
      // Arrange
      vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
        data: null,
        error: { message: "Invalid SRT format" },
      });

      // Act
      const result = await generateImagePrompts(
        "Script content",
        "invalid srt",
        5,
        "style"
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid SRT format");
    });

    it("should handle zero image count", async () => {
      // Arrange
      vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
        data: null,
        error: { message: "Image count must be greater than 0" },
      });

      // Act
      const result = await generateImagePrompts(
        "Script content",
        "SRT content",
        0,
        "style"
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe("Image count must be greater than 0");
    });
  });

  describe("generateImages", () => {
    it("should successfully generate images from string prompts", async () => {
      // Arrange
      const mockResult: ImageGenerationResult = {
        success: true,
        images: [
          "https://storage.supabase.co/images/image1.png",
          "https://storage.supabase.co/images/image2.png",
        ],
      };

      vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
        data: mockResult,
        error: null,
      });

      // Act
      const result = await generateImages(
        ["A dramatic sunset", "A peaceful forest"],
        "high",
        "16:9",
        "project-123"
      );

      // Assert
      expect(result).toEqual(mockResult);
      expect(supabase.functions.invoke).toHaveBeenCalledWith("generate-images", {
        body: {
          prompts: ["A dramatic sunset", "A peaceful forest"],
          quality: "high",
          aspectRatio: "16:9",
          projectId: "project-123",
        },
      });
    });

    it("should successfully generate images from ImagePromptWithTiming array", async () => {
      // Arrange
      const prompts: ImagePromptWithTiming[] = [
        {
          index: 0,
          startTime: "00:00:00,000",
          endTime: "00:00:10,000",
          startSeconds: 0,
          endSeconds: 10,
          prompt: "A dramatic scene",
          sceneDescription: "Scene 1",
        },
      ];

      const mockResult: ImageGenerationResult = {
        success: true,
        images: ["https://storage.supabase.co/images/image1.png"],
      };

      vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
        data: mockResult,
        error: null,
      });

      // Act
      const result = await generateImages(prompts, "standard", "16:9");

      // Assert
      expect(result).toEqual(mockResult);
      expect(supabase.functions.invoke).toHaveBeenCalledWith("generate-images", {
        body: {
          prompts: prompts,
          quality: "standard",
          aspectRatio: "16:9",
          projectId: undefined,
        },
      });
    });

    it("should use default aspect ratio when not provided", async () => {
      // Arrange
      const mockResult: ImageGenerationResult = {
        success: true,
        images: ["https://storage.supabase.co/images/image1.png"],
      };

      vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
        data: mockResult,
        error: null,
      });

      // Act
      const result = await generateImages(["A test prompt"], "high");

      // Assert
      expect(result).toEqual(mockResult);
      expect(supabase.functions.invoke).toHaveBeenCalledWith("generate-images", {
        body: {
          prompts: ["A test prompt"],
          quality: "high",
          aspectRatio: "16:9",
          projectId: undefined,
        },
      });
    });

    it("should handle Supabase function errors", async () => {
      // Arrange
      vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
        data: null,
        error: { message: "Image generation service unavailable" },
      });

      // Act
      const result = await generateImages(["Test prompt"], "high");

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe("Image generation service unavailable");
    });

    it("should handle empty prompts array", async () => {
      // Arrange
      vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
        data: null,
        error: { message: "At least one prompt is required" },
      });

      // Act
      const result = await generateImages([], "high");

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe("At least one prompt is required");
    });

    it("should handle rate limiting errors", async () => {
      // Arrange
      vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
        data: null,
        error: { message: "Rate limit exceeded. Please try again later." },
      });

      // Act
      const result = await generateImages(["Test prompt"], "high");

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe("Rate limit exceeded. Please try again later.");
    });
  });

  describe("generateImagesStreaming", () => {
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
      const progressUpdates: Array<{
        completed: number;
        total: number;
        message: string;
      }> = [];
      const onProgress = (completed: number, total: number, message: string) => {
        progressUpdates.push({ completed, total, message });
      };

      // Create a mock ReadableStream that emits SSE events
      const sseEvents = [
        'data: {"type":"progress","completed":1,"total":3,"message":"1/3 generating"}\n\n',
        'data: {"type":"progress","completed":2,"total":3,"message":"2/3 generating"}\n\n',
        'data: {"type":"progress","completed":3,"total":3,"message":"3/3 generating"}\n\n',
        'data: {"type":"complete","success":true,"total":3,"images":["https://img1.png","https://img2.png","https://img3.png"]}\n\n',
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
      const result = await generateImagesStreaming(
        ["Prompt 1", "Prompt 2", "Prompt 3"],
        "high",
        "16:9",
        onProgress,
        "project-123"
      );

      // Assert
      expect(result.success).toBe(true);
      expect(result.images).toEqual([
        "https://img1.png",
        "https://img2.png",
        "https://img3.png",
      ]);
      expect(progressUpdates).toHaveLength(4); // 3 progress + 1 complete
      expect(progressUpdates[0]).toEqual({
        completed: 1,
        total: 3,
        message: "1/3 generating",
      });
      expect(progressUpdates[3]).toEqual({
        completed: 3,
        total: 3,
        message: "3/3 done",
      });
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
      const result = await generateImagesStreaming(
        ["Test prompt"],
        "high",
        "16:9",
        onProgress
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe("Failed to generate images: 500");
    });

    it("should handle missing response body", async () => {
      // Arrange
      const onProgress = vi.fn();

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        body: null,
      });

      // Act
      const result = await generateImagesStreaming(
        ["Test prompt"],
        "high",
        "16:9",
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
        'data: {"type":"progress","completed":1,"total":3,"message":"1/3 generating"}\n\n',
        'data: {"type":"error","error":"Image generation service quota exceeded"}\n\n',
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
      const result = await generateImagesStreaming(
        ["Prompt 1", "Prompt 2", "Prompt 3"],
        "high",
        "16:9",
        onProgress
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe("Image generation service quota exceeded");
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
                'data: {"type":"progress","completed":1,"total":3,"message":"1/3 generating"}\n\n'
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
      const result = await generateImagesStreaming(
        ["Prompt 1", "Prompt 2", "Prompt 3"],
        "high",
        "16:9",
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

      const prompts: ImagePromptWithTiming[] = [
        {
          index: 0,
          startTime: "00:00:00,000",
          endTime: "00:00:10,000",
          startSeconds: 0,
          endSeconds: 10,
          prompt: "Test prompt",
          sceneDescription: "Test scene",
        },
      ];

      // Act
      await generateImagesStreaming(
        prompts,
        "standard",
        "9:16",
        onProgress,
        "project-789"
      );

      // Assert
      expect(global.fetch).toHaveBeenCalledWith(
        "https://test.supabase.co/functions/v1/generate-images",
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test-api-key",
            apikey: "test-api-key",
          },
          body: JSON.stringify({
            prompts: prompts,
            quality: "standard",
            aspectRatio: "9:16",
            stream: true,
            projectId: "project-789",
          }),
        })
      );
    });

    it("should handle malformed JSON in SSE events gracefully", async () => {
      // Arrange
      const progressUpdates: Array<{
        completed: number;
        total: number;
        message: string;
      }> = [];
      const onProgress = (completed: number, total: number, message: string) => {
        progressUpdates.push({ completed, total, message });
      };

      const sseEvents = [
        'data: {"type":"progress","completed":1,"total":2,"message":"1/2 generating"}\n\n',
        'data: {invalid json}\n\n', // Malformed JSON
        'data: {"type":"complete","success":true,"total":2,"images":["https://img1.png","https://img2.png"]}\n\n',
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
      const result = await generateImagesStreaming(
        ["Prompt 1", "Prompt 2"],
        "high",
        "16:9",
        onProgress
      );

      // Assert - should skip malformed JSON and continue
      expect(result.success).toBe(true);
      expect(result.images).toEqual(["https://img1.png", "https://img2.png"]);
      expect(progressUpdates).toHaveLength(2); // First progress + complete
    });

    it("should handle no complete event received", async () => {
      // Arrange
      const onProgress = vi.fn();

      const sseEvents = [
        'data: {"type":"progress","completed":1,"total":3,"message":"1/3 generating"}\n\n',
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
      const result = await generateImagesStreaming(
        ["Prompt 1", "Prompt 2", "Prompt 3"],
        "high",
        "16:9",
        onProgress
      );

      // Assert - returns default error message
      expect(result.success).toBe(false);
      expect(result.error).toBe("No response received");
    });

    it("should handle different aspect ratios", async () => {
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
      await generateImagesStreaming(
        ["Portrait image prompt"],
        "high",
        "9:16",
        onProgress
      );

      // Assert
      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"aspectRatio":"9:16"'),
        })
      );
    });

    it("should handle different quality settings", async () => {
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
      await generateImagesStreaming(
        ["Standard quality prompt"],
        "standard",
        "16:9",
        onProgress
      );

      // Assert
      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"quality":"standard"'),
        })
      );
    });
  });
});

describe("Image Handling Result Types", () => {
  describe("ImageGenerationResult interface", () => {
    it("should correctly type a successful image generation result", () => {
      // Arrange
      const result: ImageGenerationResult = {
        success: true,
        images: [
          "https://example.com/image1.png",
          "https://example.com/image2.png",
        ],
      };

      // Assert
      expect(result.success).toBe(true);
      expect(result.images).toBeDefined();
      expect(result.images?.length).toBe(2);
    });

    it("should correctly type an error image generation result", () => {
      // Arrange
      const result: ImageGenerationResult = {
        success: false,
        error: "Image generation failed",
      };

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("ImagePromptsResult interface", () => {
    it("should correctly type a successful image prompts result", () => {
      // Arrange
      const result: ImagePromptsResult = {
        success: true,
        prompts: [
          {
            index: 0,
            startTime: "00:00:00,000",
            endTime: "00:00:10,000",
            startSeconds: 0,
            endSeconds: 10,
            prompt: "Test prompt",
            sceneDescription: "Test scene",
          },
        ],
        totalDuration: 120,
      };

      // Assert
      expect(result.success).toBe(true);
      expect(result.prompts).toBeDefined();
      expect(result.prompts?.length).toBe(1);
      expect(result.totalDuration).toBe(120);
    });

    it("should correctly type an error image prompts result", () => {
      // Arrange
      const result: ImagePromptsResult = {
        success: false,
        error: "Prompt generation failed",
      };

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("ImagePromptWithTiming interface", () => {
    it("should correctly type a complete image prompt with timing", () => {
      // Arrange
      const prompt: ImagePromptWithTiming = {
        index: 0,
        startTime: "00:00:00,000",
        endTime: "00:00:15,500",
        startSeconds: 0,
        endSeconds: 15.5,
        prompt: "A cinematic scene of a medieval castle at sunset",
        sceneDescription: "Introduction to the castle setting",
      };

      // Assert
      expect(prompt.index).toBe(0);
      expect(prompt.startTime).toBe("00:00:00,000");
      expect(prompt.endTime).toBe("00:00:15,500");
      expect(prompt.startSeconds).toBe(0);
      expect(prompt.endSeconds).toBe(15.5);
      expect(prompt.prompt).toBeDefined();
      expect(prompt.sceneDescription).toBeDefined();
    });

    it("should handle multiple prompts with sequential timing", () => {
      // Arrange
      const prompts: ImagePromptWithTiming[] = [
        {
          index: 0,
          startTime: "00:00:00,000",
          endTime: "00:00:10,000",
          startSeconds: 0,
          endSeconds: 10,
          prompt: "Scene 1 prompt",
          sceneDescription: "Scene 1",
        },
        {
          index: 1,
          startTime: "00:00:10,000",
          endTime: "00:00:20,000",
          startSeconds: 10,
          endSeconds: 20,
          prompt: "Scene 2 prompt",
          sceneDescription: "Scene 2",
        },
        {
          index: 2,
          startTime: "00:00:20,000",
          endTime: "00:00:30,000",
          startSeconds: 20,
          endSeconds: 30,
          prompt: "Scene 3 prompt",
          sceneDescription: "Scene 3",
        },
      ];

      // Assert
      expect(prompts).toHaveLength(3);
      prompts.forEach((prompt, idx) => {
        expect(prompt.index).toBe(idx);
        expect(prompt.startSeconds).toBe(idx * 10);
        expect(prompt.endSeconds).toBe((idx + 1) * 10);
      });
    });
  });
});
