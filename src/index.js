import { loadConfig } from './config.js';
import { createApp } from './server.js';

const config = loadConfig();
const { server } = createApp(config);

server.listen(config.port, () => {
  console.log(`Kobodesk API listening on http://localhost:${config.port} (mode: ${config.mode})`);
  if (config.mode === 'sandbox') {
    console.log('Sandbox mode: deposit addresses and bank payouts are fake. No real money moves.');
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
