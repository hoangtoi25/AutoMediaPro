/**
 * generator.js — Core prompt generation pipeline.
 *
 * Ported from AutoMedia/generation.js.
 * Handles: prompt submission, image detection, downloading.
 *
 * Key difference from extension version:
 * - Uses Puppeteer page API instead of CDP message-passing
 * - Downloads via fetch-in-page + fs.writeFile instead of chrome.downloads
 * - Single-threaded (no concurrent prompts) for reliability
 */

import { TIMING, PLACEHOLDER_TEXTS, TARGET_URL } from './config.js';
import {
  findInputElement,
  findGenerateButton,
  typePrompt,
  getInputText,
  snapshotImages,
  findNewImages,
  findClaimedImages,
  isStillRendering,
  detectError,
  claimImages,
  markAllUnclaimedImages,
} from './page-actions.js';
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
 * @param {number} [config.maxRetries=2]
 * @param {AbortSignal} [config.signal] - For external stop control
 * @returns {Promise<{results: Array<{prompt: string, status: string, error?: string}>}>}
 */
export async function runGeneration(page, config) {
  const { prompts, downloadFolder, maxRetries = 2, signal } = config;
  const results = [];
  const downloadedSrcs = new Set();
  let retryQueue = [];

  log.info(`Bắt đầu pipeline: ${prompts.length} prompts → ${downloadFolder}/`);

  // Ensure we're on the ImageFX page
  const currentUrl = page.url();
  if (!currentUrl.includes('labs.google/fx')) {
    log.step(`Navigating to ImageFX...`);
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(TIMING.NAVIGATE_WAIT);
  }

  // Handle landing page: dismiss popups and create new project
  await preparePage(page);

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
      // Phase 1: Submit prompt
      const imgSnapshot = new Set(await snapshotImages(page));
      await submitPrompt(page, prompt);

      // Phase 2: Wait for result
      const result = await waitForImages(page, index, imgSnapshot, signal);

      if (result.status === 'success') {
        // Phase 3: Download
        const { images } = result;
        log.success(`Prompt #${index}: ${images.length} ảnh tạo xong`);

        // Extract file prefix from prompt (e.g., "42. prompt text" → "42")
        let filePrefix = index;
        const match = prompt.match(/^(\d+)[.\-:]?\s+/);
        if (match) filePrefix = match[1];

        for (let j = 0; j < images.length; j++) {
          if (downloadedSrcs.has(images[j].src)) {
            log.warn(`Ảnh ${j + 1} của prompt #${index} trùng URL với ảnh trước đó, vẫn tiến hành lưu để giữ thứ tự.`);
          }
          downloadedSrcs.add(images[j].src);

          const filename = images.length === 1
            ? `${filePrefix}.jfif`
            : `${filePrefix}_${j + 1}.jfif`;

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
    await markAllUnclaimedImages(page);

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

// ── Prepare Page (Handle Landing Flow) ────────────────────────

/**
 * Handle the ImageFX landing page flow:
 * 1. Dismiss "Welcome to Flow!" popup if present
 * 2. Click "+ Dự án mới" (New Project) button to create a new project
 * 3. Wait for the prompt input element to appear
 */
async function preparePage(page) {
  log.step('Kiểm tra trạng thái trang...');

  // Step 1: Dismiss "Welcome to Flow!" popup
  const dismissedPopup = await page.evaluate(() => {
    // Look for "Get started with Flow" or close button in the popup
    for (const btn of document.querySelectorAll('button')) {
      const text = btn.textContent.trim();
      if (text.includes('Get started with Flow') || text.includes('Bắt đầu với Flow')) {
        btn.click();
        return 'get-started';
      }
    }
    // Try close button (×) on the popup
    for (const btn of document.querySelectorAll('button')) {
      const text = btn.textContent.trim();
      if (text === '×' || text === 'close' || text === 'Close') {
        const dialog = btn.closest('[role="dialog"], .modal, [class*="dialog"]');
        if (dialog) {
          btn.click();
          return 'close-btn';
        }
      }
    }
    return null;
  });

  if (dismissedPopup) {
    log.step(`Đã đóng popup Welcome (${dismissedPopup})`);
    await delay(1500);
  }

  // Step 2: Check if we already have an input element (already in a project)
  let inputEl = await findInputElement(page);
  if (inputEl) {
    log.step('Ô nhập liệu đã sẵn sàng');
    return;
  }

  // Step 3: Click "+ Dự án mới" / "+ New project" button
  log.step('Tìm nút "Dự án mới"...');
  const clickedNew = await page.evaluate(() => {
    // Strategy 1: Look for the exact text
    const newProjectTexts = [
      'Dự án mới', 'New project', 'New creation',
      'Tạo mới', 'Create new', 'Start creating',
    ];
    for (const el of document.querySelectorAll('button, div[role="button"], a')) {
      const text = el.textContent.trim();
      for (const target of newProjectTexts) {
        if (text.includes(target)) {
          el.click();
          return text;
        }
      }
    }
    // Strategy 2: Look for "+" icon with nearby text
    for (const el of document.querySelectorAll('button, div[role="button"], a')) {
      const text = el.textContent.trim();
      if (text.startsWith('+') || text.includes('add')) {
        el.click();
        return text;
      }
    }
    return null;
  });

  if (clickedNew) {
    log.step(`Đã click: "${clickedNew}"`);
    await delay(3000);
  } else {
    log.warn('Không tìm thấy nút tạo dự án mới, thử tìm ô nhập trực tiếp...');
  }

  // Step 4: Wait for the input element to appear
  log.step('Chờ ô nhập liệu xuất hiện...');
  for (let i = 0; i < 20; i++) { // Max 20 * 1s = 20 seconds
    inputEl = await findInputElement(page);
    if (inputEl) {
      log.success('Ô nhập liệu đã sẵn sàng!');
      return;
    }
    await delay(1000);
  }

  // If still no input, try one more time to find and click new project
  log.warn('Vẫn chưa thấy ô nhập, thử scroll và tìm lại...');
  await page.evaluate(() => window.scrollTo(0, 0));
  await delay(1000);

  // Last resort: take a screenshot for debugging
  const screenshotPath = `debug-landing-${Date.now()}.png`;
  await page.screenshot({ path: screenshotPath, fullPage: true });
  log.warn(`Đã chụp screenshot debug: ${screenshotPath}`);

  throw new Error('Không tìm thấy ô nhập liệu sau khi chuẩn bị trang. Có thể cần login lại hoặc trang đã thay đổi.');
}

// ── Submit Prompt ─────────────────────────────────────────────

const MAX_INPUT_RETRIES = 3;

async function submitPrompt(page, prompt) {
  for (let attempt = 0; attempt < MAX_INPUT_RETRIES; attempt++) {
    const inputEl = await findInputElement(page);
    if (!inputEl) throw new Error('Không tìm thấy ô nhập liệu');

    // Scroll into view
    await inputEl.evaluate(el => el.scrollIntoView({ behavior: 'instant', block: 'center' }));
    await delay(200);

    // Type prompt
    log.step('Đang nhập prompt...');
    await typePrompt(page, inputEl, prompt);

    // Verify input
    const text = await getInputText(page);
    if (text.length > 5 && !PLACEHOLDER_TEXTS.includes(text)) {
      log.step(`Đã nhập (${text.length} ký tự)`);
      break;
    }

    log.warn(`Ô nhập trống sau khi gõ! Retry ${attempt + 1}/${MAX_INPUT_RETRIES}`);
    await delay(1000);
    if (attempt === MAX_INPUT_RETRIES - 1) {
      throw new Error('Không nhập được prompt sau nhiều lần thử');
    }
  }

  // Find and click Generate button
  const generateBtn = await findGenerateButton(page);
  if (!generateBtn) throw new Error('Không tìm thấy nút Generate');

  await generateBtn.evaluate(el => el.scrollIntoView({ behavior: 'instant', block: 'center' }));
  await delay(150);
  log.step('Bấm Generate...');
  await generateBtn.click();
}

// ── Wait for Images ───────────────────────────────────────────

async function waitForImages(page, promptIndex, imgSnapshot, signal) {
  let waitCount = 0;
  let claimed = false;
  let claimedSrcs = [];

  log.step(`Chờ ảnh mới cho prompt #${promptIndex}...`);

  while (waitCount < TIMING.MAX_WAIT_POLLS) {
    if (signal?.aborted) return { status: 'error', error: 'Stopped by user' };

    await delay(TIMING.POLL_INTERVAL);
    waitCount += 3; // ~3 seconds per poll

    if (!claimed) {
      const newImgs = await findNewImages(page, imgSnapshot);

      if (newImgs.length === 0) {
        if (waitCount >= TIMING.PHASE1_TIMEOUT_S) {
          return { status: 'timeout', error: 'Không thấy ảnh mới sau timeout' };
        }

        // Check for errors
        const err = await detectError(page);
        if (err) return { status: 'error', error: err };

        if (waitCount % 15 === 0) {
          log.step(`⏳ Chờ ảnh mới... (${waitCount}s)`);
        }
        continue;
      }

      // Claim new images
      claimedSrcs = newImgs.map(i => i.src);
      await claimImages(page, claimedSrcs, promptIndex);
      claimed = true;
      log.step(`Claimed ${claimedSrcs.length} ảnh mới`);
    }

    // Check if still rendering
    const rendering = await isStillRendering(page);
    if (rendering) {
      if (waitCount % 9 === 0) log.step('🔄 Đang render...');
      continue;
    }

    // Check for errors after claiming
    const postErr = await detectError(page);
    if (postErr) return { status: 'error', error: postErr };

    // Re-validate claimed images are fully loaded
    const claimedImgs = await findClaimedImages(page, promptIndex);
    const validImgs = claimedImgs.filter(i => i.width >= 100 && i.height >= 100);

    if (validImgs.length === 0) {
      if (waitCount % 15 === 0) {
        log.step(`⏳ Ảnh chưa sẵn sàng... (claimed: ${claimedImgs.length}, valid: ${validImgs.length})`);
      }
      continue;
    }

    // Success!
    await delay(TIMING.IMAGE_LOAD_WAIT);
    return { status: 'success', images: validImgs };
  }

  return { status: 'timeout', error: 'Quá thời gian chờ' };
}
