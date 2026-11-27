import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

interface Props { title: string; close(): void; children: ReactNode; /** A popup without a heading, such as Go to. */ popup?: boolean }

export default function CodeDialog({ title, close, children, popup = false }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    element.querySelector<HTMLElement>('input, button[data-autofocus]')?.focus();
    return () => { element.close(); };
  }, []);
  return <dialog ref={dialog} className={`code-dialog ${popup ? 'code-popup' : ''}`} aria-label={title}
    onCancel={event => { event.preventDefault(); close(); }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); close(); } }}
    onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="code-dialog-content">
      {!popup && <div className="code-dialog-heading"><h2>{title}</h2><button className="code-icon" onClick={close} aria-label="Close dialog"><X size={17} /></button></div>}
      {children}
    </div>
  </dialog>;
}
