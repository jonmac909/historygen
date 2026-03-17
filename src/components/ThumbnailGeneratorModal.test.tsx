import { fireEvent, render, screen } from "@testing-library/react";
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

  it("renders a full-width reference upload control backed by a file input", async () => {
    render(
      <ThumbnailGeneratorModal
        isOpen
        projectId="project-1"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    const fileInput = await screen.findByLabelText("Change reference image") as HTMLInputElement;
    expect(fileInput).not.toBeNull();

    const clickSpy = vi.fn();
    fileInput.addEventListener("click", clickSpy);

    fireEvent.click(fileInput);

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });
});
