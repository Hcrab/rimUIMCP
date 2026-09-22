import type { Game, Result, ActionResult, ObjectRef } from './index.ts';

export type Selector = { surface?: string; role?: string; name?: string; actionId?: string; ownerId?: string; ownerRef?: ObjectRef; rowKey?: string; parentTargetId?: string; source?: string; exact?: boolean; nth?: number };
/**
 * Stores selector criteria that are resolved on the game side at the moment of invocation. Methods
 * like filter and nth return new locator instances. To disambiguate repeated UI labels, prefer
 * using ownerId, rowKey, or actionId, and refresh selectors when the screen layout changes.
 */
export class Locator {
  game: Game; selector: Selector;
  constructor(game: Game, selector: Selector) { this.game = game; this.selector = { ...selector }; }
  filter(selector: Selector) { return new Locator(this.game, { ...this.selector, ...selector }); }
  nth(index: number) { return this.filter({ nth: index }); }
  read() { return this.game.call('ui.read', { selector: this.selector }); }
  resolve() { return this.game.call('ui.resolve', { selector: this.selector }); }
  input(action: string, args: Record<string, unknown> = {}): Promise<Result<ActionResult>> { return this.game.call('ui.input', { selector: this.selector, action, ...args }); }
  click(options: { button?: 'left' | 'right' | 'middle'; modifiers?: string } = {}) { return this.input('click', options); }
  activate() { return this.click(); }
  fill(text: string) { return this.input('fill', { text }); }
  press(key: string, modifiers?: string) { return this.input('press', { key, modifiers }); }
  setChecked(value: boolean) { return this.input('setChecked', { value }); }
  setValue(value: string | number) { return this.input('setValue', { value }); }
  scroll(options: { deltaY?: number; deltaX?: number; targetY?: number; targetX?: number }) { return this.input('scroll', options); }
  hover() { return this.input('hover'); }
}
