import type { Game } from '../../packages/sdk/src/index.ts';
import { queryAll } from './observe.ts';

export type LetterNotice = { id: number; label: string; def: string };

/** Positive letters wait for the next decision batch; unknown/negative letters stop. */
export function classifyLetters(ids: number[], letters: LetterNotice[]) {
  const byId = new Map(letters.map(letter => [letter.id, letter]));
  const deferred: LetterNotice[] = [];
  const urgent: Array<LetterNotice | { id: number; reason: string }> = [];
  for (const id of new Set(ids)) {
    const letter = byId.get(id);
    if (!letter) urgent.push({ id, reason: 'Letter disappeared before classification' });
    else if (letter.def === 'PositiveEvent') deferred.push(letter);
    else urgent.push(letter);
  }
  return { deferred, urgent };
}

/**
 * Reads current letters and classifies requested IDs as deferred PositiveEvent letters or urgent
 * alerts. It uses sameTick:false for running observations. It returns the classification only,
 * leaving the decision to pause or dismiss letters to the caller.
 */
export async function readLetterBatch(game: Game, ids: number[]) {
  const rows = await queryAll(game, {
    root: 'letters', path: 'letters', fields: ['ID', 'label', 'def.defName'],
  }, { sameTick: false });
  const letters = rows.items.map(row => ({ id: row.ID, label: row.label, def: row['def.defName'] }));
  return { ...classifyLetters(ids, letters), pages: rows.pages };
}
