import {
  ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, CircleAlert, CodeXml, Columns2, Copy,
  Eye, FilePlus2, FileText, Folder, FolderPlus, GitFork, Image, ImagePlus, KeyRound, ListPlus, LoaderCircle, MessageCircle,
  PanelLeft, Pencil, Plus, Search, Settings, SquareTerminal, Trash2, Undo2, X,
} from 'lucide-react';
import type { SVGProps } from 'react';

const icons = {
  sidebar: PanelLeft, terminal: SquareTerminal, diff: Columns2, folder: Folder, folderPlus: FolderPlus,
  plus: Plus, chat: MessageCircle, chevron: ChevronRight, down: ChevronDown, settings: Settings,
  arrowUp: ArrowUp, arrowDown: ArrowDown, close: X, file: FileText, copy: Copy,
  queue: ListPlus, restore: Undo2, eye: Eye, filePlus: FilePlus2, picture: Image,
  code: CodeXml, check: Check, alert: CircleAlert, spinner: LoaderCircle, key: KeyRound, image: ImagePlus, fork: GitFork, edit: Pencil, search: Search, trash: Trash2,
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
