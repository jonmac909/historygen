/**
 * Test Setup File
 *
 * This file is automatically loaded before each test file.
 * It configures React Testing Library and extends Vitest's expect with custom matchers.
 */

// Import jest-dom matchers for DOM assertions
// Provides matchers like toBeInTheDocument(), toHaveClass(), toBeVisible(), etc.
import "@testing-library/jest-dom";

// Configure Testing Library's cleanup after each test
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Cleanup after each test to ensure tests don't affect each other
afterEach(() => {
  cleanup();
});

// Mock window.matchMedia for components that use media queries
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// Mock ResizeObserver for components that use it
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Mock IntersectionObserver for components that use it
global.IntersectionObserver = class IntersectionObserver {
  readonly root: Element | null = null;
  readonly rootMargin: string = "";
  readonly thresholds: ReadonlyArray<number> = [];

  constructor() {}
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
};
