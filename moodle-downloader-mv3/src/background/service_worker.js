/**
 * service_worker.js — MV3 Background Service Worker
 * 
 * Central message hub for the extension.
 * Orchestrates communication between the popup and the download engine.
 * 
 * Message Protocol:
 * 
 * FROM POPUP:
 *   { action: 'START_DOWNLOAD', payload: { courseName, items } }
 *   { action: 'CANCEL_DOWNLOAD' }
 *   { action: 'GET_STATUS' }
 * 
 * TO POPUP (via chrome.runtime.sendMessage):
 *   { type: 'PROGRESS_UPDATE', downloaded, skipped, total, currentFile, errors }
 *   { type: 'STATE_CHANGE', state: 'COMPLETE' | 'CANCELLED' | 'SESSION_EXPIRED', ... }
 */

import { DownloadManager } from './download_manager.js';
import { resolveResource } from './moodle_api.js';

/* ═══════════════════════════════════════════════════════
 *  SINGLETON DOWNLOAD MANAGER
 * ═══════════════════════════════════════════════════════ */

const downloadManager = new DownloadManager();

/* ═══════════════════════════════════════════════════════
 *  MESSAGE LISTENER
 * ═══════════════════════════════════════════════════════ */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'START_DOWNLOAD':
      handleStartDownload(message.payload, sendResponse);
      return true; // Keep channel open for async response

    case 'CANCEL_DOWNLOAD':
      handleCancelDownload(sendResponse);
      return true;

    case 'GET_STATUS':
      sendResponse(downloadManager.getStatus());
      return false;

    case 'CHECK_ITEMS':
      handleCheckItems(message.payload, sendResponse);
      return true;

    case 'RESOLVE_RESOURCES':
      handleResolveResources(message.payload, sendResponse);
      return true;

    default:
      return false;
  }
});

/* ═══════════════════════════════════════════════════════
 *  HANDLERS
 * ═══════════════════════════════════════════════════════ */

/**
 * Check which items are already downloaded.
 */
async function handleCheckItems(payload, sendResponse) {
  try {
    const { courseName, items } = payload;
    const statuses = await downloadManager.checkItemsStatus(courseName, items);
    sendResponse({ success: true, statuses });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

/**
 * Resolve folder/assignment contents in batch.
 */
async function handleResolveResources(payload, sendResponse) {
  try {
    const { items } = payload;
    const results = await Promise.all(items.map(item => 
      resolveResource(item.url, item.name, item.type)
    ));
    sendResponse({ success: true, results });
  } catch (err) {
    console.error('[MoodleDL SW] Resolve resources error:', err);
    sendResponse({ success: false, error: err.message });
  }
}

/**
 * Handle START_DOWNLOAD: validate payload and kick off the download pipeline.
 */
async function handleStartDownload(payload, sendResponse) {
  try {
    if (!payload || !payload.items || payload.items.length === 0) {
      sendResponse({ success: false, error: 'No items to download' });
      return;
    }

    if (downloadManager.isRunning) {
      sendResponse({ success: false, error: 'Download already in progress' });
      return;
    }

    const { courseName, items } = payload;

    // Acknowledge the start immediately
    sendResponse({ success: true, error: null });

    // Run the download pipeline (this is fire-and-forget from the popup's perspective;
    // progress is reported via chrome.runtime.sendMessage broadcasts)
    const result = await downloadManager.start(courseName, items);

    // Store result in session storage for popup reconnection
    try {
      await chrome.storage.session.set({
        lastDownloadResult: {
          ...result,
          timestamp: Date.now(),
        },
      });
    } catch {
      // session storage may not be available in all contexts
    }

  } catch (err) {
    console.error('[MoodleDL SW] Start download error:', err);
    sendResponse({ success: false, error: err.message });
  }
}

/**
 * Handle CANCEL_DOWNLOAD: immediately halt all active downloads.
 */
async function handleCancelDownload(sendResponse) {
  try {
    await downloadManager.cancel();
    sendResponse({ success: true });
  } catch (err) {
    console.error('[MoodleDL SW] Cancel error:', err);
    sendResponse({ success: false, error: err.message });
  }
}

/* ═══════════════════════════════════════════════════════
 *  SERVICE WORKER LIFECYCLE
 * ═══════════════════════════════════════════════════════ */

/**
 * Service worker install event.
 * We skip waiting so the new version activates immediately.
 */
self.addEventListener('install', () => {
  console.log('[MoodleDL SW] Installed');
});

/**
 * Service worker activate event.
 */
self.addEventListener('activate', () => {
  console.log('[MoodleDL SW] Activated');
});
