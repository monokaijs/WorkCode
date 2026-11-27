import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { ChevronLeft, ChevronRight, Minus, Plus, LoaderCircle } from 'lucide-react';
import { store, errorMessage, type PDFData } from '../workspace';
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export default function PDFViewer({ data }: { data: PDFData }) {
  const [pdf, setPDF] = useState<pdfjs.PDFDocumentProxy | null>(null), [page, setPage] = useState(1), [zoom, setZoom] = useState(1);
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [width, setWidth] = useState(700);
  const [rotation, setRotation] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null), viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = viewport.current;
    if (!pdf || !element) return;
    const gesture = (event: Event) => {
      const { kind, value } = (event as CustomEvent<{ kind: string; value: number }>).detail ?? {};
      if (!Number.isFinite(value)) return;
      if (kind === 'zoom') setZoom(previous => Math.min(2, Math.max(0.5, previous * value)));
      if (kind === 'smart') setZoom(previous => previous > 1.05 ? 1 : 2);
      if (kind === 'rotate') setRotation(previous => (previous + (value > 0 ? 90 : 270)) % 360);
      if (kind === 'page') setPage(previous => Math.min(pdf.numPages, Math.max(1, previous + Math.sign(value))));
    };
    element.addEventListener('workos-pdf-gesture', gesture);
    return () => element.removeEventListener('workos-pdf-gesture', gesture);
  }, [pdf]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => setWidth(Math.max(240, entries[0].contentRect.width - 48)));
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let cancelled = false; let documentProxy: pdfjs.PDFDocumentProxy | null = null; let task: pdfjs.PDFDocumentLoadingTask | null = null;
    setLoading(true); setPDF(null); setError(''); setPage(1); setRotation(0); setZoom(1);
    void (async () => {
      const blob = await store.getAsset(data.assetId);
      if (blob.size > 20 * 1024 * 1024) throw new Error('This PDF exceeds the 20 MB viewer limit.');
      task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), useSystemFonts: true });
      documentProxy = await task.promise;
      if (cancelled) { await task.destroy(); return; }
      setPDF(documentProxy); setLoading(false);
    })().catch(cause => { if (!cancelled) { setError(errorMessage(cause)); setLoading(false); } });
    return () => { cancelled = true; if (task) void task.destroy(); };
  }, [data.assetId]);
  useEffect(() => {
    if (!pdf || !canvas.current) return;
    let cancelled = false; let renderTask: pdfjs.RenderTask | undefined;
    void (async () => {
      const selected = await pdf.getPage(page);
      if (cancelled || !canvas.current) return;
      const pageRotation = (selected.rotate + rotation) % 360;
      const natural = selected.getViewport({ scale: 1, rotation: pageRotation });
      const scale = Math.min(width, 1000) / natural.width * zoom;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const rendered = selected.getViewport({ scale: scale * ratio, rotation: pageRotation });
      canvas.current.width = rendered.width; canvas.current.height = rendered.height;
      canvas.current.style.width = `${rendered.width / ratio}px`; canvas.current.style.height = `${rendered.height / ratio}px`;
      renderTask = selected.render({ canvas: canvas.current, viewport: rendered });
      await renderTask.promise;
    })().catch(cause => { if (!cancelled && cause?.name !== 'RenderingCancelledException') setError(errorMessage(cause)); });
    return () => { cancelled = true; renderTask?.cancel(); };
  }, [pdf, page, zoom, width, rotation]);
  return <div className="pdf-viewer">
    <div className="pdf-toolbar"><div className="control-group"><button className="tool-button" aria-label="Previous page" disabled={!pdf || page <= 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={18} /></button><span>Page {page} <span className="muted">of {pdf?.numPages ?? '—'}</span></span><button className="tool-button" aria-label="Next page" disabled={!pdf || page >= pdf.numPages} onClick={() => setPage(value => value + 1)}><ChevronRight size={18} /></button></div><div className="control-group"><button className="tool-button" aria-label="Zoom out" disabled={zoom <= 0.5} onClick={() => setZoom(value => Math.max(0.5, value - 0.25))}><Minus size={17} /></button><span>{Math.round(zoom * 100)}%</span><button className="tool-button" aria-label="Zoom in" disabled={zoom >= 2} onClick={() => setZoom(value => Math.min(2, value + 0.25))}><Plus size={17} /></button></div></div>
    <div className="pdf-canvas-area" ref={viewport} data-workos-pdf={pdf && !loading && !error ? 'ready' : undefined}
      data-can-go-back={page > 1} data-can-go-forward={page < (pdf?.numPages ?? 0)}>{loading && <div className="editor-loading"><LoaderCircle className="spin" size={22} /> Opening PDF…</div>}{error ? <div className="inline-error" role="alert">{error} The original file is still available to export.</div> : <canvas ref={canvas} aria-label={`PDF page ${page}`} role="img" />}</div>
    <div className="editor-footer"><span>{data.fileName}</span><span>Read-only · Original preserved</span></div>
  </div>;
}
