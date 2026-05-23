/**
 * providers/meta-ai/index.js — Meta AI Imagine Provider.
 *
 * Implements the Provider Contract for Meta AI image generation.
 * Meta AI uses a chat interface with action buttons. The user must
 * click "Create image" to enter image generation mode before typing.
 *
 * Flow per prompt:
 *   1. Click "Create image" button (action chip)
 *   2. Type the prompt into the input field
 *   3. Press Enter / click Send
 *   4. Wait for generated images in the response
 *
 * Key differences from ImageFX:
 * - Chat-based UI with mode-switching action buttons
 * - Must click "Create image" before each prompt
 * - Images appear inline in chat response bubbles
 * - Login via Facebook/Meta account
 * - Needs to filter out avatars, emoji, and UI images from results
 */

import { registerProvider } from '../provider-interface.js';
import { TARGET_URL, URL_PATTERN, LOGIN_URL, PLACEHOLDER_TEXTS, META_TIMING } from './config.js';
import { TIMING } from '../../config.js';
import {
  findInputElement,
  findSendButton,
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

// ── Click "Create image" Action Button ────────────────────────

/**
 * Click the "Create image" action chip/button on Meta AI.
 * This switches the chat into image generation mode.
 * Must be called before each prompt.
 *
 * Meta AI shows action buttons like:
 *   [Learn and grow] [Analyze for me] [Create image] [Create video]
 *
 * After clicking, the input field may change placeholder or show
 * a mode indicator. We wait briefly for the UI to settle.
 */
async function clickCreateImage(page) {
  log.step('[Meta AI] Tìm nút "Create image"...');

  const clicked = await page.evaluate(() => {
    // Strategy 1: Find by exact text content
    const targetTexts = [
      'Create image', 'Tạo ảnh', 'create image',
      'Generate image', 'Imagine',
    ];

    // Look in buttons, chips, and clickable elements
    const allClickable = document.querySelectorAll(
      'button, [role="button"], a, div[tabindex], span[tabindex]'
    );

    for (const el of allClickable) {
      const text = el.textContent.trim();
      for (const target of targetTexts) {
        if (text.toLowerCase() === target.toLowerCase()) {
          el.click();
          return text;
        }
      }
    }

    // Strategy 2: Find by partial match (chip-style buttons)
    for (const el of allClickable) {
      const text = el.textContent.trim().toLowerCase();
      if (text.includes('create image') || text.includes('tạo ảnh')) {
        el.click();
        return el.textContent.trim();
      }
    }

    // Strategy 3: Find by aria-label
    for (const el of allClickable) {
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      if (label.includes('create image') || label.includes('tạo ảnh')) {
        el.click();
        return label;
      }
    }

    return null;
  });

  if (clicked) {
    log.step(`[Meta AI] Đã click: "${clicked}"`);
    await delay(1500); // Wait for mode switch UI to settle
    return true;
  }

  log.warn('[Meta AI] Không tìm thấy nút "Create image" — có thể đã ở chế độ ảnh hoặc UI đã thay đổi');
  return false;
}

// ── Prepare Page ──────────────────────────────────────────────

/**
 * Prepare the Meta AI page for automation:
 * 1. Dismiss any cookie consent / welcome dialogs
 * 2. Wait for the chat input to be available
 * 3. Click "Create image" to enter image generation mode
 */
async function preparePage(page) {
  log.step('[Meta AI] Kiểm tra trạng thái trang...');

  // Step 1: Dismiss cookie/welcome popups
  const dismissed = await page.evaluate(() => {
    const dismissTexts = [
      'Accept', 'Chấp nhận', 'Accept all', 'Chấp nhận tất cả',
      'Got it', 'OK', 'Continue', 'Tiếp tục',
      'Close', 'Đóng', 'Skip', 'Bỏ qua',
      'Get started', 'Bắt đầu',
    ];

    for (const btn of document.querySelectorAll('button, a[role="button"]')) {
      const text = btn.textContent.trim();
      for (const target of dismissTexts) {
        if (text.toLowerCase() === target.toLowerCase() || text.includes(target)) {
          btn.click();
          return text;
        }
      }
    }

    const closeButtons = document.querySelectorAll(
      'button[aria-label="Close"], button[aria-label="Đóng"], [data-testid*="close"]'
    );
    if (closeButtons.length > 0) {
      closeButtons[0].click();
      return 'close-modal';
    }

    return null;
  });

  if (dismissed) {
    log.step(`[Meta AI] Đã đóng popup: "${dismissed}"`);
    await delay(2000);
  }

  // Step 2: Wait for chat input to appear
  log.step('[Meta AI] Chờ ô nhập liệu...');
  for (let i = 0; i < 30; i++) {
    const inputEl = await findInputElement(page);
    if (inputEl) {
      log.success('[Meta AI] Ô nhập liệu đã sẵn sàng!');
      break;
    }
    await delay(1000);
    if (i === 29) {
      const screenshotPath = `debug-meta-ai-${Date.now()}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: true });
      log.warn(`[Meta AI] Đã chụp screenshot debug: ${screenshotPath}`);
      throw new Error('[Meta AI] Không tìm thấy ô nhập liệu. Có thể cần login Facebook hoặc trang đã thay đổi.');
    }
  }

  // Step 3: Click "Create image" to enter image mode
  await clickCreateImage(page);
}

// ── Submit Prompt ─────────────────────────────────────────────

/**
 * Submit a prompt to Meta AI.
 * Clicks "Create image" first to enter image mode, then types the prompt.
 * No "Imagine" prefix needed — the mode button handles intent.
 */
async function submitPrompt(page, prompt) {
  // Click "Create image" before each prompt to ensure we're in image mode
  // (after the first image is generated, Meta AI may reset to normal chat)
  await clickCreateImage(page);

  for (let attempt = 0; attempt < MAX_INPUT_RETRIES; attempt++) {
    const inputEl = await findInputElement(page);
    if (!inputEl) throw new Error('[Meta AI] Không tìm thấy ô nhập liệu');

    // Scroll into view
    await inputEl.evaluate(el => el.scrollIntoView({ behavior: 'instant', block: 'center' }));
    await delay(200);

    // Type prompt (no prefix — "Create image" mode is already active)
    log.step('[Meta AI] Đang nhập prompt...');
    await typePrompt(page, inputEl, prompt);

    // Verify input
    const text = await getInputText(page);
    if (text.length > 5) {
      log.step(`[Meta AI] Đã nhập (${text.length} ký tự)`);
      break;
    }

    log.warn(`[Meta AI] Ô nhập trống sau khi gõ! Retry ${attempt + 1}/${MAX_INPUT_RETRIES}`);
    await delay(1000);
    if (attempt === MAX_INPUT_RETRIES - 1) {
      throw new Error('[Meta AI] Không nhập được prompt sau nhiều lần thử');
    }
  }

  // Submit: Try Enter key first, fallback to send button
  log.step('[Meta AI] Gửi prompt...');

  // Try pressing Enter
  await page.keyboard.press('Enter');
  await delay(META_TIMING.RESPONSE_WAIT);

  // Verify the input was cleared (means message was sent)
  const postText = await getInputText(page);
  if (postText.length > 5) {
    // Enter didn't work — try clicking send button
    log.step('[Meta AI] Enter không gửi được, thử click nút Send...');
    const sendBtn = await findSendButton(page);
    if (sendBtn) {
      await sendBtn.click();
      await delay(META_TIMING.RESPONSE_WAIT);
    } else {
      log.warn('[Meta AI] Không tìm thấy nút Send, thử Ctrl+Enter...');
      await page.keyboard.down('Control');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Control');
      await delay(META_TIMING.RESPONSE_WAIT);
    }
  }
}

// ── Wait for Images ───────────────────────────────────────────

/**
 * Wait for Meta AI to generate and display images.
 * Polls the chat for new image elements.
 */
async function waitForImages(page, promptIndex, imgSnapshot, signal) {
  let waitCount = 0;
  let claimed = false;
  let claimedSrcs = [];
  let renderWaitCount = 0; // Track time spent in render-after-claim phase
  const MAX_RENDER_EXTRA_S = 15; // Max extra seconds to wait after claiming images

  log.step(`[Meta AI] Chờ ảnh mới cho prompt #${promptIndex}...`);

  // First, wait a bit for Meta AI to start processing
  await delay(META_TIMING.RESPONSE_WAIT);

  while (waitCount < META_TIMING.MAX_WAIT_POLLS) {
    if (signal?.aborted) return { status: 'error', error: 'Stopped by user' };

    await delay(META_TIMING.POLL_INTERVAL);
    waitCount += 3;

    if (!claimed) {
      // Scroll to bottom to see latest response
      await page.evaluate(() => {
        const chatContainer = document.querySelector('[role="main"]') ||
                              document.querySelector('main') ||
                              document.documentElement;
        chatContainer.scrollTop = chatContainer.scrollHeight;
      });

      const newImgs = await findNewImages(page, imgSnapshot);

      if (newImgs.length === 0) {
        if (waitCount >= META_TIMING.PHASE1_TIMEOUT_S) {
          return { status: 'timeout', error: '[Meta AI] Không thấy ảnh mới sau timeout' };
        }

        // Check if still generating
        const stillRendering = await isStillRendering(page);

        // Check for text-only error response
        if (!stillRendering && waitCount > 30) {
          const err = await detectError(page);
          if (err) return { status: 'error', error: `[Meta AI] ${err}` };
        }

        if (waitCount % 15 === 0) {
          log.step(`[Meta AI] ⏳ Chờ ảnh mới... (${waitCount}s)${stillRendering ? ' [đang xử lý]' : ''}`);
        }
        continue;
      }

      // Claim new images
      claimedSrcs = newImgs.map(i => i.src);
      await claimImages(page, claimedSrcs, promptIndex);
      claimed = true;
      renderWaitCount = 0; // Reset render timer
      log.step(`[Meta AI] Claimed ${claimedSrcs.length} ảnh mới`);
    }

    // Check if still rendering (more images coming?)
    const rendering = await isStillRendering(page);
    if (rendering) {
      renderWaitCount += 3;
      if (renderWaitCount >= MAX_RENDER_EXTRA_S) {
        log.step(`[Meta AI] Render timeout (${MAX_RENDER_EXTRA_S}s) — tiếp tục với ${claimedSrcs.length} ảnh đã có`);
        // Fall through to validation below
      } else {
        if (renderWaitCount % 9 === 0) log.step('[Meta AI] 🔄 Đang render thêm...');
        continue;
      }
    }

    // Small extra wait to catch late-loading images
    await delay(META_TIMING.IMAGE_LOAD_WAIT);

    // Check for any additional images that appeared during rendering
    const additionalImgs = await findNewImages(page, imgSnapshot);
    for (const img of additionalImgs) {
      if (!claimedSrcs.includes(img.src)) {
        claimedSrcs.push(img.src);
        await claimImages(page, [img.src], promptIndex);
      }
    }

    // Re-validate claimed images are fully loaded
    const claimedImgs = await findClaimedImages(page, promptIndex);
    const validImgs = claimedImgs.filter(i => i.width >= META_TIMING.MIN_IMAGE_SIZE && i.height >= META_TIMING.MIN_IMAGE_SIZE);

    if (validImgs.length === 0) {
      if (waitCount % 15 === 0) {
        log.step(`[Meta AI] ⏳ Ảnh chưa sẵn sàng... (claimed: ${claimedImgs.length}, valid: ${validImgs.length})`);
      }
      continue;
    }

    // Success!
    return { status: 'success', images: validImgs };
  }

  return { status: 'timeout', error: '[Meta AI] Quá thời gian chờ' };
}

// ── Check Login ───────────────────────────────────────────────

async function checkLogin(page) {
  return page.evaluate(() => {
    // Check if we're redirected to a login page
    if (window.location.href.includes('login') || window.location.href.includes('checkpoint')) {
      return false;
    }

    // Look for login/sign-up buttons
    for (const el of document.querySelectorAll('a, button')) {
      const text = el.textContent.trim().toLowerCase();
      if (text === 'log in' || text === 'sign up' || text === 'đăng nhập' ||
          text === 'đăng ký' || text === 'create account') {
        return false;
      }
    }

    // If we can find the chat input, we're likely logged in
    const hasInput = document.querySelector('textarea') ||
                     document.querySelector('div[role="textbox"][contenteditable="true"]');
    return !!hasInput;
  });
}

// ── Cleanup ───────────────────────────────────────────────────

async function cleanup(page) {
  await markAllUnclaimedImages(page);

  // Scroll to bottom to keep chat visible
  await page.evaluate(() => {
    const chatContainer = document.querySelector('[role="main"]') ||
                          document.querySelector('main') ||
                          document.documentElement;
    chatContainer.scrollTop = chatContainer.scrollHeight;
  });
}

// ── Register ──────────────────────────────────────────────────

registerProvider({
  name: 'meta-ai',
  displayName: 'Meta AI Imagine',
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
