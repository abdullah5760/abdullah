'use strict';
// One-click launcher: creates .env with a random password on first run, starts the server, opens the browser.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const envPath = path.join(__dirname, '.env');
if (!fs.existsSync(envPath)) {
  const pw = crypto.randomBytes(9).toString('base64url');
  fs.writeFileSync(envPath, fs.readFileSync(path.join(__dirname, '.env.example'), 'utf8').replace('APP_PASSWORD=change-me', 'APP_PASSWORD=' + pw));
  console.log('Created .env. Password (any username): ' + pw);
} else {
  console.log('Password is APP_PASSWORD in the .env file (any username).');
}
const { createApp } = require('./server'); // server.js loads .env on require
const loginToken = crypto.randomBytes(16).toString('hex');
const { server } = createApp({ loginToken });
const port = Number(process.env.PORT || 3000);
server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`Running at ${url}  DRY_RUN=${(process.env.DRY_RUN || 'true') !== 'false'}  (close this window to stop)`);
  // One-time token so the browser logs in without a prompt (the server is bound to localhost only).
  const openUrl = `${url}/?login=${loginToken}`;
  const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', openUrl]] : process.platform === 'darwin' ? ['open', [openUrl]] : ['xdg-open', [openUrl]];
  try { spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* open manually */ }
});
