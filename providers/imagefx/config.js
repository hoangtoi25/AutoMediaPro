/**
 * providers/imagefx/config.js — ImageFX-specific configuration.
 *
 * Extracted from the root config.js. Contains all selectors, keywords,
 * and URLs specific to Google Labs ImageFX / Flow.
 */

// ── Target URL ────────────────────────────────────────────────
export const TARGET_URL = 'https://labs.google/fx/tools/image-fx';
export const URL_PATTERN = 'labs.google/fx';
export const LOGIN_URL = 'https://labs.google/fx/tools/image-fx';

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
