/**
 * flow-pipeline.js — 2-Phase Flow Pipeline: Image → Video (img2video).
 *
 * Orchestrates the full flow for each prompt pair:
 *   Phase 1: Switch to Image mode → configure → generate image → download
 *   Phase 2: Switch to Video mode → configure → upload start image → generate video → download
 *
 * Repeats for each pair: Image1 → Video1 → Image2 → Video2 → ... → ImageN → VideoN
 */

import { join } from 'path';
import { TIMING, DOWNLOAD } from './config.js';
import { getProvider } from './providers/provider-interface.js';
import { downloadImage } from './downloader.js';
import { log } from './logger.js';
import {
  selectMediaMode,
  configureImageSettings,
  configureVideoSettings,
  openSettingsPanel,
  closeSettingsAndFocusInput,
  uploadStartImage,
  clearStartImage,
  selectScaleOption,
  selectModel,
  findInputElement,
  snapshotImages,
} from './providers/imagefx/page-actions.js';
import { FLOW_DEFAULTS } from './providers/imagefx/config.js';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Run the full 2-phase flow pipeline for paired image + video prompts.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {object} config
 * @param {Array<{index: number, imagePrompt: string, videoPrompt: string}>} config.pairs
 * @param {string} config.downloadFolder
 * @param {string} [config.providerName='imagefx']
 * @param {number} [config.maxRetries=2]
 * @param {AbortSignal} [config.signal]
 * @returns {Promise<{results: Array}>}
 */
export async function runFlowPipeline(page, config) {
  const {
    pairs,
    downloadFolder,
    providerName = 'imagefx',
    maxRetries = 2,
    signal,
    aspectRatio = null,
    inputMethod = 'typing',
  } = config;

  const imageAspectRatio = aspectRatio || FLOW_DEFAULTS.IMAGE_ASPECT_RATIO;
  const videoAspectRatio = aspectRatio || FLOW_DEFAULTS.VIDEO_ASPECT_RATIO;

  const provider = getProvider(providerName);
  const results = [];

  log.info(`\n${'═'.repeat(50)}`);
  log.info(`🔄 FLOW PIPELINE: ${pairs.length} cặp prompt (Image → Video)`);
  log.info(`📁 Output: ${downloadFolder}/`);
  log.info(`🎨 Image: ${imageAspectRatio}, ${FLOW_DEFAULTS.IMAGE_SCALE}, model="${FLOW_DEFAULTS.IMAGE_MODEL || 'default'}"`);
  log.info(`🎬 Video: ${videoAspectRatio}, ${FLOW_DEFAULTS.VIDEO_DURATION}, model="${FLOW_DEFAULTS.VIDEO_MODEL || 'default'}"`);
  log.info(`${'═'.repeat(50)}\n`);

  // Ensure we're on the provider's page
  const currentUrl = page.url();
  if (!currentUrl.includes(provider.urlPattern)) {
    log.step(`Navigating to ${provider.displayName}...`);
    await page.goto(provider.targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(TIMING.NAVIGATE_WAIT);
  }

  // Handle landing page (dismiss popups, create new project)
  // NOTE: Use aspectRatio 'auto' here — we'll configure settings ourselves in the per-pair loop
  //       because preparePage's config runs before settings panel is fully loaded
  await provider.preparePage(page, 'image', { aspectRatio: 'auto' });

  for (let i = 0; i < pairs.length; i++) {
    if (signal?.aborted) {
      log.warn('Đã nhận lệnh dừng!');
      break;
    }

    const pair = pairs[i];
    const pairLabel = `[${i + 1}/${pairs.length}]`;

    log.info(`\n${'─'.repeat(50)}`);
    log.info(`${pairLabel} 🔄 Bắt đầu cặp #${pair.index}`);
    log.info(`${'─'.repeat(50)}`);

    let imageSuccess = false;
    let imagePath = null;
    let videoSuccess = false;

    // ══════════════════════════════════════════════════
    // PHASE 1: TẠO ẢNH
    // ══════════════════════════════════════════════════
    log.info(`${pairLabel} 🎨 PHASE 1: Tạo ảnh #${pair.index}`);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) break;

      const retryLabel = attempt > 0 ? ` [Retry ${attempt}/${maxRetries}]` : '';

      try {
        // ── CẤU HÌNH IMAGE MODE ──────────────────────────
        log.step(`${pairLabel} ⚙️ Cấu hình Image mode...${retryLabel}`);

        // 1a. Switch to Image mode
        log.step(`${pairLabel}   → Chuyển sang tab Hình ảnh`);
        await selectMediaMode(page, 'image');
        await delay(2000); // Chờ settings panel load sau khi chuyển mode

        // 1b. Configure aspect ratio
        log.step(`${pairLabel}   → Chọn tỉ lệ ${imageAspectRatio}`);
        const ratioOk = await configureImageSettings(page, { aspectRatio: imageAspectRatio });
        await delay(500);

        // 1c. Configure scale: 1x
        log.step(`${pairLabel}   → Chọn scale ${FLOW_DEFAULTS.IMAGE_SCALE}`);
        const scaleOk = await selectScaleOption(page, FLOW_DEFAULTS.IMAGE_SCALE);
        await delay(500);

        // 1d. Select image model (e.g. "Nano Banana Pro")
        if (FLOW_DEFAULTS.IMAGE_MODEL) {
          log.step(`${pairLabel}   → Chọn model ${FLOW_DEFAULTS.IMAGE_MODEL}`);
          const modelOk = await selectModel(page, FLOW_DEFAULTS.IMAGE_MODEL);
          await delay(500);

          if (!modelOk) {
            log.warn(`${pairLabel}   ⚠️ Không chọn được model "${FLOW_DEFAULTS.IMAGE_MODEL}" — tiếp tục với model hiện tại`);
          }
        }

        log.success(`${pairLabel} ⚙️ Cấu hình Image hoàn tất`);

        // CRITICAL: Close settings panel and focus prompt input BEFORE typing
        await closeSettingsAndFocusInput(page);
        await delay(500); // Chờ ổn định trước khi nhập prompt

        // ── NHẬP PROMPT VÀ TẠO ẢNH ──────────────────────
        // 1e. Strip --ar from prompt (since we already configured aspect ratio)
        const cleanImagePrompt = pair.imagePrompt
          .replace(/\s*--ar\s+[\d]+:[\d]+/gi, '')
          .trim();

        // 1f. Snapshot → Submit → Wait
        log.prompt(pair.index, `🎨 ${cleanImagePrompt.substring(0, 80)}...`);
        const imgSnapshot = new Set(await provider.snapshotImages(page));
        await provider.submitPrompt(page, cleanImagePrompt, 'image', inputMethod);

        const imageResult = await provider.waitForImages(page, pair.index, imgSnapshot, signal, 'image');

        if (imageResult.status === 'success' && imageResult.images.length > 0) {
          // 1f. Download first image only (1x)
          const firstImage = imageResult.images[0];
          const imageFilename = `${pair.index}.jpg`;
          await downloadImage(page, firstImage.src, imageFilename, downloadFolder);

          imagePath = join(DOWNLOAD.BASE_DIR, downloadFolder, imageFilename);
          imageSuccess = true;

          log.success(`${pairLabel} ✅ Ảnh #${pair.index} tạo thành công → ${imageFilename}`);

          // Claim all images to avoid ghost-claiming
          await provider.cleanup(page);
          break; // Exit retry loop
        } else {
          const errorMsg = imageResult.error || imageResult.status;
          log.warn(`${pairLabel} Ảnh #${pair.index}: ${errorMsg}`);
          if (attempt === maxRetries) {
            log.error(`${pairLabel} ❌ Ảnh #${pair.index} thất bại sau ${maxRetries + 1} lần thử`);
            results.push({
              index: pair.index,
              phase: 'image',
              status: 'error',
              error: errorMsg,
            });
          }
          await provider.cleanup(page);
        }
      } catch (err) {
        log.error(`${pairLabel} Ảnh #${pair.index}: ${err.message}`);
        if (attempt === maxRetries) {
          results.push({
            index: pair.index,
            phase: 'image',
            status: 'error',
            error: err.message,
          });
        }
        await provider.cleanup(page);
      }

      await delay(TIMING.INTER_PROMPT_DELAY);
    }

    // Skip video if image failed
    if (!imageSuccess) {
      log.warn(`${pairLabel} ⏭️ Bỏ qua video #${pair.index} vì ảnh thất bại`);
      continue;
    }

    // Brief pause between phases
    await delay(2000);

    // ══════════════════════════════════════════════════
    // PHASE 2: TẠO VIDEO (img2video)
    // ══════════════════════════════════════════════════
    log.info(`${pairLabel} 🎬 PHASE 2: Tạo video #${pair.index} (img2video)`);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) break;

      const retryLabel = attempt > 0 ? ` [Retry ${attempt}/${maxRetries}]` : '';
      log.step(`${pairLabel} Chuyển sang mode Video...${retryLabel}`);

      try {
        // ── CẤU HÌNH VIDEO MODE ──────────────────────────
        log.step(`${pairLabel} ⚙️ Cấu hình Video mode...${retryLabel}`);

        // 2a. Switch to Video mode
        log.step(`${pairLabel}   → Chuyển sang tab Video`);
        await selectMediaMode(page, 'video');
        await delay(2000); // Chờ settings panel load sau khi chuyển mode

        // 2b. Configure video settings (aspect ratio + duration)
        log.step(`${pairLabel}   → Chọn tỉ lệ ${videoAspectRatio}, thời lượng ${FLOW_DEFAULTS.VIDEO_DURATION}`);
        await configureVideoSettings(page, {
          aspectRatio: videoAspectRatio,
          duration: FLOW_DEFAULTS.VIDEO_DURATION,
        });
        await delay(500);

        // 2c. Select video model (e.g. "Veo 3.1 - Lite")
        if (FLOW_DEFAULTS.VIDEO_MODEL) {
          log.step(`${pairLabel}   → Chọn model ${FLOW_DEFAULTS.VIDEO_MODEL}`);
          const modelOk = await selectModel(page, FLOW_DEFAULTS.VIDEO_MODEL);
          await delay(500);

          if (!modelOk) {
            log.warn(`${pairLabel}   ⚠️ Không chọn được model "${FLOW_DEFAULTS.VIDEO_MODEL}" — tiếp tục với model hiện tại`);
          }
        }

        log.success(`${pairLabel} ⚙️ Cấu hình Video hoàn tất`);

        // 2d. Select the generated image as start frame via media picker
        // NOTE: uploadStartImage() opens the "Bắt đầu" media picker dialog,
        // selects the matching image (by filename or most recent), and confirms.
        log.step(`${pairLabel}   → Chọn ảnh bắt đầu: ${imagePath}`);
        const uploadOk = await uploadStartImage(page, imagePath);
        if (!uploadOk) {
          log.warn(`${pairLabel}   ⚠️ Chọn ảnh bắt đầu không thành công — video sẽ là text-to-video`);
        }

        // CRITICAL: Close settings panel and focus prompt input BEFORE typing
        await closeSettingsAndFocusInput(page);
        await delay(500); // Chờ ổn định trước khi nhập prompt

        // ── NHẬP PROMPT VÀ TẠO VIDEO ─────────────────────
        // 2e. Submit video motion prompt
        log.prompt(pair.index, `🎬 ${pair.videoPrompt.substring(0, 80)}...`);
        const vidSnapshot = new Set(await provider.snapshotImages(page));
        await provider.submitPrompt(page, pair.videoPrompt, 'video', inputMethod);

        // 2f. Wait for video (longer timeout)
        const videoResult = await provider.waitForImages(page, pair.index, vidSnapshot, signal, 'video');

        if (videoResult.status === 'success') {
          // 2g. Download video
          const videoMedia = videoResult.images.filter(m => m.type === 'video');
          const downloadList = videoMedia.length > 0 ? videoMedia : videoResult.images;

          for (let j = 0; j < downloadList.length; j++) {
            const isVideo = downloadList[j].type === 'video';
            const ext = isVideo ? '.mp4' : '.jpg';
            const filename = downloadList.length === 1
              ? `${pair.index}${ext}`
              : `${pair.index}_${j + 1}${ext}`;

            await downloadImage(page, downloadList[j].src, filename, downloadFolder);
            await delay(TIMING.DOWNLOAD_SETTLE);
          }

          videoSuccess = true;
          log.success(`${pairLabel} ✅ Video #${pair.index} tạo thành công`);

          await provider.cleanup(page);
          break; // Exit retry loop
        } else {
          const errorMsg = videoResult.error || videoResult.status;
          log.warn(`${pairLabel} Video #${pair.index}: ${errorMsg}`);
          if (attempt === maxRetries) {
            log.error(`${pairLabel} ❌ Video #${pair.index} thất bại sau ${maxRetries + 1} lần thử`);
            results.push({
              index: pair.index,
              phase: 'video',
              status: 'error',
              error: errorMsg,
            });
          }
          await provider.cleanup(page);
        }
      } catch (err) {
        log.error(`${pairLabel} Video #${pair.index}: ${err.message}`);
        if (attempt === maxRetries) {
          results.push({
            index: pair.index,
            phase: 'video',
            status: 'error',
            error: err.message,
          });
        }
        await provider.cleanup(page);
      }

      await delay(TIMING.INTER_PROMPT_DELAY);
    }

    // 2h. Clear start image for next pair
    try {
      await clearStartImage(page);
    } catch (e) {
      log.warn(`Không xóa được ảnh bắt đầu: ${e.message}`);
    }

    // Record success
    if (imageSuccess && videoSuccess) {
      results.push({
        index: pair.index,
        phase: 'both',
        status: 'success',
      });
    } else if (imageSuccess && !videoSuccess) {
      // Image succeeded but video failed — already recorded above
    }

    // Inter-pair delay
    await delay(TIMING.INTER_PROMPT_DELAY);
  }

  // ── Summary ─────────────────────────────────────────────────
  const successPairs = results.filter(r => r.status === 'success' && r.phase === 'both').length;
  const failedImages = results.filter(r => r.phase === 'image' && r.status !== 'success').length;
  const failedVideos = results.filter(r => r.phase === 'video' && r.status !== 'success').length;

  log.info(`\n${'═'.repeat(50)}`);
  log.success(`🔄 FLOW PIPELINE HOÀN TẤT`);
  log.success(`   ✅ Thành công: ${successPairs}/${pairs.length} cặp`);
  if (failedImages > 0) log.warn(`   ❌ Ảnh thất bại: ${failedImages}`);
  if (failedVideos > 0) log.warn(`   ❌ Video thất bại: ${failedVideos}`);
  log.info(`${'═'.repeat(50)}\n`);

  return { results };
}
