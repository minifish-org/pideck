import type { Project, Session } from '../shared/api';

export type SessionSearchResult = { project: Project; session: Session };

const searchable = (value: string) => value.normalize('NFKC').toLowerCase();

export function searchSessions(projects: readonly Project[], lists: Readonly<Record<string, readonly Session[]>>, query: string): SessionSearchResult[] {
  const terms = searchable(query).trim().split(/\s+/u).filter(Boolean);
  return projects.flatMap(project => (lists[project.id] ?? [])
    .filter(session => {
      if (session.projectId !== project.id) return false;
      const text = searchable(`${session.title}\n${project.name}`);
      return terms.every(term => text.includes(term));
    })
    .map(session => ({ project, session })))
    .sort((a, b) => b.session.updatedAt - a.session.updatedAt);
}
