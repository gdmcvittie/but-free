import crypto from 'node:crypto';
import { config } from './config.js';
import db from './db.js';

/**
 * Google OAuth 2.0 (Drive) + FRAUDIO session handling.
 *
 * Deliberately implemented with plain `fetch` so the app has no heavyweight
 * Google SDK dependency - the same approach the comics app uses.
 */

const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/drive',
  // Read-only YouTube access: the "Liked videos" playlist (LL) - what YouTube
  // Music's Liked Music (LM) is built on. Needs "YouTube Data API v3" enabled
  // in the Cloud project; existing tokens need one reconnect to pick it up.
  'https://www.googleapis.com/auth/youtube.readonly'
].join(' ');

const SESSION_COOKIE = 'fraudio_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const VIP_ONLY_MESSAGE = 'This suite is for VIPs only. This Google account is not on the access list.';
// Refresh the access token this long before it actually expires.
const REFRESH_BUFFER_MS = 120000;

function isVipEmail(email) {
  const allowedEmails = new Set((process.env.VIP_EMAILS || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
  const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (adminEmail) allowedEmails.add(adminEmail);
  return typeof email === 'string' && allowedEmails.has(email.trim().toLowerCase());
}

function makeVipOnlyError() {
  const error = new Error(VIP_ONLY_MESSAGE);
  error.code = 'VIP_ONLY';
  return error;
}

function redirectUri(req) {
  if (config.google.redirectUri) return config.google.redirectUri;
  if (req) {
    const proto = req.headers['x-forwarded-proto'] || (req.connection?.encrypted ? 'https' : 'http');
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${proto}://${host}/api/auth/google/callback`;
  }
  return `http://localhost:${config.port}/api/auth/google/callback`;
}

export const googleAuth = {
  SESSION_COOKIE,

  getAuthUrl(req, state = 'fraudio_auth') {
    if (!config.google.clientId) {
      throw new Error('GOOGLE_CLIENT_ID is not configured. Copy .env.example to .env and fill it in.');
    }
    const params = new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: redirectUri(req),
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      state
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  },

  async handleCallback(code, req) {
    const { clientId, clientSecret } = config.google;
    if (!clientId || !clientSecret) {
      throw new Error('Google OAuth credentials are not configured in .env');
    }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri(req),
        grant_type: 'authorization_code'
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || tokenData.error) {
      throw new Error(tokenData.error_description || tokenData.error || 'Failed to exchange authorization code');
    }

    const { access_token, refresh_token, expires_in, token_type } = tokenData;
    const expiry_date = Date.now() + (expires_in ? expires_in * 1000 : 3600000);

    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    const profile = await profileRes.json();
    if (!profileRes.ok || profile.error) {
      throw new Error(profile.error?.message || 'Failed to fetch Google profile');
    }
    if (!isVipEmail(profile.email)) throw makeVipOnlyError();

    return db.upsertUser(
      { id: profile.id, email: profile.email, name: profile.name, avatar: profile.picture },
      { access_token, refresh_token, expiry_date, token_type }
    );
  },

  /** Returns a non-expired access token, refreshing it when necessary. */
  async getValidAccessToken(user) {
    if (!user?.tokens?.access_token) {
      throw new Error('You are not signed in to Google. Please sign in again.');
    }
    const { access_token, refresh_token, expiry_date } = user.tokens;
    if (access_token && expiry_date && Date.now() < expiry_date - REFRESH_BUFFER_MS) {
      return access_token;
    }
    if (!refresh_token) {
      throw new Error('Your Google session has expired. Please sign in again.');
    }

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token,
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        grant_type: 'refresh_token'
      })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error_description || 'Failed to refresh Google access token');
    }

    const expiry = Date.now() + (data.expires_in ? data.expires_in * 1000 : 3600000);
    db.updateUserTokens(user.id, { access_token: data.access_token, expiry_date: expiry });
    user.tokens.access_token = data.access_token;
    user.tokens.expiry_date = expiry;
    return data.access_token;
  },

  // ------------------------------------------------------------------
  // FRAUDIO session cookie
  // ------------------------------------------------------------------
  createSessionToken(user) {
    const payload = JSON.stringify({ id: user.id, email: user.email, exp: Date.now() + SESSION_TTL_MS });
    const hmac = crypto.createHmac('sha256', config.google.sessionSecret).update(payload).digest('hex');
    return `${Buffer.from(payload).toString('base64')}.${hmac}`;
  },

  verifySessionToken(token) {
    if (!token || typeof token !== 'string') return null;
    const [encoded, hmac] = token.split('.');
    if (!encoded || !hmac) return null;
    try {
      const payloadStr = Buffer.from(encoded, 'base64').toString('utf8');
      const expected = crypto.createHmac('sha256', config.google.sessionSecret).update(payloadStr).digest('hex');
      if (hmac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))) {
        return null;
      }
      const payload = JSON.parse(payloadStr);
      if (payload.exp && Date.now() > payload.exp) return null;
      return db.getUser(payload.id);
    } catch {
      return null;
    }
  },

  cookieOptions(req) {
    return {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_TTL_MS,
      secure: Boolean(req.secure) || req.headers['x-forwarded-proto'] === 'https'
    };
  },

  /** Populates req.user / req.userId when a valid session is present. */
  middleware(req, res, next) {
    let token = req.cookies?.[SESSION_COOKIE];
    if (!token && req.headers.authorization) {
      const [scheme, value] = req.headers.authorization.split(' ');
      if (scheme?.toLowerCase() === 'bearer' && value) token = value;
    }
    const user = token ? googleAuth.verifySessionToken(token) : null;
    req.vipAccessDenied = !!user && !isVipEmail(user.email);
    req.user = user && !req.vipAccessDenied ? user : null;
    req.userId = req.user?.id || null;
    next();
  },

  isVipEmail,
  vipOnlyMessage: VIP_ONLY_MESSAGE,

  /** The Google-only profile the UI needs (never exposes tokens). */
  publicProfile(user) {
    if (!user) return null;
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      avatar: user.avatar,
      audiobooksFolderId: user.audiobooksFolderId,
      audiobooksFolderName: user.audiobooksFolderName,
      musicFolderId: user.musicFolderId,
      musicFolderName: user.musicFolderName
    };
  }
};

export default googleAuth;
