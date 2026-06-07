/**
 * browser.js — Chrome connection manager.
 *
 * Two strategies:
 *   1. Connect to an EXISTING Chrome instance (user already opened with --remote-debugging-port)
 *   2. Launch a NEW Chrome instance with a dedicated profile
 *
 * Strategy 1 is preferred (reuses login session).
 */

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { execFile } from 'child_process';
import { CHROME } from './config.js';
import { log } from './logger.js';

puppeteer.use(StealthPlugin());

/**
 * Try to connect to an already-running Chrome with remote debugging.
 * @returns {Promise<import('puppeteer-core').Browser|null>}
 */
async function tryConnect() {
  try {
    const endpoint = `http://127.0.0.1:${CHROME.DEBUG_PORT}`;
    log.info(`Đang kết nối Chrome tại ${endpoint}...`);

    // Fetch WebSocket URL from debugging endpoint
    const res = await fetch(`${endpoint}/json/version`);
    const data = await res.json();
    const wsUrl = data.webSocketDebuggerUrl;

    if (!wsUrl) {
      log.warn('Không tìm thấy WebSocket endpoint.');
      return null;
    }

    const browser = await puppeteer.connect({
      browserWSEndpoint: wsUrl,
      defaultViewport: null, // Keep the user's existing viewport
    });

    log.success(`Đã kết nối Chrome (${data['Browser']})`);
    return browser;
  } catch {
    return null;
  }
}

/**
 * Launch a new Chrome instance with a dedicated automation profile.
 * This profile is separate from the user's main Chrome data.
 * @returns {Promise<import('puppeteer-core').Browser>}
 */
async function launchNew() {
  log.info('Đang mở Chrome mới...');
  log.info(`Profile: ${CHROME.USER_DATA_DIR}`);

  const args = [
    `--user-data-dir=${CHROME.USER_DATA_DIR}`,
    `--remote-debugging-port=${CHROME.DEBUG_PORT}`,
    '--disable-blink-features=AutomationControlled',
    '--exclude-switches=enable-automation',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-infobars',
    '--start-maximized',
  ];

  // Clean environment variables to prevent Chrome from inheriting ELECTRON_RUN_AS_NODE
  const cleanEnv = { ...process.env };
  delete cleanEnv.ELECTRON_RUN_AS_NODE;

  // Launch Chrome using native execFile (most robust on Windows with Portable Chrome)
  const child = execFile(CHROME.EXECUTABLE, args, {
    env: cleanEnv,
  });

  child.unref();

  // Poll debugging endpoint to get WebSocket URL
  log.info('Đang chờ Chrome khởi động...');
  const maxAttempts = 30; // Wait up to 15 seconds
  let attempts = 0;
  let wsUrl = null;

  while (attempts < maxAttempts) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const endpoint = `http://127.0.0.1:${CHROME.DEBUG_PORT}`;
      const res = await fetch(`${endpoint}/json/version`);
      const data = await res.json();
      wsUrl = data.webSocketDebuggerUrl;
      if (wsUrl) break;
    } catch (e) {
      // Ignore connection errors during startup
    }
    attempts++;
  }

  if (!wsUrl) {
    throw new Error(`Không thể khởi động hoặc kết nối tới Chrome tại cổng ${CHROME.DEBUG_PORT}.`);
  }

  const browser = await puppeteer.connect({
    browserWSEndpoint: wsUrl,
    defaultViewport: null,
  });

  log.success('Chrome đã mở và kết nối thành công.');
  return browser;
}

/**
 * Get a connected browser instance.
 * First tries to connect to existing Chrome, then launches new if needed.
 * @param {object} opts
 * @param {boolean} [opts.forceNew=false] Force launch a new instance
 * @returns {Promise<{browser: import('puppeteer-core').Browser, isNew: boolean}>}
 */
export async function getBrowser(opts = {}) {
  if (!opts.forceNew) {
    const existing = await tryConnect();
    if (existing) return { browser: existing, isNew: false };
    log.info('Không tìm thấy Chrome đang chạy, sẽ mở mới...');
  }

  const browser = await launchNew();
  return { browser, isNew: true };
}
