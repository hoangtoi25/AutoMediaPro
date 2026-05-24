/**
 * providers/imagefx/index.js — Google Flow Provider.
 *
 * Implements the Provider Contract for Google Labs Flow (formerly ImageFX).
 * Supports both Image mode (Banana/Imagen) and Video mode (Veo).
 */

import { registerProvider } from '../provider-interface.js';
import { TARGET_URL, URL_PATTERN, LOGIN_URL, PLACEHOLDER_TEXTS } from './config.js';
import { TIMING } from '../../config.js';
import {
  findInputElement,
  findGenerateButton,
  selectMediaMode,
  configureVideoSettings,
  configureImageSettings,
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
 * 3. Select the correct media mode (Image / Video)
 * 4. Configure settings (aspect ratio, duration for video)
 * 5. Wait for the prompt input element to appear
 *
 * @param {import('puppeteer-core').Page} page
 * @param {string} [mediaType='image'] - 'image' or 'video'
 * @param {object} [options] - Additional settings
 * @param {string} [options.aspectRatio] - '16:9', '9:16', or 'auto'
 */
async function preparePage(page, mediaType = 'image', options = {}) {
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
  }

  // Step 3: Click "+ Dự án mới" / "+ New project" button if no input
  if (!inputEl) {
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
  }

  // Step 4: Select media mode (Image / Video)
  await selectMediaMode(page, mediaType);

  // Step 5: Configure settings based on media type
  const aspectRatio = options.aspectRatio || 'auto';

  if (mediaType === 'video') {
    // Video mode: set aspect ratio + duration
    const videoOpts = {};
    if (aspectRatio !== 'auto') {
      videoOpts.aspectRatio = aspectRatio;
    }
    await configureVideoSettings(page, videoOpts);
  } else {
    // Image mode: set aspect ratio if specified
    if (aspectRatio !== 'auto') {
      await configureImageSettings(page, { aspectRatio });
    }
  }

  // Step 6: Wait for the input element to appear
  if (!inputEl) {
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

  // Submit: try clicking Generate button first, fallback to Enter key
  const generateBtn = await findGenerateButton(page);
  if (generateBtn) {
    // Log what we're about to click for debugging
    const btnText = await generateBtn.evaluate(el => el.textContent.trim().substring(0, 30));
    const btnAria = await generateBtn.evaluate(el => el.getAttribute('aria-label') || '');
    log.step(`Bấm Generate (text="${btnText}", aria="${btnAria}")...`);
    await generateBtn.evaluate(el => el.scrollIntoView({ behavior: 'instant', block: 'center' }));
    await delay(150);
    await generateBtn.click();
  } else {
    // Fallback: try Enter key
    log.step('Không tìm nút Generate, thử Enter key...');
    await page.keyboard.press('Enter');
  }

  // Brief wait then verify submission happened
  await delay(1500);
  const afterText = await getInputText(page);
  if (afterText.length > 5 && !PLACEHOLDER_TEXTS.includes(afterText)) {
    log.warn(`⚠️ Prompt vẫn còn trong ô nhập sau submit (${afterText.length} chars) — có thể chưa submit thành công`);
  } else {
    log.step('✓ Prompt đã được submit');
  }
}

// ── Wait for Images/Videos ────────────────────────────────────

async function waitForImages(page, promptIndex, imgSnapshot, signal, mediaType = 'image') {
  let waitCount = 0;
  let claimed = false;
  let claimedSrcs = [];
  const isVideoMode = mediaType === 'video';

  // Video needs longer timeouts
  const maxWaitPolls = isVideoMode ? 300 : TIMING.MAX_WAIT_POLLS; // ~15min for video
  const phase1Timeout = isVideoMode ? 300 : TIMING.PHASE1_TIMEOUT_S; // 5min for first result

  log.step(`Chờ ${isVideoMode ? 'video' : 'ảnh'} mới cho prompt #${promptIndex}...`);

  // VIDEO mode: track video element wait
  let hasVideoElement = false;
  let videoWaitStarted = false;
  let videoWaitCount = 0;
  const MAX_VIDEO_WAIT_S = 120; // Max seconds to wait for video element after images appear

  while (waitCount < maxWaitPolls) {
    if (signal?.aborted) return { status: 'error', error: 'Stopped by user' };

    await delay(TIMING.POLL_INTERVAL);
    waitCount += 3; // ~3 seconds per poll

    if (!claimed) {
      const newMedia = await findNewImages(page, imgSnapshot);

      if (newMedia.length === 0) {
        if (waitCount >= phase1Timeout) {
          return { status: 'timeout', error: `Không thấy ${isVideoMode ? 'video' : 'ảnh'} mới sau timeout` };
        }

        // Check for errors
        const err = await detectError(page);
        if (err) return { status: 'error', error: err };

        if (waitCount % 15 === 0) {
          log.step(`⏳ Chờ ${isVideoMode ? 'video' : 'ảnh'} mới... (${waitCount}s)`);
        }

        // Debug: every 30s dump DOM media state
        if (waitCount % 30 === 0 && waitCount > 0) {
          const domState = await page.evaluate(() => {
            const imgs = document.querySelectorAll('img');
            const vids = document.querySelectorAll('video');
            const canvases = document.querySelectorAll('canvas');

            // Check for loading spinners/progress
            const loadingIndicators = [];
            for (const el of document.querySelectorAll('*')) {
              const text = el.textContent.trim();
              const role = el.getAttribute('role');
              const ariaLabel = el.getAttribute('aria-label') || '';
              if (role === 'progressbar' || role === 'status') {
                loadingIndicators.push(`[${role}] "${text.substring(0, 30)}" aria="${ariaLabel}"`);
              }
              if (/^\d+%$/.test(text) || /generating|creating|loading/i.test(text)) {
                loadingIndicators.push(`"${text.substring(0, 40)}"`);
              }
            }

            // Sample video src
            const vidSrcs = Array.from(vids).map(v => {
              let s = v.src;
              if (!s) { const source = v.querySelector('source'); if (source) s = source.src; }
              return s ? s.substring(0, 80) : '(no src)';
            });

            // Unclaimed img count
            const unclaimedImgs = Array.from(imgs).filter(i => !i.dataset.autoMediaClaimed && i.src && !i.src.startsWith('data:image/svg'));

            return {
              imgCount: imgs.length,
              vidCount: vids.length,
              canvasCount: canvases.length,
              unclaimedImgCount: unclaimedImgs.length,
              vidSrcs: vidSrcs.slice(0, 3),
              loading: loadingIndicators.slice(0, 5),
            };
          });
          log.step(`🔍 DOM: ${domState.imgCount} img (${domState.unclaimedImgCount} unclaimed), ${domState.vidCount} video, ${domState.canvasCount} canvas`);
          if (domState.vidSrcs.length > 0) log.step(`🔍 Video src: ${domState.vidSrcs.join(' | ')}`);
          if (domState.loading.length > 0) log.step(`🔍 Loading: ${domState.loading.join(', ')}`);
        }

        continue;
      }

      // Claim new media
      claimedSrcs = newMedia.map(i => i.src);
      await claimImages(page, claimedSrcs, promptIndex);
      claimed = true;

      const videoCount = newMedia.filter(i => i.type === 'video').length;
      const imageCount = newMedia.length - videoCount;
      hasVideoElement = videoCount > 0;
      const mediaDesc = [imageCount > 0 ? `${imageCount} ảnh` : '', videoCount > 0 ? `${videoCount} video` : ''].filter(Boolean).join(' + ');
      log.step(`Claimed ${mediaDesc} mới`);

      // In VIDEO mode, if we only got images (preview thumbnails), wait for actual video
      if (isVideoMode && !hasVideoElement) {
        videoWaitStarted = true;
        videoWaitCount = 0;
        log.step(`🎬 Mode VIDEO: chờ video element xuất hiện (tối đa ${MAX_VIDEO_WAIT_S}s)...`);
      }
    }

    // ── VIDEO WAIT PHASE ──────────────────────────────────────
    if (isVideoMode && videoWaitStarted && !hasVideoElement) {
      videoWaitCount += 3;

      // Check for new video elements
      const newMedia = await findNewImages(page, imgSnapshot);
      const newVideos = newMedia.filter(m => m.type === 'video' && !claimedSrcs.includes(m.src));

      if (newVideos.length > 0) {
        for (const vid of newVideos) {
          claimedSrcs.push(vid.src);
          await claimImages(page, [vid.src], promptIndex);
        }
        hasVideoElement = true;
        log.step(`🎬 Video element đã xuất hiện! Claimed ${newVideos.length} video`);
      } else {
        // Also claim any new images that appeared
        const newImages = newMedia.filter(m => m.type === 'image' && !claimedSrcs.includes(m.src));
        for (const img of newImages) {
          claimedSrcs.push(img.src);
          await claimImages(page, [img.src], promptIndex);
        }

        // Debug: every 15s during video wait, scan ALL video/media elements in DOM
        if (videoWaitCount % 15 === 0) {
          const videoDebug = await page.evaluate(() => {
            const result = { videos: [], iframes: [], shadowHosts: [] };

            // All <video> elements (even tiny ones)
            for (const vid of document.querySelectorAll('video')) {
              let src = vid.src;
              if (!src) { const s = vid.querySelector('source'); if (s) src = s.src; }
              const rect = vid.getBoundingClientRect();
              result.videos.push({
                src: src ? src.substring(0, 80) : '(no src)',
                size: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
                claimed: vid.dataset.autoMediaClaimed || 'no',
                visible: rect.width > 0 && rect.height > 0,
                parent: vid.parentElement?.tagName || 'none',
              });
            }

            // Check for iframes (video might be inside)
            for (const iframe of document.querySelectorAll('iframe')) {
              const rect = iframe.getBoundingClientRect();
              result.iframes.push({
                src: (iframe.src || '').substring(0, 80),
                size: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
              });
            }

            // Check for elements with video-like attributes
            const mediaEls = document.querySelectorAll('[data-video], [data-media-url], [data-src*="video"]');
            for (const el of mediaEls) {
              result.shadowHosts.push({
                tag: el.tagName,
                attrs: Array.from(el.attributes).map(a => `${a.name}=${a.value.substring(0, 50)}`).join(', '),
              });
            }

            return result;
          });

          log.step(`🎬 Chờ video... (${videoWaitCount}s/${MAX_VIDEO_WAIT_S}s)`);
          log.step(`🎬 Video elements in DOM: ${videoDebug.videos.length}`);
          for (const v of videoDebug.videos) {
            log.step(`  <video> src=${v.src} size=${v.size} claimed=${v.claimed} visible=${v.visible} parent=${v.parent}`);
          }
          if (videoDebug.iframes.length > 0) {
            log.step(`🎬 Iframes: ${videoDebug.iframes.length}`);
            for (const f of videoDebug.iframes) log.step(`  <iframe> src=${f.src} size=${f.size}`);
          }
          if (videoDebug.shadowHosts.length > 0) {
            log.step(`🎬 Media attrs: ${videoDebug.shadowHosts.length}`);
            for (const s of videoDebug.shadowHosts) log.step(`  <${s.tag}> ${s.attrs}`);
          }
        }

        if (videoWaitCount >= MAX_VIDEO_WAIT_S) {
          log.warn(`🎬 Video wait timeout (${MAX_VIDEO_WAIT_S}s) — tiếp tục với ${claimedSrcs.length} media đã có`);
          videoWaitStarted = false;
        } else {
          continue;
        }
      }
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

    // Small extra wait to catch late-loading media
    await delay(TIMING.IMAGE_LOAD_WAIT);

    // Check for any additional media that appeared during rendering
    const additionalMedia = await findNewImages(page, imgSnapshot);
    for (const m of additionalMedia) {
      if (!claimedSrcs.includes(m.src)) {
        claimedSrcs.push(m.src);
        await claimImages(page, [m.src], promptIndex);
        if (m.type === 'video') hasVideoElement = true;
      }
    }

    // Re-validate claimed media are fully loaded
    const claimedImgs = await findClaimedImages(page, promptIndex);
    // Videos always pass validation (dimensions may not be reported)
    const validImgs = claimedImgs.filter(i =>
      i.type === 'video' || (i.width >= 100 && i.height >= 100)
    );

    if (validImgs.length === 0) {
      if (waitCount % 15 === 0) {
        log.step(`⏳ Media chưa sẵn sàng... (claimed: ${claimedImgs.length}, valid: ${validImgs.length})`);
      }
      continue;
    }

    // Success!
    const finalVidCount = validImgs.filter(i => i.type === 'video').length;
    const finalImgCount = validImgs.length - finalVidCount;
    if (isVideoMode && finalVidCount === 0) {
      log.warn(`⚠️ Mode VIDEO nhưng chỉ có ${finalImgCount} ảnh, không có video`);
    }
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
  displayName: 'Google Flow',
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

