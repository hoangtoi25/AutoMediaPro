/**
 * config.js — Central configuration for AutoMediaPro.
 *
 * All paths, timing values, selectors, and keywords in one place.
 * When Google Labs changes their UI, update selectors HERE only.
 */

import { homedir } from 'os';
import { join } from 'path';

// ── Chrome Connection ─────────────────────────────────────────
export const CHROME = {
  // Default Chrome executable path (Windows)
  EXECUTABLE: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  // Remote debugging port
  DEBUG_PORT: 9222,
  // User data directory — uses a DEDICATED profile to avoid conflicts
  // with your main Chrome instance
  USER_DATA_DIR: join(homedir(), '.automedia-chrome-profile'),
  // WebSocket endpoint (auto-discovered if not set)
  WS_ENDPOINT: null,
};

// ── Target URL ────────────────────────────────────────────────
export const TARGET_URL = 'https://labs.google/fx/tools/image-fx';

// ── Timing (milliseconds) ─────────────────────────────────────
export const TIMING = {
  POLL_INTERVAL:      3000,   // How often to check for new images
  INTER_PROMPT_DELAY: 3000,   // Delay between prompts
  INPUT_SETTLE:       400,    // Wait after focusing input
  TYPE_SETTLE:        1000,   // Wait after typing prompt
  SELECT_ALL_SETTLE:  300,    // Wait after Ctrl+A
  IMAGE_LOAD_WAIT:    1500,   // Wait for images to fully load before download
  DOWNLOAD_SETTLE:    500,    // Wait between downloads
  PHASE1_TIMEOUT_S:   120,    // Max seconds to wait for images to appear
  MAX_WAIT_POLLS:     200,    // Max poll cycles before timeout
  NAVIGATE_WAIT:      3000,   // Wait after navigating to ImageFX
  HUMAN_TYPE_DELAY:   25,     // ms per character (human-like typing speed)
};

// ── Selectors ─────────────────────────────────────────────────
export const SELECTORS = {
  SLATE_EDITOR:       "div[data-slate-editor='true'][contenteditable='true']",
  ROLE_TEXTBOX:       "div[role='textbox'][contenteditable='true']",
  GENERATE_BTN_CLASS: 'button.sc-e5032833-5',
  IMAGE_CARD:         'div[role="button"]',
  ALERT:              '[role="alert"]',
};

// ── Keywords ──────────────────────────────────────────────────
export const PLACEHOLDER_TEXTS = [
  'Bạn muốn tạo gì?',
  'What do you want to create?',
];

export const GENERATE_BTN_KEYWORDS = ['Banana', 'Imagen'];

export const ERROR_KEYWORDS = [
  'không thể tạo',
  'vi phạm chính sách',
  'policy violation',
  'could not generate',
  'unable to generate',
  'an error occurred',
  'đã xảy ra lỗi',
  'content policy violation',
  'unsafe content detected',
  'bạn phải cung cấp câu lệnh',
  'you must provide a prompt',
  'không thành công',
  'yêu cầu tạo quá nhanh',
  'too many requests',
];

// ── Image Detection ───────────────────────────────────────────
export const IMAGE = {
  MIN_NATURAL_SIZE: 100,
  MIN_CLAIM_SIZE:    50,
};

// ── Download ──────────────────────────────────────────────────
export const DOWNLOAD = {
  BASE_DIR: join(homedir(), 'Downloads'),
};
