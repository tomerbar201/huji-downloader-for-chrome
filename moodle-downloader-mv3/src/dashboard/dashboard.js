/**
 * dashboard.js — Course Hub Controller
 *
 * Loads all cached courses from chrome.storage.local (keys prefixed with "db_"),
 * renders them as interactive cards, and handles:
 *   - Opening a course page in Moodle
 *   - Opening the local download folder via the background service worker
 *   - Searching / filtering by course name
 *   - Removing individual courses or clearing all data
 */

(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════
   *  CONSTANTS
   * ═══════════════════════════════════════════════════════ */

  const DB_KEY_PREFIX = 'db_';
  const ROOT_FOLDER   = 'MoodleDownloads';

  /* ═══════════════════════════════════════════════════════
   *  DOM REFERENCES
   * ═══════════════════════════════════════════════════════ */

  const stateLoading    = document.getElementById('state-loading');
  const stateEmpty      = document.getElementById('state-empty');
  const stateNoResults  = document.getElementById('state-no-results');
  const stateCourses    = document.getElementById('state-courses');
  const coursesGrid     = document.getElementById('courses-grid');
  const searchInput     = document.getElementById('search-input');
  const courseBadge     = document.getElementById('course-count-badge');
  const btnClearAll     = document.getElementById('btn-clear-all');
  const confirmOverlay  = document.getElementById('confirm-overlay');
  const confirmCancel   = document.getElementById('confirm-cancel');
  const confirmOk       = document.getElementById('confirm-ok');
  const noResultsQuery  = document.getElementById('no-results-query');
  const toastContainer  = document.getElementById('toast-container');

  /* ═══════════════════════════════════════════════════════
   *  STATE
   * ═══════════════════════════════════════════════════════ */

  /** @type {Array<{ courseName: string, items: Array<Object>, moodleBaseUrl: string }>} */
  let allCourses = [];

  /** @type {string} Current search query */
  let searchQuery = '';

  /* ═══════════════════════════════════════════════════════
   *  INITIALIZATION
   * ═══════════════════════════════════════════════════════ */

  async function init() {
    bindEvents();
    await loadCourses();
  }

  /**
   * Fetch all cached courses from storage and render them.
   */
  async function loadCourses() {
    showState('loading');

    try {
      // Get everything stored under chrome.storage.local
      const allStorage = await new Promise((resolve) => {
        chrome.storage.local.get(null, (items) => {
          if (chrome.runtime.lastError) {
            resolve({});
          } else {
            resolve(items);
          }
        });
      });

      // Filter to only course cache keys
      const courseKeys = Object.keys(allStorage).filter(k => k.startsWith(DB_KEY_PREFIX));

      allCourses = courseKeys.map(key => {
        const courseName = key.slice(DB_KEY_PREFIX.length); // Strip the "db_" prefix
        const items      = allStorage[key] || [];
        const moodleBaseUrl = extractMoodleBaseUrl(items);

        return { courseName, items, moodleBaseUrl };
      });

      // Sort alphabetically by course name
      allCourses.sort((a, b) => a.courseName.localeCompare(b.courseName));

      updateBadge();
      renderCourses();

    } catch (err) {
      console.error('[Dashboard] Failed to load courses:', err);
      showState('empty');
      showToast('Failed to load course data. Please try again.', 'error');
    }
  }

  /* ═══════════════════════════════════════════════════════
   *  RENDERING
   * ═══════════════════════════════════════════════════════ */

  function renderCourses() {
    const query   = searchQuery.toLowerCase().trim();
    const visible = query
      ? allCourses.filter(c => c.courseName.toLowerCase().includes(query))
      : allCourses;

    // Update no-results hint
    noResultsQuery.textContent = searchQuery;

    if (allCourses.length === 0) {
      showState('empty');
      return;
    }

    if (visible.length === 0) {
      showState('no-results');
      return;
    }

    // Build the grid
    coursesGrid.innerHTML = '';
    visible.forEach(course => {
      const card = buildCourseCard(course);
      coursesGrid.appendChild(card);
    });

    showState('courses');
  }

  /**
   * Build a DOM node for a single course card.
   * @param {{ courseName: string, items: Array, moodleBaseUrl: string }} course
   * @returns {HTMLElement}
   */
  function buildCourseCard(course) {
    const { courseName, items, moodleBaseUrl } = course;
    const fileCount = items.length;
    const sectionSet = new Set(items.map(i => i.sectionTitle).filter(Boolean));
    const sectionCount = sectionSet.size;

    const card = document.createElement('div');
    card.className = 'course-card';
    card.setAttribute('role', 'listitem');
    card.setAttribute('aria-label', `Course: ${escapeHtml(courseName)}`);

    // ── Remove button (top-right) ──
    const removeBtn = document.createElement('button');
    removeBtn.className = 'card-remove-btn';
    removeBtn.title = 'Remove this course from the hub';
    removeBtn.setAttribute('aria-label', `Remove ${escapeHtml(courseName)} from hub`);
    removeBtn.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <line x1="18" y1="6" x2="6" y2="18"/>
        <line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    `;
    removeBtn.addEventListener('click', () => removeCourse(courseName));

    // ── Card top (icon + name + meta) ──
    const cardTop = document.createElement('div');
    cardTop.className = 'card-top';

    const cardIcon = document.createElement('div');
    cardIcon.className = 'card-icon';
    cardIcon.setAttribute('aria-hidden', 'true');
    cardIcon.innerHTML = `
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
      </svg>
    `;

    const cardInfo = document.createElement('div');
    cardInfo.className = 'card-info';

    const title = document.createElement('p');
    title.className = 'card-title';
    title.textContent = courseName;
    title.title = courseName;

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    meta.innerHTML = `
      <span>${fileCount} file${fileCount !== 1 ? 's' : ''}</span>
      ${sectionCount > 0 ? `
        <span class="card-meta-dot" aria-hidden="true"></span>
        <span>${sectionCount} section${sectionCount !== 1 ? 's' : ''}</span>
      ` : ''}
    `;

    cardInfo.appendChild(title);
    cardInfo.appendChild(meta);
    cardTop.appendChild(cardIcon);
    cardTop.appendChild(cardInfo);

    // ── Card actions ──
    const cardActions = document.createElement('div');
    cardActions.className = 'card-actions';

    // Button: Open in Moodle
    const moodleBtn = document.createElement('button');
    moodleBtn.className = 'card-btn card-btn-moodle';
    moodleBtn.title = moodleBaseUrl
      ? `Open course in Moodle: ${moodleBaseUrl}`
      : 'Open HUJI Moodle Dashboard';
    moodleBtn.setAttribute('aria-label', `Open ${escapeHtml(courseName)} in Moodle`);
    moodleBtn.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
        <polyline points="15 3 21 3 21 9"/>
        <line x1="10" y1="14" x2="21" y2="3"/>
      </svg>
      Open in Moodle
    `;
    moodleBtn.addEventListener('click', () => openInMoodle(moodleBaseUrl, courseName));

    // Button: Open Local Folder
    const folderBtn = document.createElement('button');
    folderBtn.className = 'card-btn card-btn-folder';
    folderBtn.title = `Open the local folder: ${ROOT_FOLDER}/${courseName}`;
    folderBtn.setAttribute('aria-label', `Open local download folder for ${escapeHtml(courseName)}`);
    folderBtn.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      </svg>
      Open Folder
    `;
    folderBtn.addEventListener('click', () => openLocalFolder(courseName, folderBtn));

    cardActions.appendChild(moodleBtn);
    cardActions.appendChild(folderBtn);

    // ── Assemble card ──
    card.appendChild(removeBtn);
    card.appendChild(cardTop);
    card.appendChild(cardActions);

    return card;
  }

  /* ═══════════════════════════════════════════════════════
   *  ACTIONS
   * ═══════════════════════════════════════════════════════ */

  /**
   * Open the course's Moodle page (or the Moodle dashboard as fallback).
   * @param {string|null} moodleBaseUrl - The course URL extracted from cached items.
   * @param {string} courseName
   */
  function openInMoodle(moodleBaseUrl, courseName) {
    const url = moodleBaseUrl || 'https://moodle.huji.ac.il/2025-26/my/';
    chrome.tabs.create({ url });
  }

  /**
   * Request the background service worker to open the course's download folder.
   * @param {string} courseName
   * @param {HTMLButtonElement} btn - The triggering button (for loading state).
   */
  async function openLocalFolder(courseName, btn) {
    // Visual feedback while waiting
    const originalHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="animation:spin 0.8s linear infinite">
        <line x1="12" y1="2" x2="12" y2="6"/>
        <line x1="12" y1="18" x2="12" y2="22"/>
        <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/>
        <line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/>
        <line x1="2" y1="12" x2="6" y2="12"/>
        <line x1="18" y1="12" x2="22" y2="12"/>
        <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/>
        <line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>
      </svg>
      Opening…
    `;

    try {
      const response = await sendToBackground({
        action: 'OPEN_COURSE_FOLDER',
        courseName: courseName,
      });

      if (response && response.success) {
        showToast('Folder opened in your file explorer.', 'success');
      } else {
        const msg = (response && response.error) || 'Folder not found.';
        showToast(msg, 'warning');
      }
    } catch (err) {
      console.error('[Dashboard] openLocalFolder error:', err);
      showToast('Could not communicate with the extension. Please try again.', 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHTML;
    }
  }

  /**
   * Remove a single course from storage and re-render.
   * @param {string} courseName
   */
  async function removeCourse(courseName) {
    const key = `${DB_KEY_PREFIX}${courseName}`;
    try {
      await new Promise((resolve, reject) => {
        chrome.storage.local.remove(key, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve();
          }
        });
      });

      allCourses = allCourses.filter(c => c.courseName !== courseName);
      updateBadge();
      renderCourses();
      showToast(`"${courseName}" removed from hub.`, 'success');
    } catch (err) {
      console.error('[Dashboard] removeCourse error:', err);
      showToast('Failed to remove course. Please try again.', 'error');
    }
  }

  /**
   * Clear ALL course data from storage.
   */
  async function clearAllCourses() {
    const keys = allCourses.map(c => `${DB_KEY_PREFIX}${c.courseName}`);
    if (keys.length === 0) {
      showToast('Nothing to clear.', 'warning');
      return;
    }

    try {
      await new Promise((resolve, reject) => {
        chrome.storage.local.remove(keys, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve();
          }
        });
      });

      allCourses = [];
      updateBadge();
      renderCourses();
      showToast(`Cleared ${keys.length} course${keys.length !== 1 ? 's' : ''} from hub.`, 'success');
    } catch (err) {
      console.error('[Dashboard] clearAllCourses error:', err);
      showToast('Failed to clear courses. Please try again.', 'error');
    }
  }

  /* ═══════════════════════════════════════════════════════
   *  EVENT BINDING
   * ═══════════════════════════════════════════════════════ */

  function bindEvents() {
    // Search input — debounced filter
    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value;
      renderCourses();
    });

    // Clear all — show confirm dialog
    btnClearAll.addEventListener('click', () => {
      confirmOverlay.classList.remove('hidden');
      confirmOk.focus();
    });

    // Confirm dialog: cancel
    confirmCancel.addEventListener('click', () => {
      confirmOverlay.classList.add('hidden');
    });

    // Confirm dialog: confirm clear
    confirmOk.addEventListener('click', async () => {
      confirmOverlay.classList.add('hidden');
      await clearAllCourses();
    });

    // Close confirm overlay on backdrop click
    confirmOverlay.addEventListener('click', (e) => {
      if (e.target === confirmOverlay) {
        confirmOverlay.classList.add('hidden');
      }
    });

    // Escape key closes confirm dialog
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !confirmOverlay.classList.contains('hidden')) {
        confirmOverlay.classList.add('hidden');
      }
    });

    // Listen for storage changes (e.g., if popup scans a new course while dashboard is open)
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const hasNewCourseKey = Object.keys(changes).some(k => k.startsWith(DB_KEY_PREFIX));
      if (hasNewCourseKey) {
        // Silently reload without showing loading skeleton
        reloadCoursesQuietly();
      }
    });
  }

  /**
   * Reload course data in the background without showing the loading skeleton.
   */
  async function reloadCoursesQuietly() {
    try {
      const allStorage = await new Promise((resolve) => {
        chrome.storage.local.get(null, (items) => {
          resolve(chrome.runtime.lastError ? {} : items);
        });
      });

      const courseKeys = Object.keys(allStorage).filter(k => k.startsWith(DB_KEY_PREFIX));
      allCourses = courseKeys.map(key => {
        const courseName = key.slice(DB_KEY_PREFIX.length);
        const items      = allStorage[key] || [];
        return { courseName, items, moodleBaseUrl: extractMoodleBaseUrl(items) };
      });
      allCourses.sort((a, b) => a.courseName.localeCompare(b.courseName));

      updateBadge();
      renderCourses();
    } catch {
      // Silently ignore
    }
  }

  /* ═══════════════════════════════════════════════════════
   *  UI HELPERS
   * ═══════════════════════════════════════════════════════ */

  function showState(name) {
    const panels = {
      loading:    stateLoading,
      empty:      stateEmpty,
      'no-results': stateNoResults,
      courses:    stateCourses,
    };

    for (const [key, el] of Object.entries(panels)) {
      if (key === name) {
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    }
  }

  function updateBadge() {
    const count = allCourses.length;
    if (count === 0) {
      courseBadge.classList.add('hidden');
    } else {
      courseBadge.classList.remove('hidden');
      courseBadge.textContent = `${count} course${count !== 1 ? 's' : ''}`;
    }
  }

  /**
   * Show a brief toast notification.
   * @param {string} message
   * @param {'default'|'success'|'warning'|'error'} type
   * @param {number} durationMs
   */
  function showToast(message, type = 'default', durationMs = 4000) {
    const icons = {
      success: `<svg class="toast-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
      warning: `<svg class="toast-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
      error:   `<svg class="toast-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
      default: `<svg class="toast-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
    };

    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.innerHTML = `${icons[type] || icons.default}<span>${escapeHtml(message)}</span>`;

    toastContainer.appendChild(toast);

    // Auto-dismiss
    const timer = setTimeout(() => dismissToast(toast), durationMs);
    toast.addEventListener('click', () => {
      clearTimeout(timer);
      dismissToast(toast);
    });
  }

  function dismissToast(toastEl) {
    toastEl.classList.add('toast-exit');
    toastEl.addEventListener('animationend', () => {
      toastEl.remove();
    }, { once: true });
  }

  /* ═══════════════════════════════════════════════════════
   *  UTILITIES
   * ═══════════════════════════════════════════════════════ */

  /**
   * Extract the course's Moodle URL from cached item URLs.
   * Items have URLs like: https://moodle.huji.ac.il/.../pluginfile.php/...
   * We want the course "view.php" URL, which is stored as the source URL
   * of the course. Since we only store resource URLs in items, we
   * derive the origin so the user lands on the Moodle home if we can't get the course ID.
   *
   * @param {Array<{url: string}>} items
   * @returns {string|null}
   */
  function extractMoodleBaseUrl(items) {
    if (!items || items.length === 0) return null;

    for (const item of items) {
      if (!item.url) continue;
      try {
        const url = new URL(item.url);
        // Try to extract the course ID from path patterns like /mod/resource/view.php?id=xxx
        // or construct a base origin URL
        if (url.hostname.includes('moodle')) {
          // Look for a course-view URL pattern in the URL itself
          // Items are resource URLs; extract the Moodle origin
          return `${url.protocol}//${url.hostname}/`;
        }
      } catch {
        // Malformed URL, skip
      }
    }

    return null;
  }

  /**
   * Send a message to the background service worker and await a response.
   * @param {Object} message
   * @returns {Promise<Object>}
   */
  function sendToBackground(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { success: false, error: 'No response from background.' });
        }
      });
    });
  }

  /**
   * Escape a string for safe insertion into HTML.
   * @param {string} str
   * @returns {string}
   */
  function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /* ═══════════════════════════════════════════════════════
   *  INJECT SPIN ANIMATION (for open-folder loading state)
   * ═══════════════════════════════════════════════════════ */

  const spinStyle = document.createElement('style');
  spinStyle.textContent = `@keyframes spin { to { transform: rotate(360deg); } }`;
  document.head.appendChild(spinStyle);

  /* ═══════════════════════════════════════════════════════
   *  BOOTSTRAP
   * ═══════════════════════════════════════════════════════ */

  init();

})();
