/**
 * provider-interface.js — Provider Contract & Registry.
 *
 * Defines the interface that all image generation providers must implement,
 * and provides a registry to look them up by name.
 *
 * @typedef {Object} WaitResult
 * @property {'success'|'error'|'timeout'} status
 * @property {Array<{src: string, width: number, height: number}>} [images]
 * @property {string} [error]
 *
 * @typedef {Object} Provider
 * @property {string} name - Unique provider ID (e.g. 'imagefx', 'meta-ai')
 * @property {string} displayName - Human-readable name
 * @property {string} targetUrl - Main page URL
 * @property {string} urlPattern - Substring to match in page URL
 * @property {string} loginUrl - URL to open for login flow
 *
 * @property {(page: import('puppeteer-core').Page) => Promise<void>} preparePage
 *   Prepare the page after navigation (dismiss popups, create new project, etc.)
 *
 * @property {(page: import('puppeteer-core').Page, prompt: string) => Promise<void>} submitPrompt
 *   Clear input, type prompt, and click Generate / press Enter.
 *
 * @property {(page: import('puppeteer-core').Page, promptIndex: number, imgSnapshot: Set<string>, signal?: AbortSignal) => Promise<WaitResult>} waitForImages
 *   Poll the page until new images appear or timeout.
 *
 * @property {(page: import('puppeteer-core').Page) => Promise<boolean>} checkLogin
 *   Return true if the user is logged in.
 *
 * @property {(page: import('puppeteer-core').Page) => Promise<void>} cleanup
 *   Post-prompt cleanup (mark old images, scroll, etc.)
 *
 * @property {(page: import('puppeteer-core').Page) => Promise<string[]>} snapshotImages
 *   Take a snapshot of all current image srcs on the page.
 */

// ── Provider Registry ─────────────────────────────────────────

/** @type {Map<string, Provider>} */
const registry = new Map();

/**
 * Register a provider.
 * @param {Provider} provider
 */
export function registerProvider(provider) {
  registry.set(provider.name, provider);
}

/**
 * Get a registered provider by name.
 * @param {string} name
 * @returns {Provider}
 */
export function getProvider(name) {
  const provider = registry.get(name);
  if (!provider) {
    const available = [...registry.keys()].join(', ');
    throw new Error(
      `Provider "${name}" không tồn tại. Các provider có sẵn: ${available || '(chưa có)'}`
    );
  }
  return provider;
}

/**
 * Get all registered provider names.
 * @returns {string[]}
 */
export function listProviders() {
  return [...registry.keys()];
}

// ── Auto-register built-in providers ──────────────────────────
// Dynamic imports so each provider self-registers on startup.

export async function initProviders() {
  await import('./imagefx/index.js');
  await import('./meta-ai/index.js');
}
