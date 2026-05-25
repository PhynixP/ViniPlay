const assert = require('assert');
const fs = require('fs');
const path = require('path');

const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

assert(
  serverJs.includes('epgFetchOptions'),
  'EPG processing should compute an epgFetchOptions object instead of using source.fetchOptions directly.'
);

assert(
  /source\.isXcEpg[\s\S]{0,250}User-Agent[\s\S]{0,250}activeUserAgent/.test(serverJs),
  'Managed Xtream EPG sources should be fetched with the configured active User-Agent.'
);

assert(
  /fetchUrlContent\(source\.path,\s*epgFetchOptions,\s*true\)/.test(serverJs),
  'Compressed EPG fetches should use epgFetchOptions.'
);

assert(
  /fetchUrlContent\(source\.path,\s*epgFetchOptions\)/.test(serverJs),
  'Uncompressed EPG fetches should use epgFetchOptions.'
);

console.log('xc-epg-user-agent regression checks passed');
