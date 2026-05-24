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
  const { prompts, downloadFolder, providerName = 'imagefx', maxRetries = 2, mediaType = 'image', signal } = config;
  const provider = getProvider(providerName);
  const results = [];
  const downloadedSrcs = new Set();
  let retryQueue = [];

  log.info(`[${provider.displayName}] Bắt đầu pipeline: ${prompts.length} prompts → ${downloadFolder}/ (mode: ${mediaType})`);

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

  // Parse --ar (aspect ratio) from the first prompt to apply to settings panel
  let detectedAspectRatio = 'auto';
  if (prompts.length > 0) {
    const arMatch = prompts[0].match(/--ar\s+([\d]+:[\d]+)/i);
    if (arMatch) {
      detectedAspectRatio = arMatch[1]; // e.g. '9:16' or '16:9'
      log.info(`Tỷ lệ khung hình từ prompt đầu: ${detectedAspectRatio}`);
    }
  }

  // Strip --ar flags from all prompts (ImageFX uses settings panel, not prompt text)
  const cleanPrompts = prompts.map(p => p.replace(/\s*--ar\s+[\d]+:[\d]+/gi, '').trim());

  // Ensure we're on the provider's page
  const currentUrl = page.url();
  if (!currentUrl.includes(provider.urlPattern)) {
    log.step(`Navigating to ${provider.displayName}...`);
    await page.goto(provider.targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(TIMING.NAVIGATE_WAIT);
  }

  // Handle landing page: dismiss popups, select mode, configure settings
  await provider.preparePage(page, mediaType, { aspectRatio: detectedAspectRatio });


  // Main queue (use cleanPrompts with --ar stripped for actual submission)
  let promptIndex = 0;
  const queue = cleanPrompts.map((p, i) => ({ prompt: p, index: i + 1, retryCount: 0 }));

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
      await provider.submitPrompt(page, prompt, mediaType);

      // Phase 2: Wait for result
      const result = await provider.waitForImages(page, index, imgSnapshot, signal, mediaType);

      if (result.status === 'success') {
        // Phase 3: Download
        const { images } = result;

        // In video mode: only download videos, skip thumbnail images
        let downloadList = images;
        if (mediaType === 'video') {
          const videos = images.filter(i => i.type === 'video');
          if (videos.length > 0) {
            downloadList = videos;
          }
          // If no videos found, fall back to all media (images as last resort)
        }

        const vidCount = downloadList.filter(i => i.type === 'video').length;
        const imgCount = downloadList.length - vidCount;
        const mediaLabel = [imgCount > 0 ? `${imgCount} ảnh` : '', vidCount > 0 ? `${vidCount} video` : ''].filter(Boolean).join(' + ');
        log.success(`Prompt #${index}: ${mediaLabel} tạo xong`);

        // Quyết định tiền tố tên tệp dựa trên chiến lược đặt tên đã phân tích
        let filePrefix = index;
        if (usePromptNumbers) {
          const match = prompt.trim().match(/^(\d+)/);
          if (match) {
            filePrefix = parseInt(match[1]);
          }
        }

        for (let j = 0; j < downloadList.length; j++) {
          if (downloadedSrcs.has(downloadList[j].src)) {
            log.warn(`Media ${j + 1} của prompt #${index} trùng URL với media trước đó, vẫn tiến hành lưu để giữ thứ tự.`);
          }
          downloadedSrcs.add(downloadList[j].src);

          const isVideo = downloadList[j].type === 'video';
          const ext = isVideo ? '.mp4' : '.jpg';
          const filename = downloadList.length === 1
            ? `${filePrefix}${ext}`
            : `${filePrefix}_${j + 1}${ext}`;

          await downloadImage(page, downloadList[j].src, filename, downloadFolder);
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
