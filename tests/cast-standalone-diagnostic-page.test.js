const assert = require('assert');
const fs = require('fs');

assert(
  fs.existsSync('public/cast-test.html'),
  'ViniPlay should expose a standalone /cast-test.html page to isolate Cast requestSession failures from the main player app'
);

const castTestHtml = fs.readFileSync('public/cast-test.html', 'utf8');

const callbackIndex = castTestHtml.indexOf('window.__onGCastApiAvailable');
const sdkIndex = castTestHtml.indexOf('cast_sender.js?loadCastFramework=1');
assert(callbackIndex !== -1, 'cast-test.html should define the Cast SDK callback inline');
assert(sdkIndex !== -1, 'cast-test.html should load the Google Cast sender SDK');
assert(
  callbackIndex < sdkIndex,
  'cast-test.html should define __onGCastApiAvailable before loading the Cast sender SDK'
);

assert(
  castTestHtml.includes('receiverApplicationId') && castTestHtml.includes('CC1AD845'),
  'cast-test.html should use the default media receiver app id for the same baseline as the main app'
);

assert(
  castTestHtml.includes('id="framework-cast"') && castTestHtml.includes('CastContext.getInstance().requestSession()'),
  'cast-test.html should include a minimal framework requestSession button'
);

assert(
  castTestHtml.includes('id="legacy-cast"') && castTestHtml.includes('chrome.cast.requestSession'),
  'cast-test.html should include a legacy chrome.cast.requestSession fallback button for comparison'
);

assert(
  castTestHtml.includes('id="native-launcher"') && castTestHtml.includes('google-cast-launcher'),
  'cast-test.html should include a native google-cast-launcher control for comparison'
);

assert(
  castTestHtml.includes('JSON.stringify') && castTestHtml.includes('window.cast?.framework') && castTestHtml.includes('window.chrome?.cast'),
  'cast-test.html should print structured Cast diagnostics that can be copied from DevTools/browser'
);

console.log('Standalone Cast diagnostic page regression checks passed.');
