/**
 * PO Token Provider for yt-dlp YouTube bot detection bypass
 *
 * This module manages a background HTTP server that generates YouTube
 * Proof-of-Origin tokens, which yt-dlp uses to bypass bot detection.
 *
 * Uses: https://github.com/Brainicism/bgutil-ytdlp-pot-provider
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

const POT_PROVIDER_PORT = 4416;
const POT_PROVIDER_DIR = path.join(os.tmpdir(), 'bgutil-ytdlp-pot-provider');
const POT_PROVIDER_VERSION = '1.2.2';

let potProviderProcess: ChildProcess | null = null;
let isInitialized = false;
let initPromise: Promise<void> | null = null;

/**
 * Download and build the PO Token provider if not present
 */
async function setupPotProvider(): Promise<void> {
  const serverDir = path.join(POT_PROVIDER_DIR, 'server');
  const buildDir = path.join(serverDir, 'build');
  const mainJs = path.join(buildDir, 'main.js');

  // Check if already built
  if (fs.existsSync(mainJs)) {
    console.log('[pot-provider] Already installed');
    return;
  }

  console.log('[pot-provider] Setting up PO Token provider...');

  // Create directory
  if (!fs.existsSync(POT_PROVIDER_DIR)) {
    fs.mkdirSync(POT_PROVIDER_DIR, { recursive: true });
  }

  // Clone repo
  if (!fs.existsSync(path.join(POT_PROVIDER_DIR, 'server'))) {
    console.log('[pot-provider] Cloning repository...');
    execSync(
      `git clone --single-branch --branch ${POT_PROVIDER_VERSION} --depth 1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git ${POT_PROVIDER_DIR}`,
      { stdio: 'inherit' }
    );
  }

  // Install dependencies
  console.log('[pot-provider] Installing dependencies...');
  execSync('npm install', { cwd: serverDir, stdio: 'inherit' });

  // Build TypeScript
  console.log('[pot-provider] Building...');
  execSync('npx tsc', { cwd: serverDir, stdio: 'inherit' });

  console.log('[pot-provider] Setup complete');
}

/**
 * Start the PO Token provider HTTP server
 */
async function startPotProviderServer(): Promise<void> {
  const mainJs = path.join(POT_PROVIDER_DIR, 'server', 'build', 'main.js');

  if (!fs.existsSync(mainJs)) {
    throw new Error('PO Token provider not built');
  }

  // Check if already running
  if (potProviderProcess) {
    console.log('[pot-provider] Server already running');
    return;
  }

  console.log(`[pot-provider] Starting server on port ${POT_PROVIDER_PORT}...`);

  potProviderProcess = spawn('node', [mainJs, '--port', POT_PROVIDER_PORT.toString()], {
    cwd: path.join(POT_PROVIDER_DIR, 'server'),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  potProviderProcess.stdout?.on('data', (data) => {
    console.log(`[pot-provider] ${data.toString().trim()}`);
  });

  potProviderProcess.stderr?.on('data', (data) => {
    console.error(`[pot-provider] ${data.toString().trim()}`);
  });

  potProviderProcess.on('error', (err) => {
    console.error('[pot-provider] Failed to start:', err);
    potProviderProcess = null;
  });

  potProviderProcess.on('exit', (code) => {
    console.log(`[pot-provider] Server exited with code ${code}`);
    potProviderProcess = null;
  });

  // Wait for server to be ready
  await waitForServer();
}

/**
 * Wait for the PO Token server to be ready
 */
async function waitForServer(maxAttempts = 30): Promise<void> {
  const url = `http://127.0.0.1:${POT_PROVIDER_PORT}/`;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok || response.status === 404) {
        console.log('[pot-provider] Server is ready');
        return;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  throw new Error('PO Token server failed to start');
}

/**
 * Initialize the PO Token provider (download, build, and start)
 */
export async function initPotProvider(): Promise<void> {
  if (isInitialized) {
    return;
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    try {
      await setupPotProvider();
      await startPotProviderServer();
      isInitialized = true;
      console.log('[pot-provider] Initialized successfully');
    } catch (error) {
      console.error('[pot-provider] Failed to initialize:', error);
      // Don't throw - yt-dlp can still work without POT, just with more failures
    }
  })();

  return initPromise;
}

/**
 * Get yt-dlp extractor args for PO Token provider
 */
export function getPotExtractorArgs(): string[] {
  if (!isInitialized || !potProviderProcess) {
    return [];
  }

  return [
    '--extractor-args',
    `youtube:player-client=web;po_token=web+${POT_PROVIDER_PORT}`
  ];
}

/**
 * Get the base URL for the PO Token provider
 */
export function getPotProviderUrl(): string {
  return `http://127.0.0.1:${POT_PROVIDER_PORT}`;
}

/**
 * Check if PO Token provider is available
 */
export function isPotProviderAvailable(): boolean {
  return isInitialized && potProviderProcess !== null;
}

/**
 * Shutdown the PO Token provider
 */
export function shutdownPotProvider(): void {
  if (potProviderProcess) {
    console.log('[pot-provider] Shutting down...');
    potProviderProcess.kill('SIGTERM');
    potProviderProcess = null;
  }
  isInitialized = false;
}

// Cleanup on process exit
process.on('exit', shutdownPotProvider);
process.on('SIGTERM', shutdownPotProvider);
process.on('SIGINT', shutdownPotProvider);
