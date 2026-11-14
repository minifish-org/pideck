import { createContext, useContext, type RefObject } from 'react';
import type { Project, Selection } from '../shared/api';
import type { ProjectLink } from '../shared/message-links';

export type MarkdownScope = {
  project: Project; selection?: Selection; entryId?: number; streaming: boolean;
  onReview: (target: ProjectLink) => void;
  container: RefObject<HTMLDivElement | null>;
};
export const MarkdownContext = createContext<MarkdownScope | undefined>(undefined);
export function useMarkdownScope() {
  const scope = useContext(MarkdownContext);
  if (!scope) throw new Error('Markdown must have a message scope.');
  return scope;
}
