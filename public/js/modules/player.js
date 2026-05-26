/**
 * player.js
 * * Manages the video player functionality using mpegts.js and Google Cast.
 */

import { appState, guideState, UIElements } from './state.js';
// MODIFIED: Added stopStream to the import
import { saveUserSetting, stopStream, startRedirectStream, stopRedirectStream } from './api.js';
import { showNotification, openModal, closeModal } from './ui.js';
import { castState, loadMedia, setLocalPlayerState, getCastOriginDiagnostic } from './cast.js?v=12';
import { logToPlayerConsole } from './player_direct.js';
import { ICONS } from './icons.js'; // NEW: Import ICONS
import { getCodecName } from './codecs.js'; // NEW: Import codec utility

let streamInfoInterval = null; // Interval to update stream stats
let currentLocalStreamUrl = null; // ADDED: Track the original URL of the currently playing local stream
let currentProfileId = null; // ADDED: Track the profile ID of the current stream
let currentRedirectHistoryId = null; // To track redirect streams for logging

// --- NEW: Auto-retry logic state ---
let currentChannelInfo = null; // Stores { url, name, channelId } for retries
let retryCount = 0;
const MAX_RETRIES = 3;
let retryTimeout = null;

/**
 * Handles a catastrophic stream error by attempting to restart the stream.
 */
function handleStreamError() {
    if (retryCount >= MAX_RETRIES) {
        showNotification(`Stream failed after ${MAX_RETRIES} retries. Please try another channel.`, true, 5000);
        stopAndCleanupPlayer();
        return;
    }

    retryCount++;
    showNotification(`Stream interrupted. Retrying... (${retryCount}/${MAX_RETRIES})`, true, 2000);

    // Clear any previous timeout
    if (retryTimeout) {
        clearTimeout(retryTimeout);
    }

    // Attempt to restart after a short delay
    retryTimeout = setTimeout(() => {
        console.log(`[PLAYER_RETRY] Attempting to restart stream. Attempt ${retryCount}/${MAX_RETRIES}.`);
        if (currentChannelInfo) {
            // Re-call playChannel which handles the full setup
            playChannel(currentChannelInfo.url, currentChannelInfo.name, currentChannelInfo.channelId);
        } else {
            console.error("[PLAYER_RETRY] Cannot retry: current channel info is missing.");
            stopAndCleanupPlayer();
        }
    }, 2000); // 2-second delay before retrying
}


/**
 * NEW: Forcefully stops and restarts the current stream.
 * This function will be triggered by the new refresh button.
 */
export async function forceRefreshStream() {
    if (!currentChannelInfo) {
        showNotification("No active stream to refresh.", true);
        return;
    }

    showNotification("Refreshing stream...", false, 2000);
    console.log('[PLAYER] User forced stream refresh.');

    // Clear any pending retry to prevent it from interfering
    if (retryTimeout) {
        clearTimeout(retryTimeout);
        retryTimeout = null;
    }
    retryCount = 0; // Reset retry count on manual refresh

    // Stop the current player instance without closing the modal
    if (appState.player) {
        await stopStream(currentLocalStreamUrl, currentProfileId);
        appState.player.destroy();
        appState.player = null;
    }

    // Immediately try to play the channel again
    playChannel(currentChannelInfo.url, currentChannelInfo.name, currentChannelInfo.channelId);
}


/**
 * Stops the current local stream, cleans up the mpegts.js player instance, and closes the modal.
 * This does NOT affect an active Google Cast session.
 */
export const stopAndCleanupPlayer = async () => { // MODIFIED: Made function async
    // If we were logging a redirect stream, tell the server it has stopped.
    if (currentRedirectHistoryId) {
        stopRedirectStream(currentRedirectHistoryId);
        currentRedirectHistoryId = null;
    }

    // NEW: Clear any scheduled retry attempt
    if (retryTimeout) {
        clearTimeout(retryTimeout);
        retryTimeout = null;
    }
    retryCount = 0;
    currentChannelInfo = null;


    // Explicitly tell the server to stop the stream process.
    if (currentLocalStreamUrl && !castState.isCasting) {
        console.log(`[PLAYER] Sending stop request to server for URL: ${currentLocalStreamUrl} with Profile ID: ${currentProfileId}`);
        await stopStream(currentLocalStreamUrl, currentProfileId);
        currentLocalStreamUrl = null; // Clear the tracked URL after stopping
        currentProfileId = null; // Clear the profile ID
    }

    // Clear the stream info update interval
    if (streamInfoInterval) {
        clearInterval(streamInfoInterval);
        streamInfoInterval = null;
    }

    if (UIElements.streamInfoOverlay) {
        UIElements.streamInfoOverlay.classList.add('hidden');
    }

    // CRITICAL FIX: Always destroy the local player first, regardless of cast state
    // This ensures local playback stops when switching to cast or closing the modal
    if (appState.player) {
        console.log('[PLAYER] Destroying local mpegts player.');
        appState.player.destroy();
        appState.player = null;
    }
    UIElements.videoElement.src = "";
    UIElements.videoElement.removeAttribute('src');
    UIElements.videoElement.load();

    setLocalPlayerState(null, null, null);

    // If we're casting, just close the modal and keep the cast session active
    if (castState.isCasting) {
        console.log('[PLAYER] Closing modal but leaving cast session active.');
        closeModal(UIElements.videoModal);
        return;
    }

    if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(console.error);
    }
    closeModal(UIElements.videoModal);
};

/**
 * Updates the stream info overlay with the latest stats from mpegts.js.
 * mpegts.js reports speed in KB/s so divide by 1024 for MB/s.
 */
function updateStreamInfo() {
    if (!appState.player || !appState.player.statisticsInfo) return;

    const stats = appState.player.statisticsInfo;
    const video = UIElements.videoElement;

    const resolution = (video.videoWidth && video.videoHeight) ? `${video.videoWidth}x${video.videoHeight}` : 'N/A';
    const speed = `${(stats.speed / 1024).toFixed(2)} MB/s`;
    const dropped = (stats.droppedFrames >= 0 && typeof stats.droppedFrames === 'number') ? stats.droppedFrames : 'N/A'
    const buffer = video.buffered.length > 0 ? `${(video.buffered.end(0) - video.currentTime).toFixed(2)}s` : '0.00s';
    const mediaInfo = appState.player.mediaInfo;
    const fps = mediaInfo.fps;
    const videoCodec = mediaInfo.videoCodec;
    const audioCodec = mediaInfo.audioCodec;

    UIElements.streamInfoResolution.textContent = `Resolution: ${resolution}`;
    UIElements.streamInfoBandwidth.textContent = `Bandwidth: ${speed}`;
    UIElements.streamInfoFps.textContent = `FPS: ${fps}`;
    UIElements.streamInfoDropped.textContent = `Dropped: ${dropped}`;
    UIElements.streamInfoBuffer.textContent = `Buffer: ${buffer}`;
    UIElements.streamInfoVideo.textContent = `V Codec: ${getCodecName(videoCodec)}`;
    UIElements.streamInfoAudio.textContent = `A Codec: ${getCodecName(audioCodec)}`;
}


/**
 * Initializes and starts playing a channel stream, either locally or on a Cast device.
 * @param {string} url - The URL of the channel stream.
 * @param {string} name - The name of the channel to display.
 * @param {string} channelId - The unique ID of the channel.
 */
export const playChannel = (url, name, channelId) => {
    // On a fresh play request (not a retry), reset the retry counter
    if (!retryTimeout) {
        retryCount = 0;
    }

    // Store current channel info for potential retries
    currentChannelInfo = { url, name, channelId };

    // Update and save recent channels regardless of playback target
    if (channelId) {
        const recentChannels = [channelId, ...(guideState.settings.recentChannels || []).filter(id => id !== channelId)].slice(0, 15);
        guideState.settings.recentChannels = recentChannels;
        saveUserSetting('recentChannels', recentChannels);
    }

    const profileId = guideState.settings.activeStreamProfileId;
    const userAgentId = guideState.settings.activeUserAgentId;
    if (!profileId || !userAgentId) {
        showNotification("Active stream profile or user agent not set. Please check settings.", true);
        return;
    }
    // --- Activity Logging for Redirect Streams ---
    // First, ensure any previous redirect logging session is stopped.
    if (currentRedirectHistoryId) {
        stopRedirectStream(currentRedirectHistoryId);
        currentRedirectHistoryId = null;
    }
    const profile = (guideState.settings.streamProfiles || []).find(p => p.id === profileId);
    // If the selected profile is redirect, start a new logging session.
    if (profile.command === 'redirect') {
        const channel = guideState.channels.find(c => c.id === channelId);
        startRedirectStream(url, channelId, name, channel ? channel.logo : '')
            .then(historyId => {
                if (historyId) {
                    currentRedirectHistoryId = historyId;
                }
            });
    }
    // --- End Activity Logging ---


    if (!profile) {
        return showNotification("Stream profile not found.", true);
    }

    const streamUrlToPlay = profile.command === 'redirect' ? url : `/stream?url=${encodeURIComponent(url)}&profileId=${profileId}&userAgentId=${userAgentId}`;
    const channel = guideState.channels.find(c => c.id === channelId);
    const logo = channel ? channel.logo : '';

    if (castState.isCasting) {
        console.log(`[PLAYER] Already casting. Loading new channel "${name}" to remote device.`);
        // CRITICAL FIX: Chromecast needs absolute URLs, not relative
        const absoluteStreamUrl = streamUrlToPlay.startsWith('http')
            ? streamUrlToPlay
            : `${window.location.origin}${streamUrlToPlay}`;
        loadMedia(absoluteStreamUrl, name, logo);
        openModal(UIElements.videoModal);
        return;
    }

    // --- Local Playback Logic ---
    currentLocalStreamUrl = url;
    currentProfileId = profileId; // Store the profile ID
    console.log(`[PLAYER] Playing channel "${name}" locally. Tracking URL for cleanup: ${currentLocalStreamUrl}, Profile: ${currentProfileId}`);

    setLocalPlayerState(streamUrlToPlay, name, logo, url, profileId);

    if (appState.player) {
        appState.player.destroy();
        appState.player = null;
    }
    if (streamInfoInterval) {
        clearInterval(streamInfoInterval);
        streamInfoInterval = null;
    }

    if (mpegts.isSupported()) {
        const mpegtsConfig = {
            enableStashBuffer: true,
            stashInitialSize: 4096,
            liveBufferLatency: 2.0,
        };

        appState.player = mpegts.createPlayer({
            type: 'mse',
            isLive: true,
            url: streamUrlToPlay
        }, mpegtsConfig);

        // --- NEW: Robust Error Handling ---
        appState.player.on(mpegts.Events.ERROR, (errorType, errorDetail) => {
            console.error(`[PLAYER] MPEGTS Player Error: Type=${errorType}, Detail=${errorDetail}`);
            // We only want to auto-retry on unrecoverable network/media errors.
            if (errorType === 'NetworkError' || errorType === 'MediaError') {
                // To prevent a retry loop if the user has manually closed the player
                if (appState.player) {
                    handleStreamError();
                }
            } else {
                showNotification(`Player Error: ${errorDetail}`, true);
                stopAndCleanupPlayer();
            }
        });

        // When playback starts successfully, reset the retry counter.
        appState.player.on(mpegts.Events.MEDIA_INFO, () => {
            console.log('[PLAYER] Media info received, playback started successfully.');
            retryCount = 0;
            if (retryTimeout) {
                clearTimeout(retryTimeout);
                retryTimeout = null;
            }
        });

        openModal(UIElements.videoModal);
        UIElements.videoTitle.textContent = name;
        appState.player.attachMediaElement(UIElements.videoElement);
        appState.player.load();

        // NEW: Enforce aspect ratio when metadata is loaded to ensure controls are visible
        UIElements.videoElement.addEventListener('loadedmetadata', () => {
            if (isAspectRatioLocked && UIElements.videoElement.videoWidth) {
                const videoRatio = UIElements.videoElement.videoWidth / UIElements.videoElement.videoHeight;
                const currentWidth = UIElements.videoModalContainer.offsetWidth;

                // Calculate header height
                const header = UIElements.videoModalContainer.querySelector('.flex.justify-between');
                const headerHeight = header ? header.offsetHeight : 0;

                const targetHeight = (currentWidth / videoRatio) + headerHeight;
                UIElements.videoModalContainer.style.height = `${targetHeight}px`;
            }
        }, { once: true });

        UIElements.videoElement.volume = parseFloat(localStorage.getItem('iptvPlayerVolume') || 0.5);

        appState.player.play().catch((err) => {
            console.error("MPEGTS Player play() caught an error:", err);
            // This initial play error is often critical, so we start the retry process.
            handleStreamError();
        });

        streamInfoInterval = setInterval(updateStreamInfo, 2000);

    } else {
        showNotification('Your browser does not support Media Source Extensions (MSE).', true);
    }
};


function findVodLibraryItem(url) {
    return guideState.vodMovies.find(m => m.url === url) || guideState.vodSeries.find(s => s.url === url);
}

function findProfileById(settings, profileId) {
    const allProfiles = [
        ...(settings.streamProfiles || []),
        ...(settings.castProfiles || []),
    ];
    return allProfiles.find(p => p.id === profileId);
}

function selectVodTranscodeProfile(settings, activeProfile) {
    if (!activeProfile || activeProfile.command === 'redirect' || activeProfile.command.includes('-f mp4')) {
        return activeProfile;
    }

    const candidateIds = [];
    const activeId = activeProfile.id || '';

    if (activeId.includes('nvidia') || settings.hasNvidiaGpu || guideState.hardware?.nvidia) {
        candidateIds.push('cast-nvidia', 'ffmpeg-fmp4-nvidia');
    }
    if (activeId.includes('intel') || activeId.includes('qsv') || guideState.hardware?.intel_qsv) {
        candidateIds.push('cast-intel');
    }
    if (activeId.includes('vaapi-amd') || activeId.includes('radeon') || guideState.hardware?.radeon_vaapi) {
        candidateIds.push('cast-vaapi-amd');
    }
    if (activeId.includes('vaapi') || guideState.hardware?.intel_vaapi) {
        candidateIds.push('cast-vaapi');
    }

    // CPU fMP4 is the universal VOD-safe fallback and exists in default settings.
    candidateIds.push('ffmpeg-fmp4', 'cast-default');

    for (const candidateId of candidateIds) {
        const candidate = findProfileById(settings, candidateId);
        if (candidate && candidate.command && candidate.command.includes('-f mp4')) {
            console.log(`[VOD_PLAYER] Auto-selected VOD-safe fMP4 profile "${candidate.name}" instead of live profile "${activeProfile.name}".`);
            return candidate;
        }
    }

    console.warn(`[VOD_PLAYER] No MP4/fMP4 VOD profile found. Falling back to active profile "${activeProfile.name}".`);
    return activeProfile;
}

async function playVodWithNativeVideo(streamUrlToPlay, title, logo, originalUrl, profile) {
    console.log(`[VOD_PLAYER] Using native HTML5 video playback for: "${title}"`);
    logToPlayerConsole('Using native HTML5 video playback for VOD.');

    UIElements.videoTitle.textContent = title;
    UIElements.videoElement.src = streamUrlToPlay;
    UIElements.videoElement.load();
    UIElements.videoElement.volume = parseFloat(localStorage.getItem('iptvPlayerVolume') || 0.5);

    openModal(UIElements.videoModal);

    if (profile.command === 'redirect') {
        const vodItem = findVodLibraryItem(originalUrl);
        const vodId = vodItem ? vodItem.id : null;
        const vodLogo = vodItem ? vodItem.logo : logo;
        startRedirectStream(originalUrl, vodId, title, vodLogo)
            .then(historyId => {
                if (historyId) {
                    currentRedirectHistoryId = historyId;
                }
            });
        currentLocalStreamUrl = null;
        currentProfileId = null;
    }

    try {
        await UIElements.videoElement.play();
        console.log(`[VOD_PLAYER] Native playback started for: "${title}"`);
        setLocalPlayerState(streamUrlToPlay, title, logo, originalUrl, profile.id);
    } catch (err) {
        console.error('[VOD_PLAYER] Error trying native VOD playback:', err);
        const errorMsg = `Could not play the selected video natively: ${err.message}. If this is an MKV/AVI/TS file, choose an MP4/fMP4 transcoding profile instead of Redirect.`;
        showNotification(errorMsg, true);
        logToPlayerConsole(errorMsg, true);
        UIElements.videoElement.src = '';
        UIElements.videoElement.removeAttribute('src');
        UIElements.videoElement.load();
        closeModal(UIElements.videoModal);
    }
}

/**
 * Plays a VOD (Movie or Episode) using native HTML5 video for direct/MP4 sources
 * and server-remapped MP4/fMP4 transcodes.
 * @param {string} url - The direct URL to the VOD file (e.g., .mp4, .mkv).
 * @param {string} title - The title of the VOD to display.
 */
export const playVOD = async (url, title, logo = '') => {
    const useDirectPlay = guideState.settings.vodDirectPlayEnabled === true;
    console.log(`[VOD_PLAYER] Attempting to play VOD: "${title}" | Direct Play: ${useDirectPlay}`);

    await stopAndCleanupPlayer();

    const settings = guideState.settings;
    const profileId = settings.activeStreamProfileId;
    const userAgentId = settings.activeUserAgentId;
    const directProfile = { id: 'direct', name: 'Direct Play', command: 'redirect' };
    const activeProfile = useDirectPlay
        ? directProfile
        : findProfileById(settings, profileId);
    const profile = useDirectPlay
        ? directProfile
        : selectVodTranscodeProfile(settings, activeProfile);

    if (!useDirectPlay && (!profileId || !userAgentId || !activeProfile || !profile)) {
        const errorMsg = 'Active stream profile or user agent not set/found. Cannot play VOD via profile. Please check settings.';
        showNotification(errorMsg, true);
        logToPlayerConsole(errorMsg, true);
        console.error(`[VOD_PLAYER] ${errorMsg}`);
        return;
    }

    logToPlayerConsole(`Using VOD playback profile: ${profile.name}`);

    const profileIdForStream = profile.id;
    const streamUrlToPlay = profile.command === 'redirect'
        ? url
        : `/stream?url=${encodeURIComponent(url)}&profileId=${profileIdForStream}&userAgentId=${userAgentId}&vodName=${encodeURIComponent(title)}&vodLogo=${encodeURIComponent(logo)}&vodClient=native`;

    console.log(`[VOD_PLAYER] Final VOD stream URL: ${streamUrlToPlay}`);
    logToPlayerConsole(`Final VOD stream URL: ${streamUrlToPlay}`);

    if (profile.command !== 'redirect') {
        currentLocalStreamUrl = url;
        currentProfileId = profileIdForStream;
    }

    // Always use native HTML5 video for browser VOD playback. The server-side /stream
    // guard remaps stale MPEG-TS live profile requests to MP4/fMP4 output, so routing
    // VOD through mpegts.js can mis-handle the MP4 response and race with cleanup.
    await playVodWithNativeVideo(streamUrlToPlay, title, logo, url, profile);
};

/**
 * Detects and populates available audio tracks in the menu.
 */
function updateAudioTrackList() {
    const video = UIElements.videoElement;
    const audioTracks = video.audioTracks;
    const listEl = document.getElementById('audio-track-list');
    const btnEl = document.getElementById('audio-track-btn');

    console.log('[AUDIO_TRACKS] Checking for audio tracks...');
    console.log('[AUDIO_TRACKS] audioTracks object:', audioTracks);
    console.log('[AUDIO_TRACKS] Number of tracks:', audioTracks ? audioTracks.length : 0);

    if (!audioTracks || audioTracks.length <= 1) {
        // Hide button if no multiple tracks
        console.log('[AUDIO_TRACKS] Not enough tracks, hiding button');
        btnEl?.classList.add('hidden');
        return;
    }

    console.log('[AUDIO_TRACKS] Multiple tracks found! Showing button and populating menu');
    btnEl?.classList.remove('hidden');
    if (!listEl) return;

    listEl.innerHTML = '';

    for (let i = 0; i < audioTracks.length; i++) {
        const track = audioTracks[i];
        console.log(`[AUDIO_TRACKS] Track ${i}:`, { label: track.label, language: track.language, enabled: track.enabled });
        const item = document.createElement('div');
        item.className = `px-4 py-2 cursor-pointer hover:bg-gray-700 transition-colors ${track.enabled ? 'bg-blue-600 font-semibold' : ''}`;
        item.textContent = track.label || track.language || `Track ${i + 1}`;
        item.onclick = () => selectAudioTrack(i);
        listEl.appendChild(item);
    }
}

/**
 * Selects an audio track by index.
 */
function selectAudioTrack(index) {
    const audioTracks = UIElements.videoElement.audioTracks;
    if (!audioTracks) return;

    for (let i = 0; i < audioTracks.length; i++) {
        audioTracks[i].enabled = (i === index);
    }
    updateAudioTrackList();
    document.getElementById('audio-track-menu')?.classList.add('hidden');
    showNotification(`Audio track switched`, false, 1500);
}

/**
 * Detects and populates available subtitle tracks in the menu.
 */
function updateSubtitleTrackList() {
    const video = UIElements.videoElement;
    const textTracks = video.textTracks;
    const listEl = document.getElementById('subtitle-track-list');
    const btnEl = document.getElementById('subtitle-track-btn');

    console.log('[SUBTITLES] Checking for subtitle tracks...');
    console.log('[SUBTITLES] textTracks object:', textTracks);
    console.log('[SUBTITLES] Number of tracks:', textTracks ? textTracks.length : 0);

    if (!textTracks || textTracks.length === 0) {
        console.log('[SUBTITLES] No subtitle tracks found, hiding button');
        btnEl?.classList.add('hidden');
        return;
    }

    console.log('[SUBTITLES] Subtitle tracks found! Showing button and populating menu');
    btnEl?.classList.remove('hidden');
    if (!listEl) return;

    listEl.innerHTML = '';

    // Add "Off" option
    const offItem = document.createElement('div');
    const anyShowing = Array.from(textTracks).some(t => t.mode === 'showing');
    offItem.className = `px-4 py-2 cursor-pointer hover:bg-gray-700 transition-colors ${!anyShowing ? 'bg-blue-600 font-semibold' : ''}`;
    offItem.textContent = 'Off';
    offItem.onclick = () => selectSubtitleTrack(-1);
    listEl.appendChild(offItem);

    // Add each track
    for (let i = 0; i < textTracks.length; i++) {
        const track = textTracks[i];
        console.log(`[SUBTITLES] Track ${i}:`, { label: track.label, language: track.language, kind: track.kind, mode: track.mode });
        const item = document.createElement('div');
        item.className = `px-4 py-2 cursor-pointer hover:bg-gray-700 transition-colors ${track.mode === 'showing' ? 'bg-blue-600 font-semibold' : ''}`;
        item.textContent = track.label || track.language || `Subtitle ${i + 1}`;
        item.onclick = () => selectSubtitleTrack(i);
        listEl.appendChild(item);
    }
}

/**
 * Selects a subtitle track by index (-1 for off).
 */
function selectSubtitleTrack(index) {
    const textTracks = UIElements.videoElement.textTracks;
    if (!textTracks) return;

    for (let i = 0; i < textTracks.length; i++) {
        textTracks[i].mode = (i === index) ? 'showing' : 'hidden';
    }
    updateSubtitleTrackList();
    document.getElementById('subtitle-track-menu')?.classList.add('hidden');
    showNotification(index === -1 ? 'Subtitles off' : 'Subtitle track switched', false, 1500);
}

/**
 * Sets up event listeners for the video player.
 */
export function setupPlayerEventListeners() {
    UIElements.closeModal.addEventListener('click', stopAndCleanupPlayer);

    // NEW: Add event listener for the refresh button
    const refreshBtn = document.getElementById('refresh-stream-btn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', forceRefreshStream);
    }


    UIElements.pipBtn.addEventListener('click', () => {
        if (document.pictureInPictureEnabled && UIElements.videoElement.readyState >= 3) {
            UIElements.videoElement.requestPictureInPicture().catch(() => showNotification("Could not enter Picture-in-Picture.", true));
        }
    });

    UIElements.streamInfoToggleBtn.addEventListener('click', () => {
        UIElements.streamInfoOverlay.classList.toggle('hidden');
    });

    // REMOVED: Redundant videoModal click listener handled by ui.js openModal

    // NEW: Aspect Ratio Lock Toggle
    const aspectRatioLockBtn = document.getElementById('aspect-ratio-lock-btn');
    if (aspectRatioLockBtn) {
        aspectRatioLockBtn.addEventListener('click', toggleAspectRatioLock);
        // Initialize button state
        updateAspectRatioLockButton();
    }

    if (UIElements.castBtn) {
        if (UIElements.castBtn.tagName === 'GOOGLE-CAST-LAUNCHER') {
            console.log('[PLAYER] Using native google-cast-launcher element for Cast session requests.');
        } else {
        UIElements.castBtn.addEventListener('click', () => {
            console.log('[PLAYER] Custom cast button clicked. Requesting session...');
            try {
                if (!castState.isAvailable) {
                    const detail = castState.initializationError || 'Cast SDK is not available in this browser/session.';
                    console.warn('[PLAYER] Cast clicked but SDK is unavailable.', {
                        isAvailable: castState.isAvailable,
                        initializationError: castState.initializationError
                    });
                    showNotification(`Cast is unavailable: ${detail}`, true, 9000);
                    return;
                }

                if (!castState.isInitialized) {
                    console.warn('[PLAYER] Cast clicked before CastContext initialization completed.', {
                        isAvailable: castState.isAvailable,
                        initializationError: castState.initializationError
                    });
                    const detail = castState.initializationError ? ` ${castState.initializationError}` : '';
                    showNotification(`Cast is still initializing. Please try again in a moment.${detail}`, true, 7000);
                    return;
                }

                const originDiagnostic = getCastOriginDiagnostic();
                if (originDiagnostic) {
                    console.warn('[PLAYER] Cast session request blocked because the page is not running in a Cast-supported secure context.', {
                        origin: window.location.origin,
                        hostname: window.location.hostname,
                        isSecureContext: window.isSecureContext,
                        isAvailable: castState.isAvailable,
                        isInitialized: castState.isInitialized
                    });
                    showNotification(`Cast is unavailable from this page: ${originDiagnostic}`, true, 10000);
                    return;
                }

                const castContext = cast.framework.CastContext.getInstance();
                castContext.requestSession().catch((error) => {
                    console.error('Error requesting cast session:', error, {
                        origin: window.location.origin,
                        hostname: window.location.hostname,
                        isSecureContext: window.isSecureContext,
                        castState,
                    });
                    if (error !== "cancel") {
                        const detail = typeof error === 'string' ? error : (error?.code || error?.description || 'unknown');
                        showNotification(`Could not initiate Cast session (${detail}). See console for details.`, true);
                    }
                });
            } catch (e) {
                console.error('Fatal Error: Cast framework is not available.', e);
                showNotification('Cast functionality is not available. Please try reloading.', true);
            }
        });
        }
    } else {
        console.error('[PLAYER] CRITICAL: Cast button #cast-btn NOT FOUND.');
    }

    UIElements.videoElement.addEventListener('enterpictureinpicture', () => closeModal(UIElements.videoModal));
    UIElements.videoElement.addEventListener('leavepictureinpicture', () => {
        if (appState.player && !UIElements.videoElement.paused) {
            openModal(UIElements.videoModal);
        } else {
            stopAndCleanupPlayer();
        }
    });

    UIElements.videoElement.addEventListener('volumechange', () => {
        localStorage.setItem('iptvPlayerVolume', UIElements.videoElement.volume);
    });

    // Audio track button
    const audioTrackBtn = document.getElementById('audio-track-btn');
    if (audioTrackBtn) {
        audioTrackBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const menu = document.getElementById('audio-track-menu');
            menu?.classList.toggle('hidden');
            document.getElementById('subtitle-track-menu')?.classList.add('hidden');
        });
    }

    // Subtitle track button
    const subtitleTrackBtn = document.getElementById('subtitle-track-btn');
    if (subtitleTrackBtn) {
        subtitleTrackBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const menu = document.getElementById('subtitle-track-menu');
            menu?.classList.toggle('hidden');
            document.getElementById('audio-track-menu')?.classList.add('hidden');
        });
    }

    // Close menus when clicking outside
    document.addEventListener('click', () => {
        document.getElementById('audio-track-menu')?.classList.add('hidden');
        document.getElementById('subtitle-track-menu')?.classList.add('hidden');
    });

    // Update track lists when stream loads
    UIElements.videoElement.addEventListener('loadedmetadata', () => {
        console.log('[PLAYER] Media metadata loaded, checking for audio/subtitle tracks...');
        // Small delay to ensure tracks are fully loaded
        setTimeout(() => {
            updateAudioTrackList();
            updateSubtitleTrackList();
        }, 500);
    });

    // Also check when tracks change
    UIElements.videoElement.addEventListener('addtrack', () => {
        console.log('[PLAYER] Track added, updating lists...');
        updateAudioTrackList();
        updateSubtitleTrackList();
    });
}

// --- Aspect Ratio Logic ---
let isAspectRatioLocked = true; // Default to locked

export const toggleAspectRatioLock = () => {
    isAspectRatioLocked = !isAspectRatioLocked;
    updateAspectRatioLockButton();

    // Visual feedback
    const btn = document.getElementById('aspect-ratio-lock-btn');
    if (btn) {
        // Optional: Show a toast or tooltip
        const icon = btn.querySelector('span');
        if (icon) {
            // Add a temporary animation class if desired
        }
    }
};

const updateAspectRatioLockButton = () => {
    const btn = document.getElementById('aspect-ratio-lock-btn');
    if (!btn) return;

    const iconSpan = btn.querySelector('span');
    if (isAspectRatioLocked) {
        btn.classList.add('text-blue-500');
        btn.classList.remove('text-gray-400');
        if (iconSpan) {
            iconSpan.innerHTML = ICONS.lock; // FIXED: Manually set SVG
            iconSpan.setAttribute('data-icon', 'lock');
        }
    } else {
        btn.classList.add('text-gray-400');
        btn.classList.remove('text-blue-500');
        if (iconSpan) {
            iconSpan.innerHTML = ICONS.unlock; // FIXED: Manually set SVG
            iconSpan.setAttribute('data-icon', 'unlock');
        }
    }
};

export const shouldMaintainAspectRatio = () => {
    return isAspectRatioLocked;
};

export const getVideoAspectRatio = () => {
    if (UIElements.videoElement && UIElements.videoElement.videoWidth && UIElements.videoElement.videoHeight) {
        return UIElements.videoElement.videoWidth / UIElements.videoElement.videoHeight;
    }
    return 16 / 9; // Default fallback
};
