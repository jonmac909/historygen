// YouTube OAuth 2.0 Authentication Helper

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
// youtube.upload = upload videos, youtube.readonly = read channels/playlists, youtube = modify playlists
const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube';

export interface YouTubeChannel {
  id: string;
  title: string;
  thumbnailUrl?: string;
}

export interface YouTubePlaylist {
  id: string;
  title: string;
  thumbnailUrl?: string;
  itemCount: number;
}

// Storage keys
const ACCESS_TOKEN_KEY = 'youtube_access_token';
const TOKEN_EXPIRY_KEY = 'youtube_token_expiry';
const renderApiKey = import.meta.env.VITE_INTERNAL_API_KEY;
const renderAuthHeader = renderApiKey ? { 'X-Internal-Api-Key': renderApiKey } : {};

interface TokenResponse {
  success: boolean;
  accessToken?: string;
  expiresIn?: number;
  error?: string;
  needsAuth?: boolean;
}

// Get the redirect URI based on current environment
export function getRedirectUri(): string {
  const origin = window.location.origin;
  return `${origin}/oauth/youtube/callback`;
}

// Check if we have a valid access token stored locally
export function hasValidLocalToken(): boolean {
  const token = localStorage.getItem(ACCESS_TOKEN_KEY);
  const expiry = localStorage.getItem(TOKEN_EXPIRY_KEY);

  if (!token || !expiry) {
    return false;
  }

  // Check if token is expired (with 5 minute buffer)
  const expiryTime = parseInt(expiry, 10);
  const now = Date.now();
  return now < (expiryTime - 5 * 60 * 1000);
}

// Get stored access token
export function getStoredToken(): string | null {
  if (!hasValidLocalToken()) {
    clearStoredToken();
    return null;
  }
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}

// Store access token locally
export function storeToken(accessToken: string, expiresIn: number): void {
  const expiryTime = Date.now() + (expiresIn * 1000);
  localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  localStorage.setItem(TOKEN_EXPIRY_KEY, String(expiryTime));
}

// Clear stored token
export function clearStoredToken(): void {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(TOKEN_EXPIRY_KEY);
}

// Generate a random state parameter for CSRF protection
function generateState(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

// Open OAuth popup and return authorization code
export function openAuthPopup(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!GOOGLE_CLIENT_ID) {
      reject(new Error('Google Client ID not configured. Please set VITE_GOOGLE_CLIENT_ID in .env'));
      return;
    }

    const state = generateState();
    sessionStorage.setItem('youtube_oauth_state', state);

    const redirectUri = getRedirectUri();

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', YOUTUBE_SCOPE);
    authUrl.searchParams.set('access_type', 'offline'); // Get refresh token
    authUrl.searchParams.set('prompt', 'consent'); // Always show consent to get refresh token
    authUrl.searchParams.set('state', state);

    const width = 500;
    const height = 600;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;

    const popup = window.open(
      authUrl.toString(),
      'youtube-auth',
      `width=${width},height=${height},left=${left},top=${top},scrollbars=yes`
    );

    if (!popup) {
      reject(new Error('Popup was blocked. Please allow popups for this site.'));
      return;
    }

    // Listen for message from callback page
    const handleMessage = (event: MessageEvent) => {
      // Only accept messages from our own origin
      if (event.origin !== window.location.origin) {
        return;
      }

      if (event.data.type === 'youtube-oauth-callback') {
        window.removeEventListener('message', handleMessage);

        if (event.data.error) {
          reject(new Error(event.data.error));
          return;
        }

        // Verify state
        const savedState = sessionStorage.getItem('youtube_oauth_state');
        if (event.data.state !== savedState) {
          reject(new Error('OAuth state mismatch. Please try again.'));
          return;
        }

        sessionStorage.removeItem('youtube_oauth_state');
        resolve(event.data.code);
      }
    };

    window.addEventListener('message', handleMessage);

    // Check if popup was closed without completing auth
    const checkClosed = setInterval(() => {
      if (popup.closed) {
        clearInterval(checkClosed);
        window.removeEventListener('message', handleMessage);
        sessionStorage.removeItem('youtube_oauth_state');
        reject(new Error('Authentication cancelled'));
      }
    }, 500);
  });
}

// Exchange authorization code for tokens via backend
export async function exchangeCodeForToken(code: string): Promise<TokenResponse> {
  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return { success: false, error: 'API URL not configured' };
  }

  try {
    const response = await fetch(`${renderUrl}/youtube-upload/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...renderAuthHeader },
      body: JSON.stringify({
        code,
        redirectUri: getRedirectUri()
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: data.error || 'Token exchange failed' };
    }

    // Store the access token locally
    if (data.accessToken && data.expiresIn) {
      storeToken(data.accessToken, data.expiresIn);
    }

    return {
      success: true,
      accessToken: data.accessToken,
      expiresIn: data.expiresIn
    };
  } catch (error) {
    console.error('Token exchange error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Token exchange failed'
    };
  }
}

// Refresh access token using stored refresh token (via backend)
export async function refreshAccessToken(): Promise<TokenResponse> {
  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return { success: false, error: 'API URL not configured' };
  }

  try {
    const response = await fetch(`${renderUrl}/youtube-upload/token`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', ...renderAuthHeader }
    });

    const data = await response.json();

    if (!response.ok) {
      clearStoredToken();
      return {
        success: false,
        error: data.error || 'Token refresh failed',
        needsAuth: data.needsAuth
      };
    }

    // Store the new access token locally
    if (data.accessToken && data.expiresIn) {
      storeToken(data.accessToken, data.expiresIn);
    }

    return {
      success: true,
      accessToken: data.accessToken,
      expiresIn: data.expiresIn
    };
  } catch (error) {
    console.error('Token refresh error:', error);
    clearStoredToken();
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Token refresh failed',
      needsAuth: true
    };
  }
}

// Get a valid access token (from local storage or refresh if needed)
export async function getValidAccessToken(): Promise<string | null> {
  // First check local storage
  const storedToken = getStoredToken();
  if (storedToken) {
    return storedToken;
  }

  // Try to refresh using stored refresh token
  const result = await refreshAccessToken();
  if (result.success && result.accessToken) {
    return result.accessToken;
  }

  return null;
}

// Check if YouTube is connected (has stored refresh token)
export async function checkYouTubeConnection(): Promise<{ connected: boolean; lastUpdated?: string }> {
  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return { connected: false };
  }

  try {
    const response = await fetch(`${renderUrl}/youtube-upload/status`, {
      headers: renderAuthHeader,
    });
    const data = await response.json();

    return {
      connected: data.authenticated === true,
      lastUpdated: data.lastUpdated
    };
  } catch (error) {
    console.error('Error checking YouTube connection:', error);
    return { connected: false };
  }
}

// Disconnect YouTube account
export async function disconnectYouTube(): Promise<boolean> {
  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return false;
  }

  try {
    const response = await fetch(`${renderUrl}/youtube-upload/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...renderAuthHeader }
    });

    if (response.ok) {
      clearStoredToken();
      return true;
    }
    return false;
  } catch (error) {
    console.error('Error disconnecting YouTube:', error);
    return false;
  }
}

// Full authentication flow - opens popup and exchanges code
export async function authenticateYouTube(): Promise<TokenResponse> {
  try {
    const code = await openAuthPopup();
    return await exchangeCodeForToken(code);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Authentication failed'
    };
  }
}

// Fetch YouTube channels for the authenticated user
export async function fetchYouTubeChannels(): Promise<{ channels: YouTubeChannel[]; error?: string }> {
  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return { channels: [], error: 'API URL not configured' };
  }

  // Get a valid access token
  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    return { channels: [], error: 'Not authenticated' };
  }

  try {
    const response = await fetch(`${renderUrl}/youtube-upload/channels`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...renderAuthHeader,
      }
    });

    const data = await response.json();

    if (!response.ok) {
      return { channels: [], error: data.error || 'Failed to fetch channels' };
    }

    return { channels: data.channels || [] };
  } catch (error) {
    console.error('Error fetching YouTube channels:', error);
    return { channels: [], error: error instanceof Error ? error.message : 'Failed to fetch channels' };
  }
}

// Fetch YouTube playlists for the authenticated user
export async function fetchYouTubePlaylists(): Promise<{ playlists: YouTubePlaylist[]; error?: string }> {
  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return { playlists: [], error: 'API URL not configured' };
  }

  // Get a valid access token
  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    return { playlists: [], error: 'Not authenticated' };
  }

  try {
    const response = await fetch(`${renderUrl}/youtube-upload/playlists`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...renderAuthHeader,
      }
    });

    const data = await response.json();

    if (!response.ok) {
      return { playlists: [], error: data.error || 'Failed to fetch playlists' };
    }

    return { playlists: data.playlists || [] };
  } catch (error) {
    console.error('Error fetching YouTube playlists:', error);
    return { playlists: [], error: error instanceof Error ? error.message : 'Failed to fetch playlists' };
  }
}

// Add video to a playlist
export async function addVideoToPlaylist(playlistId: string, videoId: string): Promise<{ success: boolean; error?: string }> {
  const renderUrl = import.meta.env.VITE_RENDER_API_URL;

  if (!renderUrl) {
    return { success: false, error: 'API URL not configured' };
  }

  // Get a valid access token
  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    return { success: false, error: 'Not authenticated' };
  }

  try {
    const response = await fetch(`${renderUrl}/youtube-upload/playlists/add`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...renderAuthHeader,
      },
      body: JSON.stringify({ playlistId, videoId })
    });

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: data.error || 'Failed to add video to playlist' };
    }

    return { success: true };
  } catch (error) {
    console.error('Error adding video to playlist:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to add video to playlist' };
  }
}
