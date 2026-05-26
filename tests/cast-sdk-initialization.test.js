const fs = require('fs');
const assert = require('assert');

const indexHtml = fs.readFileSync('public/index.html', 'utf8');
const castJs = fs.readFileSync('public/js/modules/cast.js', 'utf8');
const mainJs = fs.readFileSync('public/js/main.js', 'utf8');
const playerJs = fs.readFileSync('public/js/modules/player.js', 'utf8');

function indexOfOrFail(haystack, needle, message) {
  const index = haystack.indexOf(needle);
  assert(index !== -1, message || `Expected to find ${needle}`);
  return index;
}

const callbackIndex = indexOfOrFail(indexHtml, 'window.__onGCastApiAvailable', 'index.html must define the Cast SDK callback before loading the SDK');
const sdkIndex = indexOfOrFail(indexHtml, 'cast_sender.js?loadCastFramework=1', 'index.html must load the Google Cast sender SDK');

assert(
  callbackIndex < sdkIndex,
  'The Google Cast sender callback must be defined before cast_sender.js loads; otherwise the SDK can finish before cast.js registers the callback and CastContext options are never set'
);

assert(
  indexHtml.includes('window.__viniplayInitializeCastApi'),
  'index.html should bridge the early Cast SDK callback to the module initializer'
);

assert(
  castJs.includes('window.__viniplayInitializeCastApi'),
  'cast.js should expose a module initializer for the early Cast SDK callback to call once the module is loaded'
);

assert(
  castJs.includes('window.__viniplayCastSdkReady') && castJs.includes('window.__viniplayCastSdkResolved'),
  'cast.js should handle the case where the SDK callback fired before the module loaded'
);

assert(
  castJs.includes('CAST_INITIALIZATION_RETRY_DELAY_MS') && castJs.includes('setTimeout') && castJs.includes('castState.initializationAttempts'),
  'cast.js should retry CastContext initialization when the SDK callback fires before Cast framework globals are ready'
);

assert(
  castJs.includes('CAST_INITIALIZATION_MAX_ATTEMPTS') && castJs.includes('Cast SDK loaded, but Cast framework globals did not become available'),
  'cast.js should eventually expose a diagnostic error instead of leaving Cast permanently "still initializing"'
);

assert(
  mainJs.includes('./modules/player.js?v=19'),
  'main.js must deep-cache-bust player.js after Cast availability handling changes'
);

assert(
  playerJs.includes('./cast.js?v=19'),
  'player.js must deep-cache-bust cast.js after Cast availability handling changes'
);

assert(
  indexHtml.includes('<button id="cast-btn"') && indexHtml.includes('data-icon="cast"'),
  'index.html should keep a visible custom Cast icon; google-cast-launcher can hide itself through SDK visibility management'
);

assert(
  !indexHtml.includes('<google-cast-launcher id="cast-btn"'),
  'the visible #cast-btn should not be google-cast-launcher because the framework may hide it when device discovery is unavailable'
);

assert(
  playerJs.includes('Visible cast button clicked. Requesting session synchronously') &&
  playerJs.includes('CastContext.getInstance().requestSession()'),
  'player.js should request the Cast session directly from the visible button click handler'
);

const requestSessionIndex = indexOfOrFail(playerJs, 'CastContext.getInstance().requestSession()', 'player.js should request a Cast session from the visible button');
const noDevicesDiagnosticIndex = indexOfOrFail(playerJs, "castReportsNoDevices", 'player.js should retain NO_DEVICES_AVAILABLE diagnostics');
assert(
  castJs.includes('CAST_STATE_CHANGED') &&
  castJs.includes('castAvailability') &&
  playerJs.includes('but still calling requestSession') &&
  !playerJs.includes('Chrome is not detecting any Cast devices'),
  'Cast diagnostics may record NO_DEVICES_AVAILABLE, but the visible Cast button must still call requestSession because Chrome native Cast discovery can see devices while the Web Sender availability event reports NO_DEVICES_AVAILABLE'
);

assert(
  requestSessionIndex < noDevicesDiagnosticIndex,
  'requestSession() should happen before NO_DEVICES_AVAILABLE logging so nothing between the user click and Cast picker launch can interfere with Chrome transient activation'
);

assert(
  playerJs.includes('castState.isInitialized'),
  'Cast button click should guard against using CastContext before setOptions initialization completes'
);

assert(
  castJs.includes('window.isSecureContext') && castJs.includes('Google Cast requires HTTPS') && castJs.includes('localhost'),
  'cast.js should diagnose insecure-origin Cast unavailability instead of treating it as a generic initialization race'
);

assert(
  castJs.includes('getCastBrowserDiagnostic') &&
  castJs.includes('Chrome, Edge, or another Cast-supported Chromium browser') &&
  castJs.includes('navigator.userAgent') &&
  playerJs.includes('browserDiagnostic'),
  'Cast SDK unavailable diagnostics should explain unsupported browsers/sessions such as Safari, Firefox, iOS Chrome, or in-app browsers'
);

assert(
  castJs.includes('export function recoverCastSdkFromGlobals') &&
  castJs.includes('Cast SDK callback did not mark availability, but framework globals are present') &&
  playerJs.includes('recoverCastSdkFromGlobals()'),
  'Cast button click should recover when Chrome exposes Cast framework globals but __onGCastApiAvailable did not mark the SDK available'
);

assert(
  playerJs.includes('!castState.isAvailable') && playerJs.includes('Cast is unavailable') && playerJs.includes('castState.initializationError'),
  'Cast button click should report SDK unavailability/secure-origin diagnostics instead of always saying Cast is still initializing'
);

assert(
  castJs.includes('export function getCastOriginDiagnostic') &&
  playerJs.includes('getCastOriginDiagnostic') &&
  playerJs.includes('Cast session request blocked because the page is not running in a Cast-supported secure context'),
  'Cast button click should block requestSession with an HTTPS/localhost diagnostic before Chrome returns a generic session_error on insecure LAN origins'
);

console.log('Cast SDK initialization ordering regression checks passed.');
