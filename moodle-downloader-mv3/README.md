# HUJI Moodle Downloader (Chrome Extension)

A Manifest V3 Chrome Extension designed to seamlessly bulk-download course materials from the Hebrew University of Jerusalem (HUJI) Moodle platform (v5.0.7).

## Why an Extension?
Unlike standalone desktop applications, this Chrome Extension runs entirely within your browser. This brings two massive advantages:
1. **Zero Authentication Friction**: It uses your active, authenticated browser session automatically. You do not need to enter your credentials or deal with 2FA inside the app.
2. **Security & Trust**: No third-party binaries handling your university passwords.

## Architecture Highlights
- **Content Script (`dom_parser.js`)**: Parses the DOM of the active Moodle course page to extract the section hierarchy and resource links.
- **Service Worker (`service_worker.js` & `download_manager.js`)**: Acts as the background engine. It manages a concurrent download queue (max 3 at a time) and handles retry logic for rate limits (HTTP 429).
- **Moodle API (`moodle_api.js`)**: Resolves Moodle's internal redirect links and extracts the actual file endpoints (via `pluginfile.php` or IFrames) using Regex without needing the DOM.
- **Popup UI**: A rich, dynamic interface that allows users to selectively download specific sections or files, showing real-time progress and errors.

## Installation Instructions (Developer Mode)

1. Open Google Chrome.
2. Navigate to `chrome://extensions/` in the address bar.
3. In the top right corner, toggle **Developer mode** to ON.
4. Click the **Load unpacked** button in the top left.
5. Select the `moodle-downloader-mv3` folder (the directory containing `manifest.json`).
6. The extension will now appear in your browser toolbar. Pin it for easy access!

## Usage
1. Log into HUJI Moodle.
2. Navigate to any Course Overview page.
3. Click the extension icon.
4. Select the files or sections you want to download.
5. Click **Download Selected**. Files will be saved directly to your default Chrome Downloads folder, neatly organized into `MoodleDownloads/[Course Name]/[Section Name]/` subdirectories.
