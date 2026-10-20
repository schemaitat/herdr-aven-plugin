export function Legend() {
  return <details className="legend"><summary>Graph legend and state semantics</summary>
    <p>◯ Epic hub / task circle · ◇ Agent · ⬡ Attempt · ▢ Session / pane · △ Worktree · Octagon: unresolved boundary · Barrel: workspace. Every label includes entity type and textual state.</p>
    <p>contains → membership (circle arrow) · blocks → blocker to blocked task (solid amber triangle) · derived dependency → blocking-task agent to blocked-task agent (dashed amber, with source evidence) · assigned → task to execution (dashed) · session → agent to API session · placed-in → resource to pane (dotted, square arrow) · worktree → resource to checkout (diamond arrow) · related: undirected dotted line.</p>
    <p>Task status, persisted execution state and terminal observations are separate facts. Live API activity is not connected in this phase. Collapse summarizes external connections at the epic boundary; it never resolves a blocker. Filters hide connections, not dependencies in the source. Details retain source relationships even when filtered out.</p>
  </details>;
}
