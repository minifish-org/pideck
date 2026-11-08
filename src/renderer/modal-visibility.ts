import { useEffect, useState } from 'react';

export function useModalOpen() {
  const [open, setOpen] = useState(() => Boolean(document.querySelector('dialog[open]')));
  useEffect(() => {
    const update = () => setOpen(Boolean(document.querySelector('dialog[open]')));
    const observer = new MutationObserver(records => {
      if (records.some(record => record.target instanceof HTMLDialogElement
        || [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element
          && (node.matches('dialog') || node.querySelector('dialog'))))) update();
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['open'], childList: true, subtree: true });
    update();
    return () => observer.disconnect();
  }, []);
  return open;
}
