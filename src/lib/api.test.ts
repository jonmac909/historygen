import { describe, it, expect, vi } from 'vitest';

// Mock the Supabase client before importing api.ts
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    functions: {
      invoke: vi.fn(),
    },
    storage: {
      from: vi.fn(() => ({
        upload: vi.fn(),
        getPublicUrl: vi.fn(),
      })),
    },
  },
}));

// Import after mocking
import { calculateDynamicTimeout } from './api';

describe('calculateDynamicTimeout', () => {
  // Constants from the implementation
  const MIN_TIMEOUT_MS = 120000; // 2 minutes
  const MAX_TIMEOUT_MS = 1800000; // 30 minutes
  const WORDS_PER_MINUTE = 150;

  describe('timeout calculation formula', () => {
    it('should calculate timeout based on word count at 150 words/minute', () => {
      // 3000 words / 150 words per minute = 20 minutes = 1,200,000ms
      // ceil(3000/150) = 20 minutes * 60000 = 1,200,000ms (under MAX_TIMEOUT_MS)
      expect(calculateDynamicTimeout(3000)).toBe(1200000);
    });

    it('should return 2 minutes (minimum) for very short scripts', () => {
      // 100 words / 150 = 0.67, ceil = 1 minute = 60000ms
      // But minimum is 120000ms
      expect(calculateDynamicTimeout(100)).toBe(MIN_TIMEOUT_MS);
    });

    it('should return minimum timeout for 0 words', () => {
      // Edge case: 0 words
      expect(calculateDynamicTimeout(0)).toBe(MIN_TIMEOUT_MS);
    });

    it('should return minimum timeout for negative words', () => {
      // Edge case: negative words (invalid input, but should handle gracefully)
      expect(calculateDynamicTimeout(-1000)).toBe(MIN_TIMEOUT_MS);
    });
  });

  describe('word count scenarios from spec', () => {
    it('should return max (1800s / 30 minutes) for 6k words', () => {
      // ceil(6000/150) = 40 minutes * 60000 = 2,400,000ms, capped to 1800000ms (30 min)
      const result = calculateDynamicTimeout(6000);
      expect(result).toBe(MAX_TIMEOUT_MS);
    });

    it('should return max (1800s / 30 minutes) for 12k words', () => {
      // 12000 words / 150 = 80 minutes, capped at 30 minutes
      const result = calculateDynamicTimeout(12000);
      expect(result).toBe(MAX_TIMEOUT_MS);
    });

    it('should return max (1800s / 30 minutes) for 16k words', () => {
      // 16000 words / 150 = 107 minutes, capped at 30 minutes
      const result = calculateDynamicTimeout(16000);
      expect(result).toBe(MAX_TIMEOUT_MS);
    });

    it('should return max (1800s / 30 minutes) for 20k words', () => {
      // 20000 words / 150 = 134 minutes, capped at 30 minutes
      const result = calculateDynamicTimeout(20000);
      expect(result).toBe(MAX_TIMEOUT_MS);
    });
  });

  describe('boundary conditions', () => {
    it('should return minimum timeout for word counts under 300', () => {
      // 300 words / 150 = 2 minutes = 120000ms = MIN_TIMEOUT_MS
      expect(calculateDynamicTimeout(299)).toBe(MIN_TIMEOUT_MS);
      expect(calculateDynamicTimeout(150)).toBe(MIN_TIMEOUT_MS);
      expect(calculateDynamicTimeout(1)).toBe(MIN_TIMEOUT_MS);
    });

    it('should return exactly 2 minutes for 300 words (boundary)', () => {
      // 300 words / 150 = 2 minutes = 120000ms
      expect(calculateDynamicTimeout(300)).toBe(MIN_TIMEOUT_MS);
    });

    it('should return 3 minutes for 301-450 words', () => {
      // ceil(301/150) = 3 minutes = 180000ms
      expect(calculateDynamicTimeout(301)).toBe(180000);
      expect(calculateDynamicTimeout(450)).toBe(180000);
    });

    it('should return 4 minutes for 451-600 words', () => {
      // ceil(451/150) = 4 minutes = 240000ms
      expect(calculateDynamicTimeout(451)).toBe(240000);
      expect(calculateDynamicTimeout(600)).toBe(240000);
    });

    it('should hit max timeout at ~4500 words (30 minutes)', () => {
      // ceil(4500/150) = 30 minutes = 1800000ms = MAX_TIMEOUT_MS
      expect(calculateDynamicTimeout(4500)).toBe(MAX_TIMEOUT_MS);
      // Anything above 4500 should also be max
      expect(calculateDynamicTimeout(4501)).toBe(MAX_TIMEOUT_MS);
    });

    it('should return max timeout for word counts that calculate to > 30 minutes', () => {
      // ceil(4501/150) = 31 minutes, but capped at 30
      expect(calculateDynamicTimeout(4501)).toBe(MAX_TIMEOUT_MS);
      expect(calculateDynamicTimeout(10000)).toBe(MAX_TIMEOUT_MS);
      expect(calculateDynamicTimeout(20000)).toBe(MAX_TIMEOUT_MS);
      expect(calculateDynamicTimeout(30000)).toBe(MAX_TIMEOUT_MS);
    });
  });

  describe('return type', () => {
    it('should return a number', () => {
      expect(typeof calculateDynamicTimeout(1000)).toBe('number');
    });

    it('should return an integer (no decimal milliseconds)', () => {
      const result = calculateDynamicTimeout(1000);
      expect(Number.isInteger(result)).toBe(true);
    });

    it('should handle NaN input without throwing', () => {
      // NaN is an edge case - function should not throw
      // Note: Current implementation returns NaN for NaN input
      // This is acceptable as NaN inputs represent a programming error
      expect(() => calculateDynamicTimeout(NaN)).not.toThrow();
    });
  });

  describe('real-world usage scenarios', () => {
    it('should provide adequate timeout for typical short video (500 words)', () => {
      // 500 words is typical for 3-4 minute video narration
      const timeout = calculateDynamicTimeout(500);
      // Should be at least 2 minutes, at most 30 minutes
      expect(timeout).toBeGreaterThanOrEqual(MIN_TIMEOUT_MS);
      expect(timeout).toBeLessThanOrEqual(MAX_TIMEOUT_MS);
      // Specifically: ceil(500/150) = 4 minutes = 240000ms
      expect(timeout).toBe(240000);
    });

    it('should provide adequate timeout for medium video (2000 words)', () => {
      // 2000 words is typical for 10-15 minute video narration
      const timeout = calculateDynamicTimeout(2000);
      // ceil(2000/150) = 14 minutes = 840000ms (under MAX of 1800000ms)
      expect(timeout).toBe(840000);
    });

    it('should provide adequate timeout for long-form content (8000 words)', () => {
      // 8000 words is typical for documentary or educational deep-dive
      const timeout = calculateDynamicTimeout(8000);
      // ceil(8000/150) = 54 minutes, capped at 30 = 1800000ms
      expect(timeout).toBe(MAX_TIMEOUT_MS);
    });
  });
});
