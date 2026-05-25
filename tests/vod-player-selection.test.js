const assert = require('assert');
const fs = require('fs');
const path = require('path');

const playerJs = fs.readFileSync(path.join(__dirname, '..', 'public/js/modules/player.js'), 'utf8');

assert(
  playerJs.includes('function playVodWithNativeVideo'),
  'VOD playback should have a native HTML5 video path for redirect and MP4/fMP4 sources'
);

assert(
  playerJs.includes('function playVodWithMpegts'),
  'VOD playback should keep a separate mpegts.js path for MPEG-TS profile output'
);

assert(
  playerJs.includes("profile.command === 'redirect'") && playerJs.includes('profile.command.includes(\'-f mp4\')'),
  'VOD playback should choose native video for redirect URLs and FFmpeg profiles that output MP4/fMP4'
);

assert(
  playerJs.includes("type: 'mpegts'") && playerJs.includes('isLive: false'),
  'mpegts.js VOD playback should use MPEG-TS media source type and non-live buffering semantics'
);

const vodFunctionStart = playerJs.indexOf('export const playVOD');
const vodFunctionEnd = playerJs.indexOf('/**\n * Detects and populates available audio tracks', vodFunctionStart);
assert(vodFunctionStart >= 0 && vodFunctionEnd > vodFunctionStart, 'playVOD function should be found');
const playVodBody = playerJs.slice(vodFunctionStart, vodFunctionEnd);

assert(
  !playVodBody.includes('mpegts.createPlayer({\n                type: \'mse\''),
  'playVOD should not unconditionally initialize mpegts.js with type mse for all VOD sources'
);

console.log('vod-player-selection regression checks passed');
