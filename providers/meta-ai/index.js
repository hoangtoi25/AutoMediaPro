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

// ── Dialog Handling ───────────────────────────────────────────

/**
 * Dismiss Meta AI's custom "Discard prompt?" HTML dialog.
 * This appears when switching modes (image/video) or navigating
 * while there's unsent content in the input field.
 *
 * Clicks "Discard" to proceed, or "Stay" if Discard is not found.
 */
async function dismissDiscardDialog(page) {
  // Try up to 3 times with delay - dialog may appear asynchronously
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await delay(500);

    const dismissed = await page.evaluate(() => {
      const allBtns = document.querySelectorAll('button, [role="button"], a[role="button"]');

      // Strategy 1: Find "Discard" button by text
      for (const btn of allBtns) {
        const text = btn.textContent.trim().toLowerCase();
        if (text === 'discard' || text.includes('discard') ||
            text === 'leave' || text === 'delete' ||
            text === 'remove' || text === 'clear') {
          const rect = btn.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            btn.click();
            return 'discard';
          }
        }
      }

      // Strategy 2: Close button inside a dialog/modal
      for (const btn of allBtns) {
        const text = btn.textContent.trim();
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        if (text === '\u00d7' || text === '\u2715' || ariaLabel.includes('close')) {
          const dialog = btn.closest('[role="dialog"], [role="alertdialog"], [class*="modal"], [class*="dialog"], [class*="overlay"]');
          if (dialog) {
            btn.click();
            return 'close';
          }
        }
      }

      // Strategy 3: Find any container with "Discard prompt" text, then click Discard button inside
      const allElements = document.querySelectorAll('div, section, aside, [class*="modal"], [class*="dialog"], [class*="overlay"], [role="dialog"], [role="alertdialog"]');
      for (const container of allElements) {
        const containerText = container.textContent || '';
        if (containerText.includes('Discard prompt') || containerText.includes('will be lost')) {
          // Found the dialog container — now find the Discard button
          const btns = container.querySelectorAll('button, [role="button"], a');
          for (const btn of btns) {
            const btnText = btn.textContent.trim().toLowerCase();
            if (btnText === 'discard' || btnText.includes('discard')) {
              const btnRect = btn.getBoundingClientRect();
              if (btnRect.width > 0 && btnRect.height > 0) {
                btn.click();
                return 'discard-in-container';
              }
            }
          }
          // Fallback: click any non-Stay button in the container
          for (const btn of btns) {
            const btnText = btn.textContent.trim().toLowerCase();
            if (btnText !== 'stay' && btnText !== 'cancel' && btnText.length > 0 && btnText.length < 30) {
              const btnRect = btn.getBoundingClientRect();
              if (btnRect.width > 40 && btnRect.height > 20) {
                btn.click();
                return `container-btn:${btnText}`;
              }
            }
          }
        }
      }

      return null;
    });

    if (dismissed) {
      log.step(`[Meta AI] Dismissed dialog "${dismissed}"`);
      await delay(500);
      return true;
    }
  }
  return false;
}

/**
 * Set up native dialog handler for beforeunload prompts.
 * Call once per page to auto-accept all native dialogs.
 */
function setupDialogHandler(page) {
  if (!page._metaDialogHandlerSet) {
    page.on('dialog', async (dialog) => {
      log.step(`[Meta AI] Auto-dismiss native dialog: ${dialog.type()}`);
      try {
        await dialog.accept();
      } catch {}
    });
    page._metaDialogHandlerSet = true;
  }
}

// ── Click "Create image" Action Button ────────────────────────

/**
 * Click the "Create image" action chip/button on Meta AI.
 * This switches the chat into image generation mode.
 * Used for IMAGE mode only.
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

// ── Click "Create" Sidebar Button ─────────────────────────────

/**
 * Click the "Create" (✨) button on the left sidebar menu.
 * This enters Meta AI's creation mode, which accepts both
 * "Create Video: ..." and "Create image: ..." text commands.
 *
 * Sidebar layout:
 *   [New chat]  [Search]  [Vibes]  [✨ Create]
 */
async function clickCreateSidebar(page) {
  log.step('[Meta AI] Tìm nút "Create" trên sidebar...');

  const clicked = await page.evaluate(() => {
    // Strategy 1: Find sidebar nav links/buttons with exact "Create" text
    // The sidebar uses <a> tags or nav links
    const sidebarSelectors = [
      'nav a', 'nav button', 'aside a', 'aside button',
      '[role="navigation"] a', '[role="navigation"] button',
      'a', 'button', '[role="button"]', 'div[tabindex]',
    ];

    for (const selector of sidebarSelectors) {
      for (const el of document.querySelectorAll(selector)) {
        const text = el.textContent.trim().toLowerCase();
        // Match "Create" but NOT "Create image" or "Create video" (those are action chips)
        if (text === 'create' || text === 'tạo' || text === 'sáng tạo') {
          el.click();
          return el.textContent.trim();
        }
      }
    }

    // Strategy 2: Find by aria-label on sidebar items
    for (const el of document.querySelectorAll('a, button, [role="button"], [role="link"]')) {
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      if (label === 'create' || label === 'tạo' || label === 'sáng tạo') {
        el.click();
        return label;
      }
    }

    return null;
  });

  if (clicked) {
    log.step(`[Meta AI] Đã click sidebar: "${clicked}"`);
    await delay(2000); // Wait for Create mode UI to load
    return true;
  }

  log.warn('[Meta AI] Không tìm thấy nút "Create" trên sidebar');
  return false;
}

// ── Prepare Page ──────────────────────────────────────────────

/**
 * Prepare the Meta AI page for automation:
 * 1. Dismiss any cookie consent / welcome dialogs
 * 2. Wait for the chat input to be available
 * 3. Enter the correct mode:
 *    - IMAGE: Click "Create image" action chip
 *    - VIDEO: Click "Create" sidebar → wait for new input
 */
async function preparePage(page, mediaType = 'image') {
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

  // Step 2: Set up native dialog handler (beforeunload, etc.)
  setupDialogHandler(page);

  // Step 3: Wait for chat input to appear
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

  // Step 4: Click "Create image" to enter creation mode
  // (For VIDEO mode, the "Create Video:" prefix in the prompt text
  //  tells Meta AI to generate video — no separate mode switch needed)
  await clickCreateImage(page);
}

// ── Submit Prompt ─────────────────────────────────────────────

/**
 * Submit a prompt to Meta AI.
 *
 * IMAGE mode: Click "Create image" action chip → type prompt → send
 * VIDEO mode: Type "Create Video: <prompt>" → send
 *   ("Create" sidebar already clicked once during preparePage)
 *
 * Meta AI generates videos via text command prefix "Create Video: ..."
 * in the Create mode, NOT via an "Animate" button.
 */
async function submitPrompt(page, prompt, mediaType = 'image') {
  // Dismiss any lingering "Discard prompt?" dialog from previous prompt
  await dismissDiscardDialog(page);

  // Determine the actual text to type based on media type
  let promptToType = prompt;

  if (mediaType === 'video') {
    // VIDEO mode: prefix prompt with "Create Video: "
    // The text prefix tells Meta AI to generate video instead of image
    const lowerPrompt = prompt.toLowerCase().trimStart();
    if (!lowerPrompt.startsWith('create video')) {
      promptToType = `Create Video: ${prompt}`;
    }
    log.step(`[Meta AI] Mode: VIDEO → prefix "Create Video:" (${promptToType.length} ký tự)`);
  }

  // Click "Create image" chip to ensure input is ready (works for both modes)
  await clickCreateImage(page);
  // Dismiss dialog that may appear after clicking mode switch
  await dismissDiscardDialog(page);

  for (let attempt = 0; attempt < MAX_INPUT_RETRIES; attempt++) {
    const inputEl = await findInputElement(page);
    if (!inputEl) throw new Error('[Meta AI] Không tìm thấy ô nhập liệu');

    // Scroll into view
    await inputEl.evaluate(el => el.scrollIntoView({ behavior: 'instant', block: 'center' }));
    await delay(200);

    // Type prompt (with prefix for video, raw for image)
    log.step('[Meta AI] Đang nhập prompt...');
    await typePrompt(page, inputEl, promptToType);

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
 * Wait for Meta AI to generate and display images/videos.
 * Polls the chat for new image/video elements.
 *
 * In VIDEO mode: after claiming initial preview images, continues
 * polling for <video> elements which appear later (up to 60s extra).
 */
async function waitForImages(page, promptIndex, imgSnapshot, signal, mediaType = 'image') {
  let waitCount = 0;
  let claimed = false;
  let claimedSrcs = [];
  let renderWaitCount = 0; // Track time spent in render-after-claim phase
  const isVideoMode = mediaType === 'video';
  const MAX_RENDER_EXTRA_S = isVideoMode ? 60 : 15; // Video needs much longer to render

  log.step(`[Meta AI] Chờ ${isVideoMode ? 'video' : 'ảnh'} mới cho prompt #${promptIndex}...`);

  // First, wait a bit for Meta AI to start processing
  await delay(META_TIMING.RESPONSE_WAIT);

  // VIDEO mode: track whether we've seen an actual <video> element
  let hasVideoElement = false;
  let videoWaitStarted = false;
  let videoWaitCount = 0;
  const MAX_VIDEO_WAIT_S = 60; // Max seconds to wait specifically for video element after images appear

  while (waitCount < META_TIMING.MAX_WAIT_POLLS) {
    if (signal?.aborted) return { status: 'error', error: 'Stopped by user' };

    await delay(META_TIMING.POLL_INTERVAL);
    waitCount += 3;

    // Always scroll to bottom to see latest response
    await page.evaluate(() => {
      const chatContainer = document.querySelector('[role="main"]') ||
                            document.querySelector('main') ||
                            document.documentElement;
      chatContainer.scrollTop = chatContainer.scrollHeight;
    });

    if (!claimed) {
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

      // Claim new media (images + videos)
      claimedSrcs = newImgs.map(i => i.src);
      await claimImages(page, claimedSrcs, promptIndex);
      claimed = true;
      renderWaitCount = 0; // Reset render timer
      const videoCount = newImgs.filter(i => i.type === 'video').length;
      const imageCount = newImgs.length - videoCount;
      hasVideoElement = videoCount > 0;
      const mediaDesc = [imageCount > 0 ? `${imageCount} ảnh` : '', videoCount > 0 ? `${videoCount} video` : ''].filter(Boolean).join(' + ');
      log.step(`[Meta AI] Claimed ${mediaDesc} mới`);

      // In VIDEO mode, if we only got images (no video yet), start video wait phase
      if (isVideoMode && !hasVideoElement) {
        videoWaitStarted = true;
        videoWaitCount = 0;
        log.step(`[Meta AI] 🎬 Mode VIDEO: chờ video element xuất hiện (tối đa ${MAX_VIDEO_WAIT_S}s)...`);
      }
    }

    // ── VIDEO WAIT PHASE ──────────────────────────────────────
    // In VIDEO mode, after claiming preview images, keep polling
    // for a <video> element that Meta AI renders asynchronously.
    if (isVideoMode && videoWaitStarted && !hasVideoElement) {
      videoWaitCount += 3;

      // Check for new video elements
      const newMedia = await findNewImages(page, imgSnapshot);
      const newVideos = newMedia.filter(m => m.type === 'video' && !claimedSrcs.includes(m.src));

      if (newVideos.length > 0) {
        // Found video! Claim it
        for (const vid of newVideos) {
          claimedSrcs.push(vid.src);
          await claimImages(page, [vid.src], promptIndex);
        }
        hasVideoElement = true;
        log.step(`[Meta AI] 🎬 Video element đã xuất hiện! Claimed ${newVideos.length} video`);
      } else {
        // Also claim any new images that appeared
        const newImages = newMedia.filter(m => m.type === 'image' && !claimedSrcs.includes(m.src));
        for (const img of newImages) {
          claimedSrcs.push(img.src);
          await claimImages(page, [img.src], promptIndex);
        }

        if (videoWaitCount >= MAX_VIDEO_WAIT_S) {
          log.warn(`[Meta AI] 🎬 Video wait timeout (${MAX_VIDEO_WAIT_S}s) — tiếp tục với ${claimedSrcs.length} media đã có`);
          videoWaitStarted = false; // Stop waiting, fall through to validation
        } else {
          if (videoWaitCount % 15 === 0) {
            log.step(`[Meta AI] 🎬 Chờ video... (${videoWaitCount}s/${MAX_VIDEO_WAIT_S}s)`);
          }
          continue; // Keep waiting for video
        }
      }
    }

    // Check if still rendering (more images/videos coming?)
    const rendering = await isStillRendering(page);
    if (rendering) {
      renderWaitCount += 3;
      if (renderWaitCount >= MAX_RENDER_EXTRA_S) {
        log.step(`[Meta AI] Render timeout (${MAX_RENDER_EXTRA_S}s) — tiếp tục với ${claimedSrcs.length} media đã có`);
        // Fall through to validation below
      } else {
        if (renderWaitCount % 9 === 0) log.step('[Meta AI] 🔄 Đang render thêm...');
        continue;
      }
    }

    // Small extra wait to catch late-loading media
    await delay(META_TIMING.IMAGE_LOAD_WAIT);

    // Check for any additional media that appeared during rendering
    const additionalImgs = await findNewImages(page, imgSnapshot);
    for (const img of additionalImgs) {
      if (!claimedSrcs.includes(img.src)) {
        claimedSrcs.push(img.src);
        await claimImages(page, [img.src], promptIndex);
        if (img.type === 'video') hasVideoElement = true;
      }
    }

    // Re-validate claimed media are fully loaded
    const claimedImgs = await findClaimedImages(page, promptIndex);
    // Videos always pass validation (dimensions may not be reported)
    const validImgs = claimedImgs.filter(i => i.type === 'video' || (i.width >= META_TIMING.MIN_IMAGE_SIZE && i.height >= META_TIMING.MIN_IMAGE_SIZE));

    if (validImgs.length === 0) {
      if (waitCount % 15 === 0) {
        log.step(`[Meta AI] ⏳ Media chưa sẵn sàng... (claimed: ${claimedImgs.length}, valid: ${validImgs.length})`);
      }
      continue;
    }

    // Success!
    const finalVidCount = validImgs.filter(i => i.type === 'video').length;
    const finalImgCount = validImgs.length - finalVidCount;
    if (isVideoMode && finalVidCount === 0) {
      log.warn(`[Meta AI] ⚠️ Mode VIDEO nhưng chỉ có ${finalImgCount} ảnh, không có video`);
    }
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
  // Dismiss any lingering dialogs before next prompt
  await dismissDiscardDialog(page);

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
