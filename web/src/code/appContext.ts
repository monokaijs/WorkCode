import { useEffect } from 'react';
import { createAppContext } from '../../../packages/sdk/app-context';

export const codeApp = createAppContext('code');

export function useDirtyState(dirty: boolean) {
  useEffect(() => {
    void codeApp.setDirty(dirty).catch(console.error);
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      void codeApp.setDirty(false).catch(console.error);
    };
  }, [dirty]);
}
