/**
 * Camera scanning: QR via jsQR (frame decoding in a worker-free loop) with a ZXing
 * attempt for 1D barcodes, a "pick a photo" fallback for desktops without a camera, and
 * always a manual entry field. Returns the raw scanned string.
 */
import { h, button, modal, notice } from './ui.js';

const HISTORY_KEY = 'sp.recentScans';

export function recentScans() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

export function rememberScan(code) {
  const value = String(code || '').trim();
  if (!value) return;
  const list = recentScans().filter((item) => item.code !== value);
  list.unshift({ code: value, at: Date.now() });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 25)));
}

const hasJsQR = () => typeof window.jsQR === 'function';
const hasZxing = () => Boolean(window.ZXing?.BrowserMultiFormatReader);

export function scannerSupport() {
  return {
    camera: Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext,
    insecure: !window.isSecureContext,
    jsQR: hasJsQR(),
    zxing: hasZxing(),
  };
}

/** Decode a still image file (used by the photo fallback and by paste). */
export async function decodeImageFile(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 900 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  if (hasJsQR()) {
    const result = window.jsQR(data.data, data.width, data.height, { invertedHints: 'attemptBoth' });
    if (result?.data) return result.data;
  }
  if (hasZxing()) {
    try {
      const reader = new window.ZXing.BrowserMultiFormatReader();
      const found = await decodeWithZxing(reader, canvas);
      if (found) return found;
    } catch {
      /* fall through */
    }
  }
  throw new Error('No code found in that photo. Try to fill the frame with the label, or type the code below.');
}

function decodeWithZxing(reader, canvas) {
  if (typeof reader.decodeFromCanvas === 'function') return reader.decodeFromCanvas(canvas).then((r) => r?.text).catch(() => null);
  if (typeof reader.decodeFromImageUrl === 'function') return reader.decodeFromImageUrl(canvas.toDataURL('image/png')).then((r) => r?.text).catch(() => null);
  return Promise.resolve(null);
}

/**
 * Open the scanner overlay.
 * @returns {Promise<{code:string, method:string}|null>} null when cancelled
 */
export function openScanner({ title = 'scan a QR or barcode', allowManual = true } = {}) {
  const support = scannerSupport();
  let resolveRef = null;
  const promise = new Promise((resolve) => (resolveRef = resolve));

  const video = h('video', { class: 'scan-video', playsinline: true, muted: true, autoplay: true });
  const overlay = h('div', { class: 'scan-overlay' }, h('span', { class: 'scan-frame' }), h('span', { class: 'scan-line' }));
  const status = h('p', { class: 'scan-status muted' }, 'point the camera at the label…');
  const canvas = document.createElement('canvas');
  const fileInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'file', onchange: () => fromFile(fileInput.files?.[0]) });
  const manual = h('input', { class: 'scan-manual', type: 'text', inputmode: 'text', placeholder: 'or type a tooling id / location code', autocapitalize: 'characters' });
  const torchButton = h('button', { class: 'btn ghost scan-torch', type: 'button', hidden: true, onclick: () => toggleTorch() }, '🔦 light');

  const body = h(
    'div',
    { class: 'scan-body' },
    h('div', { class: 'scan-stage' }, video, overlay, status),
    h('div', { class: 'scan-controls' }, h('label', { class: 'btn ghost' }, '🖼 use a photo', fileInput), torchButton),
    allowManual
      ? h('div', { class: 'scan-manual-row' }, manual, button('go', { kind: 'primary', onClick: () => finish(manual.value.trim(), 'typed') }))
      : null,
    support.camera ? null : notice('warn', 'No camera access here. Use a photo of the label or type the code.'),
    support.insecure ? notice('warn', 'The browser only opens the camera on https or localhost. Scanning still works from a photo.') : null,
    !support.jsQR && !support.zxing ? notice('error', 'Decoder scripts did not load (offline first run?). Reload once, or type the code.') : null,
    recentScans().length
      ? h(
          'details',
          { class: 'scan-recent' },
          h('summary', null, `recent scans (${recentScans().length})`),
          h(
            'div',
            { class: 'chips' },
            recentScans()
              .slice(0, 8)
              .map((item) => h('button', { class: 'chip', type: 'button', onclick: () => finish(item.code, 'recent') }, item.code)),
          ),
        )
      : null,
  );

  const dialog = modal({
    title,
    body,
    wide: true,
    actions: h('div', { class: 'btn-row end' }, button('cancel', { kind: 'ghost', onClick: () => stop() })),
    onClose: () => stop(true),
  });

  let stream = null;
  let raf = 0;
  let frames = 0;
  let done = false;
  let zxingReader = null;
  let zxingBusy = false;

  async function start() {
    if (!support.camera) return;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      video.srcObject = stream;
      await video.play();
      status.textContent = `reading ${support.jsQR ? 'QR' : ''}${support.jsQR && support.zxing ? ' + barcode' : ''}${support.zxing && !support.jsQR ? 'barcode' : ''} — hold steady`;
      try {
        const track = stream.getVideoTracks()[0];
        const caps = track.getCapabilities?.();
        if (caps?.torch) {
          torchButton.hidden = false;
          torchButton.dataset.on = '0';
        }
      } catch {
        /* torch not supported */
      }
      if (hasZxing()) {
        try {
          zxingReader = new window.ZXing.BrowserMultiFormatReader(undefined, { delayBetweenScanAttempts: 220 });
        } catch {
          zxingReader = null;
        }
      }
      loop();
    } catch (err) {
      status.textContent = `camera refused (${err.name}: ${err.message}) - use a photo or type the code`;
    }
  }

  async function toggleTorch() {
    const track = stream?.getVideoTracks?.()[0];
    if (!track) return;
    const on = torchButton.dataset.on !== '1';
    try {
      await track.applyConstraints({ advanced: [{ torch: on }] });
      torchButton.dataset.on = on ? '1' : '0';
    } catch {
      notice('warn', 'this camera has no controllable flashlight');
    }
  }

  function loop() {
    if (done) return;
    frames += 1;
    const w = video.videoWidth;
    const h2 = video.videoHeight;
    if (w && h2) {
      const scale = Math.min(1, 520 / Math.max(w, h2));
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h2 * scale);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      if (hasJsQR()) {
        const found = window.jsQR(image.data, image.width, image.height, frames % 12 === 0 ? { invertedHints: 'attemptBoth' } : {});
        if (found?.data) return finish(found.data, 'qr');
      }
      if (zxingReader && !zxingBusy && frames % 6 === 0) {
        zxingBusy = true;
        decodeWithZxing(zxingReader, canvas)
          .then((text) => text && finish(text, 'barcode'))
          .catch(() => {})
          .finally(() => (zxingBusy = false));
      }
      status.textContent = `reading… (${Math.round((w * h2) / 1000)}k px, ${frames} frames)`;
    }
    raf = requestAnimationFrame(loop);
  }

  async function fromFile(file) {
    if (!file) return;
    status.textContent = 'decoding the photo…';
    try {
      const code = await decodeImageFile(file);
      finish(code, 'photo');
    } catch (err) {
      status.textContent = err.message;
    }
  }

  function finish(code, method) {
    if (done) return;
    if (!code) {
      status.textContent = 'nothing readable yet - move closer and keep the whole code inside the frame';
      return;
    }
    done = true;
    cancelAnimationFrame(raf);
    stopCamera();
    try {
      navigator.vibrate?.(90);
    } catch {
      /* ignore */
    }
    rememberScan(code);
    dialog.close();
    resolveRef({ code, method });
  }

  function stopCamera() {
    if (zxingReader?.reset) {
      try {
        zxingReader.reset();
      } catch {
        /* ignore */
      }
    }
    stream?.getTracks?.().forEach((track) => track.stop());
    stream = null;
  }

  function stop(fromClose) {
    done = true;
    cancelAnimationFrame(raf);
    stopCamera();
    if (!fromClose) dialog.close();
    resolveRef(null);
  }

  start();
  return promise;
}

/** POST the scanned text to the resolver and hand back the entity it points at. */
export async function resolveScan(api, code) {
  return api.post('/api/labels/scan', { code });
}
