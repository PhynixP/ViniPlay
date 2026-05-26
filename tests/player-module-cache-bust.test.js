const assert = require('assert');
const fs = require('fs');
const path = require('path');

const files = [
  'public/js/main.js',
  'public/js/modules/guide.js',
  'public/js/modules/ui.js',
  'public/js/modules/dvr.js',
  'public/js/modules/vod.js',
];

for (const file of files) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  assert(
    !/from\s+['"][^'"]*player\.js['"]/.test(source),
    `${file} must not import bare player.js; browser module caches can keep stale VOD playback code`
  );
}

const mainHtml = fs.readFileSync(path.join(__dirname, '..', 'public/index.html'), 'utf8');
assert(
  mainHtml.includes('/js/main.js?v=12'),
  'index.html should bump the main module query when player/cast code changes'
);

console.log('Player module cache-bust regression checks passed.');
