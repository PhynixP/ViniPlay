const assert = require('assert');
const fs = require('fs');
const path = require('path');

const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function extractProfileCommand(profileId) {
  const regex = new RegExp(`\\{ id: '${profileId}'[^}]*command: '([^']+)'`);
  const match = serverJs.match(regex);
  assert(match, `Profile ${profileId} should exist with a command`);
  return match[1];
}

for (const profileId of ['ffmpeg-intel', 'cast-intel', 'dvr-mp4-intel']) {
  const command = extractProfileCommand(profileId);

  assert(
    command.includes('-user_agent "{userAgent}"'),
    `${profileId} should pass the configured user agent to upstream VOD/IPTV providers`
  );

  assert(
    command.includes('-hwaccel_output_format qsv'),
    `${profileId} should explicitly request QSV hardware frames instead of relying on deprecated FFmpeg defaults`
  );

  assert(
    !command.includes('-c:v h264_qsv -i'),
    `${profileId} should not force h264_qsv as the input decoder before -i; input codec probing must remain automatic`
  );
}

assert(
  serverJs.includes('builtInProfileIdsToAutoUpdate') &&
  serverJs.includes("'ffmpeg-intel'") &&
  serverJs.includes("'cast-intel'") &&
  serverJs.includes("'dvr-mp4-intel'"),
  'settings migration should auto-update the built-in Intel QSV profiles for existing installations'
);

console.log('qsv-profile-commands regression checks passed');
