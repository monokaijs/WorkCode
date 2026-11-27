import LanguageWorker from './language.worker?worker&inline';
import type { LanguageAction, LanguageActions } from './languageTypes';

export class LanguageService {
  private worker = new LanguageWorker();
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private sequence = 0;
  private failure?: Error;

  constructor() {
    this.worker.onmessage = ({ data }) => {
      const request = this.pending.get(data.id);
      if (!request) return;
      this.pending.delete(data.id);
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(data.result);
    };
    this.worker.onerror = event => this.dispose(new Error(event.message || 'Code intelligence could not start.'));
  }

  request<K extends LanguageAction>(action: K, payload: LanguageActions[K][0]): Promise<LanguageActions[K][1]> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as LanguageActions[K][1]), reject });
      this.worker.postMessage({ id, action, payload });
    });
  }

  dispose(error = new Error('The project was closed.')) {
    this.failure = error;
    this.worker.terminate();
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}
