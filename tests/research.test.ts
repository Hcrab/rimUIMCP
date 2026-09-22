import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureResearch, researchProgress} from '../agent/helpers/research.ts';

function fake(current: string | null, completed = false, accept = true) {
  const actions: string[] = [];
  const g: any = {
    sequence: (fn: () => unknown) => fn(),
    state: {research: async () => ({meta: {sessionId: 'test', worldEpoch: 1},
      data: {current, projects: [{id: 'Machining', completed, progress: completed ? 1000 : 25, cost: 1000}]}})},
    ui: {panel: (id: string) => ({open: async () => {actions.push('panel.' + id);}}),
      snapshot: async () => ({data: {nodes: [{actionable: true, actionId: 'research.project.Machining', surface: 'research'}]}}),
      action: (id: string) => ({click: async () => {
        actions.push(id); if (id === 'research.start' && accept) current = 'Machining';
      }})},
  };
  return {g, actions};
}

test('selecting the same project twice does not click again', async () => {
  const {g, actions} = fake(null);
  assert.equal((await ensureResearch(g, 'Machining')).status, 'selected');
  assert.equal((await ensureResearch(g, 'Machining')).status, 'already-selected');
  assert.deepEqual(actions, ['panel.research', 'research.project.Machining', 'research.start']);
});

test('scrolls an off-screen project into the tree before clicking it', async () => {
  const {g, actions} = fake(null);
  let offset = 0;
  g.ui.snapshot = async () => ({data: {nodes: [
    {actionable: true, actionId: 'research.project.Machining', surface: 'research', screenRect: {x: 1500-offset, width: 100}},
    {targetId: 'tree', role: 'scroll_view', surface: 'research', scroll: {canScrollX: true, offsetX: offset, maxOffsetX: 2000, viewportScreenRect: {x: 0, width: 1000}}},
  ]}});
  g.ui.input = async (args: any) => {actions.push('scroll'); offset = args.targetX;};
  await ensureResearch(g, 'Machining');
  assert.deepEqual(actions, ['panel.research', 'scroll', 'research.project.Machining', 'research.start']);
});

test('does not click a project when scrolling failed to reveal it', async () => {
  const {g, actions} = fake(null);
  g.ui.snapshot = async () => ({data: {nodes: [
    {actionable: true, actionId: 'research.project.Machining', surface: 'research', screenRect: {x: 1500, width: 100}},
    {targetId: 'tree', role: 'scroll_view', surface: 'research', scroll: {canScrollX: true, offsetX: 0, maxOffsetX: 2000, viewportScreenRect: {x: 0, width: 1000}}},
  ]}});
  g.ui.input = async () => {};
  await assert.rejects(ensureResearch(g, 'Machining'), /remains outside/);
  assert.deepEqual(actions, ['panel.research']);
});

test('completed projects do not replace active research', async () => {
  const {g, actions} = fake('AnotherProject', true);
  assert.equal((await ensureResearch(g, 'Machining')).status, 'completed');
  assert.equal((await researchProgress(g, ['Machining'])).complete, true);
  assert.deepEqual(actions, []);
});

test('finds research culled from a snapshot by paging the real tree before activation', async () => {
  const {g,actions}=fake(null);
  let offset=2500;
  g.ui.snapshot=async()=>({data:{nodes:[
    {targetId:'tree',surface:'main-tab:Research',role:'scroll_view',scroll:{canScrollX:true,offsetX:offset,maxOffsetX:3000,viewportScreenRect:{x:0,width:1000}}},
    ...(1700-offset>=0&&1700-offset<1000?[{actionable:true,actionId:'research.project.Machining',surface:'main-tab:Research',screenRect:{x:1700-offset,width:100}}]:[]),
  ]}});
  g.ui.input=async(args:any)=>{offset=args.targetX;};
  const activate=g.ui.action;
  g.ui.action=(id:string)=>({click:async()=>{if(id==='research.project.Machining')assert.ok(1700-offset>=0&&1800-offset<=1000);await activate(id).click();}});
  assert.equal((await ensureResearch(g,'Machining')).status,'selected');
  assert.ok(actions.includes('research.start'));
});

test('processed UI input without game acceptance is an error', async () => {
  const {g} = fake(null, false, false);
  await assert.rejects(ensureResearch(g, 'Machining'), /is not selected/);
});

test('unknown or empty project sets cannot claim checkpoint completion', async () => {
  const {g} = fake(null);
  await assert.rejects(researchProgress(g, ['Misspelled']), /Unknown research/);
  assert.equal((await researchProgress(g, [])).complete, false);
});
