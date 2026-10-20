import { useEffect, useState, type ReactNode } from 'react';

// Explicit page windowing bounds mounted DOM even for variable-height hostile
// log text. Unlike scroll-only virtualization, every row is keyboard reachable.
export function WindowedList<T>({ items, render, identity, selected, label, className, ordered = false }: {
  items: T[]; render: (item: T) => ReactNode; identity: (item: T) => string;
  selected?: string; label: string; className?: string; ordered?: boolean;
}) {
  const size = 40;
  const [requestedPage, setPage] = useState(0);
  const selectedIndex = selected ? items.findIndex(item => identity(item) === selected) : -1;
  useEffect(() => { if (selectedIndex >= 0) setPage(Math.floor(selectedIndex / size)); }, [selected, selectedIndex]);
  const pages = Math.max(1, Math.ceil(items.length / size));
  const page = Math.min(requestedPage, pages - 1);
  const start = page * size;
  const children = items.slice(start, start + size).map((item, offset) => <li key={identity(item)} aria-posinset={start + offset + 1} aria-setsize={items.length}>{render(item)}</li>);
  return <>
    {items.length > size && <nav className="list-pages" aria-label={`${label} pages`}>
      <button onClick={() => setPage(page - 1)} disabled={page === 0}>Previous {label}</button>
      <span role="status">{start + 1}–{Math.min(start + size, items.length)} of {items.length} · windowed</span>
      <button onClick={() => setPage(page + 1)} disabled={page === pages - 1}>Next {label}</button>
    </nav>}
    {ordered ? <ol className={className} start={start + 1}>{children}</ol> : <ul className={className}>{children}</ul>}
  </>;
}
