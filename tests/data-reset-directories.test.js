const assert = require('assert');
const fs = require('fs');
const path = require('path');

const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

assert(
  !serverJs.includes('[SOURCES_DIR, DVR_DIR].forEach'),
  'hard reset should not remove /dvr itself; mounted DVR directories can be EBUSY'
);

assert(
  serverJs.includes('for (const child of fs.readdirSync(dir))'),
  'hard reset should clear directory contents instead of deleting mount-point directories'
);

assert(
  serverJs.includes('RAW_CACHE_DIR') && serverJs.includes('fs.mkdirSync(RAW_CACHE_DIR, { recursive: true })'),
  'hard reset should recreate /data/sources/raw_cache before source processing writes raw cache files'
);

console.log('data-reset-directories regression checks passed');
