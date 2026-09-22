import type { Game, ObservationMeta, Result } from '../../packages/sdk/src/index.ts';

type Pawn = { id: string; [key: string]: unknown };
type PawnPage = Result<{ items?: unknown; total?: unknown; offset?: unknown; limit?: unknown; nextCursor?: unknown; truncated?: unknown }>;

export type PawnPageSummary = {
  offset: number;
  limit: number;
  count: number;
  total: number | null;
  nextCursor: number | null;
  truncated: boolean;
};

export type CompletePawnRead = Result<{
  items: Pawn[];
  total: number;
  offset: 0;
  limit: number;
  nextCursor: null;
  truncated: false;
  complete: true;
  pages: PawnPageSummary[];
  pageCount: number;
  consistency: 'single-page' | 'paused-restart';
  bridge: 'metadata' | 'legacy';
  pausedForConsistency: boolean;
}> & { resumeRequired: boolean };

export type CompletePawnReadOptions = {
  colonistsOnly?: boolean;
  budgetMs?: number;
  pageSize?: number;
  maxPages?: number;
  /** Called before a paged read is restarted at cursor zero. The helper leaves resuming to its caller. */
  pauseForConsistency?: () => Promise<unknown>;
};

export class PawnPagingError extends Error {
  constructor(message: string) { super(message); this.name = 'PawnPagingError'; }
}

const sameWorld = (left: ObservationMeta, right: ObservationMeta) =>
  left.sessionId === right.sessionId && left.worldEpoch === right.worldEpoch;

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new PawnPagingError(`state.pawns returned invalid ${name}.`);
  return Number(value);
}

function itemsFrom(page: PawnPage): Pawn[] {
  if (!Array.isArray(page.data?.items)) throw new PawnPagingError('state.pawns did not return an items array.');
  return page.data.items as Pawn[];
}

function metadataMode(page: PawnPage): boolean {
  const data = page.data as Record<string, unknown>;
  const keys = ['total', 'offset', 'limit', 'nextCursor', 'truncated'];
  const found = keys.filter(key => Object.hasOwn(data, key));
  if (found.length !== 0 && found.length !== keys.length)
    throw new PawnPagingError(`state.pawns returned incomplete pagination metadata (${found.join(', ')}).`);
  return found.length === keys.length;
}

function validateIds(items: Pawn[], seen: Set<string>) {
  for (const pawn of items) {
    if (typeof pawn?.id !== 'string' || pawn.id.length === 0) throw new PawnPagingError('state.pawns returned a pawn without a stable id.');
    if (seen.has(pawn.id)) throw new PawnPagingError(`state.pawns repeated pawn id ${pawn.id}.`);
    seen.add(pawn.id);
  }
}

async function page(game: Pick<Game, 'state'>, options: CompletePawnReadOptions, offset: number, limit: number): Promise<PawnPage> {
  return await game.state.pawns({ colonistsOnly: options.colonistsOnly ?? false, budgetMs: options.budgetMs ?? 500, limit, cursor: offset }) as PawnPage;
}

/**
 * Reads every pawn page without ever presenting a partial page as complete.
 * A paged read is paused and restarted at cursor zero so all retained pages share one game tick.
 */
export async function readAllPawns(game: Pick<Game, 'state'>, options: CompletePawnReadOptions = {}): Promise<CompletePawnRead> {
  const limit = options.pageSize ?? 100;
  const maxPages = options.maxPages ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50000) throw new PawnPagingError('pageSize must be an integer from 1 through 50000.');
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new PawnPagingError('maxPages must be a positive integer.');

  let first = await page(game, options, 0, limit);
  const probeMeta = first.meta;
  let restarted = false;
  const firstItems = itemsFrom(first);
  const firstMetadata = metadataMode(first);
  const firstPaged = firstMetadata ? first.data.truncated === true : firstItems.length === limit;
  if (firstPaged) {
    if (!options.pauseForConsistency) throw new PawnPagingError('state.pawns requires multiple pages; pause and restart from cursor zero before aggregating.');
    await options.pauseForConsistency();
    first = await page(game, options, 0, limit);
    if (!sameWorld(probeMeta, first.meta)) throw new PawnPagingError('state.pawns changed session or world before its consistent paging restart.');
    restarted = true;
  }

  const mode = metadataMode(first) ? 'metadata' : 'legacy';
  const startMeta = first.meta;
  const seen = new Set<string>();
  const items: Pawn[] = [];
  const pages: PawnPageSummary[] = [];
  let offset = 0;
  let expectedTotal: number | null = null;
  let current = first;

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    if (!sameWorld(startMeta, current.meta)) throw new PawnPagingError('state.pawns changed session or world while paging.');
    if (current.meta.gameTick !== startMeta.gameTick) throw new PawnPagingError('state.pawns changed game tick while paging; partial pages were discarded.');
    if (metadataMode(current) !== (mode === 'metadata')) throw new PawnPagingError('state.pawns changed pagination format while paging.');

    const currentItems = itemsFrom(current);
    if (currentItems.length > limit) throw new PawnPagingError('state.pawns returned more items than its requested limit.');
    validateIds(currentItems, seen);
    items.push(...currentItems);

    if (mode === 'metadata') {
      const data = current.data;
      const total = positiveInteger(data.total, 'total');
      const responseOffset = positiveInteger(data.offset, 'offset');
      const responseLimit = positiveInteger(data.limit, 'limit');
      if (responseOffset !== offset || responseLimit !== limit) throw new PawnPagingError('state.pawns returned a page for a different cursor or limit.');
      if (expectedTotal !== null && total !== expectedTotal) throw new PawnPagingError('state.pawns total changed while paging.');
      expectedTotal = total;
      if (typeof data.truncated !== 'boolean') throw new PawnPagingError('state.pawns returned invalid truncated metadata.');
      const nextCursor = data.nextCursor === null ? null : positiveInteger(data.nextCursor, 'nextCursor');
      if (data.truncated !== (nextCursor !== null)) throw new PawnPagingError('state.pawns disagreed about truncation and nextCursor.');
      pages.push({ offset, limit, count: currentItems.length, total, nextCursor, truncated: data.truncated });
      if (nextCursor === null) {
        if (items.length !== total) throw new PawnPagingError(`state.pawns count mismatch: received ${items.length}, expected ${total}.`);
        return { ...current, data: { items, total, offset: 0, limit, nextCursor: null, truncated: false, complete: true, pages, pageCount: pages.length, consistency: restarted ? 'paused-restart' : 'single-page', bridge: mode, pausedForConsistency: restarted }, resumeRequired: restarted } as CompletePawnRead;
      }
      if (nextCursor !== offset + currentItems.length || nextCursor <= offset) throw new PawnPagingError('state.pawns cursor did not advance by the returned page size.');
      offset = nextCursor;
    } else {
      const truncated = currentItems.length === limit;
      pages.push({ offset, limit, count: currentItems.length, total: null, nextCursor: truncated ? offset + currentItems.length : null, truncated });
      if (!truncated) {
        return { ...current, data: { items, total: items.length, offset: 0, limit, nextCursor: null, truncated: false, complete: true, pages, pageCount: pages.length, consistency: restarted ? 'paused-restart' : 'single-page', bridge: mode, pausedForConsistency: restarted }, resumeRequired: restarted } as CompletePawnRead;
      }
      offset += currentItems.length;
    }
    if (pageNumber + 1 >= maxPages) throw new PawnPagingError(`state.pawns exceeded its ${maxPages}-page safety budget.`);
    current = await page(game, options, offset, limit);
  }
  throw new PawnPagingError(`state.pawns exceeded its ${maxPages}-page safety budget.`);
}
