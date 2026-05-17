/**
 * downloader.js — Image download via Puppeteer.
 *
 * Downloads generated images by fetching their URLs through the page context
 * (to inherit auth cookies) and saving to local filesystem.
 */

import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { DOWNLOAD } from './config.js';
import { log } from './logger.js';

/**
 * Download an image from a URL using the page's fetch (inherits cookies).
 * Falls back to direct fetch if page fetch fails.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {string} url - Image URL
 * @param {string} filename - Filename (e.g., "1.jfif")
 * @param {string} folder - Subfolder name
 * @returns {Promise<{ok: boolean, path?: string, error?: string}>}
 */
export async function downloadImage(page, url, filename, folder) {
  try {
    const folderPath = join(DOWNLOAD.BASE_DIR, folder);
    await mkdir(folderPath, { recursive: true });
    const filePath = join(folderPath, filename);

    // Fetch image data through the page context (inherits auth cookies)
    const base64 = await page.evaluate(async (imgUrl) => {
      try {
        const response = await fetch(imgUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result.split(',')[1]);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      } catch (e) {
        return null;
      }
    }, url);

    if (!base64) {
      // Fallback: try direct Node.js fetch
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Direct fetch failed: ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      await writeFile(filePath, buffer);
    } else {
      const buffer = Buffer.from(base64, 'base64');
      await writeFile(filePath, buffer);
    }

    log.download(`${folder}/${filename}`);
    return { ok: true, path: filePath };
  } catch (e) {
    log.error(`Download failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}
