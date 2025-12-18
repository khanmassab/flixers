let h = null;
let render = null;
let useEffect = null;
let useMemo = null;
let useRef = null;
let useState = null;
let html = null;

// Track whether the extension context has been invalidated
let extensionContextValid = true;

function isContextValid() {
  try {
    if (!chrome?.runtime?.id) {
      extensionContextValid = false;
      return false;
    }
    return extensionContextValid;
  } catch (_) {
    extensionContextValid = false;
    return false;
  }
}

function safeSend(message, callback) {
  if (!isContextValid()) return;
  try {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        const msg = chrome.runtime.lastError?.message || "";
        // Treat only actual invalidation as fatal; transient "no response" can happen during SW restarts.
        if (/Extension context invalidated/i.test(msg)) {
          extensionContextValid = false;
        }
        return;
      }
      if (callback) callback(response);
    });
  } catch (_) {
    extensionContextValid = false;
  }
}

// Listen for requests from popup/background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "get-video-state") {
    const video = document.querySelector("video");
    if (video) {
      sendResponse({
        t: video.currentTime,
        paused: video.paused,
        url: window.location.href,
        title: NetflixAdapter.getTitle ? NetflixAdapter.getTitle() : null,
      });
    } else {
      sendResponse(null);
    }
    return true;
  }
  
  // Sync to specific time when joining a room
  if (message.type === "sync-to-time") {
    const syncTime = () => {
      const video = document.querySelector("video");
      if (video && typeof message.time === "number") {
        try {
          video.currentTime = message.time;
          console.log("[Flixers] Synced to time:", message.time);
        } catch (err) {
          console.warn("[Flixers] Failed to sync time:", err);
        }
      }
    };
    
    // Try immediately, and retry after delays in case video isn't ready
    syncTime();
    setTimeout(syncTime, 1000);
    setTimeout(syncTime, 2000);
    setTimeout(syncTime, 4000);
    
    sendResponse({ ok: true });
    return true;
  }
});

function safeAddListener(handler) {
  if (!isContextValid()) return () => {};
  try {
    chrome.runtime.onMessage.addListener(handler);
    return () => {
      try {
        if (isContextValid()) {
          chrome.runtime.onMessage.removeListener(handler);
        }
      } catch (_) {}
    };
  } catch (_) {
    extensionContextValid = false;
    return () => {};
  }
}

function storageKey(roomId) {
  return `flixers-messages-${roomId}`;
}

function purgeRoomMessages(roomId) {
  if (!roomId || !chrome?.storage?.local) return;
  try {
    chrome.storage.local.remove([storageKey(roomId)], () => {});
  } catch (_) {
    // ignore
  }
}

function loadGlobals() {
  const lib = window.htmPreact || window.htm || window.preact || {};
  h = lib.h || lib.Fragment ? lib.h : null;
  render = lib.render || null;
  useEffect = lib.useEffect || null;
  useMemo = lib.useMemo || null;
  useRef = lib.useRef || null;
  useState = lib.useState || null;
  html = lib.html || (lib.bind ? lib.bind(h) : null) || null;
}

const BUILTIN_AVATARS = [
  { emoji: "🎬", bg: "linear-gradient(135deg,#ff9a9e,#fad0c4)" },
  { emoji: "🍿", bg: "linear-gradient(135deg,#a18cd1,#fbc2eb)" },
  { emoji: "🎟️", bg: "linear-gradient(135deg,#f6d365,#fda085)" },
  { emoji: "📺", bg: "linear-gradient(135deg,#5ee7df,#b490ca)" },
  { emoji: "✨", bg: "linear-gradient(135deg,#cfd9df,#e2ebf0)" },
  { emoji: "🌠", bg: "linear-gradient(135deg,#89f7fe,#66a6ff)" },
  { emoji: "🌃", bg: "linear-gradient(135deg,#434343,#000000)" },
  { emoji: "🎧", bg: "linear-gradient(135deg,#30cfd0,#330867)" },
  { emoji: "🎉", bg: "linear-gradient(135deg,#fddb92,#d1fdff)" },
  { emoji: "🧲", bg: "linear-gradient(135deg,#f6d242,#ff52e5)" },
];

// ============================================================================
// Netflix Adapter - Abstracts video control for Netflix-specific behavior
// Uses Netflix's internal Cadmium player API to avoid DRM issues
// ============================================================================

// Inject script into page context to access Netflix's internal API
const injectNetflixBridge = (() => {
  let injectionState = 'idle'; // idle, injecting, ready, failed
  let injectionAttempts = 0;
  const MAX_INJECTION_ATTEMPTS = 3;
  const pendingCallbacks = [];
  
  // Check if the bridge is actually working
  const verifyBridge = () => {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      let resolved = false;
      
      const handler = (e) => {
        if (e.detail?.id === id && !resolved) {
          resolved = true;
          window.removeEventListener('flixers-response', handler);
          resolve(e.detail.result?.success === true || e.detail.result?.state !== undefined);
        }
      };
      
      window.addEventListener('flixers-response', handler);
      
      // Timeout after 1 second
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          window.removeEventListener('flixers-response', handler);
          resolve(false);
        }
      }, 1000);
      
      // Send a test command
      window.dispatchEvent(new CustomEvent('flixers-command', {
        detail: { action: 'getState', data: {}, id }
      }));
    });
  };
  
  const doInject = () => {
    return new Promise((resolve, reject) => {
      injectionState = 'injecting';
      injectionAttempts++;
      
      console.log(`[Flixers] Injecting Netflix bridge (attempt ${injectionAttempts}/${MAX_INJECTION_ATTEMPTS})`);
      
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('netflix-bridge.js');
      
      script.onload = async () => {
        script.remove();
        console.log('[Flixers] Bridge script loaded, verifying...');
        
        // Wait a bit for the script to execute
        await new Promise(r => setTimeout(r, 100));
        
        // Verify the bridge is working
        const isWorking = await verifyBridge();
        if (isWorking) {
          console.log('[Flixers] Netflix bridge verified and working');
          injectionState = 'ready';
          resolve(true);
        } else {
          console.warn('[Flixers] Bridge loaded but not responding');
          injectionState = 'failed';
          reject(new Error('Bridge not responding'));
        }
      };
      
      script.onerror = (err) => {
        script.remove();
        console.error('[Flixers] Failed to load Netflix bridge script:', err);
        injectionState = 'failed';
        reject(new Error('Script load failed'));
      };
      
      (document.head || document.documentElement).appendChild(script);
    });
  };
  
  // Main inject function with retry
  const inject = async () => {
    // Already ready
    if (injectionState === 'ready') {
      // Double-check the bridge is still working
      const stillWorking = await verifyBridge();
      if (stillWorking) return true;
      
      console.log('[Flixers] Bridge stopped working, re-injecting...');
      injectionState = 'idle';
      injectionAttempts = 0;
    }
    
    // Already injecting, wait for result
    if (injectionState === 'injecting') {
      return new Promise((resolve) => {
        pendingCallbacks.push(resolve);
      });
    }
    
    // Try to inject with retries
    while (injectionAttempts < MAX_INJECTION_ATTEMPTS) {
      try {
        await doInject();
        // Notify any pending callbacks
        pendingCallbacks.forEach(cb => cb(true));
        pendingCallbacks.length = 0;
        return true;
      } catch (err) {
        console.warn(`[Flixers] Bridge injection attempt ${injectionAttempts} failed:`, err.message);
        
        if (injectionAttempts < MAX_INJECTION_ATTEMPTS) {
          // Wait before retry with exponential backoff
          const delay = 300 * Math.pow(2, injectionAttempts - 1);
          console.log(`[Flixers] Retrying bridge injection in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
          injectionState = 'idle'; // Reset for retry
        }
      }
    }
    
    console.error('[Flixers] Failed to inject bridge after all attempts');
    pendingCallbacks.forEach(cb => cb(false));
    pendingCallbacks.length = 0;
    return false;
  };
  
  // Force re-injection (useful when CSP errors detected)
  const forceReinject = () => {
    console.log('[Flixers] Force re-injection requested');
    injectionState = 'idle';
    injectionAttempts = 0;
    return inject();
  };
  
  const getState = () => injectionState;
  
  return { inject, forceReinject, getState, verifyBridge };
})();

// Call the Netflix API via the injected bridge with retry and reconnection support
const callNetflixAPI = async (action, data = {}, retries = 3) => {
  let attempts = 0;
  let reinjectAttempted = false;
  
  const attemptCall = () => {
    return new Promise((resolve) => {
      attempts++;
      const id = Math.random().toString(36).slice(2);
      let resolved = false;
      
      const handler = (e) => {
        if (e.detail?.id === id && !resolved) {
          resolved = true;
          window.removeEventListener('flixers-response', handler);
          resolve(e.detail.result);
        }
      };
      
      window.addEventListener('flixers-response', handler);
      
      // Timeout after 2 seconds
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          window.removeEventListener('flixers-response', handler);
          resolve({ success: false, error: 'Timeout', isTimeout: true });
        }
      }, 2000);
      
      window.dispatchEvent(new CustomEvent('flixers-command', {
        detail: { action, data, id }
      }));
    });
  };
  
  while (attempts <= retries) {
    // Ensure bridge is injected before each attempt
    const bridgeState = injectNetflixBridge.getState();
    if (bridgeState !== 'ready') {
      console.log(`[NetflixAPI] Bridge not ready (state: ${bridgeState}), injecting...`);
      const injected = await injectNetflixBridge.inject();
      if (!injected) {
        console.error('[NetflixAPI] Failed to inject bridge');
        return { success: false, error: 'Bridge injection failed' };
      }
    }
    
    const result = await attemptCall();
    
    // Success - return result
    if (result.success) {
      return result;
    }
    
    // Timeout might indicate bridge died (CSP issue or page navigation)
    if (result.isTimeout && !reinjectAttempted) {
      console.log('[NetflixAPI] Timeout detected, attempting bridge re-injection...');
      reinjectAttempted = true;
      
      // Force re-inject the bridge
      const reinjected = await injectNetflixBridge.forceReinject();
      if (reinjected) {
        console.log('[NetflixAPI] Bridge re-injected, retrying...');
        // Don't count this as an attempt, give it another chance
        attempts--;
      }
    }
    
    // More attempts left
    if (attempts < retries) {
      console.log(`[NetflixAPI] ${action} failed (${result.error}), retrying (${attempts}/${retries})...`);
      await new Promise(r => setTimeout(r, 300 * attempts)); // Exponential backoff
    }
  }
  
  return { success: false, error: 'Failed after all retries' };
};

const NetflixAdapter = (() => {
  let cachedVideo = null;
  let lastVideoCheck = 0;
  const VIDEO_CACHE_TTL = 500; // Re-check video every 500ms max

  // Ensure bridge is injected (async)
  const ensureBridge = async () => {
    const state = injectNetflixBridge.getState();
    if (state !== 'ready') {
      return await injectNetflixBridge.inject();
    }
    return true;
  };

  // Find the main video element (Netflix can have multiple/recreate them)
  const findVideo = () => {
    const now = Date.now();
    if (cachedVideo && now - lastVideoCheck < VIDEO_CACHE_TTL) {
      // Verify cached video is still valid
      if (cachedVideo.isConnected && cachedVideo.readyState >= 1) {
        return cachedVideo;
      }
    }
    
    lastVideoCheck = now;
    
    // Strategy 1: Main video with good readyState
    let v = document.querySelector("video");
    if (v && v.readyState >= 1 && v.duration > 0) {
      cachedVideo = v;
      return v;
    }
    
    // Strategy 2: Netflix watch container
    v = document.querySelector(".watch-video video");
    if (v && v.readyState >= 1) {
      cachedVideo = v;
      return v;
    }
    
    // Strategy 3: Any video with significant duration (not a preview)
    const videos = document.querySelectorAll("video");
    for (const vid of videos) {
      if (vid.duration > 60 && vid.readyState >= 1) {
        cachedVideo = vid;
        return vid;
      }
    }
    
    // Fallback: first video
    cachedVideo = videos[0] || null;
    return cachedVideo;
  };

  // Get current playback state
  const getState = () => {
    const v = findVideo();
    if (!v) return null;
    return {
      t: v.currentTime,
      paused: v.paused,
      duration: v.duration,
      rate: v.playbackRate,
      url: window.location.href,
      title: getTitle(),
    };
  };

  // Try to read the title from Netflix UI
  const getTitle = () => {
    try {
      const normalizeTitle = (raw) => {
        if (!raw) return null;
        let t = raw.replace(/\s+/g, " ").trim();
        t = t.replace(/([A-Za-z])([0-9])/g, "$1 $2");
        t = t.replace(/([0-9])([A-Za-z])/g, "$1 $2");
        t = t.replace(/:\s*/g, ": ");
        // Normalize season/episode tokens: collapse internal spaces then pad with spaces around them
        t = t.replace(/([SsEe])\s+(\d+)/g, "$1$2"); // E 5 -> E5
        t = t.replace(/(Ep)\s+(\d+)/gi, "$1$2");
        t = t.replace(/([A-Za-z])([SsEe](?:p)?\d+)/g, "$1 $2"); // Stranger ThingsE5 -> Stranger Things E5
        t = t.replace(/([SsEe](?:p)?\d+)([A-Za-z])/g, "$1 $2"); // E5Chapter -> E5 Chapter
        if (/^netflix$/i.test(t)) return null;
        return t;
      };

      const selectors = [
        '[data-uia="video-title"]',
        '.video-title',
        '.ellipsize-text',
        '.PlayerControlsNeo__button-control-row .text-title', // fallback
        'title',
      ];
      // Preferred: explicit Netflix UI labels
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          const text = (el.textContent || "").trim();
          const normalized = normalizeTitle(text);
          if (normalized) return normalized;
        }
      }
      // Next: social meta tags (often contain full title)
      const metaCandidates = [
        'meta[property="og:title"]',
        'meta[name="og:title"]',
        'meta[name="twitter:title"]',
      ];
      for (const sel of metaCandidates) {
        const meta = document.querySelector(sel);
        const text = (meta?.content || "").trim();
        const normalized = normalizeTitle(text && text.replace(/ - Netflix$/i, "").trim());
        if (normalized) {
          return normalized;
        }
      }
      // Fallback: document title
      const docTitle = normalizeTitle((document.title || "").replace(/ - Netflix$/i, "").trim());
      if (docTitle) return docTitle;
      return null;
    } catch (_) {
      return null;
    }
  };

  // Seek using Netflix's internal API (preferred) or scrubber interaction (fallback)
  const seekTo = async (time, maxAttempts = 3) => {
    // Ensure bridge is ready before seeking
    const bridgeReady = await ensureBridge();
    if (!bridgeReady) {
      console.warn("[NetflixAdapter] Bridge not ready, seek may fail");
    }
    
    const v = findVideo();
    if (!v || typeof time !== "number") return false;
    
    const currentTime = v.currentTime;
    const diff = Math.abs(currentTime - time);
    
    // Already close enough (within 3 seconds)
    if (diff < 3) {
      console.log("[NetflixAdapter] Already at target time, skipping seek");
      return true;
    }
    
    console.log(`[NetflixAdapter] Seeking from ${currentTime.toFixed(1)} to ${time.toFixed(1)} (diff: ${diff.toFixed(1)}s)`);
    
    // Try Netflix's internal player API first (this respects DRM)
    let seekSucceeded = false;
    
    for (let attempt = 1; attempt <= maxAttempts && !seekSucceeded; attempt++) {
      try {
        const result = await callNetflixAPI('seek', { timeMs: time * 1000 });
        if (result.success) {
          console.log(`[NetflixAdapter] Seek API call succeeded (attempt ${attempt})`);
          
          // Wait and verify the seek actually worked
          await new Promise(r => setTimeout(r, 400));
          
          const newVideo = findVideo();
          if (newVideo) {
            const newDiff = Math.abs(newVideo.currentTime - time);
            if (newDiff < 10) {
              console.log(`[NetflixAdapter] Seek verified, now at ${newVideo.currentTime.toFixed(1)}s (diff: ${newDiff.toFixed(1)}s)`);
              seekSucceeded = true;
            } else {
              console.log(`[NetflixAdapter] Seek not effective, still ${newDiff.toFixed(1)}s away (attempt ${attempt})`);
            }
          }
        } else {
          console.log(`[NetflixAdapter] Netflix API seek failed (attempt ${attempt}):`, result.error);
          
          // If multiple failures, try re-injecting the bridge (might be CSP issue)
          if (attempt >= 2 && result.error?.includes('Timeout')) {
            console.log('[NetflixAdapter] Multiple timeouts, forcing bridge re-injection...');
            await injectNetflixBridge.forceReinject();
          }
        }
      } catch (err) {
        console.warn(`[NetflixAdapter] Netflix API seek error (attempt ${attempt}):`, err.message);
      }
      
      // Wait before next attempt with exponential backoff
      if (!seekSucceeded && attempt < maxAttempts) {
        const delay = 300 * attempt;
        await new Promise(r => setTimeout(r, delay));
      }
    }
    
    if (seekSucceeded) {
      return true;
    }
    
    // Fallback: Use scrubber interaction
    console.log("[NetflixAdapter] Using scrubber fallback for seek");
    const duration = v.duration || 0;
    if (duration > 0) {
      const scrubResult = await seekViaScrubberWithVerify(time, duration);
      return scrubResult;
    }
    
    return false;
  };

  // Seek by simulating click on Netflix's progress bar
  const seekViaScrubber = (targetTime, duration) => {
    try {
      // First, show controls
      showPlayerControls();
      
      // Wait a moment for controls to appear, then seek
      setTimeout(() => {
        // Find Netflix's scrubber/progress bar - try multiple selectors
        const scrubber = document.querySelector('[data-uia="timeline-bar"]') ||
                         document.querySelector('[data-uia="timeline"]') ||
                         document.querySelector('.watch-video--advancement-container') ||
                         document.querySelector('[class*="scrubber"]') ||
                         document.querySelector('[class*="timeline"]');
        
        if (!scrubber) {
          console.warn("[NetflixAdapter] Could not find scrubber element");
          return false;
        }
        
        performScrubberSeek(scrubber, targetTime, duration);
      }, 300);
      
      return true;
    } catch (err) {
      console.warn("[NetflixAdapter] Scrubber seek failed:", err.message);
      return false;
    }
  };

  // Async version with verification
  const seekViaScrubberWithVerify = async (targetTime, duration) => {
    try {
      // Show controls first
      showPlayerControls();
      
      // Wait for controls to appear (increased delay)
      await new Promise(r => setTimeout(r, 500));
      
      // Try multiple times with different selectors
      const scrubberSelectors = [
        '[data-uia="timeline-bar"]',
        '[data-uia="timeline"]',
        '.watch-video--advancement-container',
        '[class*="scrubber"]',
        '[class*="timeline"]',
        '.PlayerControlsNeo__progress',
        '.slider'
      ];
      
      let scrubber = null;
      for (const selector of scrubberSelectors) {
        scrubber = document.querySelector(selector);
        if (scrubber && scrubber.getBoundingClientRect().width > 50) {
          console.log(`[NetflixAdapter] Found scrubber with selector: ${selector}`);
          break;
        }
        scrubber = null;
      }
      
      if (!scrubber) {
        console.warn("[NetflixAdapter] Could not find usable scrubber element");
        return false;
      }
      
      performScrubberSeek(scrubber, targetTime, duration);
      
      // Wait and verify
      await new Promise(r => setTimeout(r, 600));
      
      const v = findVideo();
      if (v) {
        const newDiff = Math.abs(v.currentTime - targetTime);
        if (newDiff < 15) {
          console.log(`[NetflixAdapter] Scrubber seek worked, now at ${v.currentTime.toFixed(1)}s`);
          return true;
        }
        console.log(`[NetflixAdapter] Scrubber seek may not have worked, diff: ${newDiff.toFixed(1)}s`);
      }
      
      return false;
    } catch (err) {
      console.warn("[NetflixAdapter] Scrubber seek failed:", err.message);
      return false;
    }
  };

  const performScrubberSeek = (scrubber, targetTime, duration) => {
    const rect = scrubber.getBoundingClientRect();
    const percentage = Math.max(0, Math.min(1, targetTime / duration));
    const clickX = rect.left + (rect.width * percentage);
    const clickY = rect.top + (rect.height / 2);
    
    console.log(`[NetflixAdapter] Clicking scrubber at ${(percentage * 100).toFixed(1)}% (x: ${clickX.toFixed(0)}, y: ${clickY.toFixed(0)})`);
    
    // Dispatch pointer events (more reliable than mouse events for modern Netflix)
    const pointerDownEvent = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      clientX: clickX,
      clientY: clickY,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true
    });
    
    const pointerUpEvent = new PointerEvent('pointerup', {
      bubbles: true,
      cancelable: true,
      clientX: clickX,
      clientY: clickY,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true
    });
    
    const clickEvent = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: clickX,
      clientY: clickY,
      button: 0,
      view: window
    });
    
    scrubber.dispatchEvent(pointerDownEvent);
    scrubber.dispatchEvent(pointerUpEvent);
    scrubber.dispatchEvent(clickEvent);
    
    return true;
  };

  // Show Netflix player controls by simulating mouse movement
  const showPlayerControls = () => {
    const watchContainer = document.querySelector('.watch-video') || 
                           document.querySelector('[data-uia="video-canvas"]') ||
                           document.querySelector('.VideoContainer');
    
    if (watchContainer) {
      const rect = watchContainer.getBoundingClientRect();
      
      const mousemoveEvent = new MouseEvent('mousemove', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.bottom - 100, // Near the bottom where controls appear
        view: window
      });
      
      watchContainer.dispatchEvent(mousemoveEvent);
    }
  };

  // Set paused state using Netflix API or native controls
  const setPaused = async (paused) => {
    // Ensure bridge is ready
    const bridgeReady = await ensureBridge();
    if (!bridgeReady) {
      console.warn("[NetflixAdapter] Bridge not ready for play/pause");
    }
    
    const v = findVideo();
    if (!v) return false;
    
    const needsPause = paused && !v.paused;
    const needsPlay = !paused && v.paused;
    
    if (!needsPause && !needsPlay) {
      return true; // Already in desired state
    }
    
    // Try Netflix's internal API first
    try {
      const action = needsPause ? 'pause' : 'play';
      const result = await callNetflixAPI(action);
      if (result.success) {
        console.log(`[NetflixAdapter] ${action} via Netflix API successful`);
        return true;
      }
      console.log(`[NetflixAdapter] Netflix API ${action} failed:`, result.error);
    } catch (err) {
      console.warn("[NetflixAdapter] Netflix API play/pause error:", err.message);
    }
    
    // Fallback to native video element
    try {
      if (needsPause) {
        console.log("[NetflixAdapter] Pausing video (native fallback)");
        v.pause();
      } else if (needsPlay) {
        console.log("[NetflixAdapter] Playing video (native fallback)");
        await v.play().catch(e => {
          console.log("[NetflixAdapter] Play failed (user gesture required):", e.message);
        });
      }
      return true;
    } catch (err) {
      console.warn("[NetflixAdapter] Play/pause failed:", err.message);
      return false;
    }
  };

  // Check if video is ready for operations
  const isReady = () => {
    const v = findVideo();
    return v && v.readyState >= 2 && v.duration > 0;
  };

  // Invalidate cache (call when video is known to have changed)
  const invalidateCache = () => {
    cachedVideo = null;
    lastVideoCheck = 0;
  };

  // Wire event listeners to video element
  const wireListeners = (handlers) => {
    const v = findVideo();
    if (!v) return null;
    
    const { onPlay, onPause, onSeeked, onTimeUpdate } = handlers;
    
    if (onPlay) v.addEventListener("play", onPlay, { passive: true });
    if (onPause) v.addEventListener("pause", onPause, { passive: true });
    if (onSeeked) v.addEventListener("seeked", onSeeked, { passive: true });
    if (onTimeUpdate) v.addEventListener("timeupdate", onTimeUpdate, { passive: true });
    
    // Return unwire function
    return () => {
      if (onPlay) v.removeEventListener("play", onPlay);
      if (onPause) v.removeEventListener("pause", onPause);
      if (onSeeked) v.removeEventListener("seeked", onSeeked);
      if (onTimeUpdate) v.removeEventListener("timeupdate", onTimeUpdate);
    };
  };

  return {
    findVideo,
    getState,
    seekTo,
    setPaused,
    isReady,
    invalidateCache,
    wireListeners,
    getTitle,
  };
})();

// ============================================================================
// PlayerSync - Coordinates sync between room participants using NetflixAdapter
// ============================================================================
const PlayerSync = (() => {
  let video = null;
  let suppressNext = false;
  let observer = null;
  let isInRoom = false;
  let eventsWired = false;
  let syncRequestSent = false;
  let lastEpisodePath = null;
  let lastEpisodeChangeTs = 0;
  const lastEpisodeSeqBySender = new Map();
  let lastSyncTargetPath = null;
  let pendingNavigationTarget = null;
  let titleRetryTimer = null;
  let titleRetryTargetPath = null;
  let lastDriftWarning = 0;
  let pollInterval = null;

  // Use adapter for video finding
  const getVideo = () => NetflixAdapter.findVideo();

  const setInRoom = (inRoom) => {
    isInRoom = inRoom;
    if (inRoom) {
      // Only start observing when joining a room
      startObservingIfNeeded();
      attach();
      // Reset sync request state
      syncRequestSent = false;
      // Start polling as backup
      startPolling();
    } else {
      // Clean up when leaving room
      video = null;
      wiredVideoElement = null;
      eventsWired = false;
      syncRequestSent = false;
      lastEpisodePath = null;
      lastEpisodeChangeTs = 0;
      lastEpisodeSeqBySender.clear();
      lastSyncTargetPath = null;
      pendingNavigationTarget = null;
      if (titleRetryTimer) {
        clearInterval(titleRetryTimer);
        titleRetryTimer = null;
        titleRetryTargetPath = null;
      }
      stopPolling();
      // Disconnect observer
      if (observer) {
        observer.disconnect();
        observer = null;
      }
    }
  };

  let wiredVideoElement = null;  // Track which element has listeners

  // Polling as fallback - MutationObserver can miss some cases
  const startPolling = () => {
    if (pollInterval) return;
    pollInterval = setInterval(() => {
      if (!isInRoom) return;
      announceEpisodeIfChanged();
      const v = getVideo();
      if (v && v !== wiredVideoElement) {
        console.log("[Flixers] Poll detected new video element");
        attach();
      }
    }, 2000);  // Check every 2 seconds
  };

  const stopPolling = () => {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  };

  const startObservingIfNeeded = () => {
    if (observer) return;
    observer = new MutationObserver(() => {
      if (!isInRoom) return;
      const hasVideo = getVideo();
      if (!hasVideo && video) {
        video = null;
        wiredVideoElement = null;
        eventsWired = false;
        syncRequestSent = false;
        safeSend({ type: "player-present", present: false, playing: false, url: null });
      }
      if (hasVideo && hasVideo !== wiredVideoElement) {
        attach();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  };
  
  const attach = () => {
    if (!isInRoom) return;
    const candidate = getVideo();
    if (!candidate) return;
    
    video = candidate;
    
    // Re-wire if this is a different video element than before
    if (wiredVideoElement !== video) {
      console.log("[Flixers] Wiring video element listeners");
      wirePlayer(video);
      wiredVideoElement = video;
      eventsWired = true;
    }
    
    announceEpisodeIfChanged();
    announcePlayer();
    
    // Request sync when video becomes ready (for joiners or after navigation)
    if (pendingNavigationTarget) {
      const currentPath = window.location.pathname;
      if (currentPath === pendingNavigationTarget) {
        console.log("[Flixers] Navigation landed on target episode, requesting sync");
        syncRequestSent = false;
        pendingNavigationTarget = null;
        requestSyncIfNeeded(500);
      }
    } else {
      requestSyncIfNeeded();
    }
  };

  const announcePlayer = () => {
    if (!video) return;
    safeSend({
      type: "player-present",
      present: true,
      playing: !video.paused,
      url: window.location.href,
      title: NetflixAdapter.getTitle ? NetflixAdapter.getTitle() : null,
    });
  };
  
  // Request sync state from other peers (for joiners)
    const requestSyncIfNeeded = (delayMs = 1500) => {
      if (!isInRoom || !video || syncRequestSent) return;
      
      // Wait a moment for video to be ready before requesting sync
      setTimeout(() => {
        if (!isInRoom || !video || syncRequestSent) return;
        
        console.log("[Flixers] Video ready, requesting sync from peers");
        syncRequestSent = true;
        safeSend({ type: "request-sync" });
      }, delayMs);
  };
  
  // Manual resync triggered by user
  const requestResync = () => {
    if (!isInRoom) return;
    console.log("[Flixers] Manual resync requested");
    syncRequestSent = false;
    safeSend({ type: "request-sync" });
  };

  const announceEpisodeIfChanged = () => {
    try {
      const path = new URL(window.location.href).pathname;
      if (!path.includes("/watch/")) return;
      if (lastEpisodePath === path) return;
      
      // If we navigated here due to a remote resync/episode-change, don't re-announce it
      // (prevents duplicate "next episode" messages and ping-pong navigation).
      if (lastSyncTargetPath && lastSyncTargetPath === path) {
        lastEpisodePath = path;
        lastEpisodeChangeTs = lastEpisodeChangeTs || Date.now();
        lastSyncTargetPath = null;
        return;
      }
      
      const ts = Date.now();
      const initialTitle = NetflixAdapter.getTitle ? NetflixAdapter.getTitle() : null;
      lastEpisodePath = path;
      lastEpisodeChangeTs = ts;
      safeSend({ type: "episode-changed", url: window.location.href, ts, title: initialTitle });
      // Re-try sending once the new title is actually visible (Netflix can update it late).
      if (titleRetryTimer) {
        clearInterval(titleRetryTimer);
      }
      titleRetryTargetPath = path;
      const startedAt = Date.now();
      titleRetryTimer = setInterval(() => {
        if (!isInRoom) {
          clearInterval(titleRetryTimer);
          titleRetryTimer = null;
          titleRetryTargetPath = null;
          return;
        }
        if (window.location.pathname !== titleRetryTargetPath) {
          clearInterval(titleRetryTimer);
          titleRetryTimer = null;
          titleRetryTargetPath = null;
          return;
        }
        const delayedTitle = NetflixAdapter.getTitle ? NetflixAdapter.getTitle() : null;
        if (delayedTitle && delayedTitle !== initialTitle) {
          safeSend({ type: "episode-changed", url: window.location.href, ts, title: delayedTitle });
          clearInterval(titleRetryTimer);
          titleRetryTimer = null;
          titleRetryTargetPath = null;
          return;
        }
        if (Date.now() - startedAt > 15000) {
          clearInterval(titleRetryTimer);
          titleRetryTimer = null;
          titleRetryTargetPath = null;
        }
      }, 500);
    } catch (_) {
      // ignore URL parse errors
    }
  };

  const forceNavigateToEpisode = (url, ts, sender, seq) => {
    if (!url) return false;
    let targetPath = null;
    try {
      targetPath = new URL(url).pathname;
    } catch (_) {
      return false;
    }
    if (!targetPath.includes("/watch/")) return false;
    const currentPath = window.location.pathname;
    const nowTs = typeof ts === "number" ? ts : Date.now();
    if (currentPath === targetPath) {
      // Already there; record seq/timestamp for dedupe
      if (sender && seq !== undefined && seq !== null) {
        lastEpisodeSeqBySender.set(sender, seq);
      }
      lastEpisodeChangeTs = Math.max(lastEpisodeChangeTs, nowTs);
      return false;
    }
    lastSyncTargetPath = targetPath;
    pendingNavigationTarget = targetPath;
    syncRequestSent = false;
    if (sender && seq !== undefined && seq !== null) {
      lastEpisodeSeqBySender.set(sender, seq);
    }
    lastEpisodeChangeTs = Math.max(lastEpisodeChangeTs, nowTs);
    console.log("[Flixers] Direct navigation to new episode:", { url, sender, seq, ts: nowTs, currentPath });
    window.location.href = url;
    return true;
  };

  const wirePlayer = (el) => {
    // Track play/pause and seek events to sync with room
    el.addEventListener("play", throttle(handlePlayEvent, 1000), { passive: true });
    el.addEventListener("pause", throttle(handlePauseEvent, 1000), { passive: true });
    el.addEventListener("seeked", throttle(handleSeekEvent, 2000), { passive: true });
    // Periodic time updates for drift detection
    el.addEventListener("timeupdate", throttle(handleTimeUpdate, 30000), { passive: true });
  };

  const handlePlayEvent = () => {
    if (!isInRoom || suppressNext) return;
    console.log("[Flixers] Play event - broadcasting to room");
    sendState("play");
  };

  const handlePauseEvent = () => {
    if (!isInRoom || suppressNext) return;
    console.log("[Flixers] Pause event - broadcasting to room");
    sendState("pause");
  };

  const handleSeekEvent = () => {
    if (!isInRoom || suppressNext) return;
    const state = NetflixAdapter.getState();
    if (!state) return;
    
    const lastTime = handleSeekEvent._lastTime || 0;
    const currentTime = state.t;
    const diff = Math.abs(currentTime - lastTime);
    handleSeekEvent._lastTime = currentTime;
    
    // Broadcast seeks of more than 3 seconds
    if (diff > 3) {
      console.log("[Flixers] Seek event:", diff.toFixed(1), "s - broadcasting to room");
      sendState("seek");
    }
  };
  handleSeekEvent._lastTime = 0;

  const handleTimeUpdate = () => {
    if (!isInRoom) return;
    const state = NetflixAdapter.getState();
    if (state) handleSeekEvent._lastTime = state.t;
  };

  const sendState = (reason) => {
    if (suppressNext || !isInRoom) return;
    
    const state = serializeState(reason);
    if (!state) return;  // No video available
    
    // Debounce - 1 second between state updates
    const now = Date.now();
    if (sendState._lastSend && now - sendState._lastSend < 1000) {
      return;
    }
    sendState._lastSend = now;
    
    safeSend({
      type: "player-event",
      payload: state,
    });
  };
  sendState._lastSend = 0;

  const serializeState = (reason) => {
    const state = NetflixAdapter.getState();
    if (!state) return null;
    return {
      t: state.t,
      paused: state.paused,
      rate: state.rate,
      reason,
      ts: Date.now(),
      url: state.url,
      title: state.title,
    };
  };

  const applyState = async (payload, isRetry = false, retryContext = {}) => {
    if (!payload) return;
    const incomingTs = typeof payload.ts === "number" ? payload.ts : Date.now();
    payload.ts = incomingTs;
    let targetPath = null;
    if (payload.url) {
      try {
        targetPath = new URL(payload.url).pathname;
      } catch (_) {
        targetPath = null;
      }
    }
    
    // Deduplicate: don't process the same sync request twice (unless it's a retry)
    const payloadKey = `${incomingTs}-${payload.t}`;
    if (!isRetry && applyState._lastPayloadKey === payloadKey) {
      console.log("[Flixers] Duplicate sync request ignored");
      return;
    }
    
    if (payload.reason === "resync") {
      const sender = payload.fromId || payload.from || "peer";
      const seq = Number.isFinite(payload.seq) ? Number(payload.seq) : null;
      const prevSeq = lastEpisodeSeqBySender.get(sender);
      const targetMatchesCurrent =
        (targetPath && targetPath === window.location.pathname) ||
        (targetPath && targetPath === lastEpisodePath);
      if (
        !isRetry &&
        ((seq !== null && typeof prevSeq === "number" && seq <= prevSeq) ||
          (seq === null && targetMatchesCurrent && incomingTs <= lastEpisodeChangeTs))
      ) {
        console.log("[Flixers] Ignoring stale resync/episode-change", {
          incomingTs,
          lastEpisodeChangeTs,
          seq,
          prevSeq,
          targetPath,
          currentPath: window.location.pathname,
          lastEpisodePath,
        });
        return;
      }
      if (!isRetry) {
        if (seq !== null) {
          lastEpisodeSeqBySender.set(sender, seq);
        }
        lastEpisodeChangeTs = Math.max(lastEpisodeChangeTs, incomingTs);
      }
    }
    
    console.log("[Flixers] applyState called with:", JSON.stringify(payload), isRetry ? "(retry)" : "");
    
    // Track retry context
    const ctx = retryContext.retryCount !== undefined ? retryContext : { retryCount: 0, bridgeRetried: false };

    // Fast-path navigation for explicit episode changes, even if the player isn't ready yet
    if (payload.reason === "resync" && payload.url && targetPath) {
      const currentPath = window.location.pathname;
      if (targetPath.includes("/watch/") && currentPath !== targetPath) {
        if (pendingNavigationTarget && pendingNavigationTarget === targetPath) {
          console.log("[Flixers] Navigation already pending to", targetPath);
        } else {
          lastSyncTargetPath = targetPath;
          pendingNavigationTarget = targetPath;
          syncRequestSent = false; // allow fresh sync after landing
          applyState._lastPayloadKey = payloadKey; // mark processed to avoid re-looping
          console.log("[Flixers] Fast navigation to new episode:", payload.url);
          window.location.href = payload.url;
          return;
        }
      }
    }
    
    // Use adapter to check if video is ready
    if (!NetflixAdapter.isReady()) {
      // Retry after a short delay - Netflix might be recreating the player
      if (ctx.retryCount < 10) { // 10 retries for video ready
        ctx.retryCount++;
        const delay = Math.min(400 * ctx.retryCount, 2500); // Exponential backoff
        console.log(`[Flixers] Video not ready, retry ${ctx.retryCount}/10 in ${delay}ms`);
        setTimeout(() => applyState(payload, true, ctx), delay);
      } else {
        console.log("[Flixers] Video never became ready after retries");
        applyState._lastPayloadKey = payloadKey;
      }
      return;
    }
    
    // Ensure bridge is ready before proceeding
    const bridgeState = injectNetflixBridge.getState();
    if (bridgeState !== 'ready' && !ctx.bridgeRetried) {
      console.log("[Flixers] Bridge not ready, injecting before sync...");
      ctx.bridgeRetried = true;
      const bridgeInjected = await injectNetflixBridge.inject();
      if (!bridgeInjected) {
        console.warn("[Flixers] Bridge injection failed, will try scrubber fallback");
      }
    }
    
    // Update our local video reference
    video = NetflixAdapter.findVideo();
    
    // Check if we're on the right video; allow navigation when target differs, with loop protection
    if (payload?.url) {
      const currentPath = window.location.pathname;
      // Only navigate on explicit resync/episode-change events.
      // Normal playback state updates should never force cross-episode navigation.
      const navigationAllowed = payload.reason === "resync";
      try {
        const navTargetPath = new URL(payload.url).pathname;
        const targetIsWatch = navTargetPath.includes("/watch/");

        if (targetIsWatch && currentPath !== navTargetPath) {
          // Loop protection: if we're already navigating to this target, ignore duplicates
          if (pendingNavigationTarget && pendingNavigationTarget === navTargetPath) {
            console.log("[Flixers] Already navigating to target episode:", navTargetPath);
            return;
          }
          
          // Only allow navigation for explicit resync flows
          if (navigationAllowed) {
            lastSyncTargetPath = navTargetPath;
            pendingNavigationTarget = navTargetPath;
            syncRequestSent = false; // allow a fresh sync after navigation
            console.log("[Flixers] Navigating to new episode for sync:", payload.url);
            window.location.href = payload.url;
            return;
          }
          
          // Ignore cross-episode navigation attempts from non-resync messages
          console.log(
            "[Flixers] Ignoring cross-episode navigation attempt (reason=" +
              payload.reason +
              "):",
            navTargetPath
          );
          return;
        } else if (targetIsWatch && currentPath === navTargetPath) {
          // We are on the target path now; clear target so future syncs apply
          lastSyncTargetPath = null;
          pendingNavigationTarget = null;
        }
      } catch (_) {
        // URL parse error, continue anyway
      }
    }
    
    // Handle live control updates (play/pause/seek) even outside initial sync
    const isInitialSync = payload.reason === "sync";
    const isControl = payload.reason === "play" || payload.reason === "pause" || payload.reason === "seek";
    console.log("[Flixers] isInitialSync:", isInitialSync, "reason:", payload.reason);
    
    if (!isInitialSync && isControl) {
      const state = NetflixAdapter.getState();
      const targetTime = typeof payload.t === "number" ? payload.t : null;
      const shouldSeek =
        targetTime !== null && state?.t !== undefined && Math.abs(state.t - targetTime) > 1.0;
      suppressNext = true;
      try {
        if (shouldSeek) {
          await NetflixAdapter.seekTo(targetTime);
        }
        if (typeof payload.paused === "boolean") {
          await NetflixAdapter.setPaused(payload.paused);
        }
      } catch (err) {
        console.warn("[Flixers] Error applying live control:", err.message);
      } finally {
        setTimeout(() => { suppressNext = false; }, 600);
      }
      return;
    }
    
    if (!isInitialSync) {
      // For other ongoing updates, just log drift but don't try to control video
      const state = NetflixAdapter.getState();
      if (state && typeof payload.t === "number") {
        const timeDiff = Math.abs(state.t - payload.t);
        if (timeDiff > 10) {
          const now = Date.now();
          if (now - lastDriftWarning > 30000) {
            lastDriftWarning = now;
            console.log("[Flixers] Drift detected:", timeDiff.toFixed(1), "s - use Resync button");
          }
        }
      }
      return;
    }
    
    // Debounce rapid sync requests (reduced from 500 to 300ms)
    const now = Date.now();
    if (!isRetry && applyState._lastApply && now - applyState._lastApply < 300) {
      console.log("[Flixers] Debounced - too soon after last apply");
      return;
    }
    applyState._lastApply = now;
    
    // Get current state for logging
    const currentState = NetflixAdapter.getState();
    const timeDiff = currentState && typeof payload.t === "number" 
      ? Math.abs(currentState.t - payload.t) 
      : 0;
    
    console.log("[Flixers] Sync - target:", payload.t?.toFixed(1), "current:", currentState?.t?.toFixed(1), "diff:", timeDiff.toFixed(1) + "s");
    
    // Skip if already close enough
    if (timeDiff < 3) {
      console.log("[Flixers] Already synced (within 3s), skipping seek");
      applyState._lastPayloadKey = payloadKey;
      // Still apply play/pause state
      if (typeof payload.paused === "boolean") {
        suppressNext = true;
        try {
          await NetflixAdapter.setPaused(payload.paused);
        } catch (err) {
          console.warn("[Flixers] Error setting paused state:", err.message);
        }
        setTimeout(() => { suppressNext = false; }, 500);
      }
      return;
    }
    
    suppressNext = true;
    
    // Mark this payload as processed (before async operations)
    applyState._lastPayloadKey = payloadKey;
    
    // Use adapter for all video operations (now async)
    let seekSucceeded = false;
    try {
      if (typeof payload.t === "number") {
        seekSucceeded = await NetflixAdapter.seekTo(payload.t);
        console.log("[Flixers] Seek result:", seekSucceeded ? "success" : "may have failed");
      }
      
      if (typeof payload.paused === "boolean") {
        await NetflixAdapter.setPaused(payload.paused);
      }
    } catch (err) {
      console.warn("[Flixers] Error applying state:", err.message);
    }
    
    // Verify sync after a delay and retry if needed
    if (!seekSucceeded && typeof payload.t === "number") {
      setTimeout(async () => {
        const state = NetflixAdapter.getState();
        if (state) {
          const newDiff = Math.abs(state.t - payload.t);
          if (newDiff > 15) {
            console.log(`[Flixers] Sync verification failed, still ${newDiff.toFixed(1)}s away. Try Resync button.`);
          }
        }
      }, 1000);
    }
    
    // Reset suppress flag after operations complete
    setTimeout(() => { suppressNext = false; }, 800);
  };
  applyState._lastApply = 0;
  applyState._lastPayloadKey = null;

  const start = () => {
    // Don't start observing automatically - wait until user joins a room
    // This prevents triggering Netflix DRM when not needed
  };

  return { start, applyState, announcePlayer, setInRoom, requestResync, forceNavigateToEpisode };
})();

function Avatar({ name, avatarUrl }) {
  const fallback = useMemo(() => assignAvatar(name), [name]);
  if (avatarUrl) {
    return html`<div
      class="flixers-avatar flixers-avatar--image"
      style=${{ backgroundImage: `url(${avatarUrl})` }}
    ></div>`;
  }
  return html`<div
    class="flixers-avatar"
    style=${{ background: fallback.bg || "#222", color: "#fff" }}
    aria-label=${`${name} avatar`}
  >
    ${fallback.emoji || fallback.initial}
  </div>`;
}

function Message({ msg, selfId }) {
  const isMine = !!selfId && !!msg.fromId && msg.fromId === selfId;
  const displayName = msg.from || (isMine ? "You" : "Anon");
  const avatarUrl = msg.avatar || null;
  const timeLabel =
    msg.ts &&
    new Date(msg.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const classes = [
    "flixers-message",
    msg.pending ? "flixers-message--pending" : "",
    isMine ? "flixers-message--own" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return html`<div class=${classes}>
    <${Avatar} name=${displayName} avatarUrl=${avatarUrl} />
    <div class="flixers-message__body">
      <div class="flixers-message__meta">
        <span class="flixers-from">${displayName}</span>
        ${msg.pending ? html`<span class="flixers-pending">queued</span>` : null}
      </div>
      <div
        class="flixers-message__text"
        dangerouslySetInnerHTML=${{ __html: escapeHtml(msg.text || "") }}
      ></div>
      <div class="flixers-message__footer">
        ${timeLabel ? html`<span class="flixers-time">${timeLabel}</span>` : null}
      </div>
    </div>
  </div>`;
}

function SystemMessage({ msg }) {
  const handleClick = (e) => {
    if (!msg.url) return;
    e.preventDefault();
    try {
      window.location.href = msg.url;
    } catch (_) {}
  };
  const body = msg.url
    ? html`<a href=${msg.url} onClick=${handleClick}>${msg.text}</a>`
    : msg.text;
  return html`<div class="flixers-system-message">
    <span class="flixers-system-text">${body}</span>
    ${msg.ts
      ? html`<span class="flixers-system-time">
          ${new Date(msg.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>`
      : null}
  </div>`;
}

function PresenceList({ participants, presenceAvatars }) {
  if (!participants?.length) {
    return html`<div class="flixers-chip">No one online</div>`;
  }
  
  const lookupAvatar = (id, fallback) => {
    const entry = presenceAvatars?.get(id);
    if (!entry) return fallback || null;
    // Support both { url } (presence) and { avatar } (chat history) shapes
    return entry.url || entry.avatar || fallback || null;
  };

  return participants.map((p) => {
    const id = p?.id || p?.name;
    const name = p?.name || "Guest";
    const avatarUrl = lookupAvatar(id, p?.picture || null);
    return html`<div class="flixers-chip" key=${id}>
      <${Avatar} name=${name} avatarUrl=${avatarUrl} />
    </div>`;
  });
}

function TypingIndicator({ typing }) {
  const names = Object.values(typing || {})
    .filter((v) => v?.active)
    .map((v) => v?.name || "Someone");
  if (!names.length) return null;
  const label = names.length === 1 ? `${names[0]} is typing…` : `${names.length} people are typing…`;
  return html`<div class="flixers-typing">${label}</div>`;
}

// Apply or remove sidebar mode styles to Netflix's video container
const applySidebarMode = (enabled) => {
  const videoContainer = document.querySelector('.watch-video') || 
                         document.querySelector('[data-uia="video-canvas"]') ||
                         document.querySelector('.VideoContainer');
  const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);

  // Only shift the video when in fullscreen to avoid hiding it in normal mode
  const shouldApply = enabled && isFullscreen;

  if (shouldApply) {
    document.body.classList.add('flixers-sidebar-mode');
  } else {
    document.body.classList.remove('flixers-sidebar-mode');
  }
  
  if (!videoContainer) return;
  
  if (shouldApply) {
    videoContainer.classList.add('flixers-sidebar-active');
  } else {
    videoContainer.classList.remove('flixers-sidebar-active');
  }
};

function App() {
  const [room, setRoom] = useState({ roomId: null, name: "Guest" });
  const [connection, setConnection] = useState("idle");
  const [messages, setMessages] = useState([]);
  const [participants, setParticipants] = useState([]);
  const [typing, setTyping] = useState({});
  const [session, setSession] = useState(null);
  const [playerStatus, setPlayerStatus] = useState({ present: false, playing: false, title: null, url: null });
  const [open, setOpen] = useState(true);
  const [fullyHidden, setFullyHidden] = useState(false);
  const [controlBarVisible, setControlBarVisible] = useState(true);
  const [input, setInput] = useState("");
  const [roomEndNotice, setRoomEndNotice] = useState(null); // { kind, roomId, text, ts }
  const presenceAvatars = useRef(new Map());
  const lastTyping = useRef({});
  const typingTimer = useRef(null);
  const seenMessages = useRef(new Set());
  const roomRef = useRef(room);
  const roomEndNoticeRef = useRef(null);
  const messagesRef = useRef(null);
  const controlBarHideTimer = useRef(null);
  const lastHealthAlert = useRef(0);
  roomRef.current = room;
  const setRoomEndNoticeSafe = (notice) => {
    roomEndNoticeRef.current = notice;
    setRoomEndNotice(notice);
  };
  const setPresenceAvatar = (id, url) => {
    if (!id || !url) return;
    presenceAvatars.current.set(id, { url });
  };
  const mergePresenceAvatars = (avatarObj = {}) => {
    Object.entries(avatarObj).forEach(([id, url]) => {
      if (url) setPresenceAvatar(id, url);
    });
  };
  const handleNowPlayingNavigate = (e) => {
    e?.preventDefault?.();
    if (playerStatus?.url) {
      window.location.href = playerStatus.url;
    }
  };

  const scrollMessagesToBottom = (force) => {
    const el = messagesRef.current;
    if (!el) return;
    if (force || el.scrollHeight - el.scrollTop - el.clientHeight < 48) {
      el.scrollTop = el.scrollHeight;
    }
  };

  useEffect(() => {
    injectStyles();
    // Don't start PlayerSync automatically - it will start when joining a room
    // This prevents triggering Netflix's DRM protection
    
    // Announce player status periodically to ensure popup gets the status
    const announceInterval = setInterval(() => {
      if (!isContextValid()) return;
      // Only announce if we have a video and are in a room
      const video = document.querySelector("video");
      if (video) {
        safeSend({
          type: "player-present",
          present: true,
          playing: !video.paused,
          url: window.location.href,
          title: NetflixAdapter.getTitle ? NetflixAdapter.getTitle() : null,
        });
      }
    }, 5000);
    // Also periodically check room state in case messages were missed
    const roomCheckInterval = setInterval(() => {
      if (!isContextValid()) return;
      safeSend({ type: "get-room" }, (res) => {
        if (!res) return;
        const currentRoom = roomRef.current;
        if (res?.roomId && res.roomId !== currentRoom.roomId) {
          setRoom({ roomId: res.roomId, name: res.name || "Guest" });
        } else if (!res?.roomId && currentRoom.roomId) {
          setRoom({ roomId: null, name: "Guest" });
        }
      });
    }, 1500);
    return () => {
      clearInterval(announceInterval);
      clearInterval(roomCheckInterval);
    };
  }, []);

  // Keep Now Playing fresh even if messages are missed
  useEffect(() => {
    if (!room.roomId) return;
    const poll = () => {
      if (!isContextValid()) return;
      safeSend({ type: "player-status" }, (res) => {
        if (!res) return;
        setPlayerStatus({
          present: !!res.present,
          playing: !!res.playing,
          url: res.url || null,
          title: res.title || null,
        });
      });
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [room.roomId]);

  // Apply sidebar mode to free video space whenever chat is open
  useEffect(() => {
    const isSidebar = open && room.roomId && !fullyHidden;
    applySidebarMode(isSidebar);
    
    // Cleanup when component unmounts or mode changes
    return () => {
      applySidebarMode(false);
    };
  }, [open, room.roomId, fullyHidden]);

  // Re-apply sidebar sizing when entering/exiting fullscreen
  useEffect(() => {
    const handleFsChange = () => {
      const isSidebar = open && room.roomId && !fullyHidden;
      applySidebarMode(isSidebar);
      
      // Scroll to bottom after fullscreen toggle (layout may have changed)
      setTimeout(() => scrollMessagesToBottom(true), 100);
      setTimeout(() => scrollMessagesToBottom(true), 300);
    };
    document.addEventListener("fullscreenchange", handleFsChange);
    document.addEventListener("webkitfullscreenchange", handleFsChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFsChange);
      document.removeEventListener("webkitfullscreenchange", handleFsChange);
    };
  }, [open, room.roomId, fullyHidden]);

  // Auto-hide control bar after 3 seconds when chat is closed, show on mouse move
  useEffect(() => {
    // Only apply auto-hide when chat is closed and in a room
    if (open || !room.roomId || fullyHidden) {
      // Chat is open or not in room - always show control bar
      setControlBarVisible(true);
      if (controlBarHideTimer.current) {
        clearTimeout(controlBarHideTimer.current);
        controlBarHideTimer.current = null;
      }
      return;
    }
    
    // Start hide timer
    const startHideTimer = () => {
      if (controlBarHideTimer.current) {
        clearTimeout(controlBarHideTimer.current);
      }
      controlBarHideTimer.current = setTimeout(() => {
        setControlBarVisible(false);
      }, 3000);
    };
    
    // Show control bar and reset timer on mouse move
    const handleMouseMove = () => {
      setControlBarVisible(true);
      startHideTimer();
    };
    
    // Initial timer start
    setControlBarVisible(true);
    startHideTimer();
    
    // Add mousemove listener
    document.addEventListener("mousemove", handleMouseMove, { passive: true });
    
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      if (controlBarHideTimer.current) {
        clearTimeout(controlBarHideTimer.current);
        controlBarHideTimer.current = null;
      }
    };
  }, [open, room.roomId, fullyHidden]);

  useEffect(() => {
    const handler = (message) => {
      if (!isContextValid()) return;
      if (message.type === "apply-state") {
        // Make sure PlayerSync is active and apply state (has its own retry logic)
        PlayerSync.setInRoom(true);
        PlayerSync.applyState(message.payload);
      }
      if (message.type === "chat") {
        const fromId = message.fromId || message.from || null;
        if (fromId && message.avatar) setPresenceAvatar(fromId, message.avatar);
        pushMessage({
          from: message.from || "Anon",
          fromId,
          text: message.text || "",
          ts: message.ts,
          avatar: message.avatar,
        });
        // Force scroll to bottom when receiving a message
        setTimeout(() => scrollMessagesToBottom(true), 50);
      }
      if (message.type === "system") {
        pushMessage({ type: "system", text: message.text, ts: message.ts, url: message.url, title: message.title });
        setTimeout(() => scrollMessagesToBottom(true), 50);
      }
      if (message.type === "presence") {
        mergePresenceAvatars(message.avatars);
        const next = Array.isArray(message.participants)
          ? message.participants
          : (message.users || []).map((name) => ({ id: name, name }));
        setParticipants(next);
      }
      if (message.type === "ws-status") {
        setConnection(message.status || "idle");
        if (message.status !== "connected") {
          setParticipants([]);
        }
        // Scroll to bottom when connected/reconnected
        if (message.status === "connected") {
          setTimeout(() => scrollMessagesToBottom(true), 100);
        }
      }
      if (message.type === "typing") {
        const fromId = message.fromId || message.from || "someone";
        const fromName = message.from || "Someone";
        lastTyping.current[fromId] = Date.now();
        setTyping((prev) => ({ ...prev, [fromId]: { name: fromName, active: !!message.active } }));
      }
      if (message.type === "player-present") {
        setPlayerStatus({
          present: !!message.present,
          playing: !!message.playing,
          url: message.url,
          title: message.title || null,
        });
      }
      if (message.type === "room-update") {
        setRoom({ roomId: message.roomId, name: message.name || "Guest" });
        // Tell PlayerSync whether we're in a room
        PlayerSync.setInRoom(!!message.roomId);
        if (message.roomId) {
          setRoomEndNoticeSafe(null);
          // Auto-open overlay when joining a room
          setOpen(true);
          // Scroll to bottom after messages load
          setTimeout(() => scrollMessagesToBottom(true), 100);
          // Note: Don't auto-trigger resync here - let the natural flow handle it
          // The joiner's requestSyncIfNeeded() will trigger after video loads
        } else {
          if (!roomEndNoticeRef.current) {
            setRoomEndNoticeSafe(null);
            resetChatState();
          }
        }
      }
      if (message.type === "auth") {
        setSession(message.session || null);
        if (!message.session) {
          setRoomEndNoticeSafe(null);
          setRoom({ roomId: null, name: "Guest" });
          resetChatState();
        }
      }
      if (message.type === "room-deleted") {
        purgeRoomMessages(message.roomId);
        if (roomRef.current?.roomId === message.roomId) {
          const ts = Date.now();
          const notice = {
            kind: "expired",
            roomId: message.roomId,
            text: "Room expired. Please create or join a new room.",
            ts,
          };
          setRoomEndNoticeSafe(notice);
          setRoom({ roomId: null, name: "Guest" });
          PlayerSync.setInRoom(false);
          setParticipants([]);
          setTyping({});
          lastTyping.current = {};
          setConnection("disconnected");
          setFullyHidden(false);
          setOpen(true);
          seenMessages.current.clear();
          setMessages([{ type: "system", text: notice.text, ts: notice.ts }]);
          setTimeout(() => scrollMessagesToBottom(true), 50);
        }
      }
    if (message.type === "episode-changed" && message.url) {
      const ts = typeof message.ts === "number" ? message.ts : Date.now();
      const fromId = message.fromId || message.from || null;
      console.log("[Flixers] episode-changed message", {
        url: message.url,
        ts,
        from: message.from,
        fromId,
        seq: message.seq,
        reason: message.reason,
      });
      // Force navigation first, then apply state in case we're already there
      PlayerSync.forceNavigateToEpisode(message.url, ts, fromId, message.seq);
      PlayerSync.applyState(
        {
          url: message.url,
          reason: message.reason || "resync",
          ts,
          from: message.from,
          fromId,
          seq: message.seq,
        },
        false,
        { retryCount: 0, bridgeRetried: false }
      );
    }
  };
    const removeListener = safeAddListener(handler);
    // Fetch initial state from background
    safeSend({ type: "get-room" }, (res) => {
      if (res) setRoom({ roomId: res.roomId || null, name: res.name || "Guest" });
    });
    safeSend({ type: "get-presence" }, (res) => {
      if (res?.avatars) mergePresenceAvatars(res.avatars);
      if (res?.participants) {
        setParticipants(res.participants);
      } else if (res?.users) {
        setParticipants((res.users || []).map((name) => ({ id: name, name })));
      }
    });
    safeSend({ type: "get-connection-status" }, (res) => {
      if (res?.status) setConnection(res.status);
    });
    safeSend({ type: "player-status" }, (res) => {
      if (!res) return;
      setPlayerStatus({
        present: !!res.present,
        playing: !!res.playing,
        url: res.url,
        title: res.title || null,
      });
    });
    safeSend({ type: "auth-get" }, (res) => {
      setSession(res?.session || null);
    });
    return removeListener;
  }, []);

  useEffect(() => {
    roomRef.current = room;
  }, [room]);
  
  // Keep PlayerSync in sync with room membership (covers reloads where no room-update event fires)
  useEffect(() => {
    PlayerSync.setInRoom(!!room.roomId);
    
    // Kick off a resync after page reloads or reconnects, even if video is paused.
    if (room.roomId) {
      setTimeout(() => {
        if (isContextValid() && roomRef.current.roomId === room.roomId) {
          PlayerSync.requestResync();
        }
      }, 1200);
    }
  }, [room.roomId]);

  useEffect(() => {
    if (!room.roomId) {
      const notice = roomEndNoticeRef.current;
      if (notice?.kind === "expired") {
        seenMessages.current.clear();
        setMessages([{ type: "system", text: notice.text, ts: notice.ts }]);
        return;
      }
      resetChatState();
      return;
    }
    loadMessagesForRoom(room.roomId);
  }, [room.roomId]);
  
  // Client-side watchdog to detect stale connections and trigger reconnect/status updates
  useEffect(() => {
    if (!room.roomId) return;
    const HEALTH_INTERVAL = 15000;
    const STALE_AFTER_MS = 45000; // 45 seconds
    
    const interval = setInterval(() => {
      if (!isContextValid()) return;
      safeSend({ type: "get-connection-status" }, (res) => {
        if (!res) {
          setConnection("disconnected");
          setParticipants([]);
          return;
        }
        const now = Date.now();
        const lastPong = res.lastPongTime || 0;
        const stale = lastPong && now - lastPong > STALE_AFTER_MS;
        const notOpen = res.readyState !== 1;
        
        if (stale || notOpen || res.status !== "connected") {
          // Show reconnecting state locally
          setConnection(res.status === "connected" ? "reconnecting" : res.status || "reconnecting");
          setParticipants([]);
          
          // Throttle user-facing alert
          if (now - lastHealthAlert.current > 20000) {
            pushMessage({
              type: "system",
              text: "Connection lost. Attempting to reconnect…",
              ts: now,
            });
            lastHealthAlert.current = now;
          }
          
          // Ask background to force a reconnect
          safeSend({ type: "force-reconnect" }, () => {});
        }
      });
    }, HEALTH_INTERVAL);
    
    return () => clearInterval(interval);
  }, [room.roomId]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (!isContextValid()) return;
      const now = Date.now();
      const copy = { ...typing };
      let dirty = false;
      Object.entries(lastTyping.current || {}).forEach(([name, ts]) => {
        if (now - ts > 3500) {
          delete copy[name];
          delete lastTyping.current[name];
          dirty = true;
        }
      });
      if (dirty) setTyping(copy);
    }, 800);
    return () => clearInterval(interval);
  }, []);

  const pushMessage = (msg) => {
    const key = `${msg.fromId || msg.from || "anon"}-${msg.ts || Date.now()}-${msg.text || ""}`;
    if (seenMessages.current.has(key)) return;
    seenMessages.current.add(key);
    setMessages((prev) => {
      const next = [...prev, msg].slice(-500);
      persistMessages(next);
      return next;
    });
  };

  const resetChatState = () => {
    setMessages([]);
    seenMessages.current.clear();
    setTyping({});
    lastTyping.current = {};
    scrollMessagesToBottom(true);
  };

  const activeTyping = useMemo(
    () => Object.fromEntries(Object.entries(typing).filter(([, v]) => v?.active)),
    [typing]
  );

  const handleSubmit = (e) => {
    e.preventDefault();
    const text = encodeEmojis(input.trim());
    if (!text || !room.roomId) return;
    
    const isQueued = connection !== "connected";
    safeSend({ type: "chat", text });
    pushMessage({
      from: session?.profile?.name || "You",
      fromId: session?.profile?.sub || null,
      text,
      ts: Date.now(),
      avatar: session?.profile?.picture || null,
      pending: isQueued, // Mark as pending if queued
    });
    setInput("");
    signalTyping(false);
    // Force scroll to bottom when sending a message
    setTimeout(() => scrollMessagesToBottom(true), 50);
  };

  const handleClear = () => {
    resetChatState();
  };

  const signalTyping = (active) => {
    if (!isContextValid()) return;
    safeSend({ type: "typing", active });
  };

  const handleInput = (val) => {
    setInput(val);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    signalTyping(!!val.trim());
    typingTimer.current = setTimeout(() => signalTyping(false), 1800);
  };

  // Stop keyboard events from propagating to Netflix player
  const stopKeyboardPropagation = (e) => {
    e.stopPropagation();
    // Also stop immediate propagation to prevent Netflix's event listeners
    if (e.nativeEvent) {
      e.nativeEvent.stopImmediatePropagation();
    }
  };

  const persistMessages = (msgs) => {
    const roomId = roomRef.current?.roomId;
    if (!roomId || !msgs || !isContextValid()) return;
    const key = storageKey(roomId);
    try {
      chrome.storage?.local?.set({ [key]: msgs.slice(-500) }, () => {
        if (chrome.runtime?.lastError) {
          extensionContextValid = false;
        }
      });
    } catch (_) {
      extensionContextValid = false;
    }
  };

  const loadMessagesForRoom = (roomId) => {
    if (!roomId || !isContextValid()) return;
    const key = storageKey(roomId);
    try {
      chrome.storage?.local?.get([key], (res) => {
        if (chrome.runtime?.lastError) {
          extensionContextValid = false;
          return;
        }
        const list = Array.isArray(res[key]) ? res[key] : [];
        seenMessages.current = new Set(
          list.map((m) => `${m.fromId || m.from || "anon"}-${m.ts || ""}-${m.text || ""}`)
        );
        setMessages(list.slice(-200));
        scrollMessagesToBottom(true);
      });
    } catch (_) {
      extensionContextValid = false;
    }
  };

  const connectionPill = useMemo(() => {
    if (connection === "connected") return "flixers-pill--ok";
    if (connection === "connecting" || connection === "reconnecting") return "flixers-pill--warm";
    return "flixers-pill--bad";
  }, [connection]);

  const presenceAvatarsMemo = useMemo(() => {
    const map = presenceAvatars.current;
    participants.forEach((p) => {
      const id = p?.id || p?.name;
      if (!id) return;
      if (!map.has(id)) {
        map.set(id, { url: p?.picture || null });
      } else if (p?.picture && !map.get(id)?.url) {
        map.set(id, { url: p.picture });
      }
      if (session?.profile?.picture && session?.profile?.sub && session.profile.sub === id) {
        map.set(id, { url: session.profile.picture });
      }
    });
    return map;
  }, [participants, session]);

  useEffect(() => {
    scrollMessagesToBottom();
  }, [messages]);

  const isWatchPage = window.location.pathname.includes("/watch/");
  if (!session || !room.roomId || !isWatchPage) {
    return null;
  }

  // When chat is open, show the panel. When closed, hide panel but keep control bar visible
  const overlayClasses = `flixers-overlay ${open ? "" : "flixers-hidden"} flixers-sidebar`;

  // Control bar - single chat toggle button on the right side
  // Position changes based on whether chat panel is open
  // Auto-hides after 3 seconds when chat is closed, reappears on mouse move
  const controlBarClasses = `flixers-control-bar ${open ? "" : "flixers-control-bar--collapsed"} ${!controlBarVisible && !open ? "flixers-control-bar--autohidden" : ""}`;
  
  const controlBar = fullyHidden
    ? null
    : html`<div class=${controlBarClasses}>
        <button 
          class="flixers-control-btn flixers-control-btn--chat"
          aria-label=${open ? "Hide chat" : "Show chat"}
          onClick=${() => setOpen(!open)}
          title=${open ? "Hide chat" : "Show chat"}
        >
          <span class="flixers-control-icon">${open ? "✕" : "💬"}</span>
          ${!open && messages.length > 0 ? html`<span class="flixers-control-badge"></span>` : null}
        </button>
      </div>`;

  const overlay = fullyHidden
    ? null
    : html`<div 
        class=${overlayClasses}
        onKeyDown=${stopKeyboardPropagation}
        onKeyUp=${stopKeyboardPropagation}
        onKeyPress=${stopKeyboardPropagation}
      >
        <div class="flixers-panel">
          <div class="flixers-header">
            <div>
              <div class="flixers-title">Live Chat</div>
              <div class="flixers-room">
                ${room.roomId ? `Room ${room.roomId}` : "Not joined"}
              </div>
            </div>
            <div class="flixers-header-right">
              <div class=${`flixers-pill ${connectionPill}`} id="flixers-connection">
                ${connection}
              </div>
            </div>
          </div>
          <div class="flixers-meta">
            <div class="flixers-presence-title">
              People · ${participants.length}
            </div>
            <div class="flixers-chips">
              <${PresenceList} participants=${participants} presenceAvatars=${presenceAvatarsMemo} />
            </div>
            <div class="flixers-nowplaying">
              <span class="flixers-presence-title" style=${{ marginBottom: 0 }}>Now Playing</span>
              ${playerStatus?.url
                ? html`<a href=${playerStatus.url} onClick=${handleNowPlayingNavigate}>
                    ${playerStatus.title || "Current video"}
                  </a>`
                : html`<span style=${{ color: "#94a3b8" }}>No video detected</span>`}
            </div>
          </div>
          <div class="flixers-status">
            ${room.roomId
              ? connection === "connected"
                ? "Connected and ready to chat"
                : connection === "connecting"
                ? "Connecting to room..."
                : connection === "reconnecting"
                ? "Reconnecting to room..."
                : "Disconnected - trying to reconnect..."
              : "Join a room from the popup to start chatting"}
          </div>
          ${roomEndNotice?.kind === "expired"
            ? html`<div class="flixers-connection-banner" role="alert">
                ${roomEndNotice.text}
              </div>`
            : room.roomId && connection !== "connected"
            ? html`<div class="flixers-connection-banner">
                ${connection === "reconnecting" || connection === "connecting"
                  ? "Reconnecting… hold tight"
                  : "Connection lost. Trying to rejoin…"}
              </div>`
            : null}
          <div class="flixers-messages-header">
            <span>Messages</span>
            <div class="flixers-header-actions">
              <button type="button" class="flixers-clear" onClick=${handleClear}>Clear</button>
            </div>
          </div>
          <div class="flixers-messages" ref=${messagesRef}>
            ${messages.map((m, idx) =>
              m.type === "system"
                ? html`<${SystemMessage} msg=${m} key=${`sys-${m.ts || idx}-${idx}`} />`
                : html`<${Message} msg=${m} selfId=${session?.profile?.sub || null} key=${`${m.ts || idx}-${idx}`} />`
            )}
          </div>
          <${TypingIndicator} typing=${activeTyping} />
          <form class="flixers-input-row" onSubmit=${handleSubmit}>
            <input
              type="text"
              placeholder=${connection === "connected" ? "Send a message" : "Message will be sent when connected..."}
              value=${input}
              onInput=${(e) => handleInput(e.target.value)}
              onKeyDown=${stopKeyboardPropagation}
              onKeyUp=${stopKeyboardPropagation}
              onKeyPress=${stopKeyboardPropagation}
              disabled=${!room.roomId}
            />
            <button type="submit" disabled=${!room.roomId || !input.trim()}>${connection === "connected" ? "Send" : "Queue"}</button>
          </form>
        </div>
      </div>`;

  return html`
    ${controlBar}
    ${overlay}
    <button
      class=${`flixers-reopen ${fullyHidden ? "" : "flixers-reopen--hidden"}`}
      aria-label="Show Flixers"
      onClick=${() => { setFullyHidden(false); setOpen(true); }}
    >
      💬 Flixers
    </button>
  `;
}

const root = document.createElement("div");
root.id = "flixers-react-root";

// Block keyboard events from propagating to Netflix when Flixers elements are focused
const setupKeyboardBlocker = () => {
  const flixersRoot = document.getElementById("flixers-react-root");
  if (!flixersRoot) return;
  
  // Keys that Netflix listens to - we need to block these
  const blockedKeys = new Set([
    " ", "Space", "Spacebar",  // Play/pause
    "ArrowLeft", "ArrowRight", // Seek
    "ArrowUp", "ArrowDown",   // Volume
    "f", "F",                 // Fullscreen
    "m", "M",                 // Mute
    "Escape",                 // Exit fullscreen
    "Enter",                  // Various actions
  ]);
  
  const blockKeyboardEvent = (e) => {
    // Check if the event target is inside Flixers
    const isFlixersElement = flixersRoot.contains(e.target) || e.target === flixersRoot;
    
    if (isFlixersElement) {
      // Stop propagation for all keys when focused on Flixers
      e.stopPropagation();
      e.stopImmediatePropagation();
      
      // For special keys that Netflix might capture at document level, prevent default too
      // but only if not in an input (so user can still type spaces, etc.)
      const isInput = e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA";
      if (!isInput && blockedKeys.has(e.key)) {
        e.preventDefault();
      }
    }
  };
  
  // Use capture phase to intercept events before Netflix
  document.addEventListener("keydown", blockKeyboardEvent, true);
  document.addEventListener("keyup", blockKeyboardEvent, true);
  document.addEventListener("keypress", blockKeyboardEvent, true);
  
  console.log("[Flixers] Keyboard blocker installed");
};

// Handle fullscreen changes to keep overlay visible
const setupFullscreenHandler = () => {
  const enforceZIndex = () => {
    const overlayRoot = document.getElementById("flixers-react-root");
    if (!overlayRoot) return;
    overlayRoot.style.setProperty("z-index", "9999999999", "important");
    overlayRoot.style.setProperty("position", "fixed", "important");
    overlayRoot.style.setProperty("pointer-events", "none", "important");
    overlayRoot.style.setProperty("inset", "0", "important");

    const overlay = overlayRoot.querySelector(".flixers-overlay");
    if (overlay) {
      overlay.style.setProperty("z-index", "9999999999", "important");
      overlay.style.setProperty("position", "fixed", "important");
      overlay.style.setProperty("pointer-events", "auto", "important");
    }

    const reopen = overlayRoot.querySelector(".flixers-reopen");
    if (reopen) {
      reopen.style.setProperty("z-index", "9999999999", "important");
      reopen.style.setProperty("position", "fixed", "important");
      reopen.style.setProperty("pointer-events", "auto", "important");
    }

    // IMPORTANT: Control bar needs pointer-events in fullscreen
    const controlBar = overlayRoot.querySelector(".flixers-control-bar");
    if (controlBar) {
      controlBar.style.setProperty("z-index", "9999999999", "important");
      controlBar.style.setProperty("position", "fixed", "important");
      controlBar.style.setProperty("pointer-events", "auto", "important");
    }

    // Also enforce on all buttons inside control bar
    const controlBtns = overlayRoot.querySelectorAll(".flixers-control-btn");
    controlBtns.forEach(btn => {
      btn.style.setProperty("pointer-events", "auto", "important");
      btn.style.setProperty("cursor", "pointer", "important");
    });
  };

  const moveOverlayToFullscreenContext = () => {
    const overlay = document.getElementById("flixers-react-root");
    if (!overlay) return;
    
    // Check if we're in fullscreen
    const fullscreenElement = document.fullscreenElement || 
                              document.webkitFullscreenElement || 
                              document.mozFullScreenElement ||
                              document.msFullscreenElement;
    
    if (fullscreenElement) {
      // We're in fullscreen - move overlay DIRECTLY into the fullscreen element
      // This is crucial for pointer-events to work
      
      // Only move if not already inside the fullscreen element
      if (!fullscreenElement.contains(overlay)) {
        console.log("[Flixers] Moving overlay into fullscreen context:", fullscreenElement.tagName);
        // Append directly to fullscreen element for best compatibility
        fullscreenElement.appendChild(overlay);
      }
      
      // Force styles immediately after move
      enforceZIndex();
      
      // Double-check styles after a short delay (Netflix can override)
      setTimeout(enforceZIndex, 100);
      setTimeout(enforceZIndex, 300);
    } else {
      // Not in fullscreen - move overlay back to body if needed
      if (overlay.parentElement !== document.body) {
        console.log("[Flixers] Moving overlay back to document body");
        document.body.appendChild(overlay);
      }
      enforceZIndex();
    }
  };
  
  // Listen for fullscreen changes
  document.addEventListener('fullscreenchange', moveOverlayToFullscreenContext);
  document.addEventListener('webkitfullscreenchange', moveOverlayToFullscreenContext);
  document.addEventListener('mozfullscreenchange', moveOverlayToFullscreenContext);
  document.addEventListener('MSFullscreenChange', moveOverlayToFullscreenContext);
  
  // Also check periodically in case we missed an event (Netflix can be tricky)
  // Check more frequently (500ms) to ensure fullscreen interaction works
  setInterval(() => {
    const fullscreenElement = document.fullscreenElement || 
                              document.webkitFullscreenElement;
    const overlay = document.getElementById("flixers-react-root");
    if (!overlay) return;
    
    if (fullscreenElement && !fullscreenElement.contains(overlay)) {
      moveOverlayToFullscreenContext();
    } else if (!fullscreenElement && overlay.parentElement !== document.body) {
      moveOverlayToFullscreenContext();
    }
    
    // Always enforce z-index and pointer-events in fullscreen
    if (fullscreenElement) {
      enforceZIndex();
    }
  }, 500);

  // Initial enforce on setup
  enforceZIndex();
};

const mount = () => {
  if (!h || !render || !html) return;
  if (document.getElementById("flixers-react-root")) return;
  document.body.appendChild(root);
  render(html`<${App} />`, root);
  // Setup fullscreen handler after mounting
  setupFullscreenHandler();
  // Setup keyboard blocker to prevent Netflix from capturing keystrokes
  setupKeyboardBlocker();
};

function waitForDepsAndMount(attempts = 0) {
  loadGlobals();
  if (h && render && html) {
    mount();
    return;
  }
  if (attempts > 200) return;
  setTimeout(() => waitForDepsAndMount(attempts + 1), 75);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => waitForDepsAndMount());
} else {
  waitForDepsAndMount();
}

function assignAvatar(name) {
  if (!name) return { emoji: "👤", bg: "#2f3545", initial: "?" };
  const idx = Math.abs(hashCode(name)) % BUILTIN_AVATARS.length;
  const base = BUILTIN_AVATARS[idx];
  return { ...base, initial: (name[0] || "?").toUpperCase() };
}

function encodeEmojis(text) {
  const table = [
    [/:\)/g, "😊"],
    [/:\(/g, "🙁"],
    [/:D/gi, "😃"],
    [/;\)/g, "😉"],
    [/:P/gi, "😛"],
    [/<3/g, "❤️"],
  ];
  return table.reduce((acc, [pattern, emoji]) => acc.replace(pattern, emoji), text);
}

function injectStyles() {
  if (document.getElementById("flixers-styles-react")) return;
  const style = document.createElement("style");
  style.id = "flixers-styles-react";
  style.textContent = `
    /* Base overlay styles */
    :root { --flixers-sidebar-width: 380px; --flixers-sidebar-gutter: 18px; --flixers-z-max: 2147483647; }
    .flixers-overlay { position: fixed; top: 18px; right: var(--flixers-sidebar-gutter); bottom: 18px; z-index: var(--flixers-z-max) !important; width: var(--flixers-sidebar-width); max-height: calc(100vh - 36px); font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #e5edff; transition: transform 0.3s ease, opacity 0.3s ease; box-sizing: border-box; display: flex; flex-direction: column; gap: 10px; pointer-events: auto; font-size: 14px; line-height: 1.5; }
    #flixers-react-root { z-index: var(--flixers-z-max) !important; position: relative; }
    .flixers-overlay .flixers-panel,
    .flixers-overlay .flixers-toggle { pointer-events: auto; }
    .flixers-overlay .flixers-panel { flex: 1; max-height: 100%; display: flex; flex-direction: column; }
    .flixers-overlay .flixers-messages { flex: 1; min-height: 150px; max-height: none; }
    .flixers-overlay .flixers-input-row { flex-shrink: 0; }
    .flixers-hidden { transform: translateX(calc(var(--flixers-sidebar-width) + 50px)); opacity: 0; pointer-events: none; }
    .flixers-hidden .flixers-panel { pointer-events: none; }
    .flixers-panel { background: linear-gradient(180deg, #0d1323 0%, #0a0f1a 100%); border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; box-shadow: 0 18px 48px rgba(0,0,0,0.45); padding: 14px; backdrop-filter: blur(12px); box-sizing: border-box; }
    .flixers-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; margin-bottom: 6px; }
    .flixers-header-right { display: flex; align-items: center; gap: 8px; }
    .flixers-title { font-weight: 800; letter-spacing: 0.4px; font-size: 16px; text-transform: uppercase; color: #c7d3ff; }
    .flixers-room { font-size: 13px; color: #94a3b8; }
    .flixers-pill { padding: 6px 12px; border-radius: 999px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; border: 1px solid rgba(255,255,255,0.08); }
    .flixers-pill--ok { background: rgba(110, 242, 196, 0.2); border-color: #6ef2c4; color: #6ef2c4; }
    .flixers-pill--bad { background: rgba(255, 111, 97, 0.15); border-color: #ff6f61; color: #ff6f61; }
    .flixers-pill--warm { background: rgba(255, 178, 122, 0.14); border-color: #ffb27a; color: #ffb27a; }
    .flixers-meta { margin: 12px 0 8px; }
    .flixers-presence-title { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #9aa5c4; margin-bottom: 6px; }
    .flixers-nowplaying { margin: 8px 0 10px; color: #cbd5e1; font-size: 13px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; line-height: 1.4; }
    .flixers-nowplaying a { color: #ffb86c; text-decoration: none; font-weight: 700; display: inline-block; line-height: 1.4; }
    .flixers-nowplaying a:hover { text-decoration: underline; }
    .flixers-chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .flixers-chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.04); font-size: 13px; color: #f8fafc; }
    .flixers-status { font-size: 12px; color: #cbd5e1; margin: 6px 0 10px; letter-spacing: 0.01em; }
    .flixers-connection-banner { margin-bottom: 10px; padding: 10px 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.12); background: linear-gradient(135deg, rgba(255,132,124,0.12), rgba(255,179,122,0.08)); color: #ffd166; font-weight: 700; font-size: 13px; }
    .flixers-messages-header { display: flex; align-items: center; justify-content: space-between; color: #c7d3ff; font-size: 13px; margin: 4px 0 6px; }
    .flixers-header-actions { display: flex; gap: 6px; }
    .flixers-resync { background: rgba(110, 242, 196, 0.15); border: 1px solid rgba(110, 242, 196, 0.3); color: #6ef2c4; padding: 7px 12px; border-radius: 12px; cursor: pointer; font-size: 12px; font-weight: 700; }
    .flixers-resync:hover { background: rgba(110, 242, 196, 0.25); }
    .flixers-clear { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #e5edff; padding: 7px 12px; border-radius: 12px; cursor: pointer; font-size: 12px; font-weight: 600; }
    .flixers-messages { height: 240px; overflow-y: auto; border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; padding: 10px; background: rgba(6,10,20,0.7); font-size: 13px; display: flex; flex-direction: column; gap: 8px; }
    .flixers-message { display: grid; grid-template-columns: 34px 1fr; gap: 8px; padding: 8px 10px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.05); background: linear-gradient(145deg, rgba(20,26,42,0.95), rgba(15,20,32,0.92)); box-shadow: 0 6px 18px rgba(0,0,0,0.28); }
    .flixers-message--right { grid-template-columns: 1fr; text-align: right; }
    .flixers-message--left { grid-template-columns: 34px 1fr; }
    .flixers-message--right .flixers-message__text { text-align: left; }
    .flixers-message__meta { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; color: #a5b4fc; font-size: 12px; justify-content: flex-start; }
    .flixers-message__meta--right { justify-content: flex-end; gap: 8px; }
    .flixers-message__footer { display: flex; justify-content: flex-start; margin-top: 8px; }
    .flixers-message__footer--right { justify-content: flex-end; }
    .flixers-avatar { width: 32px; height: 32px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 15px; font-weight: 700; background-size: cover; background-position: center; }
    .flixers-avatar--image { background-size: cover; background-position: center; }
    .flixers-from { font-weight: 700; color: #ffb86c; }
    .flixers-time { color: #94a3b8; }
    .flixers-pending { color: #ffb27a; font-size: 11px; font-style: italic; }
    .flixers-message--pending { opacity: 0.7; border-style: dashed; }
    /* Own messages match the same bubble style as others (layout still right-aligned). */
    .flixers-message--own { border-color: rgba(255,255,255,0.05); background: linear-gradient(145deg, rgba(20,26,42,0.95), rgba(15,20,32,0.92)); }
    .flixers-message--own .flixers-from { color: #ffb86c; }
    .flixers-message--own .flixers-time { color: #94a3b8; }
    .flixers-message--own .flixers-avatar { box-shadow: none; }
    .flixers-message__footer { display: flex; justify-content: flex-end; margin-top: 6px; }
    .flixers-message__text { color: #f8fafc; line-height: 1.5; word-break: break-word; }
    .flixers-input-row { display: grid; grid-template-columns: 1fr 96px; gap: 10px; margin-top: 12px; }
    .flixers-input-row input { border-radius: 12px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.06); color: #f8fafc; padding: 13px; font-size: 14px; }
    .flixers-input-row button { border: none; border-radius: 12px; background: linear-gradient(135deg, #ff6f61, #ffb27a); color: #0f1117; font-weight: 800; cursor: pointer; box-shadow: 0 12px 28px rgba(255, 179, 122, 0.35); font-size: 14px; }
    .flixers-toggle-row { display: flex; gap: 10px; margin-bottom: 12px; justify-content: flex-end; align-items: center; }
    .flixers-toggle-row--top { position: sticky; top: 0; z-index: 2; }
    .flixers-toggle { flex: 0 0 auto; background: rgba(255,255,255,0.12); color: #f8fafc; border: 1px solid rgba(255,255,255,0.18); border-radius: 12px; padding: 10px 12px; cursor: pointer; font-weight: 700; font-size: 14px; letter-spacing: 0.02em; display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
    .flixers-toggle--ghost { background: rgba(255,255,255,0.04); border-color: rgba(255,255,255,0.12); color: #c7d3ff; }
    .flixers-typing { margin: 6px 0; font-size: 13px; color: #9aa5c4; }
    .flixers-system-message { text-align: center; padding: 8px 12px; color: #9aa5c4; font-size: 12px; border-bottom: 1px solid rgba(255,255,255,0.04); }
    .flixers-system-text { margin-right: 6px; }
    .flixers-system-time { color: #64748b; font-size: 11px; }
    
    /* Sidebar mode styles */
    .flixers-overlay.flixers-sidebar { position: fixed; right: 0; top: 0; bottom: 0; width: var(--flixers-sidebar-width); height: 100%; max-height: 100vh; border-radius: 0; padding: 12px var(--flixers-sidebar-gutter); margin: 0; gap: 12px; }
    .flixers-overlay.flixers-sidebar .flixers-panel { height: 100%; max-height: 100vh; border-radius: 0; display: flex; flex-direction: column; box-sizing: border-box; overflow: hidden; }
    .flixers-overlay.flixers-sidebar .flixers-messages { flex: 1; height: auto; min-height: 100px; overflow-y: auto; }
    .flixers-overlay.flixers-sidebar .flixers-toggle-row { flex-shrink: 0; }
    .flixers-overlay.flixers-sidebar .flixers-input-row { flex-shrink: 0; margin-top: 8px; }
    .flixers-overlay.flixers-sidebar .flixers-header,
    .flixers-overlay.flixers-sidebar .flixers-meta,
    .flixers-overlay.flixers-sidebar .flixers-status,
    .flixers-overlay.flixers-sidebar .flixers-messages-header,
    .flixers-overlay.flixers-sidebar .flixers-typing { flex-shrink: 0; }
    .flixers-overlay.flixers-sidebar.flixers-hidden { transform: translateX(calc(var(--flixers-sidebar-width) + 50px)); opacity: 0; pointer-events: none; }
    .flixers-reopen { position: fixed; top: 50%; right: 24px; transform: translateY(-50%); z-index: var(--flixers-z-max) !important; background: linear-gradient(135deg, #ff6f61, #ffb27a); color: #0f1117; border: none; border-radius: 12px; padding: 14px 18px; font-weight: 800; font-size: 14px; box-shadow: 0 14px 32px rgba(255, 179, 122, 0.35); cursor: pointer; letter-spacing: 0.02em; writing-mode: vertical-rl; text-orientation: mixed; }
    .flixers-reopen:hover { transform: translateY(-50%) scale(1.05); box-shadow: 0 18px 40px rgba(255, 179, 122, 0.45); }
    .flixers-reopen--hidden { display: none; }
    
    /* Control bar - single chat toggle button on the right side */
    .flixers-control-bar { position: fixed; top: 50%; right: calc(var(--flixers-sidebar-width) + 12px); transform: translateY(-50%); z-index: 2147483647 !important; display: flex; padding: 0; background: transparent; border: none; box-shadow: none; transition: right 0.3s ease, opacity 0.3s ease, transform 0.3s ease; pointer-events: auto !important; }
    .flixers-control-bar.flixers-control-bar--collapsed { right: 24px; }
    .flixers-control-bar.flixers-control-bar--autohidden { opacity: 0; transform: translateY(-50%) translateX(20px); pointer-events: none; }
    .flixers-control-btn { width: 48px; height: 48px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.2); background: rgba(0,0,0,0.75); backdrop-filter: blur(8px); color: #f8fafc; display: flex; align-items: center; justify-content: center; cursor: pointer !important; transition: all 0.2s ease; position: relative; pointer-events: auto !important; -webkit-user-select: none; user-select: none; box-shadow: 0 4px 16px rgba(0,0,0,0.4); }
    .flixers-control-btn:hover { background: rgba(0,0,0,0.9); border-color: rgba(255,255,255,0.35); transform: scale(1.1); box-shadow: 0 6px 20px rgba(0,0,0,0.5); }
    .flixers-control-btn:active { transform: scale(0.95); }
    .flixers-control-btn--chat { background: rgba(0,0,0,0.75); }
    .flixers-control-btn--chat:hover { background: rgba(0,0,0,0.9); }
    .flixers-control-icon { font-size: 22px; line-height: 1; pointer-events: none; }
    .flixers-control-badge { position: absolute; top: 4px; right: 4px; width: 10px; height: 10px; border-radius: 50%; background: linear-gradient(135deg, #ff6f61, #ffb27a); box-shadow: 0 0 8px rgba(255,111,97,0.6); animation: flixers-pulse 2s ease-in-out infinite; pointer-events: none; }
    @keyframes flixers-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.7; transform: scale(1.2); } }
    
    /* Netflix video container adjustments for sidebar mode */
    .flixers-sidebar-active { width: 100% !important; margin: 0 !important; transition: width 0.3s ease !important; position: relative; }
    .flixers-sidebar-active video { object-fit: contain !important; }
    body.flixers-sidebar-mode { box-sizing: border-box; }
    body.flixers-sidebar-mode .watch-video,
    body.flixers-sidebar-mode [data-uia="video-canvas"],
    body.flixers-sidebar-mode .VideoContainer { width: 100% !important; max-width: none !important; margin: 0 !important; transition: width 0.3s ease !important; position: relative; }
    body.flixers-sidebar-mode .watch-video video,
    body.flixers-sidebar-mode [data-uia="video-canvas"] video,
    body.flixers-sidebar-mode .VideoContainer video { width: 100% !important; height: 100% !important; object-fit: contain !important; }
    
    /* Fullscreen overlay and sidebar adjustments */
    :fullscreen #flixers-react-root,
    :-webkit-full-screen #flixers-react-root { position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; pointer-events: none !important; }
    :fullscreen body.flixers-sidebar-mode,
    :-webkit-full-screen body.flixers-sidebar-mode { padding-right: 0; }
    :fullscreen .flixers-sidebar-active,
    :-webkit-full-screen .flixers-sidebar-active { display: grid !important; grid-template-columns: 1fr var(--flixers-sidebar-width); width: 100% !important; max-width: none !important; margin: 0 !important; align-items: stretch; }
    :fullscreen .flixers-sidebar-active video,
    :-webkit-full-screen .flixers-sidebar-active video { width: 100% !important; height: 100% !important; object-fit: contain !important; }
    :fullscreen .flixers-overlay,
    :-webkit-full-screen .flixers-overlay { position: fixed !important; z-index: 2147483647 !important; top: 0; right: 0; bottom: 0; left: auto; height: 100%; width: var(--flixers-sidebar-width); pointer-events: auto !important; isolation: isolate; margin: 0 !important; }
    :fullscreen .flixers-overlay.flixers-sidebar,
    :-webkit-full-screen .flixers-overlay.flixers-sidebar { position: fixed !important; height: 100%; }
    :fullscreen .flixers-reopen,
    :-webkit-full-screen .flixers-reopen { position: fixed !important; top: 50% !important; right: 24px !important; z-index: 2147483647 !important; pointer-events: auto !important; }
    :fullscreen .flixers-control-bar,
    :-webkit-full-screen .flixers-control-bar { position: fixed !important; z-index: 2147483647 !important; pointer-events: auto !important; }
    :fullscreen .flixers-control-bar.flixers-control-bar--collapsed,
    :-webkit-full-screen .flixers-control-bar.flixers-control-bar--collapsed { right: 24px !important; }
    :fullscreen .flixers-control-bar.flixers-control-bar--autohidden,
    :-webkit-full-screen .flixers-control-bar.flixers-control-bar--autohidden { opacity: 0 !important; transform: translateY(-50%) translateX(20px) !important; pointer-events: none !important; }
    :fullscreen .flixers-control-btn,
    :-webkit-full-screen .flixers-control-btn { pointer-events: auto !important; cursor: pointer !important; z-index: 2147483647 !important; position: relative !important; }
    :fullscreen .flixers-control-bar *,
    :-webkit-full-screen .flixers-control-bar * { pointer-events: auto !important; }
    :fullscreen .flixers-control-icon,
    :-webkit-full-screen .flixers-control-icon { pointer-events: none !important; }
    :fullscreen .flixers-overlay *,
    :-webkit-full-screen .flixers-overlay * { pointer-events: auto !important; }
    :fullscreen .flixers-panel,
    :-webkit-full-screen .flixers-panel { pointer-events: auto !important; }
    
    /* Extra fullscreen isolation - prevent Netflix from capturing our clicks */
    :fullscreen .flixers-control-bar,
    :-webkit-full-screen .flixers-control-bar { isolation: isolate !important; contain: layout !important; }
    :fullscreen .flixers-control-bar::before,
    :-webkit-full-screen .flixers-control-bar::before { content: ''; position: absolute; inset: -10px; z-index: -1; }
  `;
  document.head.appendChild(style);
}

function throttle(fn, delay) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last < delay) return;
    last = now;
    fn(...args);
  };
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (ch) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return map[ch] || ch;
  });
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}
