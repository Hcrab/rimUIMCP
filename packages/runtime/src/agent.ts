import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Scripts } from './scripts.ts';
import type { Request } from './actions.ts';

type Question = { id: string; scriptId?: string; question: string; context: unknown; status: 'pending' | 'answered' | 'cancelled'; created: string; answered?: string; answer?: unknown };
const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };

/** A durable rendezvous with the external AI. It does not claim to invoke a model. */
export class AgentMailbox {
  directory: string; scripts: Scripts;
  constructor(root: string, scripts: Scripts) { this.directory = path.join(root, 'runs', 'agent-requests'); this.scripts = scripts; mkdirSync(this.directory, { recursive: true }); }
  private file(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id ?? '')) fail('INVALID_ARGUMENT', 'Use the request UUID returned by agent.request.');
    return path.join(this.directory, id + '.json');
  }
  private save(record: Question) {
    const file = this.file(record.id), temporary = file + '.tmp';
    writeFileSync(temporary, JSON.stringify(record, null, 2)); renameSync(temporary, file);
  }
  status(id: string): Question {
    const file = this.file(id); if (!existsSync(file)) fail('TARGET_GONE', 'Unknown agent request.');
    const record: Question = JSON.parse(readFileSync(file, 'utf8'));
    const run = record.scriptId && this.scripts.runs.get(record.scriptId);
    if (record.status === 'pending' && run && !['running', 'waiting-for-agent'].includes(run.status)) { record.status = 'cancelled'; this.save(record); }
    return record;
  }
  /**
   * Manages the durable lifecycle of external AI questions and answers. Orchestrators read pending
   * requests and submit responses, while the SDK ask method polls for completion. Callers should
   * ask questions outside of a UI sequence so other actors can use the GUI while the answer is
   * being prepared, using request IDs to support repeat submissions.
   */
  invoke(call: Request) {
    const args = call.args ?? {};
    switch (call.method) {
      case 'agent.request': {
        if (call.sequenceToken) fail('SEQUENCE_HELD', 'Exit game.sequence before asking the AI so the GUI remains available.');
        if (typeof args.question !== 'string' || !args.question.trim()) fail('INVALID_ARGUMENT', 'question must be nonempty text.');
        const id = call.requestId ?? randomUUID(), file = this.file(id);
        if (existsSync(file)) {
          const previous = this.status(id);
          if (previous.scriptId !== call.scriptId || previous.question !== args.question || JSON.stringify(previous.context) !== JSON.stringify(args.context ?? null)) fail('REQUEST_ID_CONFLICT', 'Request ID was already used for a different question.');
          return previous;
        }
        const record: Question = { id, scriptId: call.scriptId, question: args.question, context: args.context ?? null, status: 'pending', created: new Date().toISOString() };
        this.save(record); this.scripts.waiting(call.scriptId, true); return record;
      }
      case 'agent.status': return this.status(args.id);
      case 'agent.pending': return { items: readdirSync(this.directory).filter(f => f.endsWith('.json')).map(f => this.status(f.slice(0, -5))).filter(r => r.status === 'pending') };
      case 'agent.respond': {
        const record = this.status(args.id);
        if (!Object.hasOwn(args, 'answer')) fail('INVALID_ARGUMENT', 'answer is required; it may be structured JSON.');
        if (record.status === 'cancelled') fail('TARGET_GONE', 'The script has already ended or been cancelled.');
        if (record.status === 'answered') {
          if (JSON.stringify(record.answer) !== JSON.stringify(args.answer)) fail('REQUEST_ID_CONFLICT', 'This question already has a different answer.');
          return record;
        }
        record.status = 'answered'; record.answer = args.answer; record.answered = new Date().toISOString();
        this.save(record); this.scripts.waiting(record.scriptId, false); return record;
      }
      default: return fail('UNKNOWN_METHOD', call.method);
    }
  }
}
