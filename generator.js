/**
 * generator.js — Core prompt generation pipeline.
 *
 * Provider-agnostic engine that delegates DOM interaction to the
 * active provider (ImageFX, Meta AI, etc.) via the Provider Contract.
 *
 * Handles: prompt submission, image detection, downloading.
 *
 * Key design:
 * - Uses provider.submitPrompt() / provider.waitForImages() instead of
 *   hardcoded page-actions
 * - Downloads via fetch-in-page + fs.writeFile (shared across providers)
 * - Single-threaded (no concurrent prompts) for reliability
 */

import { TIMING } from './config.js';
import { getProvider } from './providers/provider-interface.js';
import { downloadImage } from './downloader.js';
import { log } from './logger.js';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Run the full generation pipeline for a list of prompts.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {object} config
 * @param {string[]} config.prompts
 * @param {string} config.downloadFolder
 * @param {string} [config.providerName='imagefx'] - Provider to use
 * @param {number} [config.maxRetries=2]
 * @param {AbortSignal} [config.signal] - For external stop control
 * @returns {Promise<{results: Array<{prompt: string, status: string, error?: string}>}>}
 */
export async function runGeneration(page, config) {
  const { prompts, downloadFolder, providerName = 'imagefx', maxRetries = 2, signal } = config;
  const provider = getProvider(providerName);
  const results = [];
  const downloadedSrcs = new Set();
  let retryQueue = [];

  log.info(`[${provider.displayName}] Bắt đầu pipeline: ${prompts.length} prompts → ${downloadFolder}/`);

  // Phân tích định dạng đánh số để chọn chiến lược đặt tên tệp ảnh phù hợp
  let usePromptNumbers = false;
  const promptNumbers = [];
  let allHaveNumbers = true;

  for (const p of prompts) {
    const match = p.trim().match(/^(\d+)[.\-:]?\s+/);
    if (match) {
      promptNumbers.push(parseInt(match[1]));
    } else {
      promptNumbers.push(null);
      allHaveNumbers = false;
    }
  }

  if (allHaveNumbers && promptNumbers.length > 0) {
    let hasGaps = false;
    let lastNum = promptNumbers[0];
    for (let i = 1; i < promptNumbers.length; i++) {
      if (promptNumbers[i] !== lastNum + 1) {
        hasGaps = true;
        break;
      }
      lastNum = promptNumbers[i];
    }

    // Nếu có khoảng trống nhảy số (ví dụ: [3, 4, 5, 7] - khuyết 6)
    // hoặc bắt đầu từ một số khác 1 (ví dụ: [4, 5] nhưng là phân đoạn của script lớn hơn),
    // chúng ta sẽ giữ nguyên số ở đầu prompt để khớp với file SRT phụ đề của Capcut.
    if (hasGaps || promptNumbers[0] !== 1) {
      usePromptNumbers = true;
    }
  }

  log.info(`Chiến lược đặt tên ảnh: ${usePromptNumbers ? 'Giữ số thứ tự theo phân đoạn SRT (ví dụ: 3.jpg, 7.jpg)' : 'Tự động đánh số tuần tự từ 1 (ví dụ: 1.jpg, 2.jpg)'}`);

  // Ensure we're on the provider's page
  const currentUrl = page.url();
  if (!currentUrl.includes(provider.urlPattern)) {
    log.step(`Navigating to ${provider.displayName}...`);
    await page.goto(provider.targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(TIMING.NAVIGATE_WAIT);
  }

  // Handle landing page: dismiss popups and prepare
  await provider.preparePage(page);

  // Main queue
  let promptIndex = 0;
  const queue = prompts.map((p, i) => ({ prompt: p, index: i + 1, retryCount: 0 }));

  while (queue.length > 0 || retryQueue.length > 0) {
    if (signal?.aborted) {
      log.warn('Đã nhận lệnh dừng!');
      break;
    }

    const currentQueue = retryQueue.length > 0 ? retryQueue : queue;
    const item = currentQueue.shift();
    if (!item) break;

    const { prompt, index, retryCount } = item;
    const retryLabel = retryCount > 0 ? ` [Retry ${retryCount}/${maxRetries}]` : '';

    log.prompt(index, `${prompt}${retryLabel}`);

    try {
      // Phase 1: Snapshot & Submit prompt
      const imgSnapshot = new Set(await provider.snapshotImages(page));
      await provider.submitPrompt(page, prompt);

      // Phase 2: Wait for result
      const result = await provider.waitForImages(page, index, imgSnapshot, signal);

      if (result.status === 'success') {
        // Phase 3: Download
        const { images } = result;
        log.success(`Prompt #${index}: ${images.length} ảnh tạo xong`);

        // Quyết định tiền tố tên tệp dựa trên chiến lược đặt tên đã phân tích
        let filePrefix = index;
        if (usePromptNumbers) {
          const match = prompt.trim().match(/^(\d+)/);
          if (match) {
            filePrefix = parseInt(match[1]);
          }
        }

        for (let j = 0; j < images.length; j++) {
          if (downloadedSrcs.has(images[j].src)) {
            log.warn(`Ảnh ${j + 1} của prompt #${index} trùng URL với ảnh trước đó, vẫn tiến hành lưu để giữ thứ tự.`);
          }
          downloadedSrcs.add(images[j].src);

          const filename = images.length === 1
            ? `${filePrefix}.jpg`
            : `${filePrefix}_${j + 1}.jpg`;

          await downloadImage(page, images[j].src, filename, downloadFolder);
          await delay(TIMING.DOWNLOAD_SETTLE);
        }

        results.push({ prompt, status: 'success' });
      } else if (result.status === 'error' || result.status === 'timeout') {
        const errorMsg = result.error || result.status;
        if (retryCount < maxRetries) {
          log.warn(`Prompt #${index}: ${errorMsg} → retry ${retryCount + 1}`);
          retryQueue.push({ prompt, index, retryCount: retryCount + 1 });
        } else {
          log.error(`Prompt #${index}: ${errorMsg} → bỏ qua`);
          results.push({ prompt, status: result.status, error: errorMsg });
        }
      }
    } catch (err) {
      log.error(`Prompt #${index}: ${err.message}`);
      if (retryCount < maxRetries) {
        retryQueue.push({ prompt, index, retryCount: retryCount + 1 });
      } else {
        results.push({ prompt, status: 'error', error: err.message });
      }
    }

    // Cleanup: mark unclaimed images
    await provider.cleanup(page);

    // Delay between prompts
    await delay(TIMING.INTER_PROMPT_DELAY);
  }

  // Summary
  const ok = results.filter(r => r.status === 'success').length;
  const fail = results.filter(r => r.status !== 'success').length;
  log.info(`\n${'═'.repeat(50)}`);
  log.success(`Hoàn thành: ${ok}/${prompts.length} thành công, ${fail} thất bại`);

  return { results };
}
