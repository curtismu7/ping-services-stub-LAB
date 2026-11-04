import { createApp } from './app.js';
import { createHealth } from './health.js';

const port = Number(process.env.PORT || 6300);
const host = process.env.HOST || '127.0.0.1';
const app = createApp({ health: createHealth() });
app.listen(port, host, () => {
  console.log(`[ping-services-stub] on http://127.0.0.1:${port} (loopback only)`);
});
