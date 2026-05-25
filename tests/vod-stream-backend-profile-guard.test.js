const assert = require('assert');
const fs = require('fs');
const path = require('path');

const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

assert(
  serverJs.includes('function selectVodSafeProfileForStream'),
  'server /stream endpoint should have a backend VOD-safe profile guard so stale clients cannot request MPEG-TS VOD profiles'
);

assert(
  serverJs.includes('isVodRequest') && serverJs.includes('vodName || isMovieOrSeriesUrl(streamUrl)'),
  'backend guard should identify VOD by vodName and by /movie/ or /series/ URLs'
);

assert(
  serverJs.includes('vodClient') && serverJs.includes("vodClient === 'native'"),
  'native browser VOD requests should identify themselves so the backend can distinguish current native-video clients from stale mpegts.js clients'
);

assert(
  serverJs.includes('[STREAM] VOD profile remap') && serverJs.includes('effectiveProfileId'),
  'backend guard should remap current native-video MPEG-TS VOD requests to an effective MP4/fMP4 profile and log the remap'
);

assert(
  serverJs.includes('Stale mpegts.js VOD client detected') && serverJs.includes('using requested MPEG-TS profile'),
  'backend should keep MPEG-TS output for stale VOD clients that still initialize mpegts.js so they do not receive MP4/fMP4 in a TS player'
);

const streamRouteStart = serverJs.indexOf("app.get('/stream'");
assert(streamRouteStart >= 0, 'stream route should exist');
const streamRoute = serverJs.slice(streamRouteStart, serverJs.indexOf('// HEAD request handler', streamRouteStart));

const remapIndex = streamRoute.indexOf('selectVodSafeProfileForStream');
const keyIndex = streamRoute.indexOf('const streamKey = `${userId}::${streamUrl}::${effectiveProfileId}`');
assert(
  remapIndex >= 0 && keyIndex > remapIndex,
  'stream key should be built after VOD remapping and should use effectiveProfileId so stale MPEG-TS VOD requests do not reuse/live-key the wrong process'
);

assert(
  streamRoute.includes("res.setHeader('X-ViniPlay-Effective-Profile") && streamRoute.includes("res.setHeader('X-ViniPlay-VOD-Profile-Remapped") ,
  'backend stream response should expose headers showing which effective profile was used for debugging'
);

assert(
  serverJs.includes('Exact key ${streamKey} not found; using active remapped key'),
  'stream stop endpoint should fall back to the active effective-profile stream key when VOD remapping changed the profile ID'
);

console.log('VOD backend profile guard regression checks passed.');
