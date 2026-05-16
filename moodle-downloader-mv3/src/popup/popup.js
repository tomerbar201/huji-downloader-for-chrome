/**
 * popup.js — Popup UI Controller
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

  const btnGoMoodle = $('btn-go-moodle');
  const btnDownload = $('btn-download');
  const keepStructureCb = $('keep-structure-checkbox');
  const btnCollapseAll = $('btn-collapse-all');

  const btnCancel = $('btn-cancel');
  const btnNewDownload = $('btn-new-download');
  const btnRetry = $('btn-retry');

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

  let courseData = null;
  let allItems = [];
  let selectedIds = new Set();
  let currentActiveState = 'loading';

  /* ═══════════════════════════════════════════════════════
   * INITIALIZATION
   * ═══════════════════════════════════════════════════════ */

  async function init() {
    const prefs = await chrome.storage.local.get(['keepStructure']);
    if (prefs.keepStructure !== undefined) {
      keepStructureCb.checked = prefs.keepStructure;
    }
    try {
      bindEvents();

      const status = await sendToBackground({ action: 'GET_STATUS' }).catch(() => null);
      if (status?.isRunning) {
        showState('downloading');
        updateProgress(status.downloaded, status.skipped, status.total, '', status.errors || []);
        return;
      }

      let lastRes = null;
      try {
        const storage = await chrome.storage.session.get('lastDownloadResult');
        lastRes = storage.lastDownloadResult;
      } catch (e) { }

      if (lastRes) {
        handleStateChange({ state: lastRes.cancelled ? 'CANCELLED' : 'COMPLETE', ...lastRes });
        return;
      }

      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs && tabs.length > 0 ? tabs[0] : null;
      const url = tab?.url || '';
      const isMoodle = url.includes('moodle.huji.ac.il') || url.includes('moodle4.cs.huji.ac.il');

      if (isMoodle && tab) {
        showState('loading');
        await scanCurrentTab(tab);
      } else {
        showState('invalid');
      }

      initTheme();
    } catch (err) {
      showError('Initialization Error', 'The extension encountered an error while starting.');
    }
  }

  async function scanCurrentTab(existingTab = null) {
    try {
      const tab = existingTab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      if (!tab || !tab.id) return false;

      const url = tab.url || '';
      if (!url.includes('moodle.huji.ac.il') && !url.includes('moodle4.cs.huji.ac.il')) return false;

      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content_scripts/dom_parser.js'] });
      } catch (e) { }

      await sleep(200);

      const response = await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve({ success: false, error: 'TIMEOUT', message: 'The page took too long to respond.' });
        }, 8000);
        chrome.tabs.sendMessage(tab.id, { action: 'PARSE_COURSE' }, (resp) => {
          clearTimeout(timeout);
          if (chrome.runtime.lastError) {
            resolve({ success: false, error: 'CONNECTION_ERROR', message: chrome.runtime.lastError.message });
          } else {
            resolve(resp || { success: false, error: 'NO_RESPONSE' });
          }
        });
      });

      if (!response.success) {
        if (response.error === 'NOT_MOODLE_PAGE') return false;
        showError('Parsing Error', response.error || 'Could not read the course page.');
        return true;
      }

      courseData = response.data;
      if (courseData && courseData.sections) courseData.sections.reverse();

      if (!courseData || !courseData.sections || courseData.sections.length === 0) {
        showError('No Materials Found', 'This course page has no downloadable materials.');
        return true;
      }

      const cache = await getCourseFromDB(courseData.courseName);
      if (cache && cache.items && cache.items.length > 0) {
        // Simple cache check: if older than 7 days, ignore it
        const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;
        if (Date.now() - cache.timestamp < ONE_WEEK) {
          allItems = cache.items;
          let uid = 0;
          allItems.forEach(item => { item.uid = uid++; });
          selectedIds = new Set(allItems.map(i => i.uid));
          await enrichItemsWithStatus();
          renderCourseInfo();
          renderSections();
          showState('selection');
          return true;
        }
      }

      buildItemsList();
      await scanSubItems();
      flattenItems();
      if (allItems.length === 0) {
        showError('No Materials Found', 'This course page has no downloadable files.');
        return true;
      }
      await saveCourseToDB(courseData.courseName, allItems, courseData.courseUrl);
      await enrichItemsWithStatus();
      renderCourseInfo();
      renderSections();
      syncCheckboxes();
      showState('selection');
      return true;
    } catch (err) {
      showError('Connection Error', 'Could not connect to the Moodle page.');
      return false;
    }
  }

  /* ═══════════════════════════════════════════════════════
   * EVENT BINDING
   * ═══════════════════════════════════════════════════════ */

  function bindEvents() {
    btnGoMoodle.addEventListener('click', () => { chrome.tabs.create({ url: 'https://moodle.huji.ac.il/2025-26/my/' }); window.close(); });

    selectAllCb.addEventListener('change', () => {
      const isChecked = selectAllCb.checked;
      for (const item of allItems) {
        if (isChecked) selectedIds.add(item.uid); else selectedIds.delete(item.uid);
      }
      syncCheckboxes();
      updateSelectionCount();
      updateDownloadButton();
    });

    if (btnCollapseAll) {
      btnCollapseAll.addEventListener('click', () => {
        const groups = document.querySelectorAll('.section-group');
        const spanText = btnCollapseAll.querySelector('span');
        const isCollapsing = spanText.textContent === 'Collapse All';
        
        groups.forEach(g => {
          if (isCollapsing) g.classList.add('collapsed');
          else g.classList.remove('collapsed');
        });

        spanText.textContent = isCollapsing ? 'Expand All' : 'Collapse All';
        btnCollapseAll.querySelectorAll('span')[1].style.transform = isCollapsing ? 'none' : 'scaleY(-1)';
      });
    }

    btnDownload.addEventListener('click', startDownload);
    btnCancel.addEventListener('click', cancelDownload);
    btnNewDownload.addEventListener('click', async () => {
      if (chrome.storage && chrome.storage.session) try { await chrome.storage.session.remove('lastDownloadResult'); } catch (e) { }
      showState('loading');
      scanCurrentTab();
    });
    btnRetry.addEventListener('click', async () => {
      if (chrome.storage && chrome.storage.session) try { await chrome.storage.session.remove('lastDownloadResult'); } catch (e) { }
      showState('loading');
      scanCurrentTab();
    });

    toggleErrorsBtn.addEventListener('click', () => { $('errors-list').classList.toggle('hidden'); });
    if (toggleSuccessBtn) toggleSuccessBtn.addEventListener('click', () => { successList.classList.toggle('hidden'); });
    if (toggleFailedBtn) toggleFailedBtn.addEventListener('click', () => { failedList.classList.toggle('hidden'); });

    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'PROGRESS_UPDATE') {
        updateProgress(message.downloaded, message.skipped, message.total, message.currentFile, message.errors || []);
      } else if (message.type === 'STATE_CHANGE') {
        handleStateChange(message);
      }
    });

    const themeToggle = $('theme-toggle');
    if (themeToggle) {
      themeToggle.addEventListener('change', () => setTheme(themeToggle.checked));
    }
    keepStructureCb.addEventListener('change', () => { chrome.storage.local.set({ keepStructure: keepStructureCb.checked }); });
  }

  /* ═══════════════════════════════════════════════════════
   * DATA PROCESSING
   * ═══════════════════════════════════════════════════════ */

  function buildItemsList() {
    allItems = []; let uid = 0;
    for (const section of courseData.sections) {
      for (const item of section.items) {
        allItems.push({ uid: uid++, sectionId: section.id, sectionTitle: section.title, name: item.name, url: item.url, type: item.type, subFiles: [], scanningStatus: 'none' });
        selectedIds.add(allItems[allItems.length - 1].uid);
      }
    }
  }

  async function scanSubItems() {
    const targets = allItems.filter(item => (item.type === 'folder' || item.type === 'assign') && item.scanningStatus === 'none');
    if (targets.length === 0) return;
    const CONCURRENCY_LIMIT = 5;
    for (let i = 0; i < targets.length; i += CONCURRENCY_LIMIT) {
      const batch = targets.slice(i, i + CONCURRENCY_LIMIT);
      batch.forEach(item => item.scanningStatus = 'scanning');
      try {
        const response = await sendToBackground({ action: 'RESOLVE_RESOURCES', payload: { items: batch.map(item => ({ url: item.url, name: item.name, type: item.type })) } });
        if (response.success && response.results) {
          response.results.forEach((res, index) => {
            const item = batch[index];
            if (res.type === 'folder' || res.type === 'assign') { item.subFiles = res.files || []; item.scanningStatus = 'done'; } else item.scanningStatus = 'error';
          });
        } else batch.forEach(item => item.scanningStatus = 'error');
      } catch (err) { batch.forEach(item => item.scanningStatus = 'error'); }
    }
  }

  function flattenItems() {
    const newItems = []; let uid = 0;
    for (const item of allItems) {
      if (item.type === 'resource') { item.uid = uid++; newItems.push(item); }
      else if (item.type === 'folder' || item.type === 'assign') {
        if (item.subFiles && item.subFiles.length > 0) {
          for (const subFile of item.subFiles) {
            newItems.push({ uid: uid++, sectionId: item.sectionId, sectionTitle: item.sectionTitle, name: subFile.name, url: subFile.url, type: 'resource', parentFolder: item.name, alreadyDownloaded: false });
          }
        }
      }
    }
    allItems = newItems;
    selectedIds = new Set(allItems.map(i => i.uid));
  }

  async function enrichItemsWithStatus() {
    if (!courseData || allItems.length === 0) return;
    const itemsToCheck = allItems.map(item => ({ sectionTitle: item.sectionTitle, name: item.name, parentFolder: item.parentFolder || '' }));
    const response = await sendToBackground({ action: 'CHECK_ITEMS', payload: { courseName: courseData.courseName, items: itemsToCheck } });
    if (response.success && response.statuses) {
      response.statuses.forEach((isDownloaded, index) => {
        allItems[index].alreadyDownloaded = isDownloaded;
        if (isDownloaded) selectedIds.delete(allItems[index].uid);
      });
    }
  }

  /* ═══════════════════════════════════════════════════════
   * RENDERING
   * ═══════════════════════════════════════════════════════ */

  function renderCourseInfo() {
    courseNameEl.textContent = courseData.courseName;
    courseItemCount.textContent = `${allItems.length} downloadable items found`;
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

      // Auto-collapse if all items in this section are already downloaded
      const allDownloaded = sectionItems.every(item => item.alreadyDownloaded);
      if (allDownloaded) {
        group.classList.add('collapsed');
      }

      const header = document.createElement('div');
      header.className = 'section-header';
      header.innerHTML = `
        <label class="checkbox-wrapper section-checkbox-wrapper" style="margin:0;">
          <input type="checkbox" data-section-id="${section.id}" checked>
          <span class="checkmark"></span>
        </label>
        <span class="section-chevron">▼</span>
        <div class="section-title" dir="auto" title="${escapeHtml(section.title)}">${escapeHtml(section.title)}</div>
        <div class="section-count">${sectionItems.length}</div>
      `;

      header.addEventListener('click', (e) => {
        if (e.target.closest('.section-checkbox-wrapper')) return;
        group.classList.toggle('collapsed');
      });

      const sectionCb = header.querySelector('input[type="checkbox"]');
      sectionCb.addEventListener('change', () => {
        for (const item of sectionItems) {
          if (sectionCb.checked) selectedIds.add(item.uid); else selectedIds.delete(item.uid);
        }
        syncCheckboxes();
        updateSelectionCount();
        updateDownloadButton();
      });

      group.appendChild(header);
      const itemsContainer = document.createElement('div');
      itemsContainer.className = 'section-items';

      for (const item of sectionItems) {
        const row = document.createElement('div');
        row.className = 'item-row';

        const typeIcon = getTypeIcon(item.type);
        row.innerHTML = `
          <label class="checkbox-wrapper item-checkbox-wrapper" style="margin:0;">
            <input type="checkbox" data-uid="${item.uid}" ${item.alreadyDownloaded ? '' : 'checked'}>
            <span class="checkmark"></span>
          </label>
          ${typeIcon}
          <div class="item-name" dir="auto" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
          ${item.alreadyDownloaded ? `<div class="item-tag">DOWNLOADED</div>` : ''}
        `;

        const itemCb = row.querySelector('input[type="checkbox"]');
        itemCb.addEventListener('change', () => {
          if (itemCb.checked) selectedIds.add(item.uid); else selectedIds.delete(item.uid);
          syncCheckboxes();
          updateSelectionCount();
          updateDownloadButton();
        });

        row.addEventListener('click', (e) => {
          if (e.target.closest('.item-checkbox-wrapper')) return;
          itemCb.checked = !itemCb.checked;
          itemCb.dispatchEvent(new Event('change'));
        });

        itemsContainer.appendChild(row);
      }
      group.appendChild(itemsContainer);
      sectionsList.appendChild(group);
    }
  }

  function getTypeIcon(type) {
    const svgProps = 'width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin: 0 2px; flex-shrink: 0;"';
    const icons = {
      resource: `<svg ${svgProps} class="icon-resource"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
      folder: `<svg ${svgProps} class="icon-folder"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
      assign: `<svg ${svgProps} class="icon-assign"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>`,
      page: `<svg ${svgProps} class="icon-page"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
    };
    return icons[type] || icons.resource;
  }

  /* ═══════════════════════════════════════════════════════
   * CHECKBOX SYNCHRONIZATION
   * ═══════════════════════════════════════════════════════ */

  function syncCheckboxes() {
    if (!courseData || !courseData.sections) return;
    const itemCbs = sectionsList.querySelectorAll('input[data-uid]');
    for (const cb of itemCbs) cb.checked = selectedIds.has(parseInt(cb.dataset.uid, 10));

    for (const section of courseData.sections) {
      const sectionItems = allItems.filter(i => i.sectionId === section.id);
      const sectionCb = sectionsList.querySelector(`input[data-section-id="${section.id}"]`);
      if (!sectionCb) continue;

      const selectedCount = sectionItems.filter(i => selectedIds.has(i.uid)).length;
      if (selectedCount === 0) { sectionCb.checked = false; sectionCb.indeterminate = false; }
      else if (selectedCount === sectionItems.length) { sectionCb.checked = true; sectionCb.indeterminate = false; }
      else { sectionCb.checked = false; sectionCb.indeterminate = true; }
    }

    if (selectedIds.size === 0) { selectAllCb.checked = false; selectAllCb.indeterminate = false; }
    else if (selectedIds.size === allItems.length) { selectAllCb.checked = true; selectAllCb.indeterminate = false; }
    else { selectAllCb.checked = false; selectAllCb.indeterminate = true; }
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
    if (chrome.storage && chrome.storage.session) try { await chrome.storage.session.remove('lastDownloadResult'); } catch (e) { }

    const selectedItems = allItems.filter(item => selectedIds.has(item.uid)).map(item => ({
      sectionTitle: item.sectionTitle, name: item.name, url: item.url, type: item.type, parentFolder: item.parentFolder || '',
    }));

    showState('downloading');
    updateProgress(0, 0, selectedItems.length, 'Starting…', []);
    const response = await sendToBackground({
      action: 'START_DOWNLOAD',
      payload: { courseName: courseData.courseName, items: selectedItems, keepStructure: keepStructureCb.checked },
    });

    if (!response.success) showError('Download Error', response.error || 'Failed to start download.');
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
    if (currentFile) currentFileName.textContent = currentFile;
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
        showError('Session Expired', 'Your Moodle session has expired. Please refresh the Moodle page, log in, and try again.');
        break;
    }
  }

  /* ═══════════════════════════════════════════════════════
   * STATE MANAGEMENT & UTILS
   * ═══════════════════════════════════════════════════════ */

  function showState(name) {
    currentActiveState = name;
    const panels = [stateLoading, stateInvalid, stateSelection, stateDownloading, stateComplete, stateError];
    for (const p of panels) { if (p && p.classList) p.classList.remove('active'); }
    
    const map = { loading: stateLoading, invalid: stateInvalid, selection: stateSelection, downloading: stateDownloading, complete: stateComplete, error: stateError };
    if (map[name]) map[name].classList.add('active');
  }

  function showError(title, description) { errorTitle.textContent = title; errorDesc.textContent = description; showState('error'); }
  function sendToBackground(message) { return new Promise((resolve) => { chrome.runtime.sendMessage(message, (response) => { resolve(response || {}); }); }); }
  function escapeHtml(str) { const div = document.createElement('div'); div.textContent = str; return div.innerHTML; }
  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  /* ═══════════════════════════════════════════════════════
   * THEME & DB CACHE
   * ═══════════════════════════════════════════════════════ */

  async function initTheme() {
    const result = await chrome.storage.local.get(['darkMode']);
    const isDark = result.darkMode !== undefined ? result.darkMode : false;
    const themeToggle = $('theme-toggle');
    if (themeToggle) themeToggle.checked = isDark;
    if (isDark) document.body.classList.add('dark-mode'); else document.body.classList.remove('dark-mode');
  }

  function setTheme(isDark) {
    if (isDark) document.body.classList.add('dark-mode'); else document.body.classList.remove('dark-mode');
    chrome.storage.local.set({ darkMode: isDark });
  }

  async function getCourseFromDB(courseName) {
    const key = `db_v2_${courseName}`;
    const result = await chrome.storage.local.get(key);
    return result[key] || null;
  }

  async function saveCourseToDB(courseName, itemsArray, courseUrl = null) {
    const key = `db_v2_${courseName}`;
    const data = {};
    data[key] = {
      timestamp: Date.now(),
      items: itemsArray.map(item => ({ sectionId: item.sectionId, sectionTitle: item.sectionTitle, name: item.name, url: item.url, type: item.type, parentFolder: item.parentFolder }))
    };
    if (courseUrl) data[`url_${courseName}`] = courseUrl;
    await chrome.storage.local.set(data);
  }

  init();
})();