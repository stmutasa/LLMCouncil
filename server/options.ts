import path from 'node:path';
import { REPO_ROOT } from './app';

export interface CliOptions {
  port: number;
  host: string;
  dataDir: string;
  mock: boolean;
}

const USAGE = 'Usage: tsx server/index.ts [--port 8787] [--host 127.0.0.1] [--data-dir <path>] [--mock]';

/** Flags win over environment variables, which win over defaults. */
export function parseCliOptions(argv: string[], env: NodeJS.ProcessEnv): CliOptions {
  const opts: CliOptions = {
    port: env.PORT ? Number(env.PORT) : 8787,
    host: '127.0.0.1',
    dataDir: env.COUNCIL_DATA_DIR || path.join(REPO_ROOT, 'data'),
    mock: env.COUNCIL_MOCK === '1' || env.COUNCIL_MOCK === 'true',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined || v === '') throw new Error(`${flag} needs a value. ${USAGE}`);
      return v;
    };
    switch (flag) {
      case '--port':
        opts.port = Number(value());
        break;
      case '--host':
        opts.host = value();
        break;
      case '--data-dir':
        opts.dataDir = value();
        break;
      case '--mock':
        opts.mock = true;
        break;
      case '--help':
      case '-h':
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option ${arg}. ${USAGE}`);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    throw new Error(`The port must be a whole number between 0 and 65535. ${USAGE}`);
  }
  opts.dataDir = path.resolve(opts.dataDir);
  return opts;
}
