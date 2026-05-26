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
  mainJs.includes('./modules/player.js?v=8'),
  'main.js must deep-cache-bust player.js after Cast click handling changes'
);

assert(
  playerJs.includes('./cast.js?v=8'),
  'player.js must deep-cache-bust cast.js after Cast initialization changes'
);

assert(
  playerJs.includes('castState.isInitialized'),
  'Cast button click should guard against using CastContext before setOptions initialization completes'
);

console.log('Cast SDK initialization ordering regression checks passed.');
