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
  mainJs.includes('./modules/player.js?v=21'),
  'main.js must deep-cache-bust player.js after keeping the Cast icon visible while using the native launcher overlay'
);

assert(
  playerJs.includes('./cast.js?v=21'),
  'player.js must deep-cache-bust cast.js after keeping the Cast icon visible while using the native launcher overlay'
);

assert(
  indexHtml.includes('id="cast-btn"') && indexHtml.includes('data-icon="cast"'),
  'index.html should keep a first-party visible Cast icon so the control does not disappear when google-cast-launcher renders empty/hidden'
);

assert(
  indexHtml.includes('<google-cast-launcher id="native-cast-launcher"') && indexHtml.includes('native-cast-launcher-overlay'),
  'index.html should keep the native google-cast-launcher as an invisible overlay so Chrome owns the click path that opens the picker'
);

assert(
  indexHtml.includes('.cast-control') && indexHtml.includes('position: relative') && indexHtml.includes('.native-cast-launcher-overlay') && indexHtml.includes('opacity: 0.01'),
  'CSS should reserve a visible Cast control and place the native launcher over it as the click target'
);

assert(
  playerJs.includes("querySelector('google-cast-launcher')") && playerJs.includes('Native google-cast-launcher overlay controls Cast session requests'),
  'player.js should skip the custom requestSession click handler when #cast-btn contains the native google-cast-launcher overlay'
);

assert(
  !playerJs.includes('CastContext.getInstance().requestSession()'),
  'player.js should not manually request Cast sessions now that manual requestSession is known to return session_error in this Chrome session'
);

assert(
  castJs.includes('Cast SDK is unavailable; leaving the visible Cast control in place') && !castJs.includes("UIElements.castBtn.style.display = 'none'"),
  'cast.js should never hide the visible Cast control when SDK availability is unavailable/late because that made the button disappear'
);

assert(
  castJs.includes('window.isSecureContext') && castJs.includes('Google Cast requires HTTPS') && castJs.includes('localhost'),
  'cast.js should diagnose insecure-origin Cast unavailability instead of treating it as a generic initialization race'
);

assert(
  castJs.includes('getCastBrowserDiagnostic') &&
  castJs.includes('Chrome, Edge, or another Cast-supported Chromium browser') &&
  castJs.includes('navigator.userAgent') &&
  playerJs.includes('getCastBrowserDiagnostic'),
  'fallback diagnostics should still explain unsupported browsers/sessions such as Safari, Firefox, iOS Chrome, or in-app browsers if the native launcher overlay is missing'
);

assert(
  castJs.includes('export function recoverCastSdkFromGlobals') &&
  castJs.includes('Cast SDK callback did not mark availability, but framework globals are present'),
  'cast.js should retain late SDK recovery for initialization races even though native launcher clicks are no longer requested manually'
);

assert(
  castJs.includes('export function getCastOriginDiagnostic') &&
  playerJs.includes('getCastOriginDiagnostic') &&
  playerJs.includes('Native Cast launcher overlay is missing from the page'),
  'fallback Cast click diagnostics should explain origin/browser problems without calling manual requestSession'
);

console.log('Cast SDK initialization ordering regression checks passed.');
