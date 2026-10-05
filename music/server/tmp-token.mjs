import crypto from 'node:crypto';
import db from './server/db.js';
import config from './server/config.js';
const user = db.getUser(Object.keys(db.raw().users)[0]);
const payload = JSON.stringify({ id: user.id, email: user.email, exp: Date.now() + 3.6e6 });
const hmac = crypto.createHmac('sha256', config.google.sessionSecret).update(payload).digest('hex');
const b64 = (s) => Buffer.from(s).toString('base64url');
console.log(`${b64(payload)}.${hmac}`);
