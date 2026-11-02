import { renderPage } from './pdf-read.js';

// Opens a modal showing the full page; the user drags a rectangle around the label.
// Resolves to { crop, applyToPlatform } (crop in view-space points) or null on cancel.
export async function editCrop(page, crop, platform) {
  const viewport = page.getViewport({ scale: 1 });
  // Leave room for the hint and buttons; use nearly the full width on phones.
  const scale = Math.min((window.innerHeight - 190) / viewport.height, (window.innerWidth - 40) / viewport.width);
  // Render at device resolution so text stays sharp on phones; display at CSS size.
  const canvas = await renderPage(page, scale * (window.devicePixelRatio || 1));
  canvas.style.width = `${viewport.width * scale}px`;
  canvas.style.height = `${viewport.height * scale}px`;

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-box">
      <p class="hint">Label ni aaspaas aangli/mouse thi drag kari ne box doro.</p>
      <div class="editor"></div>
      <div class="modal-actions">
        <label><input type="checkbox" class="apply-all"> <span>Badha <b>${platform}</b> labels (page par aa j jagya) par lagavo</span></label>
        <span class="spacer"></span>
        <button class="cancel">Cancel</button>
        <button class="save primary">Save</button>
      </div>
    </div>`;
  const editor = modal.querySelector('.editor');
  const rectEl = document.createElement('div');
  rectEl.className = 'crop-rect';
  editor.append(canvas, rectEl);
  document.body.append(modal);

  let current = { ...crop };
  const show = (c) => {
    Object.assign(rectEl.style, {
      left: `${c.x * scale}px`,
      top: `${c.y * scale}px`,
      width: `${c.w * scale}px`,
      height: `${c.h * scale}px`,
    });
  };
  show(current);

  const toPoint = (e) => {
    const r = canvas.getBoundingClientRect();
    const clamp = (v, max) => Math.min(Math.max(v, 0), max);
    return {
      x: clamp((e.clientX - r.left) / scale, viewport.width),
      y: clamp((e.clientY - r.top) / scale, viewport.height),
    };
  };
  let start = null;
  editor.addEventListener('pointerdown', (e) => {
    start = toPoint(e);
    editor.setPointerCapture(e.pointerId);
  });
  editor.addEventListener('pointermove', (e) => {
    if (!start) return;
    const p = toPoint(e);
    current = {
      x: Math.min(start.x, p.x),
      y: Math.min(start.y, p.y),
      w: Math.abs(p.x - start.x),
      h: Math.abs(p.y - start.y),
    };
    show(current);
  });
  editor.addEventListener('pointerup', () => {
    start = null;
  });

  return new Promise((resolve) => {
    const close = (result) => {
      modal.remove();
      resolve(result);
    };
    modal.querySelector('.cancel').onclick = () => close(null);
    modal.querySelector('.save').onclick = () => {
      if (current.w < 10 || current.h < 10) return;
      close({ crop: current, applyToPlatform: modal.querySelector('.apply-all').checked });
    };
  });
}
