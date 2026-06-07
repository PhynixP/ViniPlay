const assert = require('assert');
const fs = require('fs');
const path = require('path');

const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const settingsJs = fs.readFileSync(path.join(__dirname, '..', 'public/js/modules/settings.js'), 'utf8');

function extractProfileCommand(source, profileId) {
  const regex = new RegExp(`\\{ id: '${profileId}'[^}]*command: '([^']+)'`);
  const match = source.match(regex);
  assert(match, `Profile ${profileId} should exist with a command`);
  return match[1];
}

function assertModernQsvCommand(command, profileId) {
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

  assert(
    /-global_quality 2[34]/.test(command),
    `${profileId} should set an explicit QSV quality mode instead of relying on FFmpeg's CQP default warning`
  );

  assert(
    command.includes('vpp_qsv') && command.includes('format=nv12'),
    `${profileId} should normalize QSV hardware frames to NV12 so HEVC/Dolby Vision sources can feed h264_qsv`
  );

  if (profileId.includes('ffmpeg-intel') || profileId.includes('cast-intel')) {
    assert(
      command.includes('w=1920:h=1080') && command.includes('-level:v 4.2') && command.includes('-bf 0'),
      `${profileId} should produce a browser-safe 1080p H.264 level 4.2 stream without B-frames for mpegts.js/MSE playback`
    );
  }
}

for (const profileId of ['ffmpeg-intel', 'cast-intel', 'dvr-mp4-intel']) {
  assertModernQsvCommand(extractProfileCommand(serverJs, profileId), `server default ${profileId}`);
  assertModernQsvCommand(extractProfileCommand(settingsJs, profileId), `hardware-detected ${profileId}`);
}

assert(
  settingsJs.includes('-user_agent "{userAgent}" -hwaccel qsv -hwaccel_output_format qsv -i "{streamUrl}"'),
  'settings UI hardware-detected Intel QSV examples should show the modern command template'
);

assert(
  serverJs.includes('builtInProfileIdsToAutoUpdate') &&
  serverJs.includes("'ffmpeg-intel'") &&
  serverJs.includes("'cast-intel'") &&
  serverJs.includes("'dvr-mp4-intel'"),
  'settings migration should auto-update the built-in Intel QSV profiles for existing installations'
);

console.log('qsv-profile-commands regression checks passed');
