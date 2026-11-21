// A stand-in CLI for the process-runner tests, spawned as `node fake-cli.mjs <mode> [...]`.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [mode, ...rest] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const forever = () => setInterval(() => {}, 1 << 30);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

switch (mode) {
  case 'stdin-digest': {
    const data = await readStdin();
    process.stdout.write(
      JSON.stringify({ bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }) + '\n',
    );
    break;
  }
  case 'stdin-ended': {
    // Exits only once stdin reaches end-of-file; a runner that never ends stdin would hang here.
    const data = await readStdin();
    process.stdout.write(`stdin closed after ${data.length} bytes\n`);
    break;
  }
  case 'chunks': {
    // Multi-byte characters and a line split across writes at awkward byte offsets.
    const text = 'première ligne — ünïcode ✓ 日本語 🎉\nzweite Zeile\r\nlast line without newline';
    const bytes = Buffer.from(text, 'utf8');
    const cuts = [1, 5, 9, 10, 11, 27, 28, 29, 30, 41, 42, 43, 44, 45, 60, 61, bytes.length];
    let start = 0;
    for (const cut of cuts) {
      process.stdout.write(bytes.subarray(start, cut));
      start = cut;
      await sleep(15);
    }
    break;
  }
  case 'exit': {
    process.stderr.write(`\u001b[31mfatal:\u001b[0m something went wrong (${rest[1] ?? 'no detail'})\n`);
    process.exit(Number(rest[0] ?? 1));
    break;
  }
  case 'env': {
    const out = {};
    for (const name of rest) out[name] = process.env[name] ?? null;
    process.stdout.write(JSON.stringify(out) + '\n');
    break;
  }
  case 'cwd': {
    process.stdout.write(process.cwd() + '\n');
    break;
  }
  case 'sleep': {
    // Starts a grandchild so tests can check that the whole tree is killed.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
    process.stdout.write(JSON.stringify({ pid: process.pid, grandchild: child.pid }) + '\n');
    forever();
    break;
  }
  case 'ignore-term': {
    process.on('SIGTERM', () => {
      process.stdout.write('ignoring SIGTERM\n');
    });
    process.stdout.write(JSON.stringify({ pid: process.pid }) + '\n');
    forever();
    break;
  }
  case 'linger': {
    process.stdout.write('{"type":"done"}\n');
    process.stdout.write(JSON.stringify({ pid: process.pid }) + '\n');
    forever();
    break;
  }
  case 'replay': {
    // Prints a fixture file, then exits with the given code.
    process.stdout.write(readFileSync(rest[0], 'utf8'));
    process.exitCode = Number(rest[1] ?? 0);
    break;
  }
  case 'plain': {
    const data = (await readStdin()).toString('utf8');
    process.stdout.write('\u001b[1mAnswer:\u001b[0m ');
    await sleep(10);
    process.stdout.write(`received ${data.length} characters\n`);
    break;
  }
  case 'args': {
    process.stdout.write(JSON.stringify(rest) + '\n');
    break;
  }
  default:
    process.stderr.write(`unknown mode ${mode}\n`);
    process.exit(2);
}
