/**
 * downloader.js — Image download via Puppeteer.
 *
 * Downloads generated images using multiple strategies:
 *
 * Strategy 1: Open image URL in a new browser tab (best for Meta AI)
 *   → Uses browser's full cookie jar → works for fbcdn.net CDN images
 *
 * Strategy 2: page.evaluate(fetch) with credentials
 *   → Works for same-origin images (ImageFX)
 *
 * Strategy 3: Direct Node.js fetch with headers
 *   → Fallback for public CDN images
 *
 * Strategy 4: Element screenshot (absolute last resort)
 *   → Produces lower quality but always works
 */

import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { DOWNLOAD } from './config.js';
import { log } from './logger.js';

/**
 * Download an image from a URL.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {string} url - Image URL
 * @param {string} filename - Filename (e.g., "1.jpg")
 * @param {string} folder - Subfolder name
 * @returns {Promise<{ok: boolean, path?: string, error?: string}>}
 */
export async function downloadImage(page, url, filename, folder) {
  try {
    const folderPath = join(DOWNLOAD.BASE_DIR, folder);
    await mkdir(folderPath, { recursive: true });
    const filePath = join(folderPath, filename);

    // Strategy 1: Open URL in a new tab (inherits full browser cookie jar)
    // Best for Meta AI (fbcdn.net) and cross-origin images
    const buffer1 = await downloadViaNewTab(page, url);
    if (buffer1) {
      await writeFile(filePath, buffer1);
      log.download(`${folder}/${filename}`);
      return { ok: true, path: filePath };
    }

    // Strategy 2: Fetch via page.evaluate (same-origin / CORS-allowed)
    const base64 = await downloadViaPageFetch(page, url);
    if (base64) {
      const buffer = Buffer.from(base64, 'base64');
      await writeFile(filePath, buffer);
      log.download(`${folder}/${filename}`);
      return { ok: true, path: filePath };
    }

    // Strategy 3: Direct Node.js fetch (public CDN images)
    log.step(`[Download] Thử direct fetch...`);
    const buffer3 = await downloadViaDirect(url);
    if (buffer3) {
      await writeFile(filePath, buffer3);
      log.download(`${folder}/${filename} (direct)`);
      return { ok: true, path: filePath };
    }

    // Strategy 4: Element screenshot (last resort — lower quality)
    log.step(`[Download] Thử screenshot element...`);
    const screenshotted = await screenshotImageElement(page, url, filePath);
    if (screenshotted) {
      log.download(`${folder}/${filename} (screenshot)`);
      return { ok: true, path: filePath };
    }

    throw new Error('All download strategies failed');
  } catch (e) {
    log.error(`Download failed (${filename}): ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/**
 * Strategy 1: Open image URL in a new browser tab.
 * This uses the browser's full cookie jar, bypassing CORS issues.
 * Works great for Meta AI (fbcdn.net) images.
 */
async function downloadViaNewTab(page, url) {
  let newPage = null;
  try {
    const browser = page.browser();
    newPage = await browser.newPage();

    const response = await newPage.goto(url, {
      waitUntil: 'load',
      timeout: 15000,
    });

    if (!response || !response.ok()) {
      return null;
    }

    const buffer = await response.buffer();

    // Verify it's actually an image (at least a few KB)
    if (buffer.length < 500) {
      return null;
    }

    return buffer;
  } catch (e) {
    // Silently fail — we'll try other strategies
    return null;
  } finally {
    if (newPage) {
      try { await newPage.close(); } catch {}
    }
  }
}

/**
 * Strategy 2: Fetch image through page.evaluate (inherits page cookies).
 * Works for same-origin or CORS-allowed images.
 */
async function downloadViaPageFetch(page, url) {
  try {
    const base64 = await page.evaluate(async (imgUrl) => {
      try {
        const response = await fetch(imgUrl, { credentials: 'include' });
        if (!response.ok) return null;

        const blob = await response.blob();
        // Verify it's an image
        if (!blob.type.startsWith('image/')) return null;

        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result.split(',')[1]);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
      } catch (e) {
        return null;
      }
    }, url);

    if (base64 && base64.length > 200) {
      return base64;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Strategy 3: Direct Node.js fetch (no browser cookies).
 * Works for public CDN images.
 */
async function downloadViaDirect(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Referer': 'https://www.meta.ai/',
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

/**
 * Strategy 4: Screenshot a specific <img> element from the page.
 * Last resort — produces lower quality than the original image.
 */
async function screenshotImageElement(page, imgSrc, filePath) {
  try {
    const imgHandle = await page.evaluateHandle((src) => {
      for (const img of document.querySelectorAll('img')) {
        if (img.src === src && img.naturalWidth > 50) {
          img.scrollIntoView({ behavior: 'instant', block: 'center' });
          return img;
        }
      }
      return null;
    }, imgSrc);

    const element = imgHandle.asElement();
    if (!element) {
      imgHandle.dispose();
      return false;
    }

    await new Promise(r => setTimeout(r, 300));
    await element.screenshot({ path: filePath, type: 'jpeg', quality: 95 });
    element.dispose();
    return true;
  } catch {
    return false;
  }
}
