/**
 * index.js — CLI entry point for AutoMediaPro.
 *
 * Usage:
 *   node index.js --prompts ./prompts/my-prompts.txt --folder "ProjectName"
 *   node index.js --prompts ./prompts/my-prompts.txt --folder "ProjectName" --provider meta-ai
 *   node index.js --prompts ./prompts/my-prompts.txt --folder "ProjectName" --new-chrome
 *
 * Options:
 *   --prompts, -p   Path to text file with prompts (1 per line)
 *   --folder, -f    Download subfolder name (default: "AutoMedia")
 *   --retries, -r   Max retries per prompt (default: 2)
 *   --provider      Image generation provider: 'imagefx' (default) or 'meta-ai'
 *   --new-chrome     Force launch a new Chrome instance
 *   --login          Open Chrome for manual login, then exit
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { getBrowser } from './browser.js';
import { runGeneration } from './generator.js';
import { initProviders, getProvider, listProviders } from './providers/provider-interface.js';
import { log } from './logger.js';

// ── Parse CLI Arguments ───────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    promptsFile: null,
    downloadFolder: 'AutoMedia',
    maxRetries: 2,
    forceNewChrome: false,
    loginMode: false,
    provider: 'imagefx',
    mediaType: 'image',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--prompts':
      case '-p':
        opts.promptsFile = args[++i];
        break;
      case '--folder':
      case '-f':
        opts.downloadFolder = args[++i];
        break;
      case '--retries':
      case '-r':
        opts.maxRetries = parseInt(args[++i]) || 2;
        break;
      case '--provider':
        opts.provider = args[++i];
        break;
      case '--new-chrome':
        opts.forceNewChrome = true;
        break;
      case '--media-type':
        opts.mediaType = args[++i] || 'image';
        break;
      case '--login':
        opts.loginMode = true;
        break;
      default:
        // If no flag, treat as prompts file
        if (!opts.promptsFile && !args[i].startsWith('-')) {
          opts.promptsFile = args[i];
        }
    }
  }

  return opts;
}

// ── Load Prompts ──────────────────────────────────────────────

/**
 * Load prompts from a .txt or .md file.
 *
 * .txt format:
 *   - Each non-empty line is a prompt
 *   - Lines starting with # are comments (skipped)
 *
 * .md format:
 *   - Headers (# ...) are skipped
 *   - Code fences (```) are skipped
 *   - Horizontal rules (---) are skipped
 *   - Image/link-only lines are skipped
 *   - Markdown formatting is stripped: **bold**, *italic*, `code`, [links](url)
 *   - Numbered lists (1. text), bullet lists (- text, * text) → extracted as prompts
 *   - Plain text lines → kept as prompts
 */
async function loadPrompts(filePath) {
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    throw new Error(`File không tồn tại: ${absPath}`);
  }

  const content = await readFile(absPath, 'utf-8');
  const ext = absPath.toLowerCase().split('.').pop();

  let prompts;
  if (ext === 'md' || ext === 'markdown') {
    prompts = parseMdPrompts(content);
  } else {
    prompts = parseTxtPrompts(content);
  }

  if (prompts.length === 0) {
    throw new Error('File prompts rỗng!');
  }

  log.info(`Định dạng: .${ext} → ${prompts.length} prompts`);
  return prompts;
}

function parseTxtPrompts(content) {
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));
}

function parseMdPrompts(content) {
  const lines = content.split(/\r?\n/);
  const allPrompts = [];
  const numberedPrompts = [];
  let inCodeBlock = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Toggle code fences
    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    // Skip empty lines
    if (line.length === 0) continue;

    // Skip markdown headers
    if (/^#{1,6}\s/.test(line)) continue;

    // Skip horizontal rules
    if (/^[-*_]{3,}$/.test(line)) continue;

    // Skip image-only lines: ![alt](url)
    if (/^!\[.*\]\(.*\)$/.test(line)) continue;

    // Skip HTML comments
    if (line.startsWith('<!--')) continue;

    // Skip lines that are just metadata (e.g., "Key: value" style headers)
    // But allow numbered prompts like "1. text" or "42: text"
    if (/^[A-Za-z][A-Za-z\s]+:/.test(line) && !/^\d+[.:]\s/.test(line)) continue;

    // Extract prompt text from list items
    let promptText = line;

    // Remove bullet markers: - text, * text, + text
    promptText = promptText.replace(/^[-*+]\s+/, '');

    // Remove checkbox markers: - [ ] text, - [x] text
    promptText = promptText.replace(/^\[[ x]\]\s+/i, '');

    // Strip markdown inline formatting
    promptText = stripMarkdownFormatting(promptText);

    // Final trim
    promptText = promptText.trim();

    // Skip if too short after stripping (likely formatting artifacts)
    if (promptText.length < 5) continue;

    // Skip link-only lines after stripping
    if (promptText.startsWith('http://') || promptText.startsWith('https://')) continue;

    allPrompts.push(promptText);

    // Track numbered prompts separately (e.g., "1. text", "42. text", "1: text")
    if (/^\d+[.\-:]\s/.test(promptText)) {
      numberedPrompts.push(promptText);
    }
  }

  // If we found numbered prompts, ONLY use those (skip description lines)
  // Otherwise fall back to all extracted lines
  if (numberedPrompts.length > 0) {
    log.step(`Tìm thấy ${numberedPrompts.length} prompt đánh số (bỏ qua ${allPrompts.length - numberedPrompts.length} dòng mô tả)`);
    return numberedPrompts;
  }

  return allPrompts;
}

/**
 * Strip common markdown inline formatting from a string.
 * Preserves numbered prefixes like "1. " for file naming.
 */
function stripMarkdownFormatting(text) {
  return text
    // Links: [text](url) → text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Images: ![alt](url) → (removed)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '')
    // Bold: **text** or __text__ → text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    // Italic: *text* or _text_ → text
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    // Strikethrough: ~~text~~ → text
    .replace(/~~(.+?)~~/g, '$1')
    // Inline code: `text` → text
    .replace(/`([^`]+)`/g, '$1')
    // HTML tags
    .replace(/<[^>]+>/g, '');
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  console.log(`
╔══════════════════════════════════════════╗
║          🎨 AutoMediaPro v2.0           ║
║   Multi-Provider Image Generation       ║
╚══════════════════════════════════════════╝
`);

  // Initialize all providers
  await initProviders();

  const opts = parseArgs();

  // Validate provider
  let provider;
  try {
    provider = getProvider(opts.provider);
  } catch (e) {
    log.error(e.message);
    log.info(`Providers có sẵn: ${listProviders().join(', ')}`);
    process.exit(1);
  }

  log.info(`Provider: ${provider.displayName}`);

  // ── Login Mode ──────────────────────────────────────────
  if (opts.loginMode) {
    log.info(`Chế độ LOGIN: Mở Chrome để đăng nhập ${provider.displayName}...`);
    log.info('Sau khi đăng nhập xong, đóng Chrome và chạy lại script.');
    const { browser } = await getBrowser({ forceNew: true });
    const page = (await browser.pages())[0] || await browser.newPage();
    await page.goto(provider.loginUrl, { waitUntil: 'networkidle2' });
    log.success(`Chrome đã mở. Đăng nhập ${provider.displayName} rồi đóng trình duyệt.`);
    // Keep alive — user closes manually
    return;
  }

  // ── Normal Mode ─────────────────────────────────────────
  if (!opts.promptsFile) {
    console.log(`
Cách dùng:
  node index.js --prompts <file.txt|file.md> --folder <tên_folder> [--provider <name>]

Ví dụ:
  node index.js -p ./prompts/my-prompts.txt -f "MyProject"
  node index.js -p ./prompts/stickman.md -f "Stickman" --provider meta-ai

Providers có sẵn:
  imagefx    → Google Labs ImageFX (mặc định)
  meta-ai    → Meta AI Imagine

Hỗ trợ file:
  .txt  → Mỗi dòng = 1 prompt, dòng # = comment
  .md   → Tự động bỏ headers, formatting, chỉ lấy prompts đánh số

Các option:
  --prompts, -p    File chứa prompts (.txt hoặc .md)
  --folder, -f     Tên thư mục download (default: AutoMedia)
  --retries, -r    Số lần retry tối đa (default: 2)
  --provider       Chọn engine tạo ảnh (default: imagefx)
  --new-chrome     Bắt buộc mở Chrome mới
  --login          Mở Chrome để đăng nhập (chạy 1 lần đầu)

Bước đầu tiên (chỉ cần 1 lần cho mỗi provider):
  node index.js --login --provider imagefx
  node index.js --login --provider meta-ai
`);
    process.exit(0);
  }

  // Load prompts
  log.info(`Đang đọc prompts từ: ${opts.promptsFile}`);
  const prompts = await loadPrompts(opts.promptsFile);
  log.info(`Đã tải ${prompts.length} prompts`);
  console.log(`[SYSTEM] PROMPTS_LIST:${JSON.stringify(prompts)}`);

  // Connect to Chrome
  const { browser, isNew } = await getBrowser({ forceNew: opts.forceNewChrome });

  // Get or create a page
  let page;
  const pages = await browser.pages();

  // Try to find an existing tab for this provider
  const providerPage = pages.find(p => {
    try { return p.url().includes(provider.urlPattern); } catch { return false; }
  });

  if (providerPage) {
    page = providerPage;
    log.info(`Đã tìm thấy tab ${provider.displayName} đang mở`);
    // Refresh to ensure frame is active
    try {
      await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
      log.step(`Đã refresh tab ${provider.displayName}`);
    } catch (e) {
      log.warn(`Tab cũ bị lỗi (${e.message}), tạo tab mới...`);
      page = await browser.newPage();
      await page.goto(provider.targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    }
  } else {
    page = pages.length > 0 ? pages[0] : await browser.newPage();
    log.step(`Đang mở ${provider.displayName}...`);
    try {
      await page.goto(provider.targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    } catch (e) {
      log.warn(`Tab hiện tại lỗi (${e.message}), tạo tab mới...`);
      page = await browser.newPage();
      await page.goto(provider.targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    }
  }

  // Wait for page to fully render
  const delayFn = (ms) => new Promise(r => setTimeout(r, ms));
  await delayFn(5000); // Give time for popups and dynamic content to load

  const isLoggedIn = await provider.checkLogin(page);

  if (!isLoggedIn) {
    log.error(`Chưa đăng nhập ${provider.displayName}!`);
    log.info(`Chạy: node index.js --login --provider ${provider.name}`);
    log.info(`Đăng nhập trong Chrome, đóng lại, rồi chạy lại script.`);
    if (isNew) await browser.close();
    process.exit(1);
  }

  log.success(`Đã đăng nhập ${provider.displayName}`);

  // Set up abort controller for graceful stop
  const ac = new AbortController();
  process.on('SIGINT', () => {
    log.warn('Ctrl+C → Đang dừng...');
    ac.abort();
  });

  // Run the pipeline
  try {
    const result = await runGeneration(page, {
      prompts,
      downloadFolder: opts.downloadFolder,
      providerName: opts.provider,
      maxRetries: opts.maxRetries,
      mediaType: opts.mediaType,
      signal: ac.signal,
    });

    // Print summary
    const failed = result.results.filter(r => r.status !== 'success');
    if (failed.length > 0) {
      log.warn(`\nCác prompt thất bại:`);
      for (const f of failed) {
        log.error(`  → ${f.prompt.substring(0, 60)}... (${f.error || f.status})`);
      }
    }
  } catch (err) {
    log.error(`Fatal error: ${err.message}`);
  }

  // Don't close the browser if we connected to an existing one
  if (isNew) {
    log.info('Đóng Chrome...');
    await browser.close();
  } else {
    log.info('Giữ Chrome mở (đã connect vào browser có sẵn)');
  }
}

main().catch(err => {
  log.error(`Lỗi nghiêm trọng: ${err.message}`);
  console.error(err);
  process.exit(1);
});
