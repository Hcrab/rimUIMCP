import type {Game} from '../../packages/sdk/src/index.ts';

async function revealProject(game: Game, projectId: string) {
  let nodes = (await game.ui.snapshot()).data.nodes;
  let project = nodes.find((n: any) => n.actionable && n.actionId === `research.project.${projectId}`);
  // RimWorld skips drawing distant columns, so the target may not exist in the current UI snapshot.
  if (!project) {
    let nextX = 0;
    for (let page = 0; page < 20 && !project; page++) {
      const trees = nodes.filter((n: any) => n.surface === 'main-tab:Research' && n.role === 'scroll_view' && n.scroll?.canScrollX);
      if (trees.length !== 1) break;
      const tree = trees[0], maximum = tree.scroll.maxOffsetX;
      await game.ui.input({targetId: tree.targetId, action: 'scroll', targetX: Math.min(nextX, maximum)});
      nodes = (await game.ui.snapshot()).data.nodes;
      project = nodes.find((n: any) => n.actionable && n.actionId === `research.project.${projectId}`);
      if (nextX >= maximum) break;
      nextX = Math.min(maximum, nextX + Math.max(1, tree.scroll.viewportScreenRect.width * 0.75));
    }
  }
  if (!project) throw new Error(`Research project ${projectId} is not present in the current research tab.`);
  const scrollers = nodes.filter((n: any) => n.surface === project.surface && n.role === 'scroll_view' && n.scroll?.canScrollX);
  if (!scrollers.length) return;
  if (scrollers.length !== 1) throw new Error('The research tree scroll view is ambiguous.');
  const scroll = scrollers[0], view = scroll.scroll.viewportScreenRect, box = project.screenRect;
  if (box.x >= view.x && box.x + box.width <= view.x + view.width) return;
  const targetX = Math.max(0, Math.min(scroll.scroll.maxOffsetX,
    scroll.scroll.offsetX + box.x + box.width / 2 - view.x - view.width / 2));
  await game.ui.input({targetId: scroll.targetId, action: 'scroll', targetX});
  const after = (await game.ui.snapshot()).data.nodes.find((n: any) => n.actionable && n.actionId === `research.project.${projectId}`);
  if (!after || after.screenRect.x < view.x || after.screenRect.x + after.screenRect.width > view.x + view.width)
    throw new Error(`Research project ${projectId} remains outside the tree viewport after scrolling.`);
}

/** Select a project through the research screen and verify the game's selection. */
export async function ensureResearch(game: Game, projectId: string) {
  return game.sequence(async () => {
    const before = await game.state.research();
    const project = before.data.projects.find((p: any) => p.id === projectId);
    if (!project) throw new Error(`Unknown research project: ${projectId}`);
    if (project.completed) return {status: 'completed', projectId, meta: before.meta};
    if (before.data.current === projectId) return {status: 'already-selected', projectId, meta: before.meta};
    await game.ui.panel('research').open();
    await revealProject(game, projectId);
    await game.ui.action(`research.project.${projectId}`).click();
    await game.ui.action('research.start').click();
    const after = await game.state.research();
    if (after.meta.sessionId !== before.meta.sessionId || after.meta.worldEpoch !== before.meta.worldEpoch)
      throw new Error('World changed while selecting research; inspect the new session.');
    if (after.data.current !== projectId)
      throw new Error(`Research input was processed, but ${projectId} is not selected. Inspect prerequisites and the active window.`);
    return {status: 'selected', projectId, meta: after.meta};
  });
}

/** Read-only milestone evidence. The caller decides which projects form a checkpoint. */
export async function researchProgress(game: Game, projectIds: string[]) {
  const observation = await game.state.research();
  const projects = projectIds.map(id => {
    const project = observation.data.projects.find((p: any) => p.id === id);
    if (!project) throw new Error(`Unknown research project: ${id}`);
    return {id, completed: project.completed, progress: project.progress, cost: project.cost};
  });
  return {meta: observation.meta, current: observation.data.current, projects,
    complete: projects.length > 0 && projects.every(p => p.completed)};
}
