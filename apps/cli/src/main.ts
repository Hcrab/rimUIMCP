import { readFileSync } from 'node:fs';
import { connect, RimError } from '../../../packages/sdk/src/index.ts';
try {
  const method = process.argv[2] ?? 'session.status';
  const source = process.argv[3] ?? '{}';
  const args = JSON.parse(source.startsWith('@') ? readFileSync(source.slice(1), 'utf8') : source);
  const game = await connect();
  const flag = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
  if (flag('--script-id')) game.scriptId = flag('--script-id')!;
  const result = await game.call(method, args, { timeoutMs: Number(args.timeoutMs ?? 30000), sequenceToken: flag('--sequence'), requestId: flag('--request-id') });
  console.log(JSON.stringify(result));
} catch (error) {
  console.log(JSON.stringify(error instanceof RimError ? error.result : { success: false, error: { code: 'CLIENT_ERROR', message: (error as Error).message } }));
  process.exitCode = 1;
}
