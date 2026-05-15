/**
 * popup.js — Popup UI Controller
 * * Manages the full popup lifecycle:
 * 1. On open: inject content script, request course data.
 * 2. Render the section/item selection tree.
 * 3. Handle user selection (select all, individual checkboxes).
 * 4. Trigger downloads via the service worker.
 * 5. Display real-time progress.
 * 6. Handle cancellation and completion.
 */

(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════
   * DOM REFERENCES
   * ═══════════════════════════════════════════════════════ */
  
  const $ = (id) => document.getElementById(id);

  const stateLoading = $('state-loading');
  const stateInvalid = $('state-invalid');
  const stateSelection = $('state-selection');
  const stateDownloading = $('state-downloading');
  const stateComplete = $('state-complete');
  const stateError = $('state-error');
  const stateLibrary = $('state-library');

  const btnGoMoodle = $('btn-go-moodle');
  const btnDownload = $('btn-download');
    const keepStructureCb = $('keep-structure-checkbox'); // <--- ADD THIS

  const btnCancel = $('btn-cancel');
  const btnNewDownload = $('btn-new-download');
  const btnRetry = $('btn-retry');
  const btnMyCourses = $('btn-my-courses');
  const btnLibraryGoMoodle = $('btn-library-go-moodle');

  const libraryList = $('library-list');
  const libraryCourseCount = $('library-course-count');
  const libraryEmpty = $('library-empty');

  const courseNameEl = $('course-name');
  const courseItemCount = $('course-item-count');
  const selectAllCb = $('select-all-checkbox');
  const selectionCount = $('selection-count');
  const sectionsList = $('sections-list');

  const progressFill = $('progress-fill');
  const progressText = $('progress-text');
  const progressPercent = $('progress-percent');
  const downloadTitle = $('download-title');
  const downloadSubtitle = $('download-subtitle');
  const currentFileName = $('current-file-name');

  const errorsContainer = $('errors-container');
  const errorsCount = $('errors-count');
  const errorsList = $('errors-list');
  const toggleErrorsBtn = $('toggle-errors');

  const completeTitle = $('complete-title');
  const completeDesc = $('complete-desc');
  const completeLogs = $('complete-logs');
  const toggleSuccessBtn = $('toggle-success');
  const successList = $('success-list');
  const successCountText = $('success-count-text');
  const toggleFailedBtn = $('toggle-failed');
  const failedList = $('failed-list');
  const failedCountText = $('failed-count-text');

  const errorTitle = $('error-title');
  const errorDesc = $('error-desc');

  /* ═══════════════════════════════════════════════════════
   * STATE
   * ═══════════════════════════════════════════════════════ */

  let courseData = null;    // Parsed course data from content script
  let allItems = [];        // Flat list of all selectable items (with sectionTitle)
  let selectedIds = new Set();
  let currentActiveState = 'loading';

  /* ═══════════════════════════════════════════════════════
   * INITIALIZATION
   * ═══════════════════════════════════════════════════════ */

  async function init() {
    // 0. Load user's folder structure preference
      const prefs = await chrome.storage.local.get(['keepStructure']);
      if (prefs.keepStructure !== undefined) {
        keepStructureCb.checked = prefs.keepStructure;
      }
    try {
      // 1. Bind events first so they are ready
      bindEvents();

      // 2. Check: Is there a download currently running in the background?
      const status = await sendToBackground({ action: 'GET_STATUS' }).catch(() => null);
      if (status?.isRunning) {
        showState('downloading');
        updateProgress(status.downloaded, status.skipped, status.total, '', status.errors || []);
        return;
      }

      // 3. Check: Is there a previous download result that hasn't been shown?
      let lastRes = null;
      try {
        const storage = await chrome.storage.session.get('lastDownloadResult');
        lastRes = storage.lastDownloadResult;
      } catch (e) {
        console.warn('[Popup] Session storage not available:', e);
      }

      if (lastRes) {
        handleStateChange({
          state: lastRes.cancelled ? 'CANCELLED' : 'COMPLETE',
          ...lastRes
        });
        return;
      }

      // 4. Default: Decide whether to scan current page or show Library
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs && tabs.length > 0 ? tabs[0] : null;
      const url = tab?.url || '';
      const isMoodle = url.includes('moodle.huji.ac.il') || url.includes('moodle4.cs.huji.ac.il');

      if (isMoodle && tab) {
        showState('loading');
        const isOnCoursePage = await scanCurrentTab(tab);
        if (!isOnCoursePage) {
          renderLibrary();
        }
      } else {
        renderLibrary();
      }

      // 5. Initialize Theme
      initTheme();
    } catch (err) {
      console.error('[Popup] Critical Init Error:', err);
      showError('Initialization Error', 'The extension encountered an error while starting. Please try refreshing the page.');
    }
  }

  /**
   * Inject the content script into the active tab and request course data.
   * Returns true if a course was successfully detected and UI moved to selection.
   */
  async function scanCurrentTab(existingTab = null) {
    try {
      const tab = existingTab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      if (!tab || !tab.id) {
        return false;
      }

      // Check URL first
      const url = tab.url || '';
      if (!url.includes('moodle.huji.ac.il') && !url.includes('moodle4.cs.huji.ac.il')) {
        return false;
      }

      // Inject content script dynamically
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['src/content_scripts/dom_parser.js'],
        });
      } catch (injectionErr) {
        console.warn('[Popup] Script injection failed:', injectionErr);
        // It might already be injected, try sending message anyway
      }

      // Small delay to ensure content script is ready
      await sleep(200);

      // Request course data from content script
      const response = await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          console.warn('[Popup] PARSE_COURSE message timed out');
          resolve({ success: false, error: 'TIMEOUT', message: 'The page is taking too long to respond. Try refreshing.' });
        }, 8000);

        chrome.tabs.sendMessage(tab.id, { action: 'PARSE_COURSE' }, (resp) => {
          clearTimeout(timeout);
          if (chrome.runtime.lastError) {
            console.error('[Popup] sendMessage error:', chrome.runtime.lastError.message);
            resolve({ success: false, error: 'CONNECTION_ERROR', message: chrome.runtime.lastError.message });
          } else {
            resolve(resp || { success: false, error: 'NO_RESPONSE' });
          }
        });
      });

      if (!response.success) {
        if (response.error === 'NOT_MOODLE_PAGE') {
          return false;
        } else {
          showError('Parsing Error', response.error || 'Could not read the course page.');
          return true; // We are on Moodle but error happened
        }
      }

      courseData = response.data;

      // Maintenance of reverse logic from Conversation 51b39d53
      if (courseData && courseData.sections) {
        courseData.sections.reverse();
      }

      if (!courseData || !courseData.sections || courseData.sections.length === 0) {
        showError('No Materials Found', 'This course page has no downloadable materials.');
        return true;
      }

      // ==========================================
      // STALE-WHILE-REVALIDATE (SWR) LOGIC
      // ==========================================
      const cachedItems = await getCourseFromDB(courseData.courseName);

      if (cachedItems && cachedItems.length > 0) {
        // --- FAST PATH (Cache Hit) ---
        console.log('[SWR] Cache hit! Loading UI instantly.');

        allItems = cachedItems;
        // Re-map UIDs and select all by default
        let uid = 0;
        allItems.forEach(item => { item.uid = uid++; });
        selectedIds = new Set(allItems.map(i => i.uid));

        await enrichItemsWithStatus(); // Check download status via Chrome API
        renderCourseInfo();
        renderSections();
        showState('selection');

        // Trigger background validation to check for updates
        performGhostScan();

      } else {
        // --- SLOW PATH (First time visit) ---
        console.log('[SWR] No cache. Scanning folders from scratch...');
        buildItemsList();
        await scanSubItems(); // Deep scan of Moodle folders (time-intensive)
        flattenItems();

        if (allItems.length === 0) {
          showError('No Materials Found', 'This course page has no downloadable files.');
          return true;
        }

        await saveCourseToDB(courseData.courseName, allItems);

        await enrichItemsWithStatus();
        renderCourseInfo();
        renderSections();
        syncCheckboxes();
        showState('selection');
      }

      return true;

    } catch (err) {
      console.error('[Popup] Init error:', err);
      showError('Connection Error', 'Could not connect to the Moodle page. Try refreshing.');
      return false;
    }
  }

  /**
   * Ghost Scan: Runs silently in the background when cache is used.
   * Compares fresh data from Moodle with current UI. Updates if new files are found.
   */
  async function performGhostScan() {
    console.log('[SWR] Starting ghost scan in background...');

    const currentUrls = new Set(allItems.map(item => item.url));
    let tempItems = [];
    let tempUid = 0;

    // Reconstruct the initial item list from the DOM response
    for (const section of courseData.sections) {
      for (const item of section.items) {
        tempItems.push({
          uid: tempUid++,
          sectionId: section.id,
          sectionTitle: section.title,
          name: item.name,
          url: item.url,
          type: item.type,
          subFiles: [],
          scanningStatus: 'none',
        });
      }
    }

    // Deep scan sub-items for the temporary array
    await scanSubItemsForArray(tempItems);

    // Flatten the results
    const freshItems = [];
    for (const item of tempItems) {
      if (item.type === 'resource') {
        freshItems.push(item);
      } else if ((item.type === 'folder' || item.type === 'assign') && item.subFiles) {
        for (const subFile of item.subFiles) {
          freshItems.push({
            sectionId: item.sectionId,
            sectionTitle: item.sectionTitle,
            name: subFile.name,
            url: subFile.url,
            type: 'resource',
            parentFolder: item.name
          });
        }
      }
    }

    // Check for discrepancies
    let foundNewFiles = false;
    for (const freshItem of freshItems) {
      if (!currentUrls.has(freshItem.url)) {
        foundNewFiles = true;
        break;
      }
    }

    if (foundNewFiles) {
      console.log('[SWR] Found NEW files! Updating UI silently.');

      // Preserve current user selections
      const selectionMap = new Map();
      allItems.forEach(item => {
        selectionMap.set(item.url, selectedIds.has(item.uid));
      });

      await saveCourseToDB(courseData.courseName, freshItems);

      allItems = freshItems;
      let newUid = 0;
      selectedIds = new Set();

      allItems.forEach(item => {
        item.uid = newUid++;

        // Restore selection or select if it's a newly discovered file
        if (selectionMap.has(item.url)) {
          if (selectionMap.get(item.url)) {
            selectedIds.add(item.uid);
          }
        } else {
          // New file! Select it by default
          selectedIds.add(item.uid);
        }
      });

      await enrichItemsWithStatus(); // This also unselects already-downloaded items

      renderCourseInfo();
      renderSections();
      syncCheckboxes();
    } else {
      console.log('[SWR] Ghost scan complete. No new files found.');
    }
  }


  /**
   * Helper: Scans sub-items for a specific array without mutating global state
   */
  async function scanSubItemsForArray(itemsArray) {
    const targets = itemsArray.filter(item =>
      (item.type === 'folder' || item.type === 'assign') && item.scanningStatus === 'none'
    );

    if (targets.length === 0) return;

    const CONCURRENCY_LIMIT = 5;

    for (let i = 0; i < targets.length; i += CONCURRENCY_LIMIT) {
      const batch = targets.slice(i, i + CONCURRENCY_LIMIT);

      try {
        const response = await sendToBackground({
          action: 'RESOLVE_RESOURCES',
          payload: {
            items: batch.map(item => ({ url: item.url, name: item.name, type: item.type }))
          }
        });

        if (response.success && response.results) {
          response.results.forEach((res, index) => {
            const item = batch[index];
            if (res.type === 'folder' || res.type === 'assign') {
              item.subFiles = res.files || [];
            }
          });
        }
      } catch (err) {
        console.warn('[SWR] Sub-item batch scan failed:', err);
      }
    }
  }

  /* ═══════════════════════════════════════════════════════
   * EVENT BINDING
   * ═══════════════════════════════════════════════════════ */

  function bindEvents() {
    // Go to Moodle
    btnGoMoodle.addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://moodle.huji.ac.il/2025-26/my/' });
      window.close();
    });

    btnLibraryGoMoodle.addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://moodle.huji.ac.il/2025-26/my/' });
      window.close();
    });

    // My Courses hub toggle
    if (btnMyCourses) {
      btnMyCourses.addEventListener('click', () => {
        if (currentActiveState === 'library') {
          // Switch back to course view if possible
          showState('loading');
          scanCurrentTab().then(found => {
            if (!found) renderLibrary();
          });
        } else {
          renderLibrary();
        }
      });
    }

    // Select All
    selectAllCb.addEventListener('change', () => {
      const isChecked = selectAllCb.checked;
      for (const item of allItems) {
        if (isChecked) {
          selectedIds.add(item.uid);
        } else {
          selectedIds.delete(item.uid);
        }
      }
      syncCheckboxes();
      updateSelectionCount();
      updateDownloadButton();
    });

    // Download
    btnDownload.addEventListener('click', startDownload);

    // Cancel
    btnCancel.addEventListener('click', cancelDownload);

    // New Download
    btnNewDownload.addEventListener('click', async () => {
      if (chrome.storage && chrome.storage.session) {
        try { await chrome.storage.session.remove('lastDownloadResult'); } catch (e) { }
      }
      showState('loading');
      scanCurrentTab();
    });

    // Retry
    btnRetry.addEventListener('click', async () => {
      if (chrome.storage && chrome.storage.session) {
        try { await chrome.storage.session.remove('lastDownloadResult'); } catch (e) { }
      }
      showState('loading');
      scanCurrentTab();
    });

    // Toggle errors
    toggleErrorsBtn.addEventListener('click', () => {
      const list = $('errors-list');
      list.classList.toggle('hidden');
      toggleErrorsBtn.classList.toggle('expanded');
    });

    // Toggle success logs
    if (toggleSuccessBtn) {
      toggleSuccessBtn.addEventListener('click', () => {
        successList.classList.toggle('hidden');
        toggleSuccessBtn.classList.toggle('expanded');
      });
    }

    // Toggle failed logs
    if (toggleFailedBtn) {
      toggleFailedBtn.addEventListener('click', () => {
        failedList.classList.toggle('hidden');
        toggleFailedBtn.classList.toggle('expanded');
      });
    }

    // Listen for progress updates from the service worker
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'PROGRESS_UPDATE') {
        updateProgress(
          message.downloaded,
          message.skipped,
          message.total,
          message.currentFile,
          message.errors || []
        );
      } else if (message.type === 'STATE_CHANGE') {
        handleStateChange(message);
      }
    });

    // Theme Toggle
    const themeToggle = $('theme-toggle');
    if (themeToggle) {
      themeToggle.addEventListener('change', () => {
        const isDark = themeToggle.checked;
        setTheme(isDark);
      });
    }
    // Save folder structure preference on toggle
    keepStructureCb.addEventListener('change', () => {
      chrome.storage.local.set({ keepStructure: keepStructureCb.checked });
    });
  }

  /* ═══════════════════════════════════════════════════════
   * DATA PROCESSING
   * ═══════════════════════════════════════════════════════ */

  function buildItemsList() {
    allItems = [];
    let uid = 0;
    for (const section of courseData.sections) {
      for (const item of section.items) {
        allItems.push({
          uid: uid++,
          sectionId: section.id,
          sectionTitle: section.title,
          name: item.name,
          url: item.url,
          type: item.type,
          subFiles: [],
          scanningStatus: 'none',
        });
        selectedIds.add(allItems[allItems.length - 1].uid);
      }
    }
  }

  async function scanSubItems() {
    const targets = allItems.filter(item =>
      (item.type === 'folder' || item.type === 'assign') && item.scanningStatus === 'none'
    );

    if (targets.length === 0) return;

    const loadingText = stateLoading.querySelector('.loading-text');
    const originalText = loadingText ? loadingText.textContent : 'Scanning course…';
    const CONCURRENCY_LIMIT = 5;

    for (let i = 0; i < targets.length; i += CONCURRENCY_LIMIT) {
      const batch = targets.slice(i, i + CONCURRENCY_LIMIT);

      if (loadingText) {
        loadingText.textContent = `Scanning items ${i + 1} to ${Math.min(i + CONCURRENCY_LIMIT, targets.length)} of ${targets.length}…`;
      }

      batch.forEach(item => item.scanningStatus = 'scanning');

      try {
        const response = await sendToBackground({
          action: 'RESOLVE_RESOURCES',
          payload: {
            items: batch.map(item => ({ url: item.url, name: item.name, type: item.type }))
          }
        });

        if (response.success && response.results) {
          response.results.forEach((res, index) => {
            const item = batch[index];
            if (res.type === 'folder' || res.type === 'assign') {
              item.subFiles = res.files || [];
              item.scanningStatus = 'done';
            } else {
              item.scanningStatus = 'error';
            }
          });
        } else {
          batch.forEach(item => item.scanningStatus = 'error');
        }
      } catch (err) {
        console.error('[Popup] Sub-item batch scan failed:', err);
        batch.forEach(item => item.scanningStatus = 'error');
      }
    }

    if (loadingText) loadingText.textContent = originalText;
  }

  function flattenItems() {
    const newItems = [];
    let uid = 0;

    for (const item of allItems) {
      if (item.type === 'resource') {
        item.uid = uid++;
        newItems.push(item);
      } else if (item.type === 'folder' || item.type === 'assign') {
        if (item.subFiles && item.subFiles.length > 0) {
          for (const subFile of item.subFiles) {
            newItems.push({
              uid: uid++,
              sectionId: item.sectionId,
              sectionTitle: item.sectionTitle,
              name: subFile.name,
              url: subFile.url,
              type: 'resource',
              parentFolder: item.name,
              alreadyDownloaded: false
            });
          }
        }
      }
    }

    allItems = newItems;
    selectedIds = new Set(allItems.map(i => i.uid));
  }

  async function enrichItemsWithStatus() {
    if (!courseData || allItems.length === 0) return;

    const itemsToCheck = allItems.map(item => ({
      sectionTitle: item.sectionTitle,
      name: item.name,
      parentFolder: item.parentFolder || ''
    }));

    const response = await sendToBackground({
      action: 'CHECK_ITEMS',
      payload: {
        courseName: courseData.courseName,
        items: itemsToCheck
      }
    });

    if (response.success && response.statuses) {
      response.statuses.forEach((isDownloaded, index) => {
        allItems[index].alreadyDownloaded = isDownloaded;
        if (isDownloaded) {
          selectedIds.delete(allItems[index].uid);
        }
      });
    }
  }

  /* ═══════════════════════════════════════════════════════
   * RENDERING
   * ═══════════════════════════════════════════════════════ */

  function renderCourseInfo() {
    courseNameEl.textContent = courseData.courseName;
    const totalItems = allItems.length;
    courseItemCount.textContent = `${totalItems} downloadable item${totalItems !== 1 ? 's' : ''} found`;
    syncCheckboxes();
    updateSelectionCount();
    updateDownloadButton();
  }

  function renderSections() {
    sectionsList.innerHTML = '';

    for (const section of courseData.sections) {
      const sectionItems = allItems.filter(item => item.sectionId === section.id);
      if (sectionItems.length === 0) continue;

      const group = document.createElement('div');
      group.className = 'section-group';
      group.dataset.sectionId = section.id;

      // Section header
      const header = document.createElement('div');
      header.className = 'section-header';
      header.innerHTML = `
        <svg class="section-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
        <label class="section-checkbox-wrapper">
          <input type="checkbox" data-section-id="${section.id}" checked>
          <span class="section-checkmark"></span>
        </label>
        <span class="section-title" title="${escapeHtml(section.title)}">${escapeHtml(section.title)}</span>
        <span class="section-count">${sectionItems.length}</span>
      `;

      // Toggle section collapse
      header.addEventListener('click', (e) => {
        if (e.target.closest('.section-checkbox-wrapper')) return;
        group.classList.toggle('collapsed');
      });

      // Section checkbox
      const sectionCb = header.querySelector('input[type="checkbox"]');
      sectionCb.addEventListener('change', () => {
        for (const item of sectionItems) {
          if (sectionCb.checked) {
            selectedIds.add(item.uid);
          } else {
            selectedIds.delete(item.uid);
          }
        }
        syncCheckboxes();
        updateSelectionCount();
        updateDownloadButton();
      });

      group.appendChild(header);

      // Items container
      const itemsContainer = document.createElement('div');
      itemsContainer.className = 'section-items';

      for (const item of sectionItems) {
        const row = document.createElement('div');
        row.className = 'item-row' + (item.alreadyDownloaded ? ' already-downloaded' : '');

        const typeIcon = getTypeIcon(item.type);

        row.innerHTML = `
          <label class="item-checkbox-wrapper">
            <input type="checkbox" data-uid="${item.uid}" ${item.alreadyDownloaded ? '' : 'checked'}>
            <span class="item-checkmark"></span>
          </label>
          <div class="item-content-wrapper">
            <div class="item-main-row">
              ${typeIcon}
              <div class="item-text-container">
                <span class="item-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
                ${item.parentFolder ? `<span class="item-parent-folder">from ${escapeHtml(item.parentFolder)}</span>` : ''}
              </div>
              ${item.alreadyDownloaded ? `
                <span class="item-status-tag">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 2px;">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                  Downloaded
                </span>
              ` : ''}
            </div>
          </div>
        `;

        const itemCb = row.querySelector('input[type="checkbox"]');
        itemCb.addEventListener('change', () => {
          if (itemCb.checked) {
            selectedIds.add(item.uid);
          } else {
            selectedIds.delete(item.uid);
          }
          syncCheckboxes();
          updateSelectionCount();
          updateDownloadButton();
        });

        // ✨ UX POLISH: Make the entire row clickable for better UX
        row.addEventListener('click', (e) => {
          // Prevent double-toggling if they actually clicked the checkbox label directly
          if (e.target.closest('.item-checkbox-wrapper')) return;
          
          itemCb.checked = !itemCb.checked;
          itemCb.dispatchEvent(new Event('change'));
        });

        itemsContainer.appendChild(row);
      }

      group.appendChild(itemsContainer);
      sectionsList.appendChild(group);

      requestAnimationFrame(() => {
        itemsContainer.style.maxHeight = itemsContainer.scrollHeight + 'px';
      });
    }
  }

  function getTypeIcon(type) {
    const icons = {
      resource: `<svg class="item-type-icon type-resource" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>`,
      folder: `<svg class="item-type-icon type-folder" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      </svg>`,
      assign: `<svg class="item-type-icon type-assign" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
        <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
      </svg>`,
      page: `<svg class="item-type-icon type-page" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <line x1="16" y1="13" x2="8" y2="13"/>
        <line x1="16" y1="17" x2="8" y2="17"/>
      </svg>`,
    };
    return icons[type] || icons.resource;
  }

  /* ═══════════════════════════════════════════════════════
   * CHECKBOX SYNCHRONIZATION
   * ═══════════════════════════════════════════════════════ */

  function syncCheckboxes() {
    if (!courseData || !courseData.sections) return;

    const itemCbs = sectionsList.querySelectorAll('input[data-uid]');
    for (const cb of itemCbs) {
      cb.checked = selectedIds.has(parseInt(cb.dataset.uid, 10));
    }

    for (const section of courseData.sections) {
      const sectionItems = allItems.filter(i => i.sectionId === section.id);
      const sectionCb = sectionsList.querySelector(`input[data-section-id="${section.id}"]`);
      if (!sectionCb) continue;

      const selectedCount = sectionItems.filter(i => selectedIds.has(i.uid)).length;
      if (selectedCount === 0) {
        sectionCb.checked = false;
        sectionCb.indeterminate = false;
      } else if (selectedCount === sectionItems.length) {
        sectionCb.checked = true;
        sectionCb.indeterminate = false;
      } else {
        sectionCb.checked = false;
        sectionCb.indeterminate = true;
      }
    }

    if (selectedIds.size === 0) {
      selectAllCb.checked = false;
      selectAllCb.indeterminate = false;
    } else if (selectedIds.size === allItems.length) {
      selectAllCb.checked = true;
      selectAllCb.indeterminate = false;
    } else {
      selectAllCb.checked = false;
      selectAllCb.indeterminate = true;
    }
  }

  function updateSelectionCount() {
    selectionCount.textContent = `${selectedIds.size} selected`;
  }

  function updateDownloadButton() {
    btnDownload.disabled = selectedIds.size === 0;
  }

  /* ═══════════════════════════════════════════════════════
   * DOWNLOAD ACTIONS
   * ═══════════════════════════════════════════════════════ */

  async function startDownload() {
    if (selectedIds.size === 0) return;

    if (chrome.storage && chrome.storage.session) {
      try { await chrome.storage.session.remove('lastDownloadResult'); } catch (e) { }
    }

    const selectedItems = allItems
      .filter(item => selectedIds.has(item.uid))
      .map(item => ({
        sectionTitle: item.sectionTitle,
        name: item.name,
        url: item.url,
        type: item.type,
        parentFolder: item.parentFolder || '',
      }));

    showState('downloading');
    updateProgress(0, 0, selectedItems.length, 'Starting…', []);
    const response = await sendToBackground({
      action: 'START_DOWNLOAD',
      payload: {
        courseName: courseData.courseName,
        items: selectedItems,
        keepStructure: keepStructureCb.checked // <--- ADD THIS
      },
    });

    if (!response.success) {
      showError('Download Error', response.error || 'Failed to start download.');
    }
  }

  async function cancelDownload() {
    btnCancel.disabled = true;
    btnCancel.textContent = 'Cancelling…';

    await sendToBackground({ action: 'CANCEL_DOWNLOAD' });
  }

  /* ═══════════════════════════════════════════════════════
   * PROGRESS UPDATES
   * ═══════════════════════════════════════════════════════ */

  function updateProgress(downloaded, skipped, total, currentFile, errors) {
    const processed = downloaded + skipped;
    const percent = total > 0 ? Math.round((processed / total) * 100) : 0;

    progressFill.style.width = `${percent}%`;
    progressText.textContent = `${downloaded} / ${total} files`;
    progressPercent.textContent = `${percent}%`;

    if (currentFile) {
      currentFileName.textContent = currentFile;
    }

    downloadTitle.textContent = 'Downloading…';
    downloadSubtitle.textContent = `${downloaded} downloaded, ${skipped} skipped`;

    if (errors && errors.length > 0) {
      errorsContainer.classList.remove('hidden');
      errorsCount.textContent = `${errors.length} issue${errors.length !== 1 ? 's' : ''}`;
      errorsList.innerHTML = errors.map(e => `<li>${escapeHtml(e)}</li>`).join('');
    }
  }

  function handleStateChange(message) {
    switch (message.state) {
      case 'COMPLETE':
      case 'CANCELLED':
        showState('complete');
        if (message.state === 'COMPLETE') {
          completeTitle.textContent = 'Download Complete!';
          completeDesc.textContent = `${message.downloaded} file${message.downloaded !== 1 ? 's' : ''} downloaded${message.skipped > 0 ? `, ${message.skipped} skipped` : ''}.`;

          if (courseData) {
            saveCourseToHistory(
              courseData.courseName,
              courseData.courseUrl || '',
              message.downloaded,
              (courseData.sections || []).length
            );
          }
        } else {
          completeTitle.textContent = 'Download Cancelled';
          completeDesc.textContent = `${message.downloaded} file${message.downloaded !== 1 ? 's' : ''} were downloaded before cancellation.`;
        }

        const successes = message.successes || [];
        const errors = message.errors || [];

        if (successes.length > 0 || errors.length > 0) {
          completeLogs.classList.remove('hidden');

          successCountText.textContent = successes.length;
          failedCountText.textContent = errors.length;

          successList.innerHTML = successes.map(s => `<li>${escapeHtml(s)}</li>`).join('');
          failedList.innerHTML = errors.map(e => `<li>${escapeHtml(e)}</li>`).join('');
        } else {
          completeLogs.classList.add('hidden');
        }
        break;

      case 'SESSION_EXPIRED':
        showError(
          'Session Expired',
          'Your Moodle session has expired. Please refresh the Moodle page, log in, and try again.'
        );
        break;
    }
  }

  /* ═══════════════════════════════════════════════════════
   * LIBRARY MANAGEMENT
   * ═══════════════════════════════════════════════════════ */

  async function renderLibrary() {
    showState('library');
    libraryList.innerHTML = '';
    libraryEmpty.classList.add('hidden');

    const result = await chrome.storage.local.get(['courseHistory']);
    const history = result.courseHistory || {};
    const courses = Object.values(history).sort((a, b) => b.lastUpdated - a.lastUpdated);

    libraryCourseCount.textContent = `${courses.length} course${courses.length !== 1 ? 's' : ''}`;

    if (courses.length === 0) {
      libraryEmpty.classList.remove('hidden');
      return;
    }

    courses.forEach(course => {
      const card = document.createElement('div');
      card.className = 'mini-course-card';

      // ✨ UX POLISH: Compact List Row Template (Narrowed & Clickable)
      card.innerHTML = `
        <div class="card-info">
          <h3 class="card-title" dir="rtl" title="${escapeHtml(course.name)}">${escapeHtml(course.name)}</h3>
          <span class="card-stats">${course.files} files • ${course.sections} sections</span>
        </div>
        <div class="card-actions">
          <button class="btn-card btn-card-primary btn-card-large btn-open-folder" data-course="${escapeHtml(course.name)}" title="Open Download Folder">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
          </button>
        </div>
      `;

      // Entire card opens Moodle
      card.addEventListener('click', () => {
        if (course.url) {
          chrome.tabs.create({ url: course.url });
        } else {
          chrome.tabs.create({ url: 'https://moodle.huji.ac.il/' });
        }
      });

      // Folder button opens local folder (stopPropagation to prevent opening Moodle)
      const btnFolder = card.querySelector('.btn-open-folder');
      btnFolder.addEventListener('click', (e) => {
        e.stopPropagation();
        sendToBackground({ action: 'OPEN_COURSE_FOLDER', payload: { courseName: course.name } });
      });

      libraryList.appendChild(card);
    });
  }

  async function saveCourseToHistory(courseName, courseUrl, filesCount, sectionsCount) {
    const result = await chrome.storage.local.get(['courseHistory']);
    let history = result.courseHistory || {};

    history[courseName] = {
      name: courseName,
      url: courseUrl,
      files: filesCount,
      sections: sectionsCount,
      lastUpdated: Date.now()
    };

    await chrome.storage.local.set({ courseHistory: history });
  }

  /* ═══════════════════════════════════════════════════════
   * STATE MANAGEMENT
   * ═══════════════════════════════════════════════════════ */

  function showState(name) {
    currentActiveState = name;
    const panels = [
      stateLoading, stateInvalid, stateSelection,
      stateDownloading, stateComplete, stateError, stateLibrary
    ];

    for (const p of panels) {
      if (p && p.classList) {
        p.classList.remove('active');
      }
    }

    const map = {
      loading: stateLoading,
      invalid: stateInvalid,
      selection: stateSelection,
      downloading: stateDownloading,
      complete: stateComplete,
      error: stateError,
      library: stateLibrary
    };

    if (map[name]) {
      map[name].classList.add('active');
    }

    if (btnMyCourses) {
      const span = btnMyCourses.querySelector('span');
      const svg = btnMyCourses.querySelector('svg');
      if (span && svg) {
        if (name === 'library') {
          span.textContent = 'Back';
          btnMyCourses.title = 'Back to scan current page';
          svg.innerHTML = '<polyline points="15 18 9 12 15 6"/>';
        } else {
          span.textContent = 'My Courses';
          btnMyCourses.title = 'My Courses — view all scanned courses';
          svg.innerHTML = '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>';
        }
      }
    }

    if (name === 'downloading' && btnCancel) {
      btnCancel.disabled = false;
      btnCancel.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
        </svg>
        Cancel
      `;
    }
  }

  function showError(title, description) {
    errorTitle.textContent = title;
    errorDesc.textContent = description;
    showState('error');
  }

  /* ═══════════════════════════════════════════════════════
   * UTILITIES
   * ═══════════════════════════════════════════════════════ */

  function sendToBackground(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response || {});
        }
      });
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /* ═══════════════════════════════════════════════════════
   * THEME MANAGEMENT
   * ═══════════════════════════════════════════════════════ */

  async function initTheme() {
    const result = await chrome.storage.local.get(['darkMode']);
    const isDark = result.darkMode !== undefined ? result.darkMode : false;
    
    const themeToggle = $('theme-toggle');
    if (themeToggle) {
      themeToggle.checked = isDark;
    }
    
    if (isDark) {
      document.body.classList.add('dark-mode');
    } else {
      document.body.classList.remove('dark-mode');
    }
  }

  function setTheme(isDark) {
    if (isDark) {
      document.body.classList.add('dark-mode');
    } else {
      document.body.classList.remove('dark-mode');
    }
    chrome.storage.local.set({ darkMode: isDark });
  }

  /* ═══════════════════════════════════════════════════════
   * DATABASE (SWR CACHE)
   * ═══════════════════════════════════════════════════════ */

  async function getCourseFromDB(courseName) {
    const key = `db_${courseName}`;
    const result = await chrome.storage.local.get(key);
    return result[key] || null;
  }

  async function saveCourseToDB(courseName, itemsArray) {
    const key = `db_${courseName}`;
    const data = {};
    data[key] = itemsArray.map(item => ({
      sectionId: item.sectionId,
      sectionTitle: item.sectionTitle,
      name: item.name,
      url: item.url,
      type: item.type,
      parentFolder: item.parentFolder
    }));
    await chrome.storage.local.set(data);
  }

  /* ═══════════════════════════════════════════════════════
   * BOOTSTRAP
   * ═══════════════════════════════════════════════════════ */

  init();

})();