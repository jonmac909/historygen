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

  it("renders a directly clickable reference file input for Change Reference", async () => {
    render(
      <ThumbnailGeneratorModal
        isOpen
        projectId="project-1"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    const button = await screen.findByText(/change reference/i);

    const input = await waitFor(() => {
      const element = button.closest("label")?.querySelector('input[type="file"]') as
        | HTMLInputElement
        | null;

      expect(element).not.toBeNull();
      return element!;
    });

    const clickSpy = vi.fn();
    input.addEventListener("click", clickSpy);

    fireEvent.click(button);

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });
});
