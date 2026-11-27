import { useEffect, useRef } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { openProjectShell } from '../../../packages/sdk/code-projects';
import '@xterm/xterm/css/xterm.css';

/** Reads a CSS color as #rrggbb, which xterm needs, by painting it. */
function solid(color: string) {
  const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!context) return undefined;
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
  return '#' + [red, green, blue].map(value => value.toString(16).padStart(2, '0')).join('');
}
/** The terminal takes the panel's colors, as VS Code's integrated terminal does. */
function themeOf(element: HTMLElement) {
  const style = getComputedStyle(element);
  const background = solid(style.backgroundColor) ?? '#000000';
  const foreground = solid(style.color) ?? '#ffffff';
  return { background, foreground, cursor: foreground, cursorAccent: background,
    selectionBackground: solid(style.getPropertyValue('--code-active-bg').trim() || 'rgba(128,128,128,.3)') };
}

export default function ProjectTerminal({ shell, visible, report }: {
  shell: ReturnType<typeof openProjectShell>; visible: boolean; report(error: unknown): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  useEffect(() => {
    let disposed = false;
    let disposeView: (() => void) | undefined;
    let timer: number;
    async function start() {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
      if (disposed) return;
      const view = new Terminal({ fontSize: 12.5, lineHeight: 1.2, cursorBlink: true, allowProposedApi: false,
        fontFamily: getComputedStyle(host.current!).getPropertyValue('--code-mono') || undefined, theme: themeOf(host.current!) });
      // Follow the WorkOS appearance when it changes.
      const appearance = new MutationObserver(() => { if (host.current) view.options.theme = themeOf(host.current); });
      appearance.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-workspace-appearance'] });
      const fit = new FitAddon();
      terminal.current = view;
      view.loadAddon(fit);
      view.open(host.current!);
      view.onData(text => { void shell.input(text).catch(report); });
      view.onResize(({ cols, rows }) => { void shell.resize(cols, rows).catch(report); });
      const resize = () => { if (host.current?.clientWidth && host.current.clientHeight) fit.fit(); };
      const observer = new ResizeObserver(resize);
      observer.observe(host.current!);
      resize();
      if (host.current!.clientHeight) view.focus();
      disposeView = () => { observer.disconnect(); appearance.disconnect(); view.dispose(); terminal.current = null; };
      async function read() {
        const encoded = await shell.read();
        if (disposed) return;
        const next = () => { if (!disposed) timer = window.setTimeout(poll, encoded ? 0 : 100); };
        if (encoded) view.write(Uint8Array.from(atob(encoded), char => char.charCodeAt(0)), next);
        else next();
      }
      function poll() { void read().catch(error => { if (!disposed) report(error); }); }
      poll();
    }
    void start().catch(error => { if (!disposed) report(error); });
    return () => { disposed = true; window.clearTimeout(timer); disposeView?.(); };
  }, [shell, report]);
  useEffect(() => { if (visible) terminal.current?.focus(); }, [visible]);
  return <div ref={host} className="code-terminal" hidden={!visible} aria-label="Project terminal" />;
}
