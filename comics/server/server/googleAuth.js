const crypto = require('crypto');
const Database = require('./database');

/**
 * Google OAuth2 Authentication Module:
 * Handles OAuth flow, code exchange, token refresh, and user session management.
 * Pure HTTP fetch implementation with no bulky dependencies.
 */

function getClientId() {
  return process.env.GOOGLE_CLIENT_ID || '';
}

function getClientSecret() {
  return process.env.GOOGLE_CLIENT_SECRET || '';
}

function getRedirectUri(req) {
  const uri = process.env.GOOGLE_REDIRECT_URI || process.env.GOOGLE_REDIRECT_URI_COMICS;
  if (uri) {
    return uri;
  }
  // Auto-detect from request headers if not specified in .env
  if (req) {
    const protocol = req.headers['x-forwarded-proto'] || (req.connection.encrypted ? 'https' : 'http');
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${protocol}://${host}/api/auth/google/callback`;
  }
  return 'http://localhost:3000/api/auth/google/callback';
}

const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/drive'
].join(' ');

const GoogleAuth = {
  getAuthUrl(req, state = '') {
    const clientId = getClientId();
    if (!clientId) {
      throw new Error('GOOGLE_CLIENT_ID is not configured in .env');
    }
    const redirectUri = getRedirectUri(req);
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      state: state || 'cmx_auth'
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  },

  async handleCallback(code, req) {
    const clientId = getClientId();
    const clientSecret = getClientSecret();
    const redirectUri = getRedirectUri(req);

    if (!clientId || !clientSecret) {
      throw new Error('Google OAuth credentials not configured in .env');
    }

    // 1. Exchange authorization code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || tokenData.error) {
      throw new Error(tokenData.error_description || tokenData.error || 'Failed to exchange authorization code');
    }

    const { access_token, refresh_token, expires_in, token_type } = tokenData;
    const expiry_date = Date.now() + (expires_in ? expires_in * 1000 : 3600 * 1000);

    // 2. Fetch user profile
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    const userData = await userRes.json();
    if (!userRes.ok || userData.error) {
      throw new Error(userData.error?.message || 'Failed to fetch Google user profile');
    }

    // 3. Save or update user in database
    const user = Database.upsertUser(userData, {
      access_token,
      refresh_token,
      expiry_date,
      token_type
    });

    return user;
  },

  async getValidAccessToken(user) {
    if (!user || !user.tokens) {
      throw new Error('User has no valid Google authentication tokens');
    }

    const { access_token, refresh_token, expiry_date } = user.tokens;
    // Check if token is still valid (with 2-minute safety buffer)
    if (access_token && expiry_date && Date.now() < (expiry_date - 120000)) {
      return access_token;
    }

    // Need refresh
    if (!refresh_token) {
      // If we only have access token and no refresh token, try current access token
      if (access_token) return access_token;
      throw new Error('Google OAuth session expired. Please sign in again.');
    }

    const clientId = getClientId();
    const clientSecret = getClientSecret();
    const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token'
      })
    });

    const refreshData = await refreshRes.json();
    if (!refreshRes.ok || refreshData.error) {
      throw new Error(refreshData.error_description || 'Failed to refresh Google token');
    }

    const newAccessToken = refreshData.access_token;
    const newExpiry = Date.now() + (refreshData.expires_in ? refreshData.expires_in * 1000 : 3600 * 1000);

    Database.updateUserTokens(user.id, {
      access_token: newAccessToken,
      expiry_date: newExpiry
    });

    return newAccessToken;
  },

  // Simple, secure session cookie token generation & verification
  createSessionToken(user) {
    const secret = process.env.SESSION_SECRET || 'comix_default_secret_salt_99';
    const payload = JSON.stringify({ id: user.id, email: user.email, exp: Date.now() + (30 * 86400 * 1000) });
    const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    const token = Buffer.from(payload).toString('base64') + '.' + hmac;
    return token;
  },

  verifySessionToken(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;

    try {
      const payloadStr = Buffer.from(parts[0], 'base64').toString('utf8');
      const secret = process.env.SESSION_SECRET || 'comix_default_secret_salt_99';
      const expectedHmac = crypto.createHmac('sha256', secret).update(payloadStr).digest('hex');

      if (parts[1] !== expectedHmac) return null;
      const payload = JSON.parse(payloadStr);
      if (payload.exp && Date.now() > payload.exp) return null;

      return Database.getUser(payload.id);
    } catch (e) {
      return null;
    }
  },

  authMiddleware(req, res, next) {
    // 1. Check comix_session cookie
    let token = req.cookies?.comix_session;

    // 2. Check Authorization Bearer header
    if (!token && req.headers.authorization) {
      const parts = req.headers.authorization.split(' ');
      if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
        token = parts[1];
      }
    }

    if (token) {
      const user = GoogleAuth.verifySessionToken(token);
      if (user) {
        req.user = user;
        req.userId = user.id;
        return next();
      }
    }

    // If no active session, check if single user exists in development or if guest mode applies
    // Allow public API paths to proceed without user
    req.user = null;
    req.userId = null;
    next();
  }
};

module.exports = GoogleAuth;
