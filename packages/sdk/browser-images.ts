/** Browser implementations used when an app runs outside a WorkOS capability window. */
export function pickBrowserImage(): Promise<File> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.oncancel = () => reject(new DOMException('Photo selection cancelled.', 'AbortError'));
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) reject(new DOMException('Photo selection cancelled.', 'AbortError'));
      else if (!file.type.startsWith('image/')) reject(new DOMException('Select an image.', 'TypeMismatchError'));
      else resolve(file);
    };
    input.click();
  });
}

export function captureBrowserImage(facing: 'user' | 'environment'): Promise<File> {
  if (document.querySelector('dialog[data-workos-camera]')) {
    return Promise.reject(new DOMException('A camera preview is open.', 'InvalidStateError'));
  }
  const dialog = document.createElement('dialog');
  dialog.dataset.workosCamera = '';
  dialog.setAttribute('aria-label', 'Take a photo');
  const video = document.createElement('video');
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.style.cssText = 'display:block;max-width:80vw;max-height:65vh;margin-bottom:.75rem';
  const capture = document.createElement('button');
  capture.textContent = 'Take photo';
  capture.disabled = true;
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  dialog.append(video, capture, cancel);
  document.body.append(dialog);

  return new Promise<File>((resolve, reject) => {
    let finished = false;
    let stream: MediaStream | undefined;
    const abort = () => finish(undefined, new DOMException('Capture cancelled.', 'AbortError'));
    const onVisibility = () => { if (document.hidden) abort(); };
    function finish(file?: File, error?: unknown) {
      if (finished) return;
      finished = true;
      window.removeEventListener('pagehide', abort);
      document.removeEventListener('visibilitychange', onVisibility);
      stream?.getTracks().forEach(track => track.stop());
      video.srcObject = null;
      dialog.remove();
      if (file) resolve(file);
      else reject(error);
    }
    dialog.oncancel = event => { event.preventDefault(); abort(); };
    dialog.onclose = abort;
    cancel.onclick = abort;
    window.addEventListener('pagehide', abort);
    document.addEventListener('visibilitychange', onVisibility);
    video.onloadeddata = () => { capture.disabled = false; capture.focus(); };
    capture.onclick = () => {
      capture.disabled = true;
      try {
        const scale = Math.min(1, 2048 / Math.max(video.videoWidth, video.videoHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Camera image unavailable.');
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(blob => {
          if (blob) finish(new File([blob], 'camera.jpg', { type: blob.type }));
          else finish(undefined, new Error('Could not encode photo.'));
        }, 'image/jpeg', 0.85);
      } catch (error) { finish(undefined, error); }
    };
    try {
      dialog.showModal();
      navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing } }, audio: false }).then(async acquired => {
        if (finished) { acquired.getTracks().forEach(track => track.stop()); return; }
        stream = acquired;
        for (const track of stream.getVideoTracks()) track.addEventListener('ended', abort, { once: true });
        video.srcObject = stream;
        await video.play();
      }).catch(error => finish(undefined, error));
    } catch (error) { finish(undefined, error); }
  });
}
