import { loadConfig } from './config.js';
import { createApp } from './server.js';

// Start-up problems are almost always a missing setting or an unwritable database folder.
// Print them as plain sentences so the host's log shows what to fix.
function explainStartupError(err) {
  const msg = err && err.message ? err.message : String(err);
  const lines = ['', 'Kobodesk could not start.', `Reason: ${msg}`];
  if (/unable to open database|EACCES|EROFS|ENOENT|EPERM|EEXIST|ENOTDIR|readonly database/i.test(msg)) {
    lines.push(
      `The database file could not be created or opened (DB_PATH is "${process.env.DB_PATH || './data/kobodesk.db'}").`,
      'Fix: attach a persistent disk and point DB_PATH at it (for example /var/data/kobodesk.db),',
      'or, for a test only, set DB_PATH=./data/kobodesk.db. Test data is lost on every redeploy.'
    );
  } else if (/node:sqlite|experimental-sqlite|ERR_UNKNOWN_BUILTIN_MODULE/i.test(msg)) {
    lines.push('This host is running a Node version without the built-in database. Use Node 22.13 or newer (the repo pins 22).');
  } else if (/outside sandbox mode|required|must be/i.test(msg)) {
    lines.push('Fix: set the missing environment variable named above, or set MODE=sandbox for a test deployment. See DEPLOY.md.');
  }
  lines.push(`Node ${process.version}`, '');
  return lines.join('\n');
}

let config, server;
try {
  config = loadConfig();
  ({ server } = createApp(config));
} catch (err) {
  console.error(explainStartupError(err));
  process.exit(1);
}

// Hosts such as Render set PORT and need the server reachable from outside the container.
server.listen(config.port, '0.0.0.0', () => {
  console.log(`Kobodesk API listening on port ${config.port} (mode: ${config.mode})`);
  if (config.mode === 'sandbox') {
    console.log('Sandbox mode: deposit addresses and bank payouts are fake. No real money moves.');
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
