/**
 * dom_parser.js — Content Script for HUJI Moodle 5.0.7
 * * Runs in the context of the Moodle course page.
 * Parses the courseindex sidebar to extract the full section/item hierarchy.
 * * Responds to messages from the popup with the structured course data.
 */

(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════
   * MODULE TYPE CLASSIFICATION
   * ═══════════════════════════════════════════════════════ */

  const ALLOWED_TYPES = new Set([
    'resource',    // Single file (PDF, doc, etc.)
    'folder',      // Folder with multiple files
    'assign',      // Assignment (may have attached files)
  ]);

  const BLOCKED_TYPES = new Set([
    'page', 'forum', 'forumng', 'quiz', 'url', 'lti', 'choice', 'feedback',
    'glossary', 'wiki', 'workshop', 'chat', 'survey', 'lesson', 'scorm',
    'data', 'h5pactivity', 'label', 'checklist', 'ojtnotebook',
  ]);

  /* ═══════════════════════════════════════════════════════
   * URL PARSING UTILITIES
   * ═══════════════════════════════════════════════════════ */

  function getModuleType(href) {
    if (!href) return null;
    try {
      const url = new URL(href, window.location.origin);
      const match = url.pathname.match(/\/mod\/([a-zA-Z0-9_]+)\//);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  function isDownloadable(modType) {
    if (!modType) return false;
    if (BLOCKED_TYPES.has(modType)) return false;
    if (ALLOWED_TYPES.has(modType)) return true;
    return false;
  }

  /* ═══════════════════════════════════════════════════════
   * COURSE NAME EXTRACTION (Polished)
   * ═══════════════════════════════════════════════════════ */

  function extractCourseName() {
    const titleTag = document.querySelector('title');
    if (titleTag) {
      const titleText = titleTag.textContent.trim();
      const pipeIdx = titleText.indexOf('|');
      let name = pipeIdx > 0 ? titleText.substring(0, pipeIdx).trim() : titleText;

      // הסרת קידומות בעברית ובאנגלית
      name = name.replace(/^(Course\s*(activities)?|קורס)\s*:\s*/i, '').trim();

      // זיהוי תבנית של "מספר - שם" והיפוך ל-"שם | מספר"
      const match = name.match(/^(\d+)\s*[-:]\s*(.+)$/);
      if (match) {
        name = `${match[2].trim()} | ${match[1]}`;
      }

      if (name.length > 0) return name;
    }

    const headerEl = document.querySelector('.page-header-headings h1, .coursename, [data-region="courseheader"] h1');
    if (headerEl) return headerEl.textContent.trim();

    const breadcrumbs = document.querySelectorAll('.breadcrumb-item a, .breadcrumb li a');
    for (const bc of breadcrumbs) {
      const href = bc.getAttribute('href') || '';
      if (href.includes('/course/view.php') || href.includes('/course/overview.php')) {
        return bc.textContent.trim();
      }
    }

    return 'Moodle Course';
  }

  /* ═══════════════════════════════════════════════════════
   * COURSE INDEX PARSER
   * ═══════════════════════════════════════════════════════ */

  function parseCourseIndex() {
    const result = {
      courseName: extractCourseName(),
      courseUrl: window.location.href,
      baseUrl: window.location.origin + window.location.pathname.replace(/\/[^/]*$/, ''),
      sections: [],
    };

    const sectionEls = document.querySelectorAll('.courseindex-section, [data-for="section"]');

    if (sectionEls.length === 0) {
      return parseMainContent(result);
    }

    for (const sectionEl of sectionEls) {
      try {
        const sectionData = parseSection(sectionEl);
        if (sectionData && sectionData.items.length > 0) {
          result.sections.push(sectionData);
        }
      } catch (err) {
        console.warn('[MoodleDL] Failed to parse section:', err);
      }
    }

    return result;
  }

  function parseSection(sectionEl) {
    const sectionId = sectionEl.getAttribute('data-id') || sectionEl.id || '';
    let title = '';
    const titleLink = sectionEl.querySelector(
      'a.courseindex-link[data-for="section_title"], ' +
      '.courseindex-section-title a.courseindex-link'
    );
    if (titleLink) {
      title = titleLink.textContent.trim();
    }

    if (!title) {
      const sectionItemDiv = sectionEl.querySelector('.courseindex-section-title, [data-for="section_item"]');
      if (sectionItemDiv) title = sectionItemDiv.textContent.trim();
    }

    if (!title) title = `Section ${sectionId}`;

    const items = [];
    const itemEls = sectionEl.querySelectorAll(
      '.courseindex-item[data-for="cm"], li.courseindex-item[data-for="cm"]'
    );

    for (const itemEl of itemEls) {
      try {
        const item = parseItem(itemEl);
        if (item) items.push(item);
      } catch (err) {
        console.warn('[MoodleDL] Failed to parse item:', err);
      }
    }

    return {
      id: sectionId,
      title: sanitizeFilename(title),
      items,
    };
  }

  function parseItem(itemEl) {
    const cmId = itemEl.getAttribute('data-id') || '';
    const link = itemEl.querySelector('a.courseindex-link[data-for="cm_name"], a.courseindex-link');
    if (!link) return null;

    const href = link.getAttribute('href');
    if (!href) return null;

    const name = link.textContent.trim();
    if (!name) return null;

    const modType = getModuleType(href);
    if (!isDownloadable(modType)) return null;

    let absoluteUrl = href;
    try { absoluteUrl = new URL(href, window.location.origin).href; } catch { }

    return {
      id: cmId,
      name: sanitizeFilename(name),
      url: absoluteUrl,
      type: modType,
    };
  }

  function parseMainContent(result) {
    const activityLinks = document.querySelectorAll(
      '.activity-item a[href*="/mod/"], .activityname a[href*="/mod/"], #region-main a[href*="/mod/"]'
    );

    if (activityLinks.length === 0) return result;

    const generalSection = { id: 'main', title: 'Course Materials', items: [] };
    const seenUrls = new Set();

    for (const link of activityLinks) {
      try {
        const href = link.getAttribute('href');
        if (!href || seenUrls.has(href)) continue;

        const modType = getModuleType(href);
        if (!isDownloadable(modType)) continue;

        seenUrls.add(href);
        let absoluteUrl = href;
        try { absoluteUrl = new URL(href, window.location.origin).href; } catch { }

        const name = link.textContent.trim() || 'Untitled';

        generalSection.items.push({
          id: '',
          name: sanitizeFilename(name),
          url: absoluteUrl,
          type: modType,
        });
      } catch { }
    }

    if (generalSection.items.length > 0) result.sections.push(generalSection);
    return result;
  }

  /* ═══════════════════════════════════════════════════════
   * FILENAME SANITIZATION
   * ═══════════════════════════════════════════════════════ */

  function sanitizeFilename(name) {
    if (!name) return 'Untitled';
    return name
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^\s+|\s+$/g, '')
      .replace(/\.+$/, '')
      .substring(0, 200);
  }

  /* ═══════════════════════════════════════════════════════
   * MOODLE PAGE DETECTION
   * ═══════════════════════════════════════════════════════ */

  function isMoodleCoursePage() {
    const validDomains = ['moodle.huji.ac.il', 'moodle4.cs.huji.ac.il'];
    if (!validDomains.includes(window.location.hostname)) return false;

    const path = window.location.pathname;
    const isCourseViewPage = path.includes('/course/view.php') || path.includes('/course/overview.php') || path.includes('/course/section.php');
    const hasCourseIndex = document.querySelector('.courseindex-section, [data-for="section"], #courseindex') !== null;
    const hasCourseClass = /course-\d+/.test(document.body.className || '');

    return isCourseViewPage || (hasCourseIndex && hasCourseClass);
  }

  /* ═══════════════════════════════════════════════════════
   * MESSAGE LISTENER
   * ═══════════════════════════════════════════════════════ */

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'PARSE_COURSE') {
      try {
        if (!isMoodleCoursePage()) {
          sendResponse({ success: false, error: 'NOT_MOODLE_PAGE', data: null });
          return true;
        }
        sendResponse({ success: true, error: null, data: parseCourseIndex() });
      } catch (err) {
        sendResponse({ success: false, error: err.message || 'Unknown parsing error', data: null });
      }
      return true;
    }
  });

})();