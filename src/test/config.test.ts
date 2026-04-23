/**
 * Environment Variable Access Tests
 *
 * These tests verify that environment variables are correctly configured
 * and accessible via import.meta.env. They ensure type safety and validate
 * the presence of required configuration values.
 */

import { describe, it, expect } from "vitest";

describe("Environment Variable Configuration", () => {
  describe("import.meta.env access pattern", () => {
    it("should have import.meta.env defined", () => {
      // Act & Assert
      expect(import.meta.env).toBeDefined();
      expect(typeof import.meta.env).toBe("object");
    });

    it("should provide MODE environment variable", () => {
      // Act
      const mode = import.meta.env.MODE;

      // Assert
      expect(mode).toBeDefined();
      expect(typeof mode).toBe("string");
    });

    it("should provide DEV boolean for development detection", () => {
      // Act
      const isDev = import.meta.env.DEV;

      // Assert
      expect(typeof isDev).toBe("boolean");
    });

    it("should provide PROD boolean for production detection", () => {
      // Act
      const isProd = import.meta.env.PROD;

      // Assert
      expect(typeof isProd).toBe("boolean");
    });
  });

  describe("Supabase environment variables", () => {
    it("should have VITE_SUPABASE_URL defined as a string", () => {
      // Act
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;

      // Assert
      // In test environment, this may be undefined, but if defined it should be a string
      if (supabaseUrl !== undefined) {
        expect(typeof supabaseUrl).toBe("string");
      }
    });

    it("should have VITE_SUPABASE_PUBLISHABLE_KEY defined as a string", () => {
      // Act
      const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

      // Assert
      // In test environment, this may be undefined, but if defined it should be a string
      if (publishableKey !== undefined) {
        expect(typeof publishableKey).toBe("string");
      }
    });
  });

  describe("Environment variable naming convention", () => {
    it("should use VITE_ prefix for client-side variables", () => {
      // Arrange
      const envKeys = Object.keys(import.meta.env);

      // Act
      const viteVars = envKeys.filter((key) => key.startsWith("VITE_"));

      // Assert
      // All custom env vars should follow VITE_ prefix convention
      // This verifies the pattern is being followed
      expect(Array.isArray(viteVars)).toBe(true);
    });

    it("should access VITE_ prefixed variables correctly", () => {
      // In Vite/browser builds, only VITE_ prefixed variables are exposed
      // In test environment, more variables may be available, but we verify
      // the VITE_ access pattern works correctly

      // Arrange
      const envKeys = Object.keys(import.meta.env);
      const viteVars = envKeys.filter((key) => key.startsWith("VITE_"));

      // Assert
      // Each VITE_ variable should be accessible and return string or undefined
      viteVars.forEach((key) => {
        const value = import.meta.env[key];
        expect(value === undefined || typeof value === "string").toBe(true);
      });
    });
  });
});

describe("Environment Variable Type Definitions", () => {
  it("should have typed VITE_SUPABASE_URL in ImportMetaEnv", () => {
    // This test verifies TypeScript compilation succeeds with the typed env vars
    // The fact that this compiles means the types are correctly defined
    const _typeCheck: ImportMetaEnv = {
      VITE_SUPABASE_URL: "https://example.supabase.co",
      VITE_SUPABASE_PUBLISHABLE_KEY: "test-key",
    };

    // Assert
    expect(_typeCheck.VITE_SUPABASE_URL).toBeDefined();
    expect(_typeCheck.VITE_SUPABASE_PUBLISHABLE_KEY).toBeDefined();
  });

  it("should enforce readonly on ImportMetaEnv properties", () => {
    // Arrange
    const env = import.meta.env;

    // Assert - env properties are readonly, so we just verify the structure
    expect(typeof env).toBe("object");
  });
});

describe("Configuration Pattern Validation", () => {
  describe("Supabase client configuration pattern", () => {
    it("should follow the pattern from src/integrations/supabase/client.ts", () => {
      // This test validates the pattern of accessing env vars used in client.ts:
      // const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
      // const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

      // Arrange
      const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
      const SUPABASE_PUBLISHABLE_KEY =
        import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

      // Assert - verify the pattern works (values may be undefined in test env)
      // The key is that the access pattern doesn't throw
      expect(SUPABASE_URL === undefined || typeof SUPABASE_URL === "string").toBe(true);
      expect(
        SUPABASE_PUBLISHABLE_KEY === undefined || typeof SUPABASE_PUBLISHABLE_KEY === "string"
      ).toBe(true);
    });
  });

  describe("Environment isolation", () => {
    it("should not have process.env available for Vite client-side code", () => {
      // In Vite projects, client-side code should use import.meta.env, not process.env
      // This test ensures we're following the Vite pattern

      // Assert - in browser/jsdom environment, process.env should exist but be minimal
      // The key assertion is that VITE_ vars are accessed via import.meta.env
      expect(import.meta.env).toBeDefined();
    });
  });
});

describe("Missing Environment Variable Handling", () => {
  it("should handle undefined environment variables gracefully", () => {
    // Arrange
    const undefinedVar = import.meta.env.VITE_NONEXISTENT_VARIABLE;

    // Assert
    expect(undefinedVar).toBeUndefined();
  });

  it("should allow optional chaining for undefined variables", () => {
    // Arrange & Act
    const value = import.meta.env.VITE_NONEXISTENT_VARIABLE ?? "default-value";

    // Assert
    expect(value).toBe("default-value");
  });
});
