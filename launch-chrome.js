/**
 * launch-chrome.js — Helper to launch Chrome with remote debugging.
 *
 * Use this if you want to manage Chrome separately from the main script.
 * 
 * Usage:
 *   node launch-chrome.js           → Launch with automation profile
 *   node launch-chrome.js --main    → Launch with your main Chrome profile
 *
 * After Chrome is running, use the main script to connect:
 *   node index.js --prompts ./prompts/test.txt --folder "Test"
 */

import { execFile } from 'child_process';
import { CHROME } from './config.js';
import { log } from './logger.js';
import { homedir } from 'os';
import { join } from 'path';

const useMainProfile = process.argv.includes('--main');

const userDataDir = useMainProfile
  ? join(homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data')
  : CHROME.USER_DATA_DIR;

const profileLabel = useMainProfile ? 'MAIN profile' : 'Automation profile';

log.info(`Đang mở Chrome với ${profileLabel}...`);
log.info(`Profile: ${userDataDir}`);
log.info(`Debug port: ${CHROME.DEBUG_PORT}`);

const args = [
  `--remote-debugging-port=${CHROME.DEBUG_PORT}`,
  `--user-data-dir=${userDataDir}`,
  '--disable-blink-features=AutomationControlled',
  '--exclude-switches=enable-automation',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-infobars',
];

const child = execFile(CHROME.EXECUTABLE, args, (error) => {
  if (error) {
    log.error(`Chrome exited: ${error.message}`);
  }
});

child.unref();

log.success(`Chrome PID: ${child.pid}`);
log.info(`WebSocket endpoint: http://127.0.0.1:${CHROME.DEBUG_PORT}/json/version`);
log.info(`\nChrome đã mở. Giờ chạy script chính:`);
log.info(`  node index.js --prompts ./prompts/my-prompts.txt --folder "MyProject"`);
