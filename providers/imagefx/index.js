/**
 * providers/imagefx/index.js — Google Labs ImageFX Provider.
 *
 * Implements the Provider Contract for Google Labs ImageFX / Flow.
 * This is the original generation engine, now wrapped as a provider module.
 */

import { registerProvider } from '../provider-interface.js';
import { TARGET_URL, URL_PATTERN, LOGIN_URL, PLACEHOLDER_TEXTS } from './config.js';
import { TIMING } from '../../config.js';
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
import { log } from '../../logger.js';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const MAX_INPUT_RETRIES = 3;

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

async function submitPrompt(page, prompt, mediaType = 'image') {
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

// ── Check Login ───────────────────────────────────────────────

async function checkLogin(page) {
  return page.evaluate(() => {
    // If we see a Sign In button, we're not logged in
    for (const el of document.querySelectorAll('a, button')) {
      const text = el.textContent.trim().toLowerCase();
      if (text === 'sign in' || text === 'đăng nhập') return false;
    }
    return true;
  });
}

// ── Cleanup ───────────────────────────────────────────────────

async function cleanup(page) {
  await markAllUnclaimedImages(page);
}

// ── Register ──────────────────────────────────────────────────

registerProvider({
  name: 'imagefx',
  displayName: 'Google ImageFX',
  targetUrl: TARGET_URL,
  urlPattern: URL_PATTERN,
  loginUrl: LOGIN_URL,

  preparePage,
  submitPrompt,
  waitForImages,
  checkLogin,
  cleanup,
  snapshotImages,
});
