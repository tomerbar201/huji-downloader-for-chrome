/**
 * moodle_api.js — Moodle URL Resolution Engine
 * 
 * Runs inside the MV3 Service Worker.
 * Responsible for:
 * 1. Fetching Moodle resource URLs.
 * 2. Detecting whether the response is a direct download or an HTML wrapper.
 * 3. Extracting the real file URL from HTML wrappers (iframe, pluginfile links).
 * 4. Handling Moodle folder pages (extracting all file links).
 * 5. Detecting session expiry.
 */

/* ═══════════════════════════════════════════════════════
 *  CONSTANTS
 * ═══════════════════════════════════════════════════════ */

/** Binary/downloadable content types that indicate a direct file stream. */
const BINARY_CONTENT_TYPES = [
  'application/pdf',
  'application/zip',
  'application/x-zip-compressed',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats',
  'application/msword',
  'application/vnd.ms-powerpoint',
  'application/octet-stream',
  'image/',
  'audio/',
  'video/',
  'text/plain',
  'text/csv',
  'application/x-rar',
  'application/gzip',
  'application/x-tar',
  'application/x-7z-compressed',
];

/* ═══════════════════════════════════════════════════════
 *  SESSION DETECTION
 * ═══════════════════════════════════════════════════════ */

/**
 * Check if HTML content is actually the Moodle login page.
 * This means the session has expired.
 */
function isLoginPage(html) {
  // Moodle login page typically has these markers
  const markers = [
    'login/index.php',
    'id="login"',
    'loginform',
    'username',
    'password',
  ];
  const htmlLower = html.toLowerCase();
  let matchCount = 0;
  for (const marker of markers) {
    if (htmlLower.includes(marker)) matchCount++;
  }
  // If 3+ markers match, it's almost certainly the login page
  return matchCount >= 3;
}

/* ═══════════════════════════════════════════════════════
 *  URL EXTRACTION FROM HTML (Regex-based for Service Worker)
 * ═══════════════════════════════════════════════════════ */

/**
 * Extract the file URL from an HTML page returned by a /mod/resource/ endpoint.
 * 
 * Strategy 1: Find <iframe id="resourceobject" src="...">
 * Strategy 2: Find any <a> or <object> with a pluginfile.php URL
 * Strategy 3: Find forcedownload links
 */
function extractFileUrlFromHtml(html, baseUrl) {
  // Strategy 1: iframe with id="resourceobject"
  const iframeRegex = /<iframe[^>]+id\s*=\s*["']resourceobject["'][^>]+src\s*=\s*["']([^"']+)["']/i;
  const iframeMatch = html.match(iframeRegex);
  if (iframeMatch && iframeMatch[1]) {
    return resolveUrl(decodeHtmlEntities(iframeMatch[1]), baseUrl);
  }

  // Also try: src before id
  const iframeRegex2 = /<iframe[^>]+src\s*=\s*["']([^"']+)["'][^>]+id\s*=\s*["']resourceobject["']/i;
  const iframeMatch2 = html.match(iframeRegex2);
  if (iframeMatch2 && iframeMatch2[1]) {
    return resolveUrl(decodeHtmlEntities(iframeMatch2[1]), baseUrl);
  }

  // Strategy 2: Look for <object> tag with data attribute containing pluginfile.php
  const objectRegex = /<object[^>]+data\s*=\s*["']([^"']*pluginfile\.php[^"']*)["']/i;
  const objectMatch = html.match(objectRegex);
  if (objectMatch && objectMatch[1]) {
    return resolveUrl(decodeHtmlEntities(objectMatch[1]), baseUrl);
  }

  // Strategy 3: Look for <embed> tag with src containing pluginfile.php
  const embedRegex = /<embed[^>]+src\s*=\s*["']([^"']*pluginfile\.php[^"']*)["']/i;
  const embedMatch = html.match(embedRegex);
  if (embedMatch && embedMatch[1]) {
    return resolveUrl(decodeHtmlEntities(embedMatch[1]), baseUrl);
  }

  // Strategy 4: Any <a> link with pluginfile.php and forcedownload
  const forceDownloadRegex = /<a[^>]+href\s*=\s*["']([^"']*pluginfile\.php[^"']*forcedownload[^"']*)["']/gi;
  const fdMatch = forceDownloadRegex.exec(html);
  if (fdMatch && fdMatch[1]) {
    return resolveUrl(decodeHtmlEntities(fdMatch[1]), baseUrl);
  }

  // Strategy 5: Any <a> link containing pluginfile.php (generic fallback)
  const pluginfileRegex = /<a[^>]+href\s*=\s*["']([^"']*pluginfile\.php[^"']*)["']/gi;
  const pfMatch = pluginfileRegex.exec(html);
  if (pfMatch && pfMatch[1]) {
    return resolveUrl(decodeHtmlEntities(pfMatch[1]), baseUrl);
  }

  return null;
}

/**
 * Extract all file URLs from a Moodle folder page.
 */
function extractFolderFiles(html, baseUrl) {
  const files = [];
  const seenUrls = new Set();

  const regex = /<a[^>]+href\s*=\s*["']([^"']*pluginfile\.php[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const rawUrl = decodeHtmlEntities(match[1]);
    const rawName = match[2].replace(/<[^>]*>/g, '').trim();

    const absoluteUrl = resolveUrl(rawUrl, baseUrl);

    if (!seenUrls.has(absoluteUrl) && rawName) {
      seenUrls.add(absoluteUrl);
      files.push({
        name: sanitizeFilename(rawName),
        url: absoluteUrl,
      });
    }
  }
  return files;
}

/**
 * Extract file URLs from an assignment page.
 */
function extractAssignmentFiles(html, baseUrl) {
  const files = [];
  const seenUrls = new Set();

  const regex = /<a[^>]+href\s*=\s*["']([^"']*pluginfile\.php[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const rawUrl = decodeHtmlEntities(match[1]);
    const rawName = match[2].replace(/<[^>]*>/g, '').trim();

    const absoluteUrl = resolveUrl(rawUrl, baseUrl);

    if (!seenUrls.has(absoluteUrl) && rawName) {
      seenUrls.add(absoluteUrl);
      files.push({
        name: sanitizeFilename(rawName),
        url: absoluteUrl,
      });
    }
  }
  return files;
}

/* ═══════════════════════════════════════════════════════
 *  RESOLVE & FETCH
 * ═══════════════════════════════════════════════════════ */

/**
 * Main resolution function.
 */
export async function resolveResource(url, itemName, itemType) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      redirect: 'follow',
    });

    if (!response.ok) {
      if (response.status === 429) {
        return { type: 'rate_limited', files: [], error: '429 Too Many Requests' };
      }
      return { type: 'error', files: [], error: `HTTP ${response.status}` };
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();

    // Check if the response is a direct binary download
    if (isDirectDownload(contentType, response)) {
      const fileName = extractFilenameFromHeaders(response, itemName);
      return {
        type: 'direct',
        files: [{ name: fileName, url: response.url }],
        error: null,
      };
    }

    // It's HTML — parse it
    const html = await response.text();

    if (isLoginPage(html)) {
      return { type: 'error', files: [], error: 'SESSION_EXPIRED' };
    }

    if (itemType === 'folder') {
      const folderFiles = extractFolderFiles(html, url);
      if (folderFiles.length > 0) {
        return { type: 'folder', files: folderFiles, error: null };
      }
      return { type: 'skipped', files: [], error: 'No files found in folder' };
    }

    if (itemType === 'assign') {
      const assignFiles = extractAssignmentFiles(html, url);
      if (assignFiles.length > 0) {
        return { type: 'assign', files: assignFiles, error: null };
      }
      return { type: 'skipped', files: [], error: 'No downloadable files in assignment' };
    }

    // For resource and page types, extract single file URL
    const fileUrl = extractFileUrlFromHtml(html, url);
    if (fileUrl) {
      let finalName = sanitizeFilename(itemName);
      const ext = getExtensionFromUrl(fileUrl);

      // If the pluginfile URL has an extension, and our UI name doesn't already end with it, append it
      if (ext && !finalName.toLowerCase().endsWith(ext.toLowerCase())) {
        finalName += ext;
      }

      return {
        type: 'resolved',
        files: [{ name: finalName, url: fileUrl }],
        error: null,
      };
    }

    if (itemType === 'page') {
      return { type: 'skipped', files: [], error: 'Page content (no file to download)' };
    }

    return { type: 'skipped', files: [], error: 'Could not extract file URL from page' };

  } catch (err) {
    return { type: 'error', files: [], error: err.message || 'Fetch failed' };
  }
}

/* ═══════════════════════════════════════════════════════
 *  HELPER FUNCTIONS
 * ═══════════════════════════════════════════════════════ */

/**
 * Determine if a response is a direct binary download.
 */
function isDirectDownload(contentType, response) {
  const disposition = response.headers.get('content-disposition');
  if (disposition && disposition.includes('attachment')) {
    return true;
  }

  for (const binType of BINARY_CONTENT_TYPES) {
    if (contentType.includes(binType)) {
      return true;
    }
  }

  return false;
}

/**
 * Extract the file extension from the server (headers or URL),
 * and always attach it to the Moodle UI name (fallbackName).
 */
function extractFilenameFromHeaders(response, fallbackName) {
  const disposition = response.headers.get('content-disposition');
  let serverFilename = '';

  if (disposition) {
    const utf8Match = disposition.match(/filename\*\s*=\s*UTF-8''([^;\s]+)/i);
    if (utf8Match) {
      try {
        serverFilename = decodeURIComponent(utf8Match[1]);
      } catch { /* fall through */ }
    }

    if (!serverFilename) {
      const quotedMatch = disposition.match(/filename\s*=\s*"([^"]+)"/i);
      if (quotedMatch) serverFilename = quotedMatch[1];
    }

    if (!serverFilename) {
      const unquotedMatch = disposition.match(/filename\s*=\s*([^;\s]+)/i);
      if (unquotedMatch) serverFilename = unquotedMatch[1];
    }
  }

  if (!serverFilename) {
    try {
      const urlObj = new URL(response.url);
      const pathParts = urlObj.pathname.split('/');
      serverFilename = decodeURIComponent(pathParts[pathParts.length - 1]);
    } catch { /* fall through */ }
  }

  let ext = '';
  if (serverFilename) {
    const extMatch = serverFilename.match(/\.([0-9a-z]+)$/i);
    if (extMatch) {
      ext = extMatch[0];
    }
  }

  const cleanFallback = sanitizeFilename(fallbackName);

  if (!ext) {
    return cleanFallback;
  }

  if (cleanFallback.toLowerCase().endsWith(ext.toLowerCase())) {
    return cleanFallback;
  }

  return cleanFallback + ext;
}

/**
 * Extract file extension directly from a URL's pathname.
 */
function getExtensionFromUrl(urlStr) {
  try {
    const urlObj = new URL(urlStr);
    const pathParts = urlObj.pathname.split('/');
    const lastPart = decodeURIComponent(pathParts[pathParts.length - 1]);

    // Look for a standard file extension pattern at the end of the filename
    const extMatch = lastPart.match(/\.([0-9a-z]+)$/i);
    if (extMatch) {
      return extMatch[0];
    }
  } catch {
    // Return empty if URL is invalid or parsing fails
  }
  return '';
}

/**
 * Resolve a potentially relative URL to an absolute URL.
 */
function resolveUrl(url, base) {
  if (!url) return '';
  try {
    url = url.replace(/&amp;/g, '&');
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

/**
 * Decode common HTML entities in URLs.
 */
function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/');
}

/**
 * Remove illegal filename characters.
 */
function sanitizeFilename(name) {
  if (!name) return 'Untitled';
  return name
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '')
    .substring(0, 200) || 'Untitled';
}