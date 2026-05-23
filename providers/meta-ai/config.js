/**
 * providers/meta-ai/config.js — Meta AI Imagine specific configuration.
 *
 * Contains selectors, URLs, and keywords for the Meta AI web interface.
 * Meta AI uses a chat-style interface where the "/imagine" command triggers
 * image generation within the conversation.
 *
 * ⚠️ Meta uses obfuscated/dynamic CSS class names. Selectors here rely on
 *    ARIA attributes, roles, and structural patterns rather than class names.
 */

// ── Target URL ────────────────────────────────────────────────
export const TARGET_URL = 'https://www.meta.ai/';
export const URL_PATTERN = 'meta.ai';
export const LOGIN_URL = 'https://www.meta.ai/';

// ── Prompt Prefix ─────────────────────────────────────────────
// Meta AI generates images when prompted with "/imagine" or a descriptive request.
// Using "Imagine" as a natural prefix works more reliably than the slash command.
export const PROMPT_PREFIX = 'Imagine ';

// ── Selectors ─────────────────────────────────────────────────
// These use ARIA attributes and roles for stability across UI updates.
export const SELECTORS = {
  // Chat input — Meta AI uses a textarea or contenteditable div
  CHAT_INPUT: [
    'textarea[aria-label]',
    'div[role="textbox"][contenteditable="true"]',
    'textarea[placeholder]',
  ],

  // Send/Submit button
  SEND_BUTTON: [
    'button[aria-label="Send"]',
    'button[aria-label="Gửi"]',
    'button[type="submit"]',
  ],

  // Generated image results within the chat
  IMAGE_RESULT: 'img',

  // Alert/error elements
  ALERT: '[role="alert"]',
};

// ── Keywords ──────────────────────────────────────────────────
export const PLACEHOLDER_TEXTS = [
  'Ask Meta AI anything',
  'Hỏi Meta AI bất cứ điều gì',
  'Ask anything',
  'Message',
];

export const ERROR_KEYWORDS = [
  'sorry',
  'cannot generate',
  'unable to create',
  'i can\'t',
  'violates',
  'try again',
  'not able to',
  'against my guidelines',
  'inappropriate',
  'i\'m not able',
  'something went wrong',
  'error',
];

// ── Timing overrides for Meta AI ──────────────────────────────
// Meta AI can be slower than ImageFX due to chat-based interaction.
export const META_TIMING = {
  POLL_INTERVAL:       3000,   // How often to check for new images
  INTER_PROMPT_DELAY:  5000,   // Longer delay — chat interface needs settling
  RESPONSE_WAIT:       2000,   // Wait for chat response bubble to start
  IMAGE_LOAD_WAIT:     2000,   // Wait for images to fully render
  PHASE1_TIMEOUT_S:    150,    // Generous timeout — Meta AI can be slow
  MAX_WAIT_POLLS:      250,    // Max poll cycles
  MIN_IMAGE_SIZE:      100,    // Min natural size to consider as generated image
};
