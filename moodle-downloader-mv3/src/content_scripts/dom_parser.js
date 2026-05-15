/**
 * dom_parser.js — Content Script for HUJI Moodle 5.0.7
 * 
 * Runs in the context of the Moodle course page.
 * Parses the courseindex sidebar to extract the full section/item hierarchy.
 * 
 * Responds to messages from the popup with the structured course data.
 */

(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════
   *  MODULE TYPE CLASSIFICATION
   * ═══════════════════════════════════════════════════════ */

  /** 
   * Map of allowed module types to download.
   * Key = the segment that appears after /mod/ in the URL path.
   */
  const ALLOWED_TYPES = new Set([
    'resource',    // Single file (PDF, doc, etc.)
    'folder',      // Folder with multiple files
    'assign',      // Assignment (may have attached files)
  ]);

  /** 
   * Module types to explicitly skip (never download).
   */
  const BLOCKED_TYPES = new Set([
    'page',        // Page content
    'forum',
    'forumng',
    'quiz',
    'url',
    'lti',
    'choice',
    'feedback',
    'glossary',
    'wiki',
    'workshop',
    'chat',
    'survey',
    'lesson',
    'scorm',
    'data',
    'h5pactivity',
    'label',
    'checklist',
    'ojtnotebook',
  ]);

  /* ═══════════════════════════════════════════════════════
   *  URL PARSING UTILITIES
   * ═══════════════════════════════════════════════════════ */

  /**
   * Extract the module type from a Moodle URL.
   * e.g., "/mod/resource/view.php?id=86201" → "resource"
   */
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

  /**
   * Determine if a module type is downloadable.
   */
  function isDownloadable(modType) {
    if (!modType) return false;
    if (BLOCKED_TYPES.has(modType)) return false;
    if (ALLOWED_TYPES.has(modType)) return true;
    // Unknown type — skip to be safe
    return false;
  }

  /* ═══════════════════════════════════════════════════════
   *  COURSE NAME EXTRACTION
   * ═══════════════════════════════════════════════════════ */

  /**
   * Extract the course name from the page.
   * Tries multiple selectors in order of specificity.
   */
  function extractCourseName() {
    // Strategy 1: The page title often has "Course Name | HUJI ..."
    const titleTag = document.querySelector('title');
    if (titleTag) {
      const titleText = titleTag.textContent.trim();
      // Format: "Course activities: 52221 - Course Name | ..."
      // or "Course: 52221 - Course Name | ..."
      const pipeIdx = titleText.indexOf('|');
      let name = pipeIdx > 0 ? titleText.substring(0, pipeIdx).trim() : titleText;
      // Remove "Course activities:" or "Course:" prefix
      name = name.replace(/^Course\s*(activities)?\s*:\s*/i, '').trim();
      if (name.length > 0) return name;
    }

    // Strategy 2: Look for the course header in the page
    const headerEl = document.querySelector('.page-header-headings h1, .coursename, [data-region="courseheader"] h1');
    if (headerEl) {
      return headerEl.textContent.trim();
    }

    // Strategy 3: Check the breadcrumb
    const breadcrumbs = document.querySelectorAll('.breadcrumb-item a, .breadcrumb li a');
    for (const bc of breadcrumbs) {
      const href = bc.getAttribute('href') || '';
      if (href.includes('/course/view.php') || href.includes('/course/overview.php')) {
        return bc.textContent.trim();
      }
    }

    // Strategy 4: M.cfg.courseId — check if we can read it from the page config
    // Fall back to a generic name
    return 'Moodle Course';
  }

  /* ═══════════════════════════════════════════════════════
   *  COURSE INDEX PARSER (Main Logic)
   * ═══════════════════════════════════════════════════════ */

  /**
   * Parse the Moodle 5.0.7 courseindex sidebar to build a structured
   * array of sections and items.
   * 
   * Returns: {
   *   courseName: string,
   *   baseUrl: string,
   *   sections: [{
   *     id: string,
   *     title: string,
   *     items: [{
   *       id: string,
   *       name: string,
   *       url: string,
   *       type: string    // 'resource' | 'folder' | 'assign' | 'page'
   *     }]
   *   }]
   * }
   */
  function parseCourseIndex() {
    const result = {
      courseName: extractCourseName(),
      courseUrl: window.location.href,
      baseUrl: window.location.origin + window.location.pathname.replace(/\/[^/]*$/, ''),
      sections: [],
    };

    // The courseindex sidebar lives inside a <nav id="courseindex"> or similar
    // Each section is: div.courseindex-section[data-for="section"]
    const sectionEls = document.querySelectorAll('.courseindex-section, [data-for="section"]');

    if (sectionEls.length === 0) {
      // Fallback: Try the main content area for course page formats
      // that don't use the sidebar (e.g., single-section view)
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

  /**
   * Parse a single courseindex section element.
   */
  function parseSection(sectionEl) {
    const sectionId = sectionEl.getAttribute('data-id') || sectionEl.id || '';

    // Section title: look for .courseindex-link[data-for="section_title"]
    // or .courseindex-section-title a.courseindex-link
    let title = '';
    const titleLink = sectionEl.querySelector(
      'a.courseindex-link[data-for="section_title"], ' +
      '.courseindex-section-title a.courseindex-link'
    );
    if (titleLink) {
      title = titleLink.textContent.trim();
    }

    // If no title found, try the section item div text
    if (!title) {
      const sectionItemDiv = sectionEl.querySelector('.courseindex-section-title, [data-for="section_item"]');
      if (sectionItemDiv) {
        // Get direct text content, excluding child elements' text where possible
        title = sectionItemDiv.textContent.trim();
      }
    }

    if (!title) {
      title = `Section ${sectionId}`;
    }

    // Parse course module items inside this section
    const items = [];
    const itemEls = sectionEl.querySelectorAll(
      '.courseindex-item[data-for="cm"], ' +
      'li.courseindex-item[data-for="cm"]'
    );

    for (const itemEl of itemEls) {
      try {
        const item = parseItem(itemEl);
        if (item) {
          items.push(item);
        }
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

  /**
   * Parse a single course module item.
   */
  function parseItem(itemEl) {
    const cmId = itemEl.getAttribute('data-id') || '';

    // The item link: a.courseindex-link[data-for="cm_name"]
    const link = itemEl.querySelector('a.courseindex-link[data-for="cm_name"], a.courseindex-link');
    if (!link) return null;

    const href = link.getAttribute('href');
    if (!href) return null;

    const name = link.textContent.trim();
    if (!name) return null;

    // Determine module type from URL
    const modType = getModuleType(href);
    if (!isDownloadable(modType)) return null;

    // Normalize the URL to absolute
    let absoluteUrl = href;
    try {
      absoluteUrl = new URL(href, window.location.origin).href;
    } catch {
      // Leave as-is if URL parsing fails
    }

    return {
      id: cmId,
      name: sanitizeFilename(name),
      url: absoluteUrl,
      type: modType,
    };
  }

  /**
   * Fallback parser: scans the main content area if the courseindex
   * sidebar is not available.
   */
  function parseMainContent(result) {
    // Look for activity links in the main content
    const activityLinks = document.querySelectorAll(
      '.activity-item a[href*="/mod/"], ' +
      '.activityname a[href*="/mod/"], ' +
      '#region-main a[href*="/mod/"]'
    );

    if (activityLinks.length === 0) return result;

    const generalSection = {
      id: 'main',
      title: 'Course Materials',
      items: [],
    };

    const seenUrls = new Set();

    for (const link of activityLinks) {
      try {
        const href = link.getAttribute('href');
        if (!href || seenUrls.has(href)) continue;

        const modType = getModuleType(href);
        if (!isDownloadable(modType)) continue;

        seenUrls.add(href);

        let absoluteUrl = href;
        try {
          absoluteUrl = new URL(href, window.location.origin).href;
        } catch { /* */ }

        const name = link.textContent.trim() || 'Untitled';

        generalSection.items.push({
          id: '',
          name: sanitizeFilename(name),
          url: absoluteUrl,
          type: modType,
        });
      } catch {
        // Skip individual link errors
      }
    }

    if (generalSection.items.length > 0) {
      result.sections.push(generalSection);
    }

    return result;
  }

  /* ═══════════════════════════════════════════════════════
   *  FILENAME SANITIZATION
   * ═══════════════════════════════════════════════════════ */

  /**
   * Remove illegal Windows/Mac filename characters and normalize whitespace.
   */
  function sanitizeFilename(name) {
    if (!name) return 'Untitled';
    return name
      .replace(/[\\/:*?"<>|]/g, '')   // Strip illegal chars
      .replace(/\s+/g, ' ')           // Normalize whitespace
      .replace(/^\s+|\s+$/g, '')      // Trim
      .replace(/\.+$/, '')            // Remove trailing dots
      .substring(0, 200);             // Cap length
  }

  /* ═══════════════════════════════════════════════════════
   *  MOODLE PAGE DETECTION
   * ═══════════════════════════════════════════════════════ */

  /**
   * Check whether the current page is a valid HUJI Moodle course page.
   */
  function isMoodleCoursePage() {
    const url = window.location.href;

    // Must be on the HUJI Moodle domain
    const validDomains = [
      'moodle.huji.ac.il',
      'moodle4.cs.huji.ac.il',
    ];

    const hostname = window.location.hostname;
    if (!validDomains.includes(hostname)) return false;

    // Must be a course page: /course/view.php, /course/overview.php, or /mod/ page
    const path = window.location.pathname;
    const isCourseViewPage =
      path.includes('/course/view.php') ||
      path.includes('/course/overview.php') ||
      path.includes('/course/section.php');

    // Also consider if the courseindex is present (mod pages also have it)
    const hasCourseIndex = document.querySelector('.courseindex-section, [data-for="section"], #courseindex') !== null;

    // Check the body class for course context
    const bodyClass = document.body.className || '';
    const hasCourseClass = /course-\d+/.test(bodyClass);

    return isCourseViewPage || (hasCourseIndex && hasCourseClass);
  }

  /* ═══════════════════════════════════════════════════════
   *  MESSAGE LISTENER
   * ═══════════════════════════════════════════════════════ */

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'PARSE_COURSE') {
      try {
        if (!isMoodleCoursePage()) {
          sendResponse({
            success: false,
            error: 'NOT_MOODLE_PAGE',
            data: null,
          });
          return true;
        }

        const courseData = parseCourseIndex();
        sendResponse({
          success: true,
          error: null,
          data: courseData,
        });
      } catch (err) {
        console.error('[MoodleDL] Parse error:', err);
        sendResponse({
          success: false,
          error: err.message || 'Unknown parsing error',
          data: null,
        });
      }
      return true; // Keep the message channel open for async response
    }
  });

})();
