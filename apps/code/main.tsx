import '../../web/src/main';

if (import.meta.env.PROD && ['https:', 'http:'].includes(location.protocol) && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').catch(console.error);
  });
}
