import { connect } from '../../packages/sdk/src/index.ts';
import { setPriority } from '../../agent/helpers/work.ts';
const game = await connect();
const pawn = (await game.state.pawns({ budgetMs: 500 })).data.items.find((p: any) => !p.work.Doctor.disabled);
const original = pawn.work.Doctor.priority;
const answer = await game.agent.ask('Lifecycle acceptance: which Doctor priority should this script apply?', { pawnId: pawn.id, original }, { timeoutMs: 60000 });
console.log(JSON.stringify(await setPriority(game, pawn.id, 'Doctor', answer.priority)));
console.log(JSON.stringify(await setPriority(game, pawn.id, 'Doctor', original)));
