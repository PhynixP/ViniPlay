const assert = require('assert');
const fs = require('fs');
const path = require('path');

const playerJs = fs.readFileSync(path.join(__dirname, '..', 'public/js/modules/player.js'), 'utf8');

assert(
  playerJs.includes('function playVodWithNativeVideo'),
  'VOD playback should have a native HTML5 video path for redirect and MP4/fMP4 sources'
);

assert(
  !playerJs.includes('function playVodWithMpegts') &&
  !playerJs.includes('Failed to initialize mpegts.js player'),
  'Browser VOD code should not retain a mpegts.js playback path or mpegts.js initialization error string; seeing that exact error means stale frontend code is loaded'
);

assert(
  playerJs.includes("const directProfile = { id: 'direct', name: 'Direct Play', command: 'redirect' }") &&
  playerJs.includes('await playVodWithNativeVideo(streamUrlToPlay, title, logo, url, profile);'),
  'VOD playback should route redirect and MP4/fMP4 /stream URLs through native HTML5 video'
);

assert(
  playerJs.includes('function selectVodTranscodeProfile') &&
  playerJs.includes('settings.castProfiles || []') &&
  playerJs.includes("'cast-intel'") &&
  playerJs.includes("'ffmpeg-fmp4'"),
  'VOD profile playback should auto-select an MP4/fMP4-capable profile, including cast Intel/QSV or CPU fallback, instead of reusing live MPEG-TS profiles'
);

assert(
  playerJs.includes('const profileIdForStream = profile.id;') &&
  playerJs.includes('profileId=${profileIdForStream}') &&
  playerJs.includes('vodClient=native'),
  'VOD /stream URLs should use the auto-selected VOD-safe profile id and identify native HTML5 video clients, not always the active live stream profile id'
);

const vodFunctionStart = playerJs.indexOf('export const playVOD');
const vodFunctionEnd = playerJs.indexOf('/**\n * Detects and populates available audio tracks', vodFunctionStart);
assert(vodFunctionStart >= 0 && vodFunctionEnd > vodFunctionStart, 'playVOD function should be found');
const playVodBody = playerJs.slice(vodFunctionStart, vodFunctionEnd);

assert(
  !playVodBody.includes('mpegts.createPlayer({\n                type: \'mse\''),
  'playVOD should not unconditionally initialize mpegts.js with type mse for all VOD sources'
);

assert(
  !playVodBody.includes('playVodWithMpegts('),
  'playVOD should not route browser VOD playback through mpegts.js; the backend remaps stale MPEG-TS profile requests to MP4/fMP4, so the frontend should use native video for VOD streams'
);

console.log('vod-player-selection regression checks passed');
