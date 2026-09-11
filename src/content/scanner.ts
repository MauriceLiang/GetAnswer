import type { CodeFiller } from '../adapters/base';
import { findAdapter } from '../adapters';
import type { PageContext } from '../shared/types';

export function scanPage(
  document: Document,
  location: Location,
  fillCode?: CodeFiller
): PageContext {
  const adapter = findAdapter(document, location, fillCode);
  const video = document.querySelector<HTMLVideoElement>('.fragment-video video')
    ?? document.querySelector<HTMLVideoElement>('video');
  const videoSrc = video?.currentSrc
    || video?.getAttribute('src')
    || video?.querySelector('source')?.getAttribute('src')
    || undefined;
  const pageFlags = {
    hasVideo: video !== null,
    ...(videoSrc ? { videoSrc } : {}),
    hasEditor: document.querySelector('.CodeMirror') !== null
  };

  if (!adapter) {
    return {
      adapter: 'none',
      supported: false,
      ...pageFlags
    };
  }

  const question = adapter.extractQuestion() ?? undefined;
  const isInformationalPage = adapter.isInformationalPage?.() === true;
  const supportsVideo = pageFlags.hasVideo && adapter.completeVideo !== undefined;
  return {
    adapter: adapter.name,
    supported: question?.type === 'programming'
      || question?.type === 'project'
      || question?.type === 'choice'
      || question?.type === 'fill'
      || supportsVideo,
    ...(question ? { question } : {}),
    ...(isInformationalPage ? { isInformationalPage: true } : {}),
    ...pageFlags
  };
}

export function createDebouncedScanner<T>(
  scan: () => T | Promise<T>,
  emit: (value: T) => void,
  delayMs = 300
): () => void {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let previousSnapshot: string | undefined;

  const emitIfChanged = (value: T): void => {
    const snapshot = JSON.stringify(value);
    if (snapshot !== previousSnapshot) {
      previousSnapshot = snapshot;
      emit(value);
    }
  };

  return () => {
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = setTimeout(() => {
      const value = scan();
      if (value instanceof Promise) {
        void value.then(emitIfChanged);
      } else {
        emitIfChanged(value);
      }
    }, delayMs);
  };
}
