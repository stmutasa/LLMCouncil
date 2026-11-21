import { APP_NAME } from '../shared/defaults';
import { createApp } from './app';
import { parseCliOptions, type CliOptions } from './options';
import { killAll } from './providers/proc';

async function main(): Promise<void> {
  let opts: CliOptions;
  try {
    opts = parseCliOptions(process.argv.slice(2), process.env);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const council = await createApp({ dataDir: opts.dataDir, mock: opts.mock, host: opts.host });
  const server = council.app.listen(opts.port, opts.host);

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${opts.port} on ${opts.host} is already in use. Start the server on another port, for example: --port ${opts.port + 1}`);
    } else {
      console.error(`Could not start the server: ${err.message}`);
    }
    process.exit(1);
  });

  server.on('listening', () => {
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : opts.port;
    const host = opts.host.includes(':') ? `[${opts.host}]` : opts.host;
    console.log(`${APP_NAME} is running at http://${host}:${port}/${opts.mock ? ' (demo provider enabled)' : ''}`);
    console.log(`Data directory: ${opts.dataDir}`);
  });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) {
      killAll(true);
      process.exit(1);
    }
    stopping = true;
    console.log(`\n${signal} received; stopping running turns and CLI processes…`);
    const shutdown = council.shutdown();
    killAll();
    server.closeAllConnections?.();
    server.close();
    void shutdown.finally(() => {
      // Anything that ignored SIGTERM must not outlive the server.
      killAll(true);
      process.exit(0);
    });
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

// A defect in one request must not take the whole server, and every running turn, down with it.
process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled promise rejection:', reason);
});

void main().catch((err: unknown) => {
  console.error('The server failed to start:', err);
  killAll(true);
  process.exit(1);
});
