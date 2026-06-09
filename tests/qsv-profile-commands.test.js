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
    command.includes('-reconnect 1') && command.includes('-reconnect_streamed 1') && command.includes('-reconnect_delay_max'),
    `${profileId} should include reconnect flags to survive brief upstream stream interruptions`
  );

  assert(
    command.includes('-hwaccel qsv'),
    `${profileId} should include -hwaccel qsv to initialize the QSV device context needed by hwupload`
  );

  assert(
    !command.includes('-hwaccel_output_format qsv'),
    `${profileId} should not force QSV hardware decode output — CPU decode + QSV encode is required for all-codec compatibility`
  );

  assert(
    command.includes('hwupload=extra_hw_frames=64') && command.includes('format=nv12'),
    `${profileId} should upload software frames to QSV memory via hwupload so all input codecs work with h264_qsv encoder`
  );

  assert(
    command.includes('-c:v h264_qsv'),
    `${profileId} should use h264_qsv for GPU-accelerated encoding`
  );

  assert(
    /-global_quality 2[34]/.test(command),
    `${profileId} should set an explicit QSV quality mode instead of relying on FFmpeg's CQP default warning`
  );

  if (profileId.includes('ffmpeg-intel') || profileId.includes('cast-intel')) {
    assert(
      command.includes('-level:v 4.2') && command.includes('-bf 0'),
      `${profileId} should produce a browser-safe H.264 level 4.2 stream without B-frames for mpegts.js/MSE playback`
    );
  }
}

for (const profileId of ['ffmpeg-intel', 'cast-intel', 'dvr-mp4-intel']) {
  assertModernQsvCommand(extractProfileCommand(serverJs, profileId), `server default ${profileId}`);
  assertModernQsvCommand(extractProfileCommand(settingsJs, profileId), `hardware-detected ${profileId}`);
}

// dvr-ts-intel only exists in server.js (server-side built-in)
assertModernQsvCommand(extractProfileCommand(serverJs, 'dvr-ts-intel'), 'server default dvr-ts-intel');

assert(
  serverJs.includes('builtInProfileIdsToAutoUpdate') &&
  serverJs.includes("'ffmpeg-intel'") &&
  serverJs.includes("'cast-intel'") &&
  serverJs.includes("'dvr-ts-intel'") &&
  serverJs.includes("'dvr-mp4-intel'"),
  'settings migration should auto-update the built-in Intel QSV profiles for existing installations'
);

console.log('qsv-profile-commands regression checks passed');
