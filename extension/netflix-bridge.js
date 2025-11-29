(function() {
  // Prevent duplicate injection
  if (window.__flixersNetflixBridge && window.__flixersNetflixBridge._version >= 2) {
    console.log('[Flixers] Bridge already injected, skipping');
    return;
  }
  
  // Bridge for Netflix player API access
  window.__flixersNetflixBridge = {
    _version: 2,
    _injectedAt: Date.now(),
    
    // Health check method
    isHealthy: function() {
      return true;
    },
    
    seek: function(timeMs) {
      try {
        const videoPlayer = window.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
        if (!videoPlayer) return { success: false, error: 'No video player API' };
        
        const sessionId = videoPlayer.getAllPlayerSessionIds?.()[0];
        if (!sessionId) return { success: false, error: 'No session ID' };
        
        const player = videoPlayer.getVideoPlayerBySessionId?.(sessionId);
        if (!player || typeof player.seek !== 'function') {
          return { success: false, error: 'No seek function' };
        }
        
        player.seek(timeMs);
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
    
    play: function() {
      try {
        const videoPlayer = window.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
        if (!videoPlayer) return { success: false, error: 'No video player API' };
        
        const sessionId = videoPlayer.getAllPlayerSessionIds?.()[0];
        if (!sessionId) return { success: false, error: 'No session ID' };
        
        const player = videoPlayer.getVideoPlayerBySessionId?.(sessionId);
        if (player && typeof player.play === 'function') {
          player.play();
          return { success: true };
        }
        return { success: false, error: 'No play function' };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
    
    pause: function() {
      try {
        const videoPlayer = window.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
        if (!videoPlayer) return { success: false, error: 'No video player API' };
        
        const sessionId = videoPlayer.getAllPlayerSessionIds?.()[0];
        if (!sessionId) return { success: false, error: 'No session ID' };
        
        const player = videoPlayer.getVideoPlayerBySessionId?.(sessionId);
        if (player && typeof player.pause === 'function') {
          player.pause();
          return { success: true };
        }
        return { success: false, error: 'No pause function' };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
    
    getState: function() {
      try {
        const videoPlayer = window.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
        if (!videoPlayer) return null;
        
        const sessionId = videoPlayer.getAllPlayerSessionIds?.()[0];
        if (!sessionId) return null;
        
        const player = videoPlayer.getVideoPlayerBySessionId?.(sessionId);
        if (!player) return null;
        
        return {
          currentTime: player.getCurrentTime?.() / 1000,
          duration: player.getDuration?.() / 1000,
          paused: player.isPaused?.()
        };
      } catch (err) {
        return null;
      }
    }
  };
  
  // Listen for commands from content script
  window.addEventListener('flixers-command', function(e) {
    const { action, data, id } = e.detail || {};
    let result = { success: false, error: 'Unknown action' };
    
    try {
      if (action === 'seek') {
        result = window.__flixersNetflixBridge.seek(data.timeMs);
      } else if (action === 'play') {
        result = window.__flixersNetflixBridge.play();
      } else if (action === 'pause') {
        result = window.__flixersNetflixBridge.pause();
      } else if (action === 'getState') {
        result = { success: true, state: window.__flixersNetflixBridge.getState() };
      } else if (action === 'healthCheck') {
        result = { 
          success: true, 
          healthy: window.__flixersNetflixBridge.isHealthy(),
          version: window.__flixersNetflixBridge._version,
          uptime: Date.now() - window.__flixersNetflixBridge._injectedAt
        };
      }
    } catch (err) {
      result = { success: false, error: err.message };
    }
    
    window.dispatchEvent(new CustomEvent('flixers-response', { 
      detail: { id: id, result: result } 
    }));
  });
  
  console.log('[Flixers] Netflix bridge injected (v2)');
})();

