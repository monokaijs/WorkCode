import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface MenuItem { label: string; action(): void; destructive?: boolean; /** Draws a rule above the item. */ separator?: boolean }
interface Props { label: string; x: number; y: number; items: MenuItem[]; close(): void }

/** A context menu at the pointer, as in VS Code. It closes on Escape, a click elsewhere, or a resize. */
export default function CodeMenu({ label, x, y, items, close }: Props) {
  const element = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const menu = element.current!;
    const { width, height } = menu.getBoundingClientRect();
    const bounds = (menu.offsetParent ?? document.documentElement).getBoundingClientRect();
    setPosition({
      left: Math.max(4, Math.min(x, bounds.right - width - 4) - bounds.left),
      top: Math.max(4, (y + height > bounds.bottom - 4 ? y - height : y) - bounds.top),
    });
    menu.querySelector<HTMLElement>('[role=menuitem]')?.focus();
  }, [x, y]);
  useEffect(() => {
    const outside = (event: Event) => { if (!element.current?.contains(event.target as Node)) close(); };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [close]);
  return <div ref={element} className="code-menu" role="menu" aria-label={label} style={position}
    onKeyDown={event => {
      const options = Array.from(element.current!.querySelectorAll<HTMLElement>('[role=menuitem]'));
      const at = options.indexOf(document.activeElement as HTMLElement);
      if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); close(); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        options[(at + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length]?.focus();
      }
    }}>
    {items.map(item => <button key={item.label} type="button" role="menuitem"
      className={[item.destructive && 'destructive', item.separator && 'separated'].filter(Boolean).join(' ')}
      onClick={() => { close(); item.action(); }}>{item.label}</button>)}
  </div>;
}
