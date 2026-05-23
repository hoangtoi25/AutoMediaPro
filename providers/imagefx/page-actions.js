/**
 * providers/imagefx/page-actions.js — DOM interaction layer for Google Labs ImageFX.
 *
 * All page interactions go through Puppeteer's page API instead of
 * the old extension's CDP message-passing. This gives us cleaner,
 * more reliable control.
 *
 * Ported from: AutoMedia/dom-helpers.js + cdp.js
 */

import { SELECTORS, PLACEHOLDER_TEXTS, GENERATE_BTN_KEYWORDS, ERROR_KEYWORDS } from './config.js';
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

/**
 * Find the Generate button.
 * Strategy: Find the model-selection button (contains "Banana"/"Imagen"),
 *           then pick the next sibling button.
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<import('puppeteer-core').ElementHandle|null>}
 */
export async function findGenerateButton(page) {
  const handle = await page.evaluateHandle((keywords, fallbackSelector) => {
    const allBtns = Array.from(document.querySelectorAll('button'));

    // Strategy 1: next button after model-selection button
    const settingsBtnIndex = allBtns.findLastIndex(b => {
      const text = b.textContent || '';
      return keywords.some(kw => text.includes(kw));
    });
    if (settingsBtnIndex !== -1 && settingsBtnIndex + 1 < allBtns.length) {
      return allBtns[settingsBtnIndex + 1];
    }

    // Strategy 2: CSS class fallback
    const candidates = document.querySelectorAll(fallbackSelector);
    return candidates.length > 0 ? candidates[candidates.length - 1] : null;
  }, GENERATE_BTN_KEYWORDS, SELECTORS.GENERATE_BTN_CLASS);

  const element = handle.asElement();
  if (!element) {
    handle.dispose();
    return null;
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
 * Take a snapshot of all image src strings currently on the page.
 * Used to diff before/after to find newly generated images.
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<string[]>}
 */
export async function snapshotImages(page) {
  return page.evaluate(() => {
    const srcs = [];
    document.querySelectorAll('img').forEach(img => {
      if (img.src) srcs.push(img.src);
    });
    return srcs;
  });
}

/**
 * Find new images that appeared after the snapshot.
 * @param {import('puppeteer-core').Page} page
 * @param {Set<string>} snapshotSrcs
 * @returns {Promise<Array<{src: string, width: number, height: number}>>}
 */
export async function findNewImages(page, snapshotSrcs) {
  const allImages = await page.evaluate((minSize) => {
    const result = [];
    for (const img of document.querySelectorAll('img')) {
      if (!img.src || img.src.startsWith('data:image/svg')) continue;
      if (img.dataset.autoMediaClaimed) continue;
      if (img.naturalWidth < minSize || img.naturalHeight < minSize) continue;
      result.push({
        src: img.src,
        width: img.naturalWidth,
        height: img.naturalHeight,
      });
    }
    return result;
  }, 50);

  // Filter out images that were in the snapshot
  return allImages.filter(img => !snapshotSrcs.has(img.src));
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
 * Mark images as claimed so they won't be picked up again.
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
  }, srcs, promptIndex);
}

/**
 * Find images that were claimed by a specific prompt index.
 * Used after claiming to re-validate that images are fully loaded.
 * @param {import('puppeteer-core').Page} page
 * @param {number} promptIndex
 * @returns {Promise<Array<{src: string, width: number, height: number}>>}
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
      });
    }
    return result;
  }, promptIndex, 100);
}

/**
 * Mark ALL unclaimed images as 'old' to prevent ghost-claiming.
 * @param {import('puppeteer-core').Page} page
 */
export async function markAllUnclaimedImages(page) {
  await page.evaluate(() => {
    document.querySelectorAll('img:not([data-auto-media-claimed])').forEach(img => {
      if (img.src && !img.src.startsWith('data:image/svg')) {
        img.dataset.autoMediaClaimed = 'old';
      }
    });
  });
}

// ── Utility ───────────────────────────────────────────────────

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
