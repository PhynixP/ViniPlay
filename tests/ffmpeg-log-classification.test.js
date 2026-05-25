const assert = require('assert');
const fs = require('fs');
const path = require('path');

const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

assert(
  serverJs.includes('logFFmpegStderr'),
  'server should classify FFmpeg stderr instead of treating every stderr line as an error'
);

assert(
  !serverJs.includes('console.error(`[FFMPEG_ERROR] Stream: ${streamKey} - ${data.toString().trim()}`)'),
  'FFmpeg info/warning stderr should not all be logged with the FFMPEG_ERROR prefix'
);

assert(
  serverJs.includes('[FFMPEG_WARN]') && serverJs.includes('[FFMPEG_INFO]') && serverJs.includes('[FFMPEG_ERROR]'),
  'server should retain distinct FFmpeg info/warn/error prefixes for accurate log severity'
);

console.log('ffmpeg-log-classification regression checks passed');
