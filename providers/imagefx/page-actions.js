/**
 * providers/imagefx/page-actions.js — DOM interaction layer for Google Labs ImageFX.
 *
 * All page interactions go through Puppeteer's page API instead of
 * the old extension's CDP message-passing. This gives us cleaner,
 * more reliable control.
 *
 * Ported from: AutoMedia/dom-helpers.js + cdp.js
 */

import { SELECTORS, PLACEHOLDER_TEXTS, GENERATE_BTN_KEYWORDS, ERROR_KEYWORDS, MEDIA_TAB_LABELS, VIDEO_DEFAULTS } from './config.js';
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

/**
 * Click the "Image" or "Video" tab button in the settings panel.
 * Uses flexible text matching since Flow buttons may contain icons.
 * @param {import('puppeteer-core').Page} page
 * @param {'image'|'video'} mediaType
 * @returns {Promise<boolean>} true if clicked successfully
 */
export async function selectMediaMode(page, mediaType) {
  const labels = MEDIA_TAB_LABELS[mediaType] || MEDIA_TAB_LABELS.image;

  log.step(`[ImageFX] Chọn mode "${mediaType}"...`);

  const clicked = await page.evaluate((targetLabels) => {
    const allClickable = document.querySelectorAll(
      'button, [role="tab"], [role="button"], [role="radio"], div[tabindex], label, span[tabindex]'
    );

    // Collect ALL matching candidates
    const candidates = [];

    for (const el of allClickable) {
      const text = el.textContent.trim();
      const rect = el.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) continue;

      for (const label of targetLabels) {
        if (text.toLowerCase().includes(label.toLowerCase())) {
          candidates.push({ el, text, len: text.length });
        }
      }
    }

    if (candidates.length === 0) return null;

    // Pick the one with SHORTEST text (most specific match, avoids parent containers)
    candidates.sort((a, b) => a.len - b.len);
    const best = candidates[0];

    const isActive = best.el.classList.contains('active') ||
                     best.el.getAttribute('aria-selected') === 'true' ||
                     best.el.getAttribute('data-state') === 'active' ||
                     best.el.getAttribute('aria-pressed') === 'true';
    if (isActive) return { text: best.text, alreadyActive: true };
    best.el.click();
    return { text: best.text, alreadyActive: false };
  }, labels);

  if (clicked) {
    if (clicked.alreadyActive) {
      log.step(`[ImageFX] Mode "${clicked.text}" đã được chọn sẵn`);
    } else {
      log.step(`[ImageFX] Đã chọn mode "${clicked.text}"`);
      await delay(1500);
    }
    return true;
  }

  log.warn(`[ImageFX] Không tìm thấy nút mode "${mediaType}"`);
  return false;
}

/**
 * Helper: click a button whose text includes the target string.
 * Works for aspect ratio, duration, and other settings buttons.
 */
async function clickSettingButton(page, targetText, settingName) {
  log.step(`[ImageFX] Chọn ${settingName}: ${targetText}...`);

  const result = await page.evaluate((target) => {
    const allClickable = document.querySelectorAll(
      'button, [role="tab"], [role="button"], [role="radio"], div[tabindex], label, span[tabindex]'
    );

    // Collect ALL matching candidates
    const candidates = [];

    for (const el of allClickable) {
      const text = el.textContent.trim();
      const rect = el.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) continue;

      // Only match SHORT text (< 20 chars) to avoid matching the combined
      // status bar like "Video · 8scrop_16_91x" which contains all settings
      if (text.length < 20 && (text === target || text.includes(target))) {
        candidates.push({ el, text, len: text.length });
      }
    }

    if (candidates.length === 0) return null;

    // Pick SHORTEST text match (most specific element)
    candidates.sort((a, b) => a.len - b.len);
    const best = candidates[0];

    const isActive = best.el.classList.contains('active') ||
                     best.el.getAttribute('aria-selected') === 'true' ||
                     best.el.getAttribute('aria-pressed') === 'true' ||
                     best.el.getAttribute('data-state') === 'active';
    if (isActive) return { text: best.text, alreadyActive: true };
    best.el.click();
    return { text: best.text, alreadyActive: false };
  }, targetText);

  if (result) {
    if (result.alreadyActive) {
      log.step(`[ImageFX] ${settingName} "${result.text}" đã được chọn sẵn`);
    } else {
      log.step(`[ImageFX] Đã chọn ${settingName} "${result.text}"`);
      await delay(500);
    }
    return true;
  }

  log.warn(`[ImageFX] Không tìm thấy nút ${settingName} "${targetText}"`);
  return false;
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

  if (aspectRatio && aspectRatio !== 'auto') {
    await clickSettingButton(page, aspectRatio, 'tỷ lệ khung hình');
  }
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
 * Clear the input field and type a new prompt.
 * Uses Puppeteer's keyboard API which dispatches trusted events.
 * @param {import('puppeteer-core').Page} page
 * @param {import('puppeteer-core').ElementHandle} inputEl
 * @param {string} prompt
 */
export async function typePrompt(page, inputEl, prompt) {
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

// ── Utility ───────────────────────────────────────────────────

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

