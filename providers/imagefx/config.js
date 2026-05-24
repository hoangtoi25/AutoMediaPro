/**
 * providers/imagefx/config.js — ImageFX-specific configuration.
 *
 * Extracted from the root config.js. Contains all selectors, keywords,
 * and URLs specific to Google Labs ImageFX / Flow.
 */

// ── Target URL ────────────────────────────────────────────────
export const TARGET_URL = 'https://labs.google/fx/vi/tools/flow';
export const URL_PATTERN = 'labs.google/fx';
export const LOGIN_URL = 'https://labs.google/fx/vi/tools/flow';

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

export const GENERATE_BTN_KEYWORDS = ['Banana', 'Imagen', 'Veo'];

// ── Video Mode Settings ───────────────────────────────────────
// Labels for Image/Video tab buttons in the settings panel
export const MEDIA_TAB_LABELS = {
  image: ['Image', 'Hình ảnh'],
  video: ['Video'],
};

// Preferred video settings (applied during preparePage when mediaType='video')
export const VIDEO_DEFAULTS = {
  // Aspect ratio: '16:9', '9:16', or 'auto' (parse from first prompt's --ar flag)
  ASPECT_RATIO: 'auto',
  // Duration: '4s', '6s', or '8s'
  DURATION: '8s',
  // Preferred model name substring (leave empty to keep default)
  MODEL: '',
};

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
