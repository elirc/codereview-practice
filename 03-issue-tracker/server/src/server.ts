import { buildApp } from './app.js';
import { ConfigError, loadConfig, loadDotEnvIfPresent, type Config } from './config.js';
import { systemClock } from './lib/clock.js';

function readConfig(): Config {
  try {
    return loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

loadDotEnvIfPresent();
const config = readConfig();
const app = await buildApp({ config, clock: systemClock });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.host, port: config.port });
