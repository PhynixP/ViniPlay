const assert = require('assert');
const fs = require('fs');
const path = require('path');

const EXPECTED_VERSION = 21;

const files = [
  'public/js/main.js',
  'public/js/modules/guide.js',
  'public/js/modules/ui.js',
  'public/js/modules/dvr.js',
  'public/js/modules/vod.js',
];

for (const file of files) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

  // Guard: bare player.js import (no query string) must never appear
  assert(
    !/from\s+['"][^'"]*player\.js['"]/.test(source),
    `${file} must not import bare player.js; browser module caches can keep stale VOD playback code`
  );

  // Guard: every versioned player.js import must use the canonical version
  const versionedImports = [...source.matchAll(/from\s+['"][^'"]*player\.js\?v=(\d+)['"]/g)];
  for (const match of versionedImports) {
    const v = parseInt(match[1], 10);
    assert.strictEqual(
      v,
      EXPECTED_VERSION,
      `${file} imports player.js?v=${v} but expected v=${EXPECTED_VERSION}; ` +
      `mismatched query strings cause the browser to instantiate multiple module instances, splitting Cast/playback state`
    );
  }
}

const mainHtml = fs.readFileSync(path.join(__dirname, '..', 'public/index.html'), 'utf8');
assert(
  mainHtml.includes('/js/main.js?v=21'),
  'index.html should bump the main module query when player/cast code changes'
);

console.log('Player module cache-bust regression checks passed.');
