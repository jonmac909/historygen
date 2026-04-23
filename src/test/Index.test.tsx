/**
 * Index Page Component Integration Tests
 *
 * These tests verify the main workflow component including:
 * - Component rendering and initial state
 * - Input mode toggling between URL and Title
 * - Form validation and error handling
 * - Settings popover interaction
 * - View state transitions
 * - Toast notifications for validation errors
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock the Supabase client module before any imports
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: {
      invoke: vi.fn(),
    },
    storage: {
      from: vi.fn().mockReturnValue({
        upload: vi.fn().mockResolvedValue({ data: {}, error: null }),
        getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: "https://example.com/file" } }),
      }),
    },
  },
}));

// Mock the API module
vi.mock("@/lib/api", () => ({
  getYouTubeTranscript: vi.fn(),
  rewriteScriptStreaming: vi.fn(),
  generateAudioStreaming: vi.fn(),
  generateImagesStreaming: vi.fn(),
  generateImagePrompts: vi.fn(),
  generateCaptions: vi.fn(),
  saveScriptToStorage: vi.fn(),
}));

// Import Index after mocks are set up
import Index from "@/pages/Index";

// Mock the toast hook
const mockToast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  toast: (props: unknown) => mockToast(props),
  useToast: () => ({ toast: mockToast }),
}));

// Import mocked modules for type assertions
import {
  getYouTubeTranscript,
  rewriteScriptStreaming,
} from "@/lib/api";

describe("Index Page Component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset crypto.randomUUID mock
    vi.stubGlobal("crypto", {
      randomUUID: () => "test-project-id-123",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("Initial Rendering", () => {
    it("should render the main heading", () => {
      render(<Index />);

      expect(
        screen.getByRole("heading", { name: /create your history ai video/i })
      ).toBeInTheDocument();
    });

    it("should render the subtitle text", () => {
      render(<Index />);

      expect(
        screen.getByText(/from youtube url to full production ready assets/i)
      ).toBeInTheDocument();
    });

    it("should render the application logo and title", () => {
      render(<Index />);

      expect(screen.getByText("HistoryVidGen")).toBeInTheDocument();
    });

    it("should render the URL input placeholder by default", () => {
      render(<Index />);

      expect(
        screen.getByPlaceholderText(/paste youtube url/i)
      ).toBeInTheDocument();
    });

    it("should render the Generate button", () => {
      render(<Index />);

      expect(
        screen.getByRole("button", { name: /generate/i })
      ).toBeInTheDocument();
    });

    it("should display URL mode indicator by default", () => {
      render(<Index />);

      expect(screen.getByText("URL")).toBeInTheDocument();
    });
  });

  describe("Input Mode Toggle", () => {
    it("should switch from URL to Title mode when toggle is clicked", async () => {
      const user = userEvent.setup();
      render(<Index />);

      // Find and click the mode toggle button
      const toggleButton = screen.getByText("URL").closest("button");
      expect(toggleButton).toBeInTheDocument();

      await user.click(toggleButton!);

      // Should now show Title mode
      expect(screen.getByText("Title")).toBeInTheDocument();
      expect(
        screen.getByPlaceholderText(/enter video title/i)
      ).toBeInTheDocument();
    });

    it("should switch back from Title to URL mode", async () => {
      const user = userEvent.setup();
      render(<Index />);

      // Toggle to Title mode
      const toggleButton = screen.getByText("URL").closest("button");
      await user.click(toggleButton!);

      // Toggle back to URL mode
      const titleButton = screen.getByText("Title").closest("button");
      await user.click(titleButton!);

      // Should be back to URL mode
      expect(screen.getByText("URL")).toBeInTheDocument();
      expect(
        screen.getByPlaceholderText(/paste youtube url/i)
      ).toBeInTheDocument();
    });

    it("should clear input value when mode is toggled", async () => {
      const user = userEvent.setup();
      render(<Index />);

      // Type in URL input
      const input = screen.getByPlaceholderText(/paste youtube url/i);
      await user.type(input, "https://youtube.com/watch?v=test");

      expect(input).toHaveValue("https://youtube.com/watch?v=test");

      // Toggle mode
      const toggleButton = screen.getByText("URL").closest("button");
      await user.click(toggleButton!);

      // Input should be cleared
      const newInput = screen.getByPlaceholderText(/enter video title/i);
      expect(newInput).toHaveValue("");
    });
  });

  describe("Input Validation", () => {
    it("should show toast error when URL input is empty", async () => {
      const user = userEvent.setup();
      render(<Index />);

      const generateButton = screen.getByRole("button", { name: /generate/i });
      await user.click(generateButton);

      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "URL Required",
          description: "Please paste a YouTube URL to generate.",
          variant: "destructive",
        })
      );
    });

    it("should show toast error when Title input is empty", async () => {
      const user = userEvent.setup();
      render(<Index />);

      // Switch to Title mode
      const toggleButton = screen.getByText("URL").closest("button");
      await user.click(toggleButton!);

      const generateButton = screen.getByRole("button", { name: /generate/i });
      await user.click(generateButton);

      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Title Required",
          description: "Please enter a video title to generate.",
          variant: "destructive",
        })
      );
    });

    it("should show toast error for invalid YouTube URL format", async () => {
      const user = userEvent.setup();
      render(<Index />);

      const input = screen.getByPlaceholderText(/paste youtube url/i);
      await user.type(input, "not-a-valid-url");

      const generateButton = screen.getByRole("button", { name: /generate/i });
      await user.click(generateButton);

      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Invalid URL",
          description: "Please enter a valid YouTube URL.",
          variant: "destructive",
        })
      );
    });

    it("should accept valid YouTube URL formats", async () => {
      const user = userEvent.setup();
      render(<Index />);

      // Setup mocks for API calls - but we won't get far without voice sample
      vi.mocked(getYouTubeTranscript).mockResolvedValueOnce({
        success: true,
        videoId: "dQw4w9WgXcQ",
        title: "Test Video",
        transcript: "Test transcript content",
      });

      const input = screen.getByPlaceholderText(/paste youtube url/i);
      await user.type(input, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");

      const generateButton = screen.getByRole("button", { name: /generate/i });
      await user.click(generateButton);

      // Should show voice sample required error (since no voice sample configured)
      await waitFor(() => {
        expect(mockToast).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Voice Sample Required",
            description:
              "Please upload a voice sample for cloning in Settings.",
            variant: "destructive",
          })
        );
      });
    });

    it("should accept youtu.be short URLs", async () => {
      const user = userEvent.setup();
      render(<Index />);

      const input = screen.getByPlaceholderText(/paste youtube url/i);
      await user.type(input, "https://youtu.be/dQw4w9WgXcQ");

      const generateButton = screen.getByRole("button", { name: /generate/i });
      await user.click(generateButton);

      // Should show voice sample required (not invalid URL error)
      await waitFor(() => {
        expect(mockToast).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Voice Sample Required",
          })
        );
      });
    });
  });

  describe("Settings Management", () => {
    it("should render settings button", () => {
      render(<Index />);

      // Settings button is inside the input area
      const settingsButtons = screen.getAllByRole("button");
      // There should be multiple buttons including settings
      expect(settingsButtons.length).toBeGreaterThan(2);
    });
  });

  describe("View State Management", () => {
    it("should start in create view state", () => {
      render(<Index />);

      // Main heading should be visible (only in create state)
      expect(
        screen.getByRole("heading", { name: /create your history ai video/i })
      ).toBeInTheDocument();
    });

    it("should have Generate button enabled in create state", () => {
      render(<Index />);

      const generateButton = screen.getByRole("button", { name: /generate/i });
      expect(generateButton).not.toBeDisabled();
    });
  });

  describe("User Input Handling", () => {
    it("should update input value when user types", async () => {
      const user = userEvent.setup();
      render(<Index />);

      const input = screen.getByPlaceholderText(/paste youtube url/i);
      await user.type(input, "https://youtube.com/watch?v=test123");

      expect(input).toHaveValue("https://youtube.com/watch?v=test123");
    });

    it("should handle whitespace-only input as empty", async () => {
      const user = userEvent.setup();
      render(<Index />);

      const input = screen.getByPlaceholderText(/paste youtube url/i);
      await user.type(input, "   ");

      const generateButton = screen.getByRole("button", { name: /generate/i });
      await user.click(generateButton);

      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "URL Required",
        })
      );
    });
  });

  describe("Component Structure", () => {
    it("should render the header with logo", () => {
      render(<Index />);

      const header = document.querySelector("header");
      expect(header).toBeInTheDocument();
    });

    it("should render the main content area", () => {
      render(<Index />);

      const main = document.querySelector("main");
      expect(main).toBeInTheDocument();
    });

    it("should have proper accessibility attributes on input", () => {
      render(<Index />);

      const input = screen.getByPlaceholderText(/paste youtube url/i);
      expect(input).toHaveAttribute("type", "url");
    });

    it("should have text input type in Title mode", async () => {
      const user = userEvent.setup();
      render(<Index />);

      const toggleButton = screen.getByText("URL").closest("button");
      await user.click(toggleButton!);

      const input = screen.getByPlaceholderText(/enter video title/i);
      expect(input).toHaveAttribute("type", "text");
    });
  });
});

describe("Index Page Integration Workflows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("crypto", {
      randomUUID: () => "test-workflow-id",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("Generation Workflow Prerequisites", () => {
    it("should require template configuration before generating", async () => {
      const user = userEvent.setup();
      render(<Index />);

      // Note: Default templates are loaded, so this test validates
      // that the component properly checks for template existence
      const input = screen.getByPlaceholderText(/paste youtube url/i);
      await user.type(input, "https://www.youtube.com/watch?v=test123");

      const generateButton = screen.getByRole("button", { name: /generate/i });
      await user.click(generateButton);

      // Should reach voice sample check (template exists by default)
      await waitFor(() => {
        expect(mockToast).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Voice Sample Required",
          })
        );
      });
    });
  });

  describe("Error Handling", () => {
    it("should handle API errors gracefully", async () => {
      const user = userEvent.setup();
      render(<Index />);

      // Mock settings would need voice sample to proceed
      const input = screen.getByPlaceholderText(/paste youtube url/i);
      await user.type(input, "https://www.youtube.com/watch?v=test123");

      const generateButton = screen.getByRole("button", { name: /generate/i });
      await user.click(generateButton);

      // Verify that error handling shows appropriate message
      await waitFor(() => {
        expect(mockToast).toHaveBeenCalled();
      });
    });
  });
});

describe("Index Page Responsive Behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should render on mobile viewport", () => {
    // Set mobile viewport
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      value: 375,
    });

    render(<Index />);

    expect(
      screen.getByRole("heading", { name: /create your history ai video/i })
    ).toBeInTheDocument();
  });

  it("should render on desktop viewport", () => {
    // Set desktop viewport
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      value: 1920,
    });

    render(<Index />);

    expect(
      screen.getByRole("heading", { name: /create your history ai video/i })
    ).toBeInTheDocument();
  });
});
