import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThumbnailGeneratorModal } from "@/components/ThumbnailGeneratorModal";

vi.mock("@/lib/api", () => ({
  generateThumbnailsStreaming: vi.fn(),
  suggestThumbnailPrompts: vi.fn(),
  expandTopicToDescription: vi.fn(),
}));

describe("ThumbnailGeneratorModal", () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      blob: async () => new Blob(["test"], { type: "image/jpeg" }),
    }) as typeof fetch;

    class MockFileReader {
      onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
      onerror: ((event: ProgressEvent<FileReader>) => void) | null = null;

      readAsDataURL() {
        this.onload?.({
          target: { result: "data:image/jpeg;base64,ZmFrZQ==" },
        } as ProgressEvent<FileReader>);
      }
    }

    vi.stubGlobal("FileReader", MockFileReader);
  });

  it("opens the mounted reference input picker from Change Reference", async () => {
    render(
      <ThumbnailGeneratorModal
        isOpen
        projectId="project-1"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    const button = await screen.findByRole("button", { name: /change reference/i });

    const input = await waitFor(() => {
      const element = document.getElementById("thumbnail-ref-input") as
        | (HTMLInputElement & { showPicker?: () => void })
        | null;

      expect(element).not.toBeNull();
      return element!;
    });

    const showPicker = vi.fn();
    Object.defineProperty(input, "showPicker", {
      configurable: true,
      value: showPicker,
    });

    fireEvent.click(button);

    expect(showPicker).toHaveBeenCalledTimes(1);
  });
});
