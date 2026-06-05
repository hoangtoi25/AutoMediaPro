/**
 * downloader.js — Media download via Puppeteer.
 *
 * Downloads generated images & videos using multiple strategies:
 *
 * Strategy 0 (Blob): Extract blob: URL data directly from browser context
 *   → Only way to download blob: URLs (Meta AI videos)
 *
 * Strategy 1 (New Tab): Open URL in a new browser tab
 *   → Uses browser's full cookie jar → works for fbcdn.net CDN images
 *
 * Strategy 2 (Page Fetch): page.evaluate(fetch) with credentials
 *   → Works for same-origin images/videos
 *
 * Strategy 3 (Direct Fetch): Node.js fetch with headers
 *   → Fallback for public CDN images/videos
 *
 * Strategy 4 (Screenshot): Element screenshot (absolute last resort)
 *   → Produces lower quality but always works for images
 *   → For videos: captures a single frame as JPEG
 */

import { writeFile, mkdir } from 'fs/promises';
import { join, isAbsolute } from 'path';
import { DOWNLOAD } from './config.js';
import { log } from './logger.js';

/**
 * Download media (image or video) from a URL.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {string} url - Media URL (can be blob:, https://, etc.)
 * @param {string} filename - Filename (e.g., "1.jpg" or "1.mp4")
 * @param {string} folder - Subfolder name (can be absolute path)
 * @returns {Promise<{ok: boolean, path?: string, error?: string}>}
 */
export async function downloadImage(page, url, filename, folder) {
  try {
    const folderPath = isAbsolute(folder) ? folder : join(DOWNLOAD.BASE_DIR, folder);
    await mkdir(folderPath, { recursive: true });
    const filePath = join(folderPath, filename);

    const isBlob = url.startsWith('blob:');
    const isVideo = filename.endsWith('.mp4') || filename.endsWith('.webm');
    const urlPreview = isBlob ? `blob:...${url.slice(-30)}` : url.substring(0, 80);

    log.step(`[Download] ${filename} ← ${urlPreview}${isVideo ? ' (video)' : ''}`);

    // Strategy 0: Blob URL extraction (only for blob: URLs)
    if (isBlob) {
      log.step(`[Download] Strategy 0: Blob extraction...`);
      const blobBuffer = await downloadViaBlobExtract(page, url);
      if (blobBuffer) {
        await writeFile(filePath, blobBuffer);
        log.download(`${folder}/${filename} (blob)`);
        return { ok: true, path: filePath };
      }
      log.warn(`[Download] Blob extraction thất bại, thử screenshot...`);

      // For blob videos, screenshot is the only fallback
      const screenshotted = await screenshotMediaElement(page, url, filePath);
      if (screenshotted) {
        log.download(`${folder}/${filename} (screenshot)`);
        return { ok: true, path: filePath };
      }

      throw new Error('Blob URL extraction and screenshot both failed');
    }

    // ── VIDEO DOWNLOAD ORDER ──────────────────────────────────
    // For video files: page fetch FIRST (Strategy 2), then direct fetch (Strategy 3).
    // SKIP new-tab (Strategy 1) for videos because page.goto(videoUrl)
    // causes Chrome to render an internal video player → response.buffer()
    // hangs indefinitely waiting for the streaming to complete.
    //
    // ── IMAGE DOWNLOAD ORDER ──────────────────────────────────
    // For images: new tab first (Strategy 1), then page fetch, then direct.

    if (isVideo) {
      // Video: cookies-based fetch → page fetch → direct fetch → new-tab → screenshot
      // Note: new-tab HANGS for video URLs because Chrome renders its built-in video player.
      // cookies-based fetch uses Node.js fetch with browser cookies, avoiding Chrome rendering.

      log.step(`[Download] Strategy C (video): Cookies-based fetch...`);
      const bufferC = await downloadViaCookieFetch(page, url);
      if (bufferC) {
        await writeFile(filePath, bufferC);
        log.download(`${folder}/${filename} (cookie-fetch)`);
        return { ok: true, path: filePath };
      }
      log.step(`[Download] Strategy C thất bại, thử page fetch...`);

      const buffer2 = await downloadViaPageFetch(page, url, true);
      if (buffer2) {
        await writeFile(filePath, buffer2);
        log.download(`${folder}/${filename} (page-fetch)`);
        return { ok: true, path: filePath };
      }
      log.step(`[Download] Strategy 2 thất bại, thử direct fetch...`);

      const buffer3 = await downloadViaDirect(url);
      if (buffer3) {
        await writeFile(filePath, buffer3);
        log.download(`${folder}/${filename} (direct)`);
        return { ok: true, path: filePath };
      }
      log.step(`[Download] All video fetch strategies thất bại, thử screenshot frame...`);

      const screenshotted = await screenshotMediaElement(page, url, filePath);
      if (screenshotted) {
        log.download(`${folder}/${filename} (screenshot-frame)`);
        return { ok: true, path: filePath };
      }
    } else {
      // Image: new tab → page fetch → direct fetch → screenshot
      log.step(`[Download] Strategy 1: New tab...`);
      const buffer1 = await downloadViaNewTab(page, url);
      if (buffer1) {
        await writeFile(filePath, buffer1);
        log.download(`${folder}/${filename}`);
        return { ok: true, path: filePath };
      }
      log.step(`[Download] Strategy 1 thất bại, thử page fetch...`);

      const buffer2 = await downloadViaPageFetch(page, url, false);
      if (buffer2) {
        await writeFile(filePath, buffer2);
        log.download(`${folder}/${filename} (page-fetch)`);
        return { ok: true, path: filePath };
      }
      log.step(`[Download] Strategy 2 thất bại, thử direct fetch...`);

      const buffer3 = await downloadViaDirect(url);
      if (buffer3) {
        await writeFile(filePath, buffer3);
        log.download(`${folder}/${filename} (direct)`);
        return { ok: true, path: filePath };
      }
      log.step(`[Download] Strategy 3 thất bại, thử screenshot...`);

      const screenshotted = await screenshotMediaElement(page, url, filePath);
      if (screenshotted) {
        log.download(`${folder}/${filename} (screenshot)`);
        return { ok: true, path: filePath };
      }
    }

    throw new Error('All download strategies failed');
  } catch (e) {
    log.error(`Download failed (${filename}): ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ── Strategy 0: Blob URL Extraction ─────────────────────────────

/**
 * Extract blob: URL data directly from the browser context.
 * This is the ONLY way to download blob: URLs since they are
 * bound to the page's origin and can't be accessed externally.
 *
 * Uses XMLHttpRequest in the browser to read the blob as ArrayBuffer,
 * then converts to base64 and transfers to Node.js.
 */
async function downloadViaBlobExtract(page, blobUrl) {
  try {
    const base64 = await page.evaluate(async (url) => {
      try {
        // Method 1: Fetch API
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
        const blob = await response.blob();

        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const result = reader.result;
            if (result && result.includes(',')) {
              resolve(result.split(',')[1]);
            } else {
              resolve(null);
            }
          };
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
      } catch (e1) {
        // Method 2: XMLHttpRequest (fallback)
        try {
          return new Promise((resolve) => {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.responseType = 'blob';
            xhr.timeout = 30000;
            xhr.onload = () => {
              if (xhr.status !== 200) { resolve(null); return; }
              const reader = new FileReader();
              reader.onloadend = () => {
                const result = reader.result;
                if (result && result.includes(',')) {
                  resolve(result.split(',')[1]);
                } else {
                  resolve(null);
                }
              };
              reader.onerror = () => resolve(null);
              reader.readAsDataURL(xhr.response);
            };
            xhr.onerror = () => resolve(null);
            xhr.ontimeout = () => resolve(null);
            xhr.send();
          });
        } catch {
          return null;
        }
      }
    }, blobUrl);

    if (base64 && base64.length > 200) {
      return Buffer.from(base64, 'base64');
    }
    return null;
  } catch (e) {
    log.warn(`[Download] Blob extract error: ${e.message}`);
    return null;
  }
}

// ── Strategy 1: New Tab ─────────────────────────────────────────

/**
 * Open media URL in a new browser tab.
 * Uses the browser's full cookie jar, bypassing CORS issues.
 * Works great for Meta AI (fbcdn.net) images & video CDN URLs.
 */
async function downloadViaNewTab(page, url, timeout = 20000) {
  // Skip blob URLs — they can't be opened in a new tab
  if (url.startsWith('blob:')) return null;

  let newPage = null;
  try {
    const browser = page.browser();
    newPage = await browser.newPage();

    const response = await newPage.goto(url, {
      waitUntil: 'load',
      timeout,
    });

    if (!response || !response.ok()) {
      return null;
    }

    const buffer = await response.buffer();

    // Verify it's a real file (at least a few KB)
    if (buffer.length < 500) {
      return null;
    }

    return buffer;
  } catch (e) {
    // Fail silently — we'll try other strategies
    return null;
  } finally {
    if (newPage) {
      try { await newPage.close(); } catch {}
    }
  }
}

// ── Strategy 2: Page Fetch ──────────────────────────────────────

/**
 * Fetch media through page.evaluate (inherits page cookies).
 * For videos, transfers as chunked base64 to avoid memory issues.
 */
async function downloadViaPageFetch(page, url, isVideo = false) {
  // Skip blob URLs — handled by Strategy 0
  if (url.startsWith('blob:')) return null;

  try {
    const result = await page.evaluate(async (mediaUrl) => {
      try {
        const response = await fetch(mediaUrl, { credentials: 'include' });
        if (!response.ok) return { error: `HTTP ${response.status} ${response.statusText}` };

        const blob = await response.blob();
        const type = blob.type || 'unknown';
        const size = blob.size;

        // Accept any media type or octet-stream
        const validTypes = ['image/', 'video/', 'application/octet-stream', 'binary/'];
        const isValidType = validTypes.some(t => type.startsWith(t));
        if (!isValidType) {
          return { error: `Invalid content-type: ${type} (size: ${size})` };
        }

        // Skip files larger than 100MB (too large for base64 transfer)
        if (size > 100 * 1024 * 1024) {
          return { error: `File too large: ${(size / 1024 / 1024).toFixed(1)}MB` };
        }

        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const dataUrl = reader.result;
            if (dataUrl && dataUrl.includes(',')) {
              resolve({ ok: true, base64: dataUrl.split(',')[1], type, size });
            } else {
              resolve({ error: 'FileReader returned empty result' });
            }
          };
          reader.onerror = () => resolve({ error: 'FileReader error' });
          reader.readAsDataURL(blob);
        });
      } catch (e) {
        return { error: e.message || 'Unknown fetch error' };
      }
    }, url);

    if (result && result.ok && result.base64 && result.base64.length > 200) {
      log.step(`[Download] Page fetch OK: ${result.type} (${(result.size / 1024).toFixed(0)}KB)`);
      return Buffer.from(result.base64, 'base64');
    }
    if (result && result.error) {
      log.warn(`[Download] Page fetch failed: ${result.error}`);
    }
    return null;
  } catch (e) {
    log.warn(`[Download] Page fetch exception: ${e.message}`);
    return null;
  }
}

// ── Strategy C: Cookie-based Fetch (Node.js with browser cookies) ───

/**
 * Download using Node.js fetch with cookies extracted from the browser.
 * This avoids Chrome's built-in video player which causes new-tab to hang.
 * The cookies provide authentication for Google Flow API redirect URLs.
 */
async function downloadViaCookieFetch(page, url) {
  if (url.startsWith('blob:')) return null;

  try {
    // Extract cookies from the browser
    const cookies = await page.cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    log.step(`[Download] Cookie fetch: ${cookies.length} cookies, following redirects...`);

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'video/mp4,video/webm,video/*,image/*,*/*;q=0.8',
        'Cookie': cookieHeader,
        'Referer': 'https://labs.google/',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      log.warn(`[Download] Cookie fetch HTTP ${response.status} ${response.statusText}`);
      return null;
    }

    const contentType = response.headers.get('content-type') || '';
    const contentLength = response.headers.get('content-length') || '?';
    log.step(`[Download] Cookie fetch response: ${contentType} (${contentLength} bytes)`);

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 500) {
      log.warn(`[Download] Cookie fetch: file too small (${buffer.length} bytes)`);
      return null;
    }

    log.step(`[Download] Cookie fetch OK: ${(buffer.length / 1024).toFixed(0)}KB`);
    return buffer;
  } catch (e) {
    log.warn(`[Download] Cookie fetch error: ${e.message}`);
    return null;
  }
}

// ── Strategy 3: Direct Fetch ────────────────────────────────────

/**
 * Direct Node.js fetch (no browser cookies).
 * Works for public CDN images/videos.
 */
async function downloadViaDirect(url) {
  // Skip blob URLs
  if (url.startsWith('blob:')) return null;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/*,video/mp4,video/webm,video/*,*/*;q=0.8',
        'Referer': 'https://labs.google/',
        'Sec-Fetch-Dest': 'image',
        'Sec-Fetch-Mode': 'no-cors',
      },
      redirect: 'follow',
    });

    if (!response.ok) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 500) return null;

    return buffer;
  } catch {
    return null;
  }
}

// ── Strategy 4: Screenshot Element ──────────────────────────────

/**
 * Screenshot a specific <img> or <video> element from the page.
 * Last resort — produces lower quality than the original media.
 * For videos, captures the current visible frame.
 */
async function screenshotMediaElement(page, mediaSrc, filePath) {
  try {
    const imgHandle = await page.evaluateHandle((src) => {
      // Try image first
      for (const img of document.querySelectorAll('img')) {
        if (img.src === src && img.naturalWidth > 50) {
          img.scrollIntoView({ behavior: 'instant', block: 'center' });
          return img;
        }
      }
      // Try video next
      for (const vid of document.querySelectorAll('video')) {
        let vidSrc = vid.src;
        if (!vidSrc) {
          const source = vid.querySelector('source');
          if (source) vidSrc = source.src;
        }
        if (vidSrc === src) {
          vid.scrollIntoView({ behavior: 'instant', block: 'center' });
          return vid;
        }
      }
      return null;
    }, mediaSrc);

    const element = imgHandle.asElement();
    if (!element) {
      imgHandle.dispose();
      return false;
    }

    await new Promise(r => setTimeout(r, 500));
    await element.screenshot({ path: filePath, type: 'jpeg', quality: 95 });
    element.dispose();
    return true;
  } catch {
    return false;
  }
}
