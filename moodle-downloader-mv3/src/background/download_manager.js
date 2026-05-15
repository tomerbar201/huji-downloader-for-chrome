/**
 * download_manager.js — Concurrency-limited Download Queue
 * 
 * Manages the download pipeline:
 * 1. Receives a list of items to download.
 * 2. Resolves each item's URL via moodle_api.js.
 * 3. Triggers chrome.downloads.download() for each resolved file.
 * 4. Limits concurrency to MAX_CONCURRENT tasks.
 * 5. Reports progress back via chrome.runtime.sendMessage().
 * 6. Supports cancellation mid-download.
 * 7. Implements exponential backoff for 429 responses.
 */

import { resolveResource } from './moodle_api.js';

/* ═══════════════════════════════════════════════════════
 *  CONSTANTS
 * ═══════════════════════════════════════════════════════ */

const MAX_CONCURRENT = 3;
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 2000;
const ROOT_FOLDER = 'MoodleDownloads';

/* ═══════════════════════════════════════════════════════
 *  DOWNLOAD MANAGER CLASS
 * ═══════════════════════════════════════════════════════ */

export class DownloadManager {
  constructor() {
    /** @type {Array<Object>} Items queued for processing */
    this.queue = [];

    /** @type {number} Number of currently active download tasks */
    this.activeCount = 0;

    /** @type {boolean} Whether the user has requested cancellation */
    this.cancelled = false;

    /** @type {number} Total number of files discovered (including folder contents) */
    this.totalFiles = 0;

    /** @type {number} Number of files successfully downloaded */
    this.downloadedFiles = 0;

    /** @type {number} Number of files skipped */
    this.skippedFiles = 0;

    /** @type {Array<string>} Error/skip messages for the UI */
    this.errors = [];

    /** @type {Array<string>} Success messages for the UI */
    this.successes = [];

    /** @type {Set<number>} Active chrome.downloads IDs (for cancellation) */
    this.activeDownloadIds = new Set();

    /** @type {string} Course name for folder structure */
    this.courseName = '';

    /** @type {Function|null} Resolve function for the completion promise */
    this._resolveCompletion = null;

    /** @type {boolean} Whether a download session is active */
    this.isRunning = false;
  }

  /**
   * Start downloading the selected course items.
   * 
   * @param {string} courseName - The course name (used as root folder)
   * @param {Array<Object>} items - Array of { sectionTitle, name, url, type }
   * @returns {Promise<Object>} - Resolves when all downloads complete or are cancelled
   */
  async start(courseName, items) {
    // 1. Check if we are already downloading
    if (this.isRunning) {
      console.log('Already downloading! Ignoring this request.');
      return { success: false, error: 'Already downloading' };
    }

    // 2. If not busy, proceed as usual
    this.reset();
    this.isRunning = true;
    this.courseName = sanitizePath(courseName);
    this.totalFiles = items.length;

    // Build the queue
    this.queue = items.map((item, index) => ({
      index,
      sectionTitle: sanitizePath(item.sectionTitle),
      name: item.name,
      url: item.url,
      type: item.type,
      retries: 0,
    }));

    // Broadcast initial state
    this.broadcastProgress('Preparing downloads…');

    // Create a promise that resolves when all items are processed
    return new Promise((resolve) => {
      this._resolveCompletion = resolve;
      // Kick off concurrent workers
      this.processQueue();
    });
  }

  /**
   * Cancel all active and queued downloads.
   */
  async cancel() {
    this.cancelled = true;

    // Cancel all active chrome.downloads
    const cancelPromises = [];
    for (const dlId of this.activeDownloadIds) {
      cancelPromises.push(
        new Promise((resolve) => {
          try {
            chrome.downloads.cancel(dlId, () => {
              resolve();
            });
          } catch {
            resolve();
          }
        })
      );
    }
    await Promise.all(cancelPromises);

    this.activeDownloadIds.clear();
    this.queue = [];

    this.broadcastState('CANCELLED');
    this.finish();
  }

  /**
   * Reset internal state for a new download session.
   */
  reset() {
    this.queue = [];
    this.activeCount = 0;
    this.cancelled = false;
    this.totalFiles = 0;
    this.downloadedFiles = 0;
    this.skippedFiles = 0;
    this.errors = [];
    this.successes = [];
    this.activeDownloadIds.clear();
    this.courseName = '';
    this._resolveCompletion = null;
    this.isRunning = false;
  }

  /**
   * Process items from the queue, respecting concurrency limits.
   */
  processQueue() {
    while (this.activeCount < MAX_CONCURRENT && this.queue.length > 0 && !this.cancelled) {
      const item = this.queue.shift();
      this.activeCount++;
      this.processItem(item).then(() => {
        this.activeCount--;
        if (this.cancelled) return;

        if (this.queue.length > 0) {
          this.processQueue();
        } else if (this.activeCount === 0) {
          // All done
          this.finish();
        }
      });
    }

    // Edge case: queue was empty from the start
    if (this.queue.length === 0 && this.activeCount === 0 && !this.cancelled) {
      this.finish();
    }
  }

  /**
   * Process a single queue item: resolve URL → download file(s).
   */
  async processItem(item) {
    if (this.cancelled) return;

    this.broadcastProgress(`Resolving: ${item.name}`);

    const result = await resolveResource(item.url, item.name, item.type);

    if (this.cancelled) return;

    switch (result.type) {
      case 'direct':
      case 'resolved':
        // Single file download
        if (result.files.length > 0) {
          const file = result.files[0];
          await this.downloadFile(
            file.url,
            this.buildFilePath(this.courseName, item.sectionTitle, file.name)
          );
        }
        break;

      case 'folder':
      case 'assign':
        // Multiple files — adjust total count and download each
        if (result.files.length > 0) {

          this.totalFiles += result.files.length - 1;
          this.broadcastProgress(`Found ${result.files.length} files in ${item.name}`);

          for (const file of result.files) {
            if (this.cancelled) break;
            const subFolder = item.type === 'folder' ? item.name : '';
            const filePath = subFolder
              ? this.buildFilePath(this.courseName, item.sectionTitle, subFolder, file.name)
              : this.buildFilePath(this.courseName, item.sectionTitle, file.name);
            await this.downloadFile(file.url, filePath);
          }
        } else {
          this.skippedFiles++;
          this.broadcastProgress(`Skipped: ${item.name}`);
        }
        break;

      case 'rate_limited':
        // Retry with exponential backoff
        if (item.retries < MAX_RETRIES) {
          item.retries++;
          const delay = BASE_RETRY_DELAY_MS * Math.pow(2, item.retries - 1);
          this.broadcastProgress(`Rate limited, retrying in ${delay / 1000}s: ${item.name}`);
          await this.sleep(delay);
          if (!this.cancelled) {
            this.queue.unshift(item); // Re-add to front of queue
          }
        } else {
          this.errors.push(`Rate limited (max retries): ${item.name}`);
          this.skippedFiles++;
          this.broadcastProgress(`Failed after retries: ${item.name}`);
        }
        break;

      case 'skipped':
        this.skippedFiles++;
        if (result.error) {
          this.errors.push(`${item.name}: ${result.error}`);
        }
        this.broadcastProgress(`Skipped: ${item.name}`);
        break;

      case 'error':
        if (result.error === 'SESSION_EXPIRED') {
          // Critical: halt everything
          this.errors.push('Session expired — please log in and try again');
          this.cancelled = true;
          this.broadcastState('SESSION_EXPIRED');
          return;
        }
        this.errors.push(`${item.name}: ${result.error}`);
        this.skippedFiles++;
        this.broadcastProgress(`Error: ${item.name}`);
        break;

      default:
        this.skippedFiles++;
        break;
    }
  }

  /**
   * Trigger a chrome.downloads.download() call and wait for completion.
   */
  async downloadFile(url, filename) {
    if (this.cancelled) return;

    // Check if file already exists
    const exists = await this.checkIfFileExists(filename);
    if (exists) {
      this.skippedFiles++;
      const displayName = this.getDisplayName(filename);
      // We count it as "skipped" but inform the user it already exists
      this.successes.push(`Already exists: ${displayName}`);
      this.broadcastProgress(`Already exists: ${displayName}`);
      return;
    }

    return new Promise((resolve) => {
      try {
        chrome.downloads.download(
          {
            url: url,
            filename: filename,
            conflictAction: 'uniquify',
            saveAs: false,
          },
          (downloadId) => {
            if (chrome.runtime.lastError) {
              this.errors.push(`Download failed: ${filename} — ${chrome.runtime.lastError.message}`);
              this.skippedFiles++;
              this.broadcastProgress(`Failed: ${filename}`);
              resolve();
              return;
            }

            if (downloadId === undefined) {
              this.errors.push(`Download failed: ${filename} — No download ID returned`);
              this.skippedFiles++;
              resolve();
              return;
            }

            this.activeDownloadIds.add(downloadId);

            // Listen for download state changes
            const onChanged = (delta) => {
              if (delta.id !== downloadId) return;

              if (delta.state) {
                if (delta.state.current === 'complete') {
                  chrome.downloads.onChanged.removeListener(onChanged);
                  this.activeDownloadIds.delete(downloadId);
                  this.downloadedFiles++;
                  this.successes.push(this.getDisplayName(filename));
                  this.broadcastProgress(`Downloaded: ${this.getDisplayName(filename)}`);
                  resolve();
                } else if (delta.state.current === 'interrupted') {
                  chrome.downloads.onChanged.removeListener(onChanged);
                  this.activeDownloadIds.delete(downloadId);
                  const reason = delta.error ? delta.error.current : 'interrupted';
                  if (!this.cancelled) {
                    this.errors.push(`Interrupted: ${this.getDisplayName(filename)} (${reason})`);
                    this.skippedFiles++;
                  }
                  resolve();
                }
              }
            };

            chrome.downloads.onChanged.addListener(onChanged);
          }
        );
      } catch (err) {
        this.errors.push(`Exception: ${filename} — ${err.message}`);
        this.skippedFiles++;
        resolve();
      }
    });
  }

  /**
   * Build the full file path for chrome.downloads.download().
   * Format: MoodleDownloads/CourseName/SectionName/[SubFolder/]Filename
   */
  /**
   * Build the full file path for chrome.downloads.download().
   * Format: MoodleDownloads/CourseName/SectionName/[SubFolder/]Filename
   */
  buildFilePath(courseName, ...parts) {
    const cleanParts = [ROOT_FOLDER, sanitizePath(courseName), ...parts]
      .filter(Boolean)
      .map(p => sanitizePath(p));
    return cleanParts.join('/');
  }

  /**
   * Extract just the filename portion from a full path for display.
   */
  getDisplayName(filePath) {
    const parts = filePath.split('/');
    return parts[parts.length - 1] || filePath;
  }

  /**
   * Called when all downloads are complete or cancelled.
   */
  finish() {
    this.isRunning = false;
    const result = {
      downloaded: this.downloadedFiles,
      skipped: this.skippedFiles,
      total: this.totalFiles,
      errors: this.errors,
      successes: this.successes,
      cancelled: this.cancelled,
    };

    if (!this.cancelled) {
      this.broadcastState('COMPLETE');
    }

    if (this._resolveCompletion) {
      this._resolveCompletion(result);
      this._resolveCompletion = null;
    }
  }

  /**
   * Broadcast a progress update to the popup.
   */
  broadcastProgress(currentFile) {
    try {
      chrome.runtime.sendMessage({
        type: 'PROGRESS_UPDATE',
        downloaded: this.downloadedFiles,
        skipped: this.skippedFiles,
        total: this.totalFiles,
        currentFile: currentFile || '',
        errors: this.errors,
        successes: this.successes,
      });
    } catch {
      // Popup may be closed — that's fine
    }
  }

  /**
   * Broadcast a state change event.
   */
  broadcastState(state) {
    try {
      chrome.runtime.sendMessage({
        type: 'STATE_CHANGE',
        state: state,
        downloaded: this.downloadedFiles,
        skipped: this.skippedFiles,
        total: this.totalFiles,
        errors: this.errors,
        successes: this.successes,
      });
    } catch {
      // Popup may be closed — that's fine
    }
  }

  /**
   * Return current status (for popup reconnection).
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      downloaded: this.downloadedFiles,
      skipped: this.skippedFiles,
      total: this.totalFiles,
      errors: this.errors,
      successes: this.successes,
      cancelled: this.cancelled,
    };
  }

  /**
   * Utility: sleep for a given number of milliseconds.
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Check if a file already exists in the download directory.
   * Uses chrome.downloads.search to check the history and disk status.
   * @param {string} relativePath - The relative path from the downloads root.
   * @returns {Promise<boolean>}
   */
  async checkIfFileExists(relativePath) {
    return new Promise((resolve) => {
      try {
        // relativePath looks like: "MoodleDownloads/Course Name/Section/File Name"
        const pathParts = relativePath.split('/');
        const fileNameUI = pathParts.pop(); // e.g., "Lecture 1"
        const courseName = pathParts.length > 1 ? pathParts[1] : ''; // e.g., "Course Name"

        // Search the browser history for the UI name
        chrome.downloads.search({ query: [fileNameUI], state: 'complete' }, (items) => {
          if (!items || items.length === 0) {
            resolve(false);
            return;
          }

          const isAlreadyDownloaded = items.some(item => {
            if (!item.exists) return false; // File was deleted or moved

            // Normalize slashes for Windows/Mac
            const safePath = item.filename.replace(/\\/g, '/');
            const downloadedFileName = safePath.split('/').pop(); // e.g., "Lecture 1.pdf"

            // 1. Check if the file belongs to the correct course (prevents mixing up "Syllabus" from 2 different courses)
            if (courseName && !safePath.includes(courseName)) {
              return false;
            }

            // 2. Check if the downloaded file name STARTS with our UI name
            if (downloadedFileName.startsWith(fileNameUI)) {
              // Look at whatever is left over (e.g., ".pdf", ".docx", or nothing)
              const leftover = downloadedFileName.substring(fileNameUI.length);

              // It is a match if the leftover is an extension (starts with '.') or is perfectly empty
              return leftover === '' || leftover.startsWith('.');
            }

            return false;
          });

          resolve(isAlreadyDownloaded);
        });

      } catch (err) {
        console.error('Error checking file existence:', err);
        resolve(false); // Fallback: just download it if check fails
      }
    });
  }
  /**
   * Check which items from a list have already been downloaded.
   * @param {string} courseName
   * @param {Array<Object>} items
   * @returns {Promise<Array<boolean>>}
   */
  async checkItemsStatus(courseName, items) {
    return await Promise.all(items.map(async item => {
      const filePath = this.buildFilePath(courseName, item.sectionTitle, item.name);
      return await this.checkIfFileExists(filePath);
    }));
  }
}

/* ═══════════════════════════════════════════════════════
 *  PATH SANITIZATION
 * ═══════════════════════════════════════════════════════ */

/**
 * Sanitize a string for use as a folder or file name component.
 * Strips characters that are illegal on Windows/Mac/Linux.
 */
function sanitizePath(str) {
  if (!str) return '';
  return str
    .replace(/[\\/:*?"<>|]/g, '')     // Windows-illegal chars
    .replace(/\s+/g, ' ')             // Normalize whitespace
    .trim()
    .replace(/\.+$/, '')              // Remove trailing dots (Windows)
    .substring(0, 200) || 'Untitled'; // Cap length
}
