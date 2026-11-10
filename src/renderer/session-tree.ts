import type { Session } from '../shared/api';

export type SessionTreeRow = { session: Session; depth: number; hasChildren: boolean; parentId?: string };

// Stable sibling order follows the host's recency order, never inferred titles.
// Broken/missing ancestry is shown at the root rather than hiding a session.
export function sessionTree(sessions: Session[], collapsed: Readonly<Record<string, boolean>> = {}): SessionTreeRow[] {
  const records = new Map(sessions.map(session => [session.id, session]));
  const children = new Map<string | undefined, Session[]>();
  for (const session of sessions) {
    let parent = session.parentSessionId;
    const seen = new Set([session.id]);
    let ancestor = parent;
    while (ancestor && records.has(ancestor)) {
      if (seen.has(ancestor)) { parent = undefined; break; }
      seen.add(ancestor);
      ancestor = records.get(ancestor)?.parentSessionId;
    }
    if (!parent || !records.has(parent)) parent = undefined;
    const group = children.get(parent) ?? [];
    group.push(session);
    children.set(parent, group);
  }
  const rows: SessionTreeRow[] = [];
  function visit(parentId: string | undefined, depth: number) {
    for (const session of children.get(parentId) ?? []) {
      rows.push({ session, depth, parentId, hasChildren: Boolean(children.get(session.id)?.length) });
      if (!collapsed[session.id]) visit(session.id, depth + 1);
    }
  }
  visit(undefined, 0);
  return rows;
}
