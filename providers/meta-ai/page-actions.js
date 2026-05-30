/**
 * providers/meta-ai/page-actions.js — DOM interaction layer for Meta AI.
 *
 * Meta AI uses a chat-based interface (similar to ChatGPT) where:
 * - The user types in a textarea/contenteditable at the bottom
 * - Image generation is triggered by describing an image (or using "Imagine ...")
 * - Generated images appear inline in the chat response
 *
 * Key differences from ImageFX:
 * - Chat interface vs. dedicated image tool
 * - Images appear in response bubbles, not a dedicated grid
 * - Uses Enter key to submit (or send button)
 * - Login is via Facebook/Meta account
 * - DOM uses obfuscated class names → we rely on ARIA, roles, structure
 */

import { SELECTORS, PLACEHOLDER_TEXTS, ERROR_KEYWORDS, META_TIMING } from './config.js';
import { TIMING } from '../../config.js';
import { log } from '../../logger.js';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ── Find Input Element ────────────────────────────────────────

/**
 * Find the chat input element.
 * Uses multiple strategies with ARIA attributes and roles.
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<import('puppeteer-core').ElementHandle|null>}
 */
export async function findInputElement(page) {
  const handle = await page.evaluateHandle((selectorList, placeholders) => {
    // Strategy 1: Try each selector in order
    for (const selector of selectorList) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        // Return the last matching element (usually the active input)
        return elements[elements.length - 1];
      }
    }

    // Strategy 2: Find by placeholder text content
    for (const el of document.querySelectorAll('textarea, div[contenteditable="true"]')) {
      const placeholder = el.getAttribute('placeholder') || el.getAttribute('aria-label') || '';
      for (const ph of placeholders) {
        if (placeholder.toLowerCase().includes(ph.toLowerCase())) {
          return el;
        }
      }
    }

    // Strategy 3: Find the last visible textarea on the page
    const textareas = document.querySelectorAll('textarea');
    if (textareas.length > 0) {
      return textareas[textareas.length - 1];
    }

    // Strategy 4: Find the last contenteditable div
    const editables = document.querySelectorAll('div[contenteditable="true"]');
    if (editables.length > 0) {
      return editables[editables.length - 1];
    }

    return null;
  }, SELECTORS.CHAT_INPUT, PLACEHOLDER_TEXTS);

  const element = handle.asElement();
  if (!element) {
    handle.dispose();
    return null;
  }
  return element;
}

// ── Find Send Button ──────────────────────────────────────────

/**
 * Find the send/submit button.
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<import('puppeteer-core').ElementHandle|null>}
 */
export async function findSendButton(page) {
  const handle = await page.evaluateHandle((selectorList) => {
    // Strategy 1: Try each selector
    for (const selector of selectorList) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        return elements[elements.length - 1];
      }
    }

    // Strategy 2: Find button near the input area with send icon
    // Look for SVG send icons (paper plane, arrow) inside buttons
    const allBtns = document.querySelectorAll('button');
    for (const btn of allBtns) {
      const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (ariaLabel.includes('send') || ariaLabel.includes('gửi') || ariaLabel.includes('submit')) {
        return btn;
      }
    }

    // Strategy 3: Find the submit button in the form containing the input
    const form = document.querySelector('form');
    if (form) {
      const submitBtn = form.querySelector('button[type="submit"], button:last-child');
      if (submitBtn) return submitBtn;
    }

    return null;
  }, SELECTORS.SEND_BUTTON);

  const element = handle.asElement();
  if (!element) {
    handle.dispose();
    return null;
  }
  return element;
}

// ── Type Prompt ───────────────────────────────────────────────

/**
 * Clear the input and type a new prompt.
 * @param {import('puppeteer-core').Page} page
 * @param {import('puppeteer-core').ElementHandle} inputEl
 * @param {string} prompt
 * @param {string} inputMethod
 */
export async function typePrompt(page, inputEl, prompt, inputMethod = 'typing') {
  // Click to focus — try Puppeteer click first, fallback to JS-level click
  try {
    await inputEl.click();
  } catch (clickErr) {
    // Fallback: use JavaScript click + focus directly on the DOM element
    try {
      await inputEl.evaluate(el => {
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        el.focus();
        el.click();
      });
    } catch (jsClickErr) {
      // Last resort: click via page coordinates
      const box = await inputEl.boundingBox();
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      } else {
        throw new Error(`Cannot click input element: ${clickErr.message}`);
      }
    }
  }
  await delay(TIMING.INPUT_SETTLE);

  // Select all + delete (works for both textarea and contenteditable)
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await delay(100);
  await page.keyboard.press('Backspace');
  await delay(TIMING.SELECT_ALL_SETTLE);

  if (inputMethod === 'paste') {
    // Fast typing (simulates paste, safe for React/Angular frameworks)
    await page.keyboard.type(prompt, { delay: 0 });
    await delay(TIMING.TYPE_SETTLE);
  } else {
    // Type with human-like delay
    await page.keyboard.type(prompt, { delay: TIMING.HUMAN_TYPE_DELAY });
    await delay(TIMING.TYPE_SETTLE);
  }
}

/**
 * Get the current text in the input field.
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<string>}
 */
export async function getInputText(page) {
  return page.evaluate((selectorList) => {
    for (const selector of selectorList) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        const el = elements[elements.length - 1];
        return (el.value || el.textContent || '').trim();
      }
    }
    // Fallback: last textarea
    const textareas = document.querySelectorAll('textarea');
    if (textareas.length > 0) {
      return (textareas[textareas.length - 1].value || '').trim();
    }
    return '';
  }, SELECTORS.CHAT_INPUT);
}

// ── Image Snapshot & Detection ────────────────────────────────

/**
 * Take a snapshot of all image and video srcs currently on the page.
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<string[]>}
 */
export async function snapshotImages(page) {
  return page.evaluate((minSize) => {
    const srcs = [];
    document.querySelectorAll('img').forEach(img => {
      if (img.src && !img.src.startsWith('data:image/svg')) {
        srcs.push(img.src);
      }
    });
    document.querySelectorAll('video').forEach(vid => {
      if (vid.src) {
        srcs.push(vid.src);
      } else {
        const source = vid.querySelector('source');
        if (source && source.src) {
          srcs.push(source.src);
        }
      }
    });
    return srcs;
  }, META_TIMING.MIN_IMAGE_SIZE);
}

/**
 * Find new images and videos that appeared after the snapshot.
 * Filters out small elements by size.
 * @param {import('puppeteer-core').Page} page
 * @param {Set<string>} snapshotSrcs
 * @returns {Promise<Array<{src: string, width: number, height: number, type: 'image'|'video'}>>}
 */
export async function findNewImages(page, snapshotSrcs) {
  const allMedia = await page.evaluate((minSize) => {
    const result = [];
    
    // Images
    for (const img of document.querySelectorAll('img')) {
      if (!img.src) continue;
      if (img.src.startsWith('data:image/svg')) continue;
      if (img.dataset.autoMediaClaimed) continue;

      if (img.naturalWidth < minSize || img.naturalHeight < minSize) continue;

      const rect = img.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 80) continue;

      result.push({
        src: img.src,
        width: img.naturalWidth || rect.width,
        height: img.naturalHeight || rect.height,
        type: 'image',
      });
    }

    // Videos
    for (const vid of document.querySelectorAll('video')) {
      let src = vid.src;
      if (!src) {
        const source = vid.querySelector('source');
        if (source) src = source.src;
      }
      if (!src) continue;
      if (vid.dataset.autoMediaClaimed) continue;

      const rect = vid.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 80) continue;

      result.push({
        src: src,
        width: vid.videoWidth || rect.width || 720,
        height: vid.videoHeight || rect.height || 1280,
        type: 'video',
      });
    }

    return result;
  }, META_TIMING.MIN_IMAGE_SIZE);

  return allMedia.filter(media => !snapshotSrcs.has(media.src));
}

// ── Rendering Detection ───────────────────────────────────────

/**
 * Check if Meta AI is still generating/loading a response.
 * Looks for typing indicators, loading spinners, etc.
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<boolean>}
 */
export async function isStillRendering(page) {
  return page.evaluate(() => {
    // Strategy 1: Look for typing indicator / loading animation
    // Meta AI shows animated dots or a "thinking" indicator
    const loadingIndicators = [
      '[data-testid*="loading"]',
      '[data-testid*="typing"]',
      '[role="progressbar"]',
    ];

    for (const selector of loadingIndicators) {
      if (document.querySelector(selector)) return true;
    }

    // Strategy 2: Look for "Thinking" or loading text in buttons/spans
    // Meta AI shows a "Thinking" button or status text while generating
    const thinkingTexts = ['thinking', 'generating', 'đang suy nghĩ', 'đang tạo'];
    for (const el of document.querySelectorAll('button, span')) {
      const text = (el.textContent || '').toLowerCase().trim();
      if (thinkingTexts.some(t => text === t || text.includes(t))) {
        // Make sure it's visible
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return true;
      }
    }

    return false;
  });
}

// ── Error Detection ───────────────────────────────────────────

/**
 * Check for error messages in the latest chat response.
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<string|null>}
 */
export async function detectError(page) {
  return page.evaluate((errorKeywords) => {
    // Get the last few chat messages and check for error patterns
    // Meta AI's error responses are in the assistant's message bubbles
    const allText = document.body.innerText.toLowerCase();
    const lastChunk = allText.slice(-3000);

    for (const kw of errorKeywords) {
      if (lastChunk.includes(kw)) {
        // Verify it's in a recent message, not old content
        return kw;
      }
    }

    // Check for alert elements
    for (const al of document.querySelectorAll('[role="alert"]')) {
      const t = al.textContent.toLowerCase();
      for (const kw of errorKeywords) {
        if (t.includes(kw)) return kw;
      }
    }

    return null;
  }, ERROR_KEYWORDS);
}

// ── Claim & Cleanup ───────────────────────────────────────────

/**
 * Mark images and videos as claimed to prevent re-detection.
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
 * Find images and videos claimed by a specific prompt index.
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
      if (img.naturalWidth < minSize || img.naturalHeight < minSize) continue;
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
  }, promptIndex, META_TIMING.MIN_IMAGE_SIZE);
}

/**
 * Mark all unclaimed images and videos as 'old'.
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
