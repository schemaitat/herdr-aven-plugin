import type { Entity } from '../shared/graph.js';
import type { ProjectChoice } from '../shared/projects.js';
import { ALL_TYPES, defaultFilters, type Filters, type TimePreset } from './graph/state.js';

export function Toolbar({ nodes, filters, onChange, onCommand, mounted, onMount, onSearch, matches, visible, unknownTimeExclusions, projects, project, onProject, paused, onPause }: {
  paused: boolean; onPause: () => void;
  projects: ProjectChoice[]; project?: string; onProject: (project: string) => void;
  nodes: Entity[]; filters: Filters; onChange: (filters: Filters) => void;
  onCommand: (kind: 'fit' | 'reset' | 'in' | 'out') => void; mounted: boolean; onMount: () => void;
  onSearch: () => void;
  matches: number; visible: number; unknownTimeExclusions: number;
}) {
  const epics = nodes.filter(node => node.kind === 'epic').sort((a, b) => a.label.localeCompare(b.label));
  const epic = epics.find(node => node.id === filters.epic);
  return <section aria-label="Graph and entity controls">
    <div className="toolbar" aria-label="Entity filters">
      <label>Project<select aria-label="Project" value={project ?? ''} disabled={!project} onChange={event => onProject(event.target.value)}>{!project && <option value="">Loading projects…</option>}{project && !projects.some(choice => choice.key === project) && <option value={project}>{project} (current)</option>}{projects.map(choice => <option key={choice.key} value={choice.key}>{choice.name}</option>)}</select></label>
      <button onClick={onSearch}>Search /</button>
      <label>Search entities<input type="search" maxLength={256} value={filters.query} onChange={event => onChange({ ...filters, query: event.target.value })} placeholder="Task, session, pane, branch…" /></label>
      <details className="filter-popover" onKeyDown={event => {
        if (event.key !== 'Escape') return;
        event.preventDefault(); event.stopPropagation();
        event.currentTarget.open = false;
        event.currentTarget.querySelector('summary')?.focus();
      }}>
        <summary>Filters</summary>
        <div className="filter-options">
          <fieldset><legend>Entity types</legend><div className="type-options">{ALL_TYPES.map(kind => <label key={kind}><input type="checkbox" checked={filters.kinds.has(kind)} onChange={event => {
            const kinds = new Set(filters.kinds);
            if (event.target.checked) kinds.add(kind); else kinds.delete(kind);
            onChange({ ...filters, kinds });
          }} />{kind}</label>)}</div><button onClick={() => onChange({ ...filters, kinds: new Set(ALL_TYPES) })}>All types</button></fieldset>
          <label>Source state<select value={filters.state} onChange={event => onChange({ ...filters, state: event.target.value })}><option value="all">All states</option>{[...new Set([...nodes.map(node => node.state), ...(filters.state === 'all' ? [] : [filters.state])])].sort().map(value => <option key={value}>{value}</option>)}</select></label>
          <label>Recent source changes<select value={filters.time} onChange={event => onChange({ ...filters, time: event.target.value as TimePreset })}><option value="all">All time</option><option value="24h">Last 24 hours</option><option value="72h">Last 72 hours</option><option value="7d">Last 7 days</option><option value="14d">Last 14 days</option><option value="30d">Last 30 days</option></select></label>
          <label>Epic scope<select aria-label="Epic scope" value={filters.epic ?? ''} onChange={event => onChange({ ...filters, epic: event.target.value || undefined })}><option value="">All epics and standalone entities</option>{filters.epic && !epic && <option value={filters.epic}>Unavailable epic (clear scope to continue)</option>}{epics.map(node => <option key={node.id} value={node.id}>{node.label}</option>)}</select></label>
          {filters.epic && <button onClick={() => onChange({ ...filters, epic: undefined })}>Clear epic</button>}
          <p className="muted">Time means recent source changes, not polling or heartbeat activity. Rolling windows include the cutoff; unknown, invalid and future dates are excluded. Linked resources inherit explicit owners’ source times. Current loaded records only, not historical or exhaustive coverage; filters do not fetch more sources.</p>
        </div>
      </details>
      <button onClick={() => onChange(defaultFilters())}>Reset filters</button>
    </div>
    <div className="scope-chips" aria-label="Active scope"><span>{filters.kinds.size} of {ALL_TYPES.length} types</span><span>{filters.state === 'all' ? 'All states' : filters.state}</span><span>{filters.time === 'all' ? 'All time' : `Last ${filters.time} source changes`}</span>{filters.epic && <span>{epic?.label ?? 'Unavailable epic'} <button aria-label="Clear epic scope" onClick={() => onChange({ ...filters, epic: undefined })}>×</button></span>}{filters.query && <span>Search: {filters.query}</span>}<span>{matches} matches · {visible} on canvas</span>{filters.time !== 'all' && <span role="status">{unknownTimeExclusions} unknown/invalid/future-time exclusions</span>}</div>
    <div className="graph-controls"><button disabled={!mounted} onClick={() => onCommand('in')}>Zoom in</button><button disabled={!mounted} onClick={() => onCommand('out')}>Zoom out</button><button disabled={!mounted} onClick={() => onCommand('fit')}>Fit graph</button><button disabled={!mounted} onClick={() => onCommand('reset')}>Reset positions</button><button aria-pressed={paused} onClick={onPause}>{paused ? 'Resume motion' : 'Pause motion'}</button><button onClick={onMount}>{mounted ? 'Hide graph' : 'Show graph'}</button></div>
  </section>;
}
