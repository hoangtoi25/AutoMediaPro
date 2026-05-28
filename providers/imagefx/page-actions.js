/**
 * providers/imagefx/page-actions.js — DOM interaction layer for Google Labs ImageFX.
 *
 * All page interactions go through Puppeteer's page API instead of
 * the old extension's CDP message-passing. This gives us cleaner,
 * more reliable control.
 *
 * Ported from: AutoMedia/dom-helpers.js + cdp.js
 */

import { SELECTORS, PLACEHOLDER_TEXTS, GENERATE_BTN_KEYWORDS, ERROR_KEYWORDS, MEDIA_TAB_LABELS, VIDEO_DEFAULTS, COMPONENT_TAB_LABELS, FRAME_TAB_LABELS, START_IMAGE_LABELS, FLOW_DEFAULTS } from './config.js';
import { TIMING } from '../../config.js';
import { log } from '../../logger.js';

/**
 * Find and return the prompt input element handle.
 * Mirrors the extension's findInputElement() logic.
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<import('puppeteer-core').ElementHandle|null>}
 */
export async function findInputElement(page) {
  // Strategy 1: Find by placeholder text → walk up to contenteditable
  const handle = await page.evaluateHandle((placeholders, selectors) => {
    // Try placeholder-based search first
    for (const el of document.querySelectorAll('span, p, div')) {
      const text = el.textContent.trim();
      if (placeholders.includes(text)) {
        let parent = el.parentElement;
        for (let d = 0; d < 5 && parent; d++) {
          if (parent.getAttribute('contenteditable') === 'true') return parent;
          parent = parent.parentElement;
        }
      }
    }
    // Strategy 2: Slate editor selector
    let inputs = Array.from(document.querySelectorAll(selectors.SLATE_EDITOR));
    if (inputs.length === 0) {
      inputs = Array.from(document.querySelectorAll(selectors.ROLE_TEXTBOX));
    }
    return inputs.length > 0 ? inputs[inputs.length - 1] : null;
  }, PLACEHOLDER_TEXTS, SELECTORS);

  const element = handle.asElement();
  if (!element) {
    handle.dispose();
    return null;
  }
  return element;
}

// ── Media Mode Selection ──────────────────────────────────────

export async function selectMediaMode(page, mediaType) {
  const labels = MEDIA_TAB_LABELS[mediaType] || MEDIA_TAB_LABELS.image;

  log.step(`[ImageFX] Chọn mode "${mediaType}"...`);

  // First, ensure settings panel is open
  await openSettingsPanel(page);

  // Find the button position (don't click from evaluate)
  const result = await page.evaluate((targetLabels) => {
    const dropdown = document.querySelector('.DropdownMenuContent, [class*="DropdownMenuContent"]');
    const searchRoot = dropdown || document;
    const allClickable = searchRoot.querySelectorAll(
      'button, [role="tab"], [role="button"], [role="radio"], div[tabindex], label, span[tabindex]'
    );

    const candidates = [];

    for (const el of allClickable) {
      const text = el.textContent.trim();
      const rect = el.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) continue;

      for (const label of targetLabels) {
        if (text.toLowerCase().includes(label.toLowerCase())) {
          const isActive = el.classList.contains('active') ||
                           el.getAttribute('aria-selected') === 'true' ||
                           el.getAttribute('data-state') === 'active' ||
                           el.getAttribute('aria-pressed') === 'true';

          candidates.push({
            text,
            len: text.length,
            x: rect.x,
            y: rect.y,
            w: rect.width,
            h: rect.height,
            isActive,
          });
        }
      }
    }

    if (candidates.length === 0) return null;

    // Pick the one with SHORTEST text (most specific match)
    candidates.sort((a, b) => a.len - b.len);
    return candidates[0];
  }, labels);

  if (!result) {
    log.warn(`[ImageFX] Không tìm thấy nút mode "${mediaType}"`);
    return false;
  }

  if (result.isActive) {
    log.step(`[ImageFX] Mode "${result.text}" đã được chọn sẵn`);
    return true;
  }

  // Click with page.mouse — Google Flow components need native clicks
  await page.mouse.click(result.x + result.w / 2, result.y + result.h / 2);
  log.step(`[ImageFX] Đã chọn mode "${result.text}"`);
  await delay(1500);

  return true;
}

/**
 * Open the settings panel by clicking the combined settings summary button.
 * e.g. "Video · 8scrop_16_91x" or "🍌 Nano Banana 2crop_squarex4" at the bottom of the page.
 * Must use page.mouse.click() — el.click() doesn't work on this component.
 *
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<boolean>} true if panel was opened or already open
 */
export async function openSettingsPanel(page) {
  // Check if settings panel is already open by looking for the DropdownMenuContent container
  const alreadyOpen = await page.evaluate(() => {
    const dropdown = document.querySelector('.DropdownMenuContent, [class*="DropdownMenuContent"]');
    if (dropdown) {
      const rect = dropdown.getBoundingClientRect();
      return rect.width > 10 && rect.height > 10;
    }
    return false;
  });

  if (alreadyOpen) {
    log.step('[ImageFX] Settings panel đã mở sẵn');
    return true;
  }

  // Find the combined settings summary button (contains 'crop_' representing the current aspect ratio)
  const btnBox = await page.evaluate(() => {
    // Strategy 1: Look for any button whose text contains 'crop_'
    for (const btn of document.querySelectorAll('button')) {
      const text = btn.textContent.trim();
      if (text.toLowerCase().includes('crop_')) {
        const rect = btn.getBoundingClientRect();
        if (rect.width > 5 && rect.height > 5) {
          return { x: rect.x, y: rect.y, w: rect.width, h: rect.height, text };
        }
      }
    }
    // Fallback: look for button containing '·' representing combined settings
    for (const btn of document.querySelectorAll('button')) {
      const text = btn.textContent.trim();
      if (text.includes('·')) {
        const rect = btn.getBoundingClientRect();
        if (rect.width > 5 && rect.height > 5) {
          return { x: rect.x, y: rect.y, w: rect.width, h: rect.height, text };
        }
      }
    }
    return null;
  });

  if (!btnBox) {
    log.warn('[ImageFX] Không tìm thấy nút settings summary');
    return false;
  }

  log.step(`[ImageFX] Click mở Settings Panel: "${btnBox.text}"`);
  // MUST use page.mouse.click() — Google Flow components don't respond to el.click()
  await page.mouse.click(btnBox.x + btnBox.w / 2, btnBox.y + btnBox.h / 2);
  await delay(1500);

  // Verify panel opened
  const opened = await page.evaluate(() => {
    const dropdown = document.querySelector('.DropdownMenuContent, [class*="DropdownMenuContent"]');
    if (dropdown) {
      const rect = dropdown.getBoundingClientRect();
      return rect.width > 10 && rect.height > 10;
    }
    return false;
  });

  if (opened) {
    log.success('[ImageFX] Settings panel đã mở');
    return true;
  }

  log.warn('[ImageFX] Settings panel không mở được sau khi click');
  return false;
}

/**
 * Helper: click a button whose text includes the target string.
 * Uses page.mouse.click() with bounding box coordinates because Google Flow
 * components don't respond to synthetic el.click() from evaluate.
 *
 * IMPORTANT: Settings panel must be open first (call openSettingsPanel()).
 */
async function clickSettingButton(page, targetText, settingName) {
  log.step(`[ImageFX] Chọn ${settingName}: ${targetText}...`);

  // Find button position via evaluate, then click via page.mouse
  const result = await page.evaluate((target) => {
    const dropdown = document.querySelector('.DropdownMenuContent, [class*="DropdownMenuContent"]');
    const searchRoot = dropdown || document;
    const allClickable = searchRoot.querySelectorAll(
      'button, [role="tab"], [role="button"], [role="radio"], div[tabindex], label, span[tabindex]'
    );

    const candidates = [];

    for (const el of allClickable) {
      const text = el.textContent.trim();
      const rect = el.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) continue;

      // Only match SHORT text (< 30 chars) to avoid matching the combined
      // status bar like "Video · 8scrop_16_91x" which contains all settings.
      // Needs to be 30+ because icon-prefixed texts like "crop_freeKhung hình" are ~21 chars.
      if (text.length < 30 && (text === target || text.includes(target))) {
        const isActive = el.classList.contains('active') ||
                         el.getAttribute('aria-selected') === 'true' ||
                         el.getAttribute('aria-pressed') === 'true' ||
                         el.getAttribute('data-state') === 'active';

        candidates.push({
          text,
          len: text.length,
          x: rect.x,
          y: rect.y,
          w: rect.width,
          h: rect.height,
          isActive,
        });
      }
    }

    if (candidates.length === 0) return null;

    // Pick SHORTEST text match (most specific element)
    candidates.sort((a, b) => a.len - b.len);
    return candidates[0];
  }, targetText);

  if (!result) {
    log.warn(`[ImageFX] Không tìm thấy nút ${settingName} "${targetText}"`);
    return false;
  }

  if (result.isActive) {
    log.step(`[ImageFX] ${settingName} "${result.text}" đã được chọn sẵn`);
    return true;
  }

  // Click via page.mouse at the center of the button
  await page.mouse.click(result.x + result.w / 2, result.y + result.h / 2);
  log.step(`[ImageFX] Đã chọn ${settingName} "${result.text}"`);
  await delay(500);
  return true;
}

/**
 * Configure video-specific settings: aspect ratio, duration.
 * Call after selectMediaMode('video').
 *
 * @param {import('puppeteer-core').Page} page
 * @param {object} [options]
 * @param {string} [options.aspectRatio] - '16:9' or '9:16'
 * @param {string} [options.duration] - '4s', '6s', or '8s'
 */
export async function configureVideoSettings(page, options = {}) {
  const aspectRatio = options.aspectRatio || VIDEO_DEFAULTS.ASPECT_RATIO;
  const duration = options.duration || VIDEO_DEFAULTS.DURATION;

  // Ensure settings panel is open first
  await openSettingsPanel(page);

  // Open "Khung hình" tab first to ensure aspect ratio and duration buttons are visible
  await clickFrameTab(page);

  // ── Select Aspect Ratio ─────────────────────────────────
  if (aspectRatio && aspectRatio !== 'auto') {
    await clickSettingButton(page, aspectRatio, 'tỷ lệ khung hình');
  }

  // ── Select Duration ─────────────────────────────────────
  if (duration) {
    // Try with 's' suffix first, then just the number
    const clicked = await clickSettingButton(page, duration, 'thời lượng');
    if (!clicked) {
      await clickSettingButton(page, duration.replace('s', ''), 'thời lượng');
    }
  }
}

/**
 * Configure image-specific settings: aspect ratio.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {object} [options]
 * @param {string} [options.aspectRatio] - '16:9', '4:3', '1:1', '3:4', or '9:16'
 */
export async function configureImageSettings(page, options = {}) {
  const aspectRatio = options.aspectRatio;

  // Ensure settings panel is open first
  await openSettingsPanel(page);

  // Open "Khung hình" tab first to ensure aspect ratio buttons are visible
  await clickFrameTab(page);

  if (aspectRatio && aspectRatio !== 'auto') {
    return await clickSettingButton(page, aspectRatio, 'tỷ lệ khung hình');
  }
  return true;
}

/**
 * Find the Generate / Submit button.
 * Strategies:
 *   1. Find model-selection button (contains "Banana"/"Imagen"/"Veo"), take the next button
 *   2. Find arrow button (→, ▶) typically used as submit
 *   3. CSS class fallback
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<import('puppeteer-core').ElementHandle|null>}
 */
export async function findGenerateButton(page) {
  const handle = await page.evaluateHandle((keywords, fallbackSelector) => {
    const allBtns = Array.from(document.querySelectorAll('button'));

    // EXCLUSION: buttons that should NEVER be treated as Generate
    const EXCLUDE_WORDS = ['close', 'xoá', 'xóa', 'clear', 'delete', 'back', 'quay lại', 'đóng'];
    function isExcluded(btn) {
      const text = (btn.textContent || '').toLowerCase();
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      return EXCLUDE_WORDS.some(w => text.includes(w) || aria.includes(w));
    }

    // Strategy 1: next button after model-selection button (shortest text = most specific)
    const modelBtns = allBtns
      .map((b, idx) => ({ b, idx, text: b.textContent || '' }))
      .filter(({ text }) => keywords.some(kw => text.includes(kw)));
    if (modelBtns.length > 0) {
      modelBtns.sort((a, b) => a.text.length - b.text.length);
      const modelIdx = modelBtns[0].idx;
      // Look for the next non-excluded button after the model button
      for (let i = modelIdx + 1; i < allBtns.length; i++) {
        if (!isExcluded(allBtns[i])) {
          const r = allBtns[i].getBoundingClientRect();
          if (r.width > 15 && r.height > 15) return allBtns[i];
        }
      }
    }

    // Strategy 2: Find arrow/submit button by text, aria-label, or material icon name
    for (const btn of allBtns) {
      if (isExcluded(btn)) continue;
      const text = btn.textContent.trim().toLowerCase();
      const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (text === '→' || text === '▶' || text === '➜' || text === '➤' ||
          text.startsWith('arrow_forward') || text.startsWith('send') ||
          ariaLabel.includes('submit') || ariaLabel.includes('generate') ||
          ariaLabel.includes('send') || ariaLabel.includes('create') ||
          ariaLabel.includes('gửi') || ariaLabel.includes('tạo')) {
        const rect = btn.getBoundingClientRect();
        if (rect.width > 15 && rect.height > 15) return btn;
      }
    }

    // Strategy 3: Find button near the right side of the input bar (EXCLUDE clear buttons)
    const inputBar = document.querySelector('[contenteditable="true"]') ||
                     document.querySelector('[role="textbox"]') ||
                     document.querySelector('[data-slate-editor="true"]');
    if (inputBar) {
      const inputRect = inputBar.getBoundingClientRect();
      const nearbyBtns = allBtns.filter(btn => {
        if (isExcluded(btn)) return false;
        const r = btn.getBoundingClientRect();
        return r.width > 15 && r.height > 15 &&
               Math.abs(r.top - inputRect.top) < 100 &&
               r.left >= inputRect.right - 50;
      });
      if (nearbyBtns.length > 0) {
        nearbyBtns.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
        return nearbyBtns[0];
      }
    }

    // Strategy 4: Icon-only buttons (SVG, minimal text) near bottom of viewport
    for (const btn of allBtns) {
      if (isExcluded(btn)) continue;
      const hasSvg = btn.querySelector('svg');
      const text = btn.textContent.trim();
      if (hasSvg && text.length < 5) {
        const rect = btn.getBoundingClientRect();
        if (rect.width > 20 && rect.height > 20 && rect.top > window.innerHeight * 0.5) {
          return btn;
        }
      }
    }

    // Strategy 5: CSS class fallback
    const candidates = document.querySelectorAll(fallbackSelector);
    if (candidates.length > 0) {
      const last = candidates[candidates.length - 1];
      if (!isExcluded(last)) return last;
    }

    return null;
  }, GENERATE_BTN_KEYWORDS, SELECTORS.GENERATE_BTN_CLASS);

  const element = handle.asElement();

  // Always dump buttons for debugging (helps diagnose wrong matches)
  const debugInfo = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).map(btn => {
      const r = btn.getBoundingClientRect();
      return `"${btn.textContent.trim().substring(0, 50)}" aria="${btn.getAttribute('aria-label') || ''}" svg=${!!btn.querySelector('svg')} pos=${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
    });
  });

  if (!element) {
    log.warn('[ImageFX] Không tìm thấy nút Generate. Buttons trên trang:');
    for (const d of debugInfo.slice(0, 30)) {
      log.warn(`  ${d}`);
    }
    handle.dispose();
    return null;
  } else {
    // Log which button was selected and list all for context
    log.step('[ImageFX] Tất cả buttons trên trang:');
    for (const d of debugInfo.slice(0, 30)) {
      log.step(`  ${d}`);
    }
  }
  return element;
}

/**
 * Close the settings panel if it is currently open.
 * Can close by pressing the 'Escape' key or clicking the summary button.
 *
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<boolean>}
 */
export async function closeSettingsPanel(page) {
  const isOpen = await page.evaluate(() => {
    const dropdown = document.querySelector('.DropdownMenuContent, [class*="DropdownMenuContent"]');
    if (dropdown) {
      const rect = dropdown.getBoundingClientRect();
      return rect.width > 10 && rect.height > 10;
    }
    return false;
  });

  if (!isOpen) return true;

  log.step('[ImageFX] Đóng settings panel...');

  // Strategy 1: Press Escape
  await page.keyboard.press('Escape');
  await delay(500);

  // Verify closed
  const stillOpen = await page.evaluate(() => {
    const dropdown = document.querySelector('.DropdownMenuContent, [class*="DropdownMenuContent"]');
    if (dropdown) {
      const rect = dropdown.getBoundingClientRect();
      return rect.width > 10 && rect.height > 10;
    }
    return false;
  });

  if (!stillOpen) {
    log.success('[ImageFX] Settings panel đã đóng (Escape)');
    return true;
  }

  // Strategy 2: Click settings summary button again to toggle closed
  const btnBox = await page.evaluate(() => {
    for (const btn of document.querySelectorAll('button')) {
      const text = btn.textContent.trim();
      if (text.toLowerCase().includes('crop_')) {
        const rect = btn.getBoundingClientRect();
        return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
      }
    }
    return null;
  });

  if (btnBox) {
    await page.mouse.click(btnBox.x + btnBox.w / 2, btnBox.y + btnBox.h / 2);
    await delay(1000);
  }

  return true;
}

/**
 * Close the settings panel and focus the prompt input element.
 * Must be called AFTER all settings configuration and BEFORE typing a prompt.
 * This ensures the settings panel doesn't cover the input field.
 *
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<boolean>} true if input was focused successfully
 */
export async function closeSettingsAndFocusInput(page) {
  // Close settings panel
  await closeSettingsPanel(page);
  await delay(300);

  // Find and click the prompt input to ensure focus
  const inputEl = await findInputElement(page);
  if (inputEl) {
    // Scroll input into view first
    await inputEl.evaluate(el => el.scrollIntoView({ behavior: 'instant', block: 'center' }));
    await delay(200);
    await inputEl.click();
    await delay(300);
    log.step('[ImageFX] ✓ Đã focus vào ô nhập prompt');
    return true;
  }

  log.warn('[ImageFX] Không tìm thấy ô nhập prompt sau khi đóng settings');
  return false;
}

/**
 * Clear the input field and type a new prompt.
 * Uses Puppeteer's keyboard API which dispatches trusted events.
 * @param {import('puppeteer-core').Page} page
 * @param {import('puppeteer-core').ElementHandle} inputEl
 * @param {string} prompt
 */
export async function typePrompt(page, inputEl, prompt) {
  // Ensure settings panel is closed first to avoid covering the input field!
  await closeSettingsPanel(page);

  // Click to focus
  await inputEl.click();
  await delay(TIMING.INPUT_SETTLE);

  // Select all + delete
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await delay(100);
  await page.keyboard.press('Backspace');
  await delay(TIMING.SELECT_ALL_SETTLE);

  // Type with human-like delay
  await page.keyboard.type(prompt, { delay: TIMING.HUMAN_TYPE_DELAY });
  await delay(TIMING.TYPE_SETTLE);
}

/**
 * Verify the input actually contains our prompt text (not placeholder).
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<string>}
 */
export async function getInputText(page) {
  return page.evaluate((placeholders, selectors) => {
    // Re-find the input
    for (const el of document.querySelectorAll('span, p, div')) {
      const text = el.textContent.trim();
      if (placeholders.includes(text)) {
        let parent = el.parentElement;
        for (let d = 0; d < 5 && parent; d++) {
          if (parent.getAttribute('contenteditable') === 'true') {
            return parent.textContent.trim();
          }
          parent = parent.parentElement;
        }
      }
    }
    let inputs = Array.from(document.querySelectorAll(selectors.SLATE_EDITOR));
    if (inputs.length === 0) {
      inputs = Array.from(document.querySelectorAll(selectors.ROLE_TEXTBOX));
    }
    return inputs.length > 0 ? inputs[inputs.length - 1].textContent.trim() : '';
  }, PLACEHOLDER_TEXTS, SELECTORS);
}

/**
 * Take a snapshot of all image and video src strings currently on the page.
 * Used to diff before/after to find newly generated media.
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<string[]>}
 */
export async function snapshotImages(page) {
  return page.evaluate(() => {
    const srcs = [];
    document.querySelectorAll('img').forEach(img => {
      if (img.src) srcs.push(img.src);
    });
    document.querySelectorAll('video').forEach(vid => {
      if (vid.src) {
        srcs.push(vid.src);
      } else {
        const source = vid.querySelector('source');
        if (source && source.src) srcs.push(source.src);
      }
    });
    return srcs;
  });
}

/**
 * Find new images and videos that appeared after the snapshot.
 * @param {import('puppeteer-core').Page} page
 * @param {Set<string>} snapshotSrcs
 * @returns {Promise<Array<{src: string, width: number, height: number, type: 'image'|'video'}>>}
 */
export async function findNewImages(page, snapshotSrcs) {
  const allMedia = await page.evaluate((minSize) => {
    const result = [];

    // Images
    for (const img of document.querySelectorAll('img')) {
      if (!img.src || img.src.startsWith('data:image/svg')) continue;
      if (img.dataset.autoMediaClaimed) continue;
      if (img.naturalWidth < minSize || img.naturalHeight < minSize) continue;
      result.push({
        src: img.src,
        width: img.naturalWidth,
        height: img.naturalHeight,
        type: 'image',
      });
    }

    // Videos — accept ANY video with a valid src, regardless of visual size.
    // Google Flow renders videos as hidden 0x0 elements inside <button> containers.
    for (const vid of document.querySelectorAll('video')) {
      let src = vid.src;
      if (!src) {
        const source = vid.querySelector('source');
        if (source) src = source.src;
      }
      if (!src) continue;
      if (vid.dataset.autoMediaClaimed) continue;

      const rect = vid.getBoundingClientRect();

      result.push({
        src: src,
        width: vid.videoWidth || rect.width || 720,
        height: vid.videoHeight || rect.height || 1280,
        type: 'video',
      });
    }

    return result;
  }, 50);

  // Filter out media that were in the snapshot
  return allMedia.filter(m => !snapshotSrcs.has(m.src));
}

/**
 * Check if the page shows any rendering progress (e.g. "45%").
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<boolean>}
 */
export async function isStillRendering(page) {
  return page.evaluate(() => {
    for (const span of document.querySelectorAll('span, div')) {
      const txt = span.textContent.trim();
      if (/^\d+%$/.test(txt) && parseInt(txt) < 100) return true;
    }
    return false;
  });
}

/**
 * Check for error messages on the page.
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<string|null>}
 */
export async function detectError(page) {
  return page.evaluate((errorKeywords, alertSelector) => {
    // Check alert elements
    for (const al of document.querySelectorAll(alertSelector)) {
      const t = al.textContent.toLowerCase();
      for (const kw of errorKeywords) {
        if (t.includes(kw)) return kw;
      }
    }
    // Check page body for error keywords (last 2000 chars to avoid false positives)
    const bodyText = document.body.textContent.toLowerCase().slice(-2000);
    for (const kw of errorKeywords) {
      if (bodyText.includes(kw)) return kw;
    }
    return null;
  }, ERROR_KEYWORDS, SELECTORS.ALERT);
}

/**
 * Mark images and videos as claimed so they won't be picked up again.
 * @param {import('puppeteer-core').Page} page
 * @param {string[]} srcs
 * @param {number} promptIndex
 */
export async function claimImages(page, srcs, promptIndex) {
  await page.evaluate((srcList, idx) => {
    for (const img of document.querySelectorAll('img')) {
      if (srcList.includes(img.src)) {
        img.dataset.autoMediaClaimed = String(idx);
      }
    }
    for (const vid of document.querySelectorAll('video')) {
      let src = vid.src;
      if (!src) {
        const source = vid.querySelector('source');
        if (source) src = source.src;
      }
      if (src && srcList.includes(src)) {
        vid.dataset.autoMediaClaimed = String(idx);
      }
    }
  }, srcs, promptIndex);
}

/**
 * Find media that were claimed by a specific prompt index.
 * Used after claiming to re-validate that media are fully loaded.
 * @param {import('puppeteer-core').Page} page
 * @param {number} promptIndex
 * @returns {Promise<Array<{src: string, width: number, height: number, type: 'image'|'video'}>>}
 */
export async function findClaimedImages(page, promptIndex) {
  return page.evaluate((idx, minSize) => {
    const result = [];
    for (const img of document.querySelectorAll('img')) {
      if (img.dataset.autoMediaClaimed !== String(idx)) continue;
      if (!img.src || img.src.startsWith('data:image/svg')) continue;
      result.push({
        src: img.src,
        width: img.naturalWidth,
        height: img.naturalHeight,
        type: 'image',
      });
    }
    for (const vid of document.querySelectorAll('video')) {
      if (vid.dataset.autoMediaClaimed !== String(idx)) continue;
      let src = vid.src;
      if (!src) {
        const source = vid.querySelector('source');
        if (source) src = source.src;
      }
      if (!src) continue;
      const rect = vid.getBoundingClientRect();
      result.push({
        src: src,
        width: vid.videoWidth || rect.width || 720,
        height: vid.videoHeight || rect.height || 1280,
        type: 'video',
      });
    }
    return result;
  }, promptIndex, 100);
}

/**
 * Mark ALL unclaimed images and videos as 'old' to prevent ghost-claiming.
 * @param {import('puppeteer-core').Page} page
 */
export async function markAllUnclaimedImages(page) {
  await page.evaluate(() => {
    document.querySelectorAll('img:not([data-auto-media-claimed])').forEach(img => {
      if (img.src && !img.src.startsWith('data:image/svg')) {
        img.dataset.autoMediaClaimed = 'old';
      }
    });
    document.querySelectorAll('video:not([data-auto-media-claimed])').forEach(vid => {
      let src = vid.src;
      if (!src) {
        const source = vid.querySelector('source');
        if (source) src = source.src;
      }
      if (src) {
        vid.dataset.autoMediaClaimed = 'old';
      }
    });
  });
}

// ── Flow Pipeline: Component Tab & Start Image ───────────────

/**
 * Click the "Thành phần" (Components) tab inside Video mode settings.
 * This tab contains the start image upload area for img2video.
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<boolean>} true if clicked successfully
 */
export async function clickComponentTab(page) {
  log.step('[ImageFX] Mở tab "Thành phần" (Components)...');

  // First, ensure settings panel is open
  await openSettingsPanel(page);

  const result = await page.evaluate((labels) => {
    const dropdown = document.querySelector('.DropdownMenuContent, [class*="DropdownMenuContent"]');
    const searchRoot = dropdown || document;
    const allClickable = searchRoot.querySelectorAll(
      'button, [role="tab"], [role="button"], div[tabindex], label, span[tabindex]'
    );

    const candidates = [];
    for (const el of allClickable) {
      const text = el.textContent.trim();
      const rect = el.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) continue;

      for (const label of labels) {
        if (text.length < 30 && text.toLowerCase().includes(label.toLowerCase())) {
          const isActive = el.classList.contains('active') ||
                           el.getAttribute('aria-selected') === 'true' ||
                           el.getAttribute('data-state') === 'active';

          candidates.push({
            text,
            len: text.length,
            x: rect.x,
            y: rect.y,
            w: rect.width,
            h: rect.height,
            isActive
          });
        }
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.len - b.len);
    return candidates[0];
  }, COMPONENT_TAB_LABELS);

  if (!result) {
    log.warn('[ImageFX] Không tìm thấy tab "Thành phần"');
    return false;
  }

  if (result.isActive) {
    log.step(`[ImageFX] Tab "${result.text}" đã được chọn sẵn`);
    return true;
  }

  // Click via page.mouse
  await page.mouse.click(result.x + result.w / 2, result.y + result.h / 2);
  log.step(`[ImageFX] Đã chọn tab "${result.text}"`);
  await delay(1000);
  return true;
}

/**
 * Click the "Khung hình" (Frame/Aspect ratio) tab inside settings.
 * This tab contains the aspect ratio and duration buttons.
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<boolean>} true if clicked successfully
 */
export async function clickFrameTab(page) {
  log.step('[ImageFX] Mở tab "Khung hình" (Frame)...');

  // First, ensure settings panel is open
  await openSettingsPanel(page);

  const result = await page.evaluate((labels) => {
    const dropdown = document.querySelector('.DropdownMenuContent, [class*="DropdownMenuContent"]');
    const searchRoot = dropdown || document;
    const allClickable = searchRoot.querySelectorAll(
      'button, [role="tab"], [role="button"], div[tabindex], label, span[tabindex]'
    );

    const candidates = [];
    for (const el of allClickable) {
      const text = el.textContent.trim();
      const rect = el.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) continue;

      for (const label of labels) {
        if (text.length < 30 && text.toLowerCase().includes(label.toLowerCase())) {
          const isActive = el.classList.contains('active') ||
                           el.getAttribute('aria-selected') === 'true' ||
                           el.getAttribute('data-state') === 'active';

          candidates.push({
            text,
            len: text.length,
            x: rect.x,
            y: rect.y,
            w: rect.width,
            h: rect.height,
            isActive
          });
        }
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.len - b.len);
    return candidates[0];
  }, FRAME_TAB_LABELS);

  if (!result) {
    log.warn('[ImageFX] Không tìm thấy tab "Khung hình"');
    return false;
  }

  if (result.isActive) {
    log.step(`[ImageFX] Tab "${result.text}" đã được chọn sẵn`);
    return true;
  }

  // Click via page.mouse
  await page.mouse.click(result.x + result.w / 2, result.y + result.h / 2);
  log.step(`[ImageFX] Đã chọn tab "${result.text}"`);
  await delay(1000);
  return true;
}

/**
 * Select the most recently generated image as the "Bắt đầu" (Start) frame
 * for img2video generation in Google Flow.
 *
 * Flow:
 * 1. Ensure settings panel is CLOSED
 * 2. Click the "Bắt đầu" (Start) frame selector container in the prompt bar
 * 3. In the media picker dialog that opens:
 *    a. Find the target image by index (e.g. "1.jpg") or select the first image
 *    b. Click it to select it
 *    c. Click "Thêm vào câu lệnh" (Add to prompt) to confirm
 * 4. Verify the start frame is now filled
 *
 * NOTE: The image must ALREADY exist on the project canvas (generated in Phase 1).
 * This function does NOT upload a file — it selects an existing canvas image.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {string} imagePath - Path to the generated image (used to extract index for matching)
 * @returns {Promise<boolean>} true if start frame was selected successfully
 */
export async function uploadStartImage(page, imagePath) {
  // Extract the image filename (e.g. "1.jpg") from the path for matching in the picker
  const imageFilename = imagePath.split(/[/\\]/).pop();
  log.step(`[ImageFX] Chọn ảnh bắt đầu: ${imageFilename}`);

  // Step 1: Close settings panel if open
  await closeSettingsPanel(page);
  await delay(500);

  // Step 2: Find and click the "Bắt đầu" (Start) frame selector
  const batDau = await page.evaluate(() => {
    for (const el of document.querySelectorAll('div')) {
      // Check own text content only (not children)
      const ownText = Array.from(el.childNodes)
        .filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent.trim())
        .join('');
      const r = el.getBoundingClientRect();
      if (ownText === 'Bắt đầu' && r.width >= 40 && r.width <= 70 && r.height >= 40 && r.height <= 70) {
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }
    }
    return null;
  });

  if (!batDau) {
    log.warn('[ImageFX] Không tìm thấy container "Bắt đầu" — có thể chưa ở Video mode');
    return false;
  }

  log.step(`[ImageFX] Click "Bắt đầu" tại ${Math.round(batDau.x)},${Math.round(batDau.y)}`);
  await page.mouse.click(batDau.x + batDau.w / 2, batDau.y + batDau.h / 2);
  await delay(2000);

  // Step 3: The media picker dialog should now be open
  const dialogExists = await page.evaluate(() => !!document.querySelector('[role="dialog"]'));
  if (!dialogExists) {
    log.warn('[ImageFX] Media picker dialog không mở sau khi click "Bắt đầu"');
    return false;
  }
  log.step('[ImageFX] Media picker dialog đã mở');

  // Step 3a: Find and click the target image in the media list
  // The images appear as rows with alt text matching the filename (e.g. "1.jpg")
  // or generated name (e.g. "Man on cliff turbulent sea")
  const imageSelected = await page.evaluate((targetFilename) => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return { success: false, reason: 'no-dialog' };

    // Collect all selectable image rows in the dialog
    const rows = [];
    for (const el of dialog.querySelectorAll('div')) {
      const img = el.querySelector('img');
      if (!img) continue;
      const r = el.getBoundingClientRect();
      // Media rows are ~48px tall, ~246px wide
      if (r.height < 30 || r.height > 80 || r.width < 100 || r.width > 400) continue;

      const alt = img.alt || '';
      const isSelected = el.classList.contains('selected') ||
                         el.getAttribute('aria-selected') === 'true' ||
                         // Google Flow uses different classes for selected vs unselected:
                         // selected: hkoShs, unselected: bHRxNd
                         (el.className && el.className.includes('hkoShs'));

      rows.push({
        alt,
        x: r.x, y: r.y, w: r.width, h: r.height,
        isSelected,
        element: el,
      });
    }

    if (rows.length === 0) return { success: false, reason: 'no-rows' };

    // Strategy 1: Find exact filename match (e.g. "1.jpg")
    let target = rows.find(r => r.alt === targetFilename);

    // Strategy 2: Find by filename without extension
    if (!target) {
      const nameNoExt = targetFilename.replace(/\.\w+$/, '');
      target = rows.find(r => r.alt.startsWith(nameNoExt));
    }

    // Strategy 3: Select the FIRST non-video image (most recent)
    if (!target) {
      target = rows[0];
    }

    if (!target) return { success: false, reason: 'no-target' };

    return {
      success: true,
      alt: target.alt,
      alreadySelected: target.isSelected,
      x: target.x, y: target.y, w: target.w, h: target.h,
    };
  }, imageFilename);

  if (!imageSelected.success) {
    log.warn(`[ImageFX] Không tìm thấy ảnh trong media picker: ${imageSelected.reason}`);
    // Close dialog
    await page.keyboard.press('Escape');
    await delay(500);
    return false;
  }

  // Click the target image row if not already selected
  if (!imageSelected.alreadySelected) {
    log.step(`[ImageFX] Chọn ảnh "${imageSelected.alt}" trong media picker`);
    await page.mouse.click(
      imageSelected.x + imageSelected.w / 2,
      imageSelected.y + imageSelected.h / 2
    );
    await delay(1000);
  } else {
    log.step(`[ImageFX] Ảnh "${imageSelected.alt}" đã được chọn sẵn`);
  }

  // Step 3b: Click "Thêm vào câu lệnh" (Add to prompt)
  const addBtn = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return null;
    for (const btn of dialog.querySelectorAll('button')) {
      const text = btn.textContent.trim();
      if (text.includes('Thêm vào câu lệnh') || text.includes('Add to prompt') || text.includes('Chọn')) {
        const r = btn.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, text, disabled: btn.disabled };
      }
    }
    return null;
  });

  if (!addBtn) {
    log.warn('[ImageFX] Không tìm thấy nút "Thêm vào câu lệnh"');
    await page.keyboard.press('Escape');
    await delay(500);
    return false;
  }

  if (addBtn.disabled) {
    log.warn('[ImageFX] Nút "Thêm vào câu lệnh" bị disable — có thể chưa chọn ảnh');
    await page.keyboard.press('Escape');
    await delay(500);
    return false;
  }

  log.step(`[ImageFX] Click "${addBtn.text}"`);
  await page.mouse.click(addBtn.x + addBtn.w / 2, addBtn.y + addBtn.h / 2);
  await delay(1500);

  // Step 4: Verify the start frame is now filled (the "Bắt đầu" container should now
  // contain an image or have a different visual state)
  const startFrameFilled = await page.evaluate(() => {
    for (const el of document.querySelectorAll('div')) {
      const ownText = Array.from(el.childNodes)
        .filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent.trim())
        .join('');
      const r = el.getBoundingClientRect();
      if (ownText === 'Bắt đầu' && r.width >= 40 && r.width <= 70) {
        // Check if there's an image inside now
        const img = el.querySelector('img');
        return !!img;
      }
    }
    // If we can't find the text "Bắt đầu" anymore, the frame might be filled
    // (the text is replaced by a thumbnail)
    return true;
  });

  if (startFrameFilled) {
    log.success(`[ImageFX] ✓ Ảnh bắt đầu "${imageSelected.alt}" đã được chọn thành công`);
  } else {
    log.warn('[ImageFX] Chưa xác nhận được ảnh bắt đầu đã được chọn');
  }

  return true;
}

/**
 * Clear/remove the start image after generating a video.
 * Looks for a close/remove button on the start image preview.
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<boolean>}
 */
export async function clearStartImage(page) {
  log.step('[ImageFX] Xóa ảnh bắt đầu...');

  const cleared = await page.evaluate((labels) => {
    // Strategy 1: Find close/remove button near start image area
    const closeKeywords = ['×', 'close', 'remove', 'xóa', 'xoá', 'clear', 'gỡ', 'bỏ'];

    // First, find the start image area
    let startImageArea = null;
    for (const el of document.querySelectorAll('*')) {
      const text = el.textContent.trim();
      for (const label of labels) {
        if (text.toLowerCase().includes(label.toLowerCase()) && text.length < 50) {
          startImageArea = el;
          break;
        }
      }
      if (startImageArea) break;
    }

    if (!startImageArea) return null;

    // Look for close buttons within or near the start image area
    const nearbyBtns = startImageArea.querySelectorAll('button, [role="button"], svg');
    for (const btn of nearbyBtns) {
      const text = btn.textContent.trim().toLowerCase();
      const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
      for (const kw of closeKeywords) {
        if (text.includes(kw) || ariaLabel.includes(kw)) {
          btn.click();
          return { text: btn.textContent.trim(), strategy: 'close-btn' };
        }
      }
      // Also try icon-only buttons (SVG with no text)
      if (text.length === 0 && btn.querySelector('svg, i')) {
        const rect = btn.getBoundingClientRect();
        if (rect.width > 10 && rect.width < 40 && rect.height > 10 && rect.height < 40) {
          btn.click();
          return { text: '(icon)', strategy: 'icon-btn' };
        }
      }
    }

    // Strategy 2: Find any small close button near a preview thumbnail
    const allBtns = document.querySelectorAll('button');
    for (const btn of allBtns) {
      const rect = btn.getBoundingClientRect();
      if (rect.width < 40 && rect.height < 40 && rect.width > 10) {
        const text = btn.textContent.trim().toLowerCase();
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        for (const kw of closeKeywords) {
          if (text === kw || ariaLabel.includes(kw)) {
            btn.click();
            return { text: btn.textContent.trim() || ariaLabel, strategy: 'global-close' };
          }
        }
      }
    }

    return null;
  }, START_IMAGE_LABELS);

  if (cleared) {
    log.step(`[ImageFX] Đã xóa ảnh bắt đầu (${cleared.strategy}: "${cleared.text}")`);
    await delay(1000);
    return true;
  }

  log.warn('[ImageFX] Không tìm thấy nút xóa ảnh bắt đầu — có thể cần xóa thủ công');
  return false;
}

/**
 * Select scale/multiplier option in image mode (1x, 2x, 3x, 4x).
 * @param {import('puppeteer-core').Page} page
 * @param {string} scale - '1x', '2x', '3x', or '4x'
 * @returns {Promise<boolean>}
 */
export async function selectScaleOption(page, scale) {
  return clickSettingButton(page, scale, 'tỷ lệ phóng đại');
}

/**
 * Select a specific AI model from the model dropdown/selector.
 * Clicks the current model button to open dropdown, then selects target model.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {string} modelSubstring - Substring to match (e.g. 'Nano Banana Pro', 'Veo 3.1')
 * @returns {Promise<boolean>}
 */
export async function selectModel(page, modelSubstring) {
  if (!modelSubstring) return true;

  log.step(`[ImageFX] Chọn model: "${modelSubstring}"...`);

  // Ensure settings panel is open
  await openSettingsPanel(page);

  // Step 1: Check if the current model already matches
  const currentModel = await page.evaluate((keywords) => {
    const dropdown = document.querySelector('.DropdownMenuContent, [class*="DropdownMenuContent"]');
    const searchRoot = dropdown || document;
    for (const btn of searchRoot.querySelectorAll('button')) {
      const text = btn.textContent.trim();
      if (keywords.some(kw => text.includes(kw))) {
        return text;
      }
    }
    return null;
  }, GENERATE_BTN_KEYWORDS);

  if (currentModel && currentModel.toLowerCase().includes(modelSubstring.toLowerCase())) {
    log.step(`[ImageFX] Model "${currentModel}" đã được chọn sẵn`);
    return true;
  }

  // Step 2: Click the model selector button to open dropdown (using native mouse click)
  const modelBtnBox = await page.evaluate((keywords) => {
    const dropdown = document.querySelector('.DropdownMenuContent, [class*="DropdownMenuContent"]');
    const searchRoot = dropdown || document;
    const allBtns = Array.from(searchRoot.querySelectorAll('button'));

    const modelBtns = allBtns
      .map(b => {
        const rect = b.getBoundingClientRect();
        return { b, text: b.textContent.trim(), x: rect.x, y: rect.y, w: rect.width, h: rect.height };
      })
      .filter(({ text }) => keywords.some(kw => text.includes(kw)));

    if (modelBtns.length === 0) return null;
    modelBtns.sort((a, b) => a.text.length - b.text.length);
    return { x: modelBtns[0].x, y: modelBtns[0].y, w: modelBtns[0].w, h: modelBtns[0].h, text: modelBtns[0].text };
  }, GENERATE_BTN_KEYWORDS);

  if (!modelBtnBox) {
    log.warn('[ImageFX] Không tìm thấy nút chọn model');
    return false;
  }

  log.step(`[ImageFX] Đã click model selector: "${modelBtnBox.text}"`);
  await page.mouse.click(modelBtnBox.x + modelBtnBox.w / 2, modelBtnBox.y + modelBtnBox.h / 2);
  await delay(1500);

  // Step 3: Find and click the target model in the dropdown/list (using native mouse click)
  const targetBtnBox = await page.evaluate((target) => {
    // Look in dropdowns, menus, lists, dialogs
    const containers = document.querySelectorAll(
      '[role="listbox"], [role="menu"], [role="dialog"], [class*="dropdown"], [class*="popup"], [class*="menu"], [class*="modal"], ul, ol'
    );

    // Search in containers first
    for (const container of containers) {
      const rect = container.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) continue;

      const items = container.querySelectorAll(
        '[role="option"], [role="menuitem"], li, button, div[tabindex], label'
      );
      for (const item of items) {
        const text = item.textContent.trim();
        if (text.toLowerCase().includes(target.toLowerCase())) {
          const itemRect = item.getBoundingClientRect();
          return { x: itemRect.x, y: itemRect.y, w: itemRect.width, h: itemRect.height, text, source: 'container' };
        }
      }
    }

    // Fallback: search all visible clickable elements
    for (const el of document.querySelectorAll('button, [role="option"], [role="menuitem"], li, div[tabindex], label')) {
      const text = el.textContent.trim();
      const rect = el.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) continue;
      if (text.toLowerCase().includes(target.toLowerCase()) && text.length < 60) {
        return { x: rect.x, y: rect.y, w: rect.width, h: rect.height, text, source: 'global' };
      }
    }

    return null;
  }, modelSubstring);

  if (targetBtnBox) {
    log.step(`[ImageFX] Đã chọn model "${targetBtnBox.text}" (${targetBtnBox.source})`);
    await page.mouse.click(targetBtnBox.x + targetBtnBox.w / 2, targetBtnBox.y + targetBtnBox.h / 2);
    await delay(1000);
    return true;
  }

  // If dropdown didn't appear, click outside to close any open menu
  log.warn(`[ImageFX] Không tìm thấy model "${modelSubstring}" trong dropdown`);
  await page.keyboard.press('Escape');
  await delay(500);
  return false;
}

// ── Utility ───────────────────────────────────────────────────

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

