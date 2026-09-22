/* ============ version.js — the one place the release number lives ============
 *
 * Bump this on every release. Home shows it (so what a device has actually
 * loaded is never a guess — the offline shell cache runs one reload behind a
 * deploy), the service worker names its cache after it, and Home compares it
 * against the live copy of this file to offer a one-tap reload when a newer
 * build is deployed.
 *
 * Date-based: YYYY.MM.DD, with a letter suffix for a second release on the
 * same day (2026.09.22b).
 */
'use strict';

const APP_VERSION = '2026.09.23c';
