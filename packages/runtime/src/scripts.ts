import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { Bridge } from './bridge.ts';
import { dispatch } from './actions.ts';

type CleanupError = { stage: string; message: string };
type Run = {
  id: string; path: string; status: string; started: string; ended?: string; exitCode?: number | null;
  budgetMs: number; directory: string; sourceSha256: string; reason?: string; cleanupErrors?: CleanupError[];
  process?: ChildProcess; timer?: NodeJS.Timeout; cancelPromise?: Promise<void>;
};
export class Scripts {
  runs = new Map<string, Run>(); root: string; configFile: string; bridge: Bridge;
  constructor(root: string, configFile: string, bridge: Bridge) { this.root = root; this.configFile = configFile; this.bridge = bridge; }
  persist(run: Run) { writeFileSync(path.join(run.directory, 'status.json'), JSON.stringify(this.describe(run), null, 2)); }
  describe(run: Run) { const { process, timer, cancelPromise, ...record } = run; return record; }
  private message(error: unknown) {
    let text: string;
    try { text = error instanceof Error ? error.message : String(error); }
    catch { return 'Cleanup error could not be serialized.'; }
    if (/(?:token|password|secret|authorization|rimplay_config)/i.test(text)) return 'Sensitive error details were redacted.';
    return text
      .replace(/(["']?(?:token|password|secret|authorization)["']?\s*[=:]\s*)(?:["'][^"']*["']|[^\s,;}]+)/gi, '$1[redacted]')
      .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
      .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
      .slice(0, 500);
  }
  private rememberCleanupError(run: Run, stage: string, error: unknown) {
    const message = this.message(error);
    const errors = run.cleanupErrors ??= [];
    if (!errors.some(item => item.stage === stage && item.message === message)) errors.push({ stage, message });
  }
  private persistSafely(run: Run) {
    try { this.persist(run); return true; }
    catch (error) { this.rememberCleanupError(run, 'status-persist', error); return false; }
  }
  private appendSafely(run: Run, file: 'stdout.log' | 'stderr.log', data: string | Buffer) {
    try { appendFileSync(path.join(run.directory, file), data); }
    catch (error) { this.rememberCleanupError(run, file === 'stdout.log' ? 'stdout-log' : 'stderr-log', error); this.persistSafely(run); }
  }
  private async finishAfterClose(run: Run) {
    if (run.status !== 'succeeded' && run.status !== 'failed') return;
    try { await dispatch(this.bridge, { method: 'session.finish', args: { scriptId: run.id, status: run.status } }); }
    catch (error) { this.rememberCleanupError(run, 'session-finish', error); this.persistSafely(run); }
  }
  private onClose(run: Run, code: number | null) {
    try {
      clearTimeout(run.timer); run.exitCode = code; run.ended = new Date().toISOString();
      if (['running', 'waiting-for-agent'].includes(run.status)) {
        run.status = code === 0 ? 'succeeded' : 'failed';
        if (run.status === 'failed') run.reason = `Script process exited with code ${code ?? 'unknown'}.`;
      }
      this.persistSafely(run);
      void this.finishAfterClose(run).catch(error => { this.rememberCleanupError(run, 'close-handler', error); this.persistSafely(run); });
    } catch (error) {
      this.rememberCleanupError(run, 'close-handler', error); this.persistSafely(run);
    }
  }
  /**
   * Launches a TypeScript, JavaScript, or Python script under the current user with the inherited
   * environment, injecting the configuration and script ID. It archives the entry source and its
   * hash for traceability while executing the original path, meaning external dependencies are not
   * snapshotted. The wall-clock budget ranges from 1 second to 12 hours (defaulting to 30
   * minutes), and the run record is returned immediately.
   */
  run(args: Record<string, any>) {
    const file = path.resolve(this.root, args.path);
    if (!existsSync(file)) throw new Error('Script file not found: ' + file);
    const extension = path.extname(file).toLowerCase();
    if (!['.ts', '.js', '.mjs', '.py'].includes(extension)) throw new Error('Use a TS, JS or Python script.');
    const id = randomUUID(); const directory = path.join(this.root, 'runs', id); mkdirSync(directory, { recursive: true });
    const requestedBudget = Number(args.budgetMs ?? 30 * 60000);
    if (!Number.isFinite(requestedBudget)) throw new Error('budgetMs must be a finite number');
    const budgetMs = Math.max(1000, Math.min(12 * 3600000, requestedBudget));
    const source = readFileSync(file); writeFileSync(path.join(directory, 'entry-source' + extension), source);
    const run: Run = { id, path: file, status: 'running', started: new Date().toISOString(), budgetMs, directory, sourceSha256: createHash('sha256').update(source).digest('hex') };
    const executable = extension === '.py' ? process.env.RIMUIMCP_PYTHON ?? 'python' : process.execPath;
    const child = spawn(executable, [file, ...(args.argv ?? []).map(String)], { cwd: this.root, windowsHide: true,
      env: { ...process.env, RIMUIMCP_CONFIG: this.configFile, RIMUIMCP_SCRIPT_ID: id, PYTHONPATH: path.join(this.root, 'packages', 'python'), PYTHONUNBUFFERED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    run.process = child; this.runs.set(id, run);
    child.stdout?.on('data', bytes => this.appendSafely(run, 'stdout.log', bytes));
    child.stderr?.on('data', bytes => this.appendSafely(run, 'stderr.log', bytes));
    child.on('error', error => {
      try {
        if (['running', 'waiting-for-agent'].includes(run.status)) { run.status = 'failed'; run.reason = this.message(error); }
        this.appendSafely(run, 'stderr.log', this.message(error)); this.persistSafely(run);
      } catch (handlerError) { this.rememberCleanupError(run, 'error-handler', handlerError); this.persistSafely(run); }
    });
    child.on('close', code => this.onClose(run, code));
    run.timer = setTimeout(() => {
      void this.cancel(id, 'budget-exceeded').catch(error => {
        this.rememberCleanupError(run, 'budget-cancel', error);
        this.persistSafely(run);
      });
    }, budgetMs);
    this.persistSafely(run); return this.describe(run);
  }
  /**
   * Retrieves the status of a script run, prioritizing live in-memory execution and falling back
   * to the persisted record. If the host restarts, any previously running or waiting records are
   * read as unknown. This allows callers to distinguish historical records from actively managed
   * processes.
   */
  status(id: string) {
    const run = this.runs.get(id); if (run) return this.describe(run);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Unknown script ID');
    const file = path.join(this.root, 'runs', id, 'status.json'); if (!existsSync(file)) throw new Error('Unknown script ID');
    const record = JSON.parse(readFileSync(file, 'utf8'));
    return ['running', 'waiting-for-agent'].includes(record.status) ? { ...record, status: 'unknown', reason: 'Owning runtime restarted; saved status is historical.' } : record;
  }
  waiting(id: string | undefined, waiting: boolean) {
    const run = id && this.runs.get(id);
    if (run && ['running', 'waiting-for-agent'].includes(run.status)) { run.status = waiting ? 'waiting-for-agent' : 'running'; this.persist(run); }
  }
  /**
   * Cancels active bridge work first, then attempts to terminate the local process even if the
   * bridge cleanup fails. It saves any cleanup errors and reuses the cancellation promise for
   * repeat calls. Any game inputs already applied by the script remain in the game.
   */
  async cancel(id: string, reason = 'cancelled') {
    const run = this.runs.get(id); if (!run) throw new Error('Unknown script ID');
    if (!['running', 'waiting-for-agent'].includes(run.status)) { if (run.cancelPromise) await run.cancelPromise; return this.describe(run); }
    run.status = reason; run.reason = reason; clearTimeout(run.timer); this.persistSafely(run);
    run.cancelPromise = (async () => {
      try { await dispatch(this.bridge, { method: 'session.cancel', args: { scriptId: id }, timeoutMs: 5000 }); }
      catch (error) { this.rememberCleanupError(run, 'session-cancel', error); }
      try {
        const killed = run.process?.kill();
        if (!killed && !run.ended) this.rememberCleanupError(run, 'process-kill', new Error('Local script process was unavailable for termination.'));
      } catch (error) { this.rememberCleanupError(run, 'process-kill', error); }
      this.persistSafely(run);
    })();
    await run.cancelPromise;
    return this.describe(run);
  }
}
