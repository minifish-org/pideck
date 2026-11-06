import {
  ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, CircleAlert, CodeXml, Columns2,
  Ellipsis, FileText, Folder, FolderPlus, GitFork, ImagePlus, KeyRound, Layers, LockKeyhole, MessageCircle,
  PanelLeft, Plus, Search, Settings, ShieldCheck, SquareTerminal, X,
} from 'lucide-react';
import type { SVGProps } from 'react';

const icons = {
  sidebar: PanelLeft, terminal: SquareTerminal, diff: Columns2, folder: Folder, folderPlus: FolderPlus,
  plus: Plus, chat: MessageCircle, chevron: ChevronRight, down: ChevronDown, settings: Settings,
  lock: LockKeyhole, shield: ShieldCheck, arrowUp: ArrowUp, arrowDown: ArrowDown, close: X, file: FileText,
  code: CodeXml, check: Check, alert: CircleAlert, key: KeyRound, image: ImagePlus, layers: Layers, fork: GitFork, more: Ellipsis, search: Search,
};

export function Icon({ name, ...props }: { name: keyof typeof icons | 'mark' | 'stop' } & SVGProps<SVGSVGElement>) {
  if (name === 'mark' || name === 'stop') {
    return (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
        strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        {name === 'mark'
          ? <><path d="m3 7 9-4 9 4-9 4-9-4Z" /><path d="m3 12 9 4 9-4M3 17l9 4 9-4" /></>
          : <rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor" stroke="none" />}
      </svg>
    );
  }

  const Drawing = icons[name];
  return <Drawing size={16} strokeWidth={1.65} aria-hidden="true" {...props} />;
}
