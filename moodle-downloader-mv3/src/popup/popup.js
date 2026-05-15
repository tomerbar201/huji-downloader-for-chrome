/**
 * popup.js — Popup UI Controller
 * 
 * Manages the full popup lifecycle:
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
   *  DOM REFERENCES
   * ═══════════════════════════════════════════════════════ */

  const $ = (id) => document.getElementById(id);

  const stateLoading     = $('state-loading');
  const stateInvalid     = $('state-invalid');
  const stateSelection   = $('state-selection');
  const stateDownloading = $('state-downloading');
  const stateComplete    = $('state-complete');
  const stateError       = $('state-error');

  const btnGoMoodle     = $('btn-go-moodle');
  const btnDownload     = $('btn-download');
  const btnCancel       = $('btn-cancel');
  const btnNewDownload  = $('btn-new-download');
  const btnRetry        = $('btn-retry');

  const courseNameEl     = $('course-name');
  const courseItemCount  = $('course-item-count');
  const selectAllCb     = $('select-all-checkbox');
  const selectionCount  = $('selection-count');
  const sectionsList    = $('sections-list');

  const progressFill    = $('progress-fill');
  const progressText    = $('progress-text');
  const progressPercent = $('progress-percent');
  const downloadTitle   = $('download-title');
  const downloadSubtitle = $('download-subtitle');
  const currentFileName = $('current-file-name');

  const errorsContainer = $('errors-container');
  const errorsCount     = $('errors-count');
  const errorsList      = $('errors-list');
  const toggleErrorsBtn = $('toggle-errors');

  const completeTitle   = $('complete-title');
  const completeDesc    = $('complete-desc');
  const completeLogs    = $('complete-logs');
  const toggleSuccessBtn = $('toggle-success');
  const successList     = $('success-list');
  const successCountText = $('success-count-text');
  const toggleFailedBtn = $('toggle-failed');
  const failedList      = $('failed-list');
  const failedCountText = $('failed-count-text');

  const errorTitle      = $('error-title');
  const errorDesc       = $('error-desc');

  /* ═══════════════════════════════════════════════════════
   *  STATE
   * ═══════════════════════════════════════════════════════ */

  let courseData = null;    // Parsed course data from content script
  let allItems = [];        // Flat list of all selectable items (with sectionTitle)
  let selectedIds = new Set();

  /* ═══════════════════════════════════════════════════════
   *  INITIALIZATION
   * ═══════════════════════════════════════════════════════ */

  async function init() {
    // 1. הכנת הממשק הראשונית
    showState('loading');
    bindEvents();

    // 2. בדיקה: האם יש הורדה שרצה כרגע ברקע?
    const status = await sendToBackground({ action: 'GET_STATUS' }).catch(() => null);
    if (status?.isRunning) {
      showState('downloading');
      updateProgress(status.downloaded, status.skipped, status.total, '', status.errors || []);
      return; // עוצרים כאן אם יש הורדה פעילה
    }

    // 3. בדיקה: האם יש תוצאה של הורדה קודמת שטרם הוצגה?
    const storage = await chrome.storage.session.get('lastDownloadResult').catch(() => ({}));
    const lastRes = storage.lastDownloadResult;
    
    if (lastRes) {
      handleStateChange({
        state: lastRes.cancelled ? 'CANCELLED' : 'COMPLETE',
        ...lastRes
      });
      return; // עוצרים כאן אם הצגנו תוצאה שמורה
    }

    // 4. ברירת מחדל: אם אין כלום ברקע, סרוק את העמוד הנוכחי
    await scanCurrentTab();
  }
  /**
   * Inject the content script into the active tab and request course data.
   */
  async function scanCurrentTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) {
        showState('invalid');
        return;
      }

      // Check URL first
      const url = tab.url || '';
      if (!url.includes('moodle.huji.ac.il') && !url.includes('moodle4.cs.huji.ac.il')) {
        showState('invalid');
        return;
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
        chrome.tabs.sendMessage(tab.id, { action: 'PARSE_COURSE' }, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(resp || { success: false, error: 'No response' });
          }
        });
      });

    if (!response.success) {
      if (response.error === 'NOT_MOODLE_PAGE') {
        showState('invalid');
      } else {
        showError('Parsing Error', response.error || 'Could not read the course page.');
      }
      return;
    }

    courseData = response.data;

    // Maintenance of reverse logic from Conversation 51b39d53
    if (courseData && courseData.sections) {
      courseData.sections.reverse();
    }

    if (!courseData || !courseData.sections || courseData.sections.length === 0) {
      showError('No Materials Found', 'This course page has no downloadable materials.');
      return;
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
        return;
      }

      await saveCourseToDB(courseData.courseName, allItems);
      
      await enrichItemsWithStatus();
      renderCourseInfo();
      renderSections();
      syncCheckboxes(); 
      showState('selection');
    }

    } catch (err) {
      console.error('[Popup] Init error:', err);
      showError('Connection Error', 'Could not connect to the Moodle page. Try refreshing.');
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

    for (const item of targets) {
      try {
        const response = await sendToBackground({
          action: 'RESOLVE_RESOURCES',
          payload: { items: [{ url: item.url, name: item.name, type: item.type }] }
        });

        if (response.success && response.results && response.results[0]) {
          const res = response.results[0];
          if (res.type === 'folder' || res.type === 'assign') {
            item.subFiles = res.files || [];
          }
        }
      } catch (err) {
        console.warn('[SWR] Sub-item scan failed:', err);
      }
    }
  }

  /* ═══════════════════════════════════════════════════════
   *  EVENT BINDING
   * ═══════════════════════════════════════════════════════ */

  function bindEvents() {
    // Go to Moodle
    btnGoMoodle.addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://moodle.huji.ac.il/2025-26/my/' });
      window.close();
    });

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
        try { await chrome.storage.session.remove('lastDownloadResult'); } catch (e) {}
      }
      showState('loading');
      scanCurrentTab();
    });

    // Retry
    btnRetry.addEventListener('click', async () => {
      if (chrome.storage && chrome.storage.session) {
        try { await chrome.storage.session.remove('lastDownloadResult'); } catch (e) {}
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
  }

  /* ═══════════════════════════════════════════════════════
   *  DATA PROCESSING
   * ═══════════════════════════════════════════════════════ */

  /**
   * Build a flat items list with unique IDs and section references.
   */
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
          subFiles: [],      // To be filled by sub-item scanning
          scanningStatus: 'none', // 'none' | 'scanning' | 'done' | 'error'
        });
        // Select all by default
        selectedIds.add(allItems[allItems.length - 1].uid);
      }
    }
  }

  /**
   * Scan folders and assignments for their internal files.
   * Runs during the 'loading' state.
   */
  async function scanSubItems() {
    const targets = allItems.filter(item => 
      (item.type === 'folder' || item.type === 'assign') && item.scanningStatus === 'none'
    );

    if (targets.length === 0) return;

    const loadingText = stateLoading.querySelector('.loading-text');
    const originalText = loadingText ? loadingText.textContent : 'Scanning course…';

    // We process them one by one or in small batches to show progress
    for (let i = 0; i < targets.length; i++) {
      const item = targets[i];
      if (loadingText) {
        loadingText.textContent = `Scanning ${item.type === 'folder' ? 'folder' : 'assignment'} ${i + 1} of ${targets.length}…`;
      }

      item.scanningStatus = 'scanning';

      try {
        const response = await sendToBackground({
          action: 'RESOLVE_RESOURCES',
          payload: { items: [{ url: item.url, name: item.name, type: item.type }] }
        });

        if (response.success && response.results && response.results[0]) {
          const res = response.results[0];
          if (res.type === 'folder' || res.type === 'assign') {
            item.subFiles = res.files || [];
            item.scanningStatus = 'done';
          } else {
            item.scanningStatus = 'error';
          }
        } else {
          item.scanningStatus = 'error';
        }
      } catch (err) {
        console.error('[Popup] Sub-item scan failed:', err);
        item.scanningStatus = 'error';
      }
    }

    if (loadingText) loadingText.textContent = originalText;
  }

  /**
   * Replace folder/assignment containers with their actual files.
   * If a container is empty, it is removed.
   */
  function flattenItems() {
    const newItems = [];
    let uid = 0;

    for (const item of allItems) {
      if (item.type === 'resource') {
        // Keep direct files as is
        item.uid = uid++;
        newItems.push(item);
      } else if (item.type === 'folder' || item.type === 'assign') {
        // Replace container with its files
        if (item.subFiles && item.subFiles.length > 0) {
          for (const subFile of item.subFiles) {
            newItems.push({
              uid: uid++,
              sectionId: item.sectionId,
              sectionTitle: item.sectionTitle,
              name: subFile.name,
              url: subFile.url,
              type: 'resource', // Treat as resource for UI purposes
              parentFolder: item.name, // Preserve for path construction
              alreadyDownloaded: false
            });
          }
        }
        // If empty, it's naturally excluded from newItems
      }
    }

    allItems = newItems;
    selectedIds = new Set(allItems.map(i => i.uid)); // Re-select all by default
  }

  /**
   * Check with the background script which items are already downloaded.
   */
  async function enrichItemsWithStatus() {
    if (!courseData || allItems.length === 0) return;
    
    // We only need to check items that are files (resource, folder, assign)
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
          // Unselect already downloaded items by default
          selectedIds.delete(allItems[index].uid);
        }
      });
    }
  }

  /* ═══════════════════════════════════════════════════════
   *  RENDERING
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

        itemsContainer.appendChild(row);
      }

      // Set initial max-height for animation
      group.appendChild(itemsContainer);
      sectionsList.appendChild(group);

      // After append, set the max-height for CSS transitions
      requestAnimationFrame(() => {
        itemsContainer.style.maxHeight = itemsContainer.scrollHeight + 'px';
      });
    }
  }

  /**
   * Get an SVG icon for a module type.
   */
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
   *  CHECKBOX SYNCHRONIZATION
   * ═══════════════════════════════════════════════════════ */

  function syncCheckboxes() {
    // Sync individual item checkboxes
    const itemCbs = sectionsList.querySelectorAll('input[data-uid]');
    for (const cb of itemCbs) {
      cb.checked = selectedIds.has(parseInt(cb.dataset.uid, 10));
    }

    // Sync section checkboxes
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

    // Sync select all
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
   *  DOWNLOAD ACTIONS
   * ═══════════════════════════════════════════════════════ */

  async function startDownload() {
    if (selectedIds.size === 0) return;

    if (chrome.storage && chrome.storage.session) {
      try { await chrome.storage.session.remove('lastDownloadResult'); } catch (e) {}
    }

    // Gather selected items
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

    // Send to service worker
    const response = await sendToBackground({
      action: 'START_DOWNLOAD',
      payload: {
        courseName: courseData.courseName,
        items: selectedItems,
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
   *  PROGRESS UPDATES
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

    // Update errors
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
        } else {
          completeTitle.textContent = 'Download Cancelled';
          completeDesc.textContent = `${message.downloaded} file${message.downloaded !== 1 ? 's' : ''} were downloaded before cancellation.`;
        }
        
        // Show logs if there are any
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
   *  STATE MANAGEMENT
   * ═══════════════════════════════════════════════════════ */

  function showState(name) {
    const panels = [stateLoading, stateInvalid, stateSelection, stateDownloading, stateComplete, stateError];
    for (const p of panels) {
      p.classList.remove('active');
    }

    const map = {
      loading: stateLoading,
      invalid: stateInvalid,
      selection: stateSelection,
      downloading: stateDownloading,
      complete: stateComplete,
      error: stateError,
    };

    if (map[name]) {
      map[name].classList.add('active');
    }

    // Reset cancel button state
    if (name === 'downloading') {
      btnCancel.disabled = false;
      btnCancel.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="15" y1="9" x2="9" y2="15"/>
          <line x1="9" y1="9" x2="15" y2="15"/>
        </svg>
        Cancel Download
      `;
    }
  }

  function showError(title, description) {
    errorTitle.textContent = title;
    errorDesc.textContent = description;
    showState('error');
  }

  /* ═══════════════════════════════════════════════════════
   *  UTILITIES
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
   *  DATABASE (SWR CACHE)
   * ═══════════════════════════════════════════════════════ */

  async function getCourseFromDB(courseName) {
    const key = `db_${courseName}`;
    const result = await chrome.storage.local.get(key);
    return result[key] || null;
  }

  async function saveCourseToDB(courseName, itemsArray) {
    const key = `db_${courseName}`;
    const data = {};
    // Save only essential metadata to optimize storage space
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
   *  BOOTSTRAP
   * ═══════════════════════════════════════════════════════ */

  init();

})();
