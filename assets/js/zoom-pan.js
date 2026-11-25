/**
 * Free Zoom & Pan Controller for Flipbook Stage
 * Supports focal-point mouse wheel zoom, two-finger touch pinch-to-zoom,
 * double-tap / double-click smart zoom, smooth drag panning, and boundary clamping.
 */
export class ZoomPanController {
  constructor(viewportEl, layerEl, options = {}) {
    this.viewport = viewportEl;
    this.layer = layerEl;
    this.minScale = options.minScale ?? 1.0;
    this.maxScale = options.maxScale ?? 4.0;
    this.doubleTapScale = options.doubleTapScale ?? 2.25;
    this.onChange = options.onChange || (() => {});
    this.onZoomSettled = options.onZoomSettled || (() => {});

    this.scale = 1.0;
    this.panX = 0;
    this.panY = 0;

    // Pointer tracking for pinch & pan
    this.pointers = new Map();
    this.isPanning = false;
    this.panStartX = 0;
    this.panStartY = 0;
    this.panOriginX = 0;
    this.panOriginY = 0;

    this.pinchStartDist = 0;
    this.pinchStartScale = 1;
    this.pinchLastMid = null;

    // Double-tap tracking for touch
    this.lastTapTime = 0;
    this.lastTapX = 0;
    this.lastTapY = 0;

    this.settleTimer = null;
    this.animating = false;

    this._bindEvents();
  }

  getScale() {
    return this.scale;
  }

  isZoomed() {
    return this.scale > 1.02;
  }

  _bindEvents() {
    this._onWheel = this._handleWheel.bind(this);
    this._onPointerDown = this._handlePointerDown.bind(this);
    this._onPointerMove = this._handlePointerMove.bind(this);
    this._onPointerUp = this._handlePointerUp.bind(this);
    this._onDblClick = this._handleDblClick.bind(this);

    this.viewport.addEventListener('wheel', this._onWheel, { passive: false });
    this.viewport.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointermove', this._onPointerMove, { passive: false });
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('pointercancel', this._onPointerUp);
    this.viewport.addEventListener('dblclick', this._onDblClick);
  }

  destroy() {
    this.viewport.removeEventListener('wheel', this._onWheel);
    this.viewport.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointercancel', this._onPointerUp);
    this.viewport.removeEventListener('dblclick', this._onDblClick);
    clearTimeout(this.settleTimer);
  }

  _getViewportCenter() {
    const rect = this.viewport.getBoundingClientRect();
    return {
      cx: rect.left + rect.width / 2,
      cy: rect.top + rect.height / 2,
      width: rect.width,
      height: rect.height
    };
  }

  _clampPan(panX, panY, scale) {
    if (scale <= 1.005) {
      return { x: 0, y: 0 };
    }
    const rect = this.viewport.getBoundingClientRect();
    const contentEl = this.layer.firstElementChild || this.layer;
    const baseW = contentEl.offsetWidth || rect.width * 0.8;
    const baseH = contentEl.offsetHeight || rect.height * 0.85;

    const scaledW = baseW * scale;
    const scaledH = baseH * scale;

    // Allow panning cleanly to all corners with a comfortable margin
    const maxPanX = Math.max(0, (scaledW - rect.width) / 2 + 48);
    const maxPanY = Math.max(0, (scaledH - rect.height) / 2 + 48);

    return {
      x: Math.max(-maxPanX, Math.min(maxPanX, panX)),
      y: Math.max(-maxPanY, Math.min(maxPanY, panY))
    };
  }

  _applyTransform(animate = false) {
    if (animate) {
      this.layer.classList.add('is-animating');
      this.animating = true;
      clearTimeout(this._animTimer);
      this._animTimer = setTimeout(() => {
        this.layer.classList.remove('is-animating');
        this.animating = false;
      }, 280);
    } else {
      this.layer.classList.remove('is-animating');
    }

    const clamped = this._clampPan(this.panX, this.panY, this.scale);
    this.panX = clamped.x;
    this.panY = clamped.y;

    this.layer.style.transform = `translate3d(${this.panX.toFixed(2)}px, ${this.panY.toFixed(2)}px, 0) scale(${this.scale.toFixed(4)})`;

    const zoomed = this.isZoomed();
    this.viewport.classList.toggle('is-zoomed', zoomed);

    this.onChange({
      scale: this.scale,
      panX: this.panX,
      panY: this.panY,
      isZoomed: zoomed
    });

    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.onZoomSettled({
        scale: this.scale,
        panX: this.panX,
        panY: this.panY,
        isZoomed: this.isZoomed()
      });
    }, animate ? 300 : 170);
  }

  setZoom(targetScale, focalPoint = null, animate = false) {
    const newScale = Math.max(this.minScale, Math.min(this.maxScale, targetScale));
    if (Math.abs(newScale - 1.0) < 0.025) {
      this.scale = 1.0;
      this.panX = 0;
      this.panY = 0;
      this._applyTransform(animate);
      return;
    }

    const { cx, cy } = this._getViewportCenter();
    const px = focalPoint ? focalPoint.x : cx;
    const py = focalPoint ? focalPoint.y : cy;

    const dx = px - cx;
    const dy = py - cy;

    const ratio = newScale / this.scale;
    this.panX = dx - (dx - this.panX) * ratio;
    this.panY = dy - (dy - this.panY) * ratio;
    this.scale = newScale;

    this._applyTransform(animate);
  }

  zoomIn(step = 0.35) {
    const next = Math.min(this.maxScale, Math.round((this.scale + step) * 100) / 100);
    this.setZoom(next, null, true);
  }

  zoomOut(step = 0.35) {
    const next = Math.max(this.minScale, Math.round((this.scale - step) * 100) / 100);
    this.setZoom(next, null, true);
  }

  reset(animate = true) {
    this.scale = 1.0;
    this.panX = 0;
    this.panY = 0;
    this._applyTransform(animate);
  }

  updateBounds() {
    this._applyTransform(false);
  }

  _handleWheel(e) {
    // Ignore wheel over interactive overlay buttons if any
    if (e.target.closest('button, input, .side-drawer')) return;
    e.preventDefault();

    // Smooth exponential zoom factor for both trackpad pinch (ctrlKey) and mouse wheel
    const sensitivity = e.ctrlKey ? 0.0085 : 0.0018;
    const delta = -e.deltaY;
    const factor = Math.exp(delta * sensitivity);
    const nextScale = this.scale * factor;

    this.setZoom(nextScale, { x: e.clientX, y: e.clientY }, false);
  }

  _handleDblClick(e) {
    if (e.target.closest('button, input, a, .nav-edge-btn')) return;
    if (this.isZoomed()) {
      this.reset(true);
    } else {
      this.setZoom(this.doubleTapScale, { x: e.clientX, y: e.clientY }, true);
    }
  }

  _handlePointerDown(e) {
    if (e.target.closest('button, input, a, .nav-edge-btn')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });

    // Touch double-tap detection
    if (e.pointerType === 'touch' && this.pointers.size === 1) {
      const now = Date.now();
      const dist = Math.hypot(e.clientX - this.lastTapX, e.clientY - this.lastTapY);
      if (now - this.lastTapTime < 310 && dist < 34) {
        this.lastTapTime = 0;
        if (this.isZoomed()) {
          this.reset(true);
        } else {
          this.setZoom(this.doubleTapScale, { x: e.clientX, y: e.clientY }, true);
        }
        return;
      }
      this.lastTapTime = now;
      this.lastTapX = e.clientX;
      this.lastTapY = e.clientY;
    }

    if (this.pointers.size === 2) {
      // Begin pinch-to-zoom
      this.isPanning = false;
      this.viewport.classList.add('is-pinching');
      const [p1, p2] = Array.from(this.pointers.values());
      this.pinchStartDist = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
      this.pinchStartScale = this.scale;
      this.pinchLastMid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      return;
    }

    if (this.pointers.size === 1 && this.isZoomed()) {
      this.isPanning = true;
      this.viewport.classList.add('is-panning');
      this.panStartX = e.clientX;
      this.panStartY = e.clientY;
      this.panOriginX = this.panX;
      this.panOriginY = this.panY;
    }
  }

  _handlePointerMove(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });

    if (this.pointers.size === 2) {
      e.preventDefault();
      const [p1, p2] = Array.from(this.pointers.values());
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };

      const targetScale = Math.max(
        this.minScale,
        Math.min(this.maxScale, this.pinchStartScale * (dist / this.pinchStartDist))
      );

      // Apply midpoint translation delta + focal zoom
      if (this.pinchLastMid) {
        this.panX += mid.x - this.pinchLastMid.x;
        this.panY += mid.y - this.pinchLastMid.y;
      }
      this.pinchLastMid = mid;

      const { cx, cy } = this._getViewportCenter();
      const dx = mid.x - cx;
      const dy = mid.y - cy;
      const ratio = targetScale / this.scale;
      this.panX = dx - (dx - this.panX) * ratio;
      this.panY = dy - (dy - this.panY) * ratio;
      this.scale = targetScale;

      this._applyTransform(false);
      return;
    }

    if (this.isPanning && this.pointers.size === 1) {
      e.preventDefault();
      this.panX = this.panOriginX + (e.clientX - this.panStartX);
      this.panY = this.panOriginY + (e.clientY - this.panStartY);
      this._applyTransform(false);
    }
  }

  _handlePointerUp(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);

    if (this.pointers.size < 2) {
      this.viewport.classList.remove('is-pinching');
      this.pinchLastMid = null;
      if (this.scale < 1.03) {
        this.reset(true);
      }
    }

    if (this.pointers.size === 1 && this.isZoomed()) {
      // Seamlessly transition remaining finger into pan
      const [remaining] = Array.from(this.pointers.values());
      this.isPanning = true;
      this.panStartX = remaining.x;
      this.panStartY = remaining.y;
      this.panOriginX = this.panX;
      this.panOriginY = this.panY;
    } else if (this.pointers.size === 0) {
      this.isPanning = false;
      this.viewport.classList.remove('is-panning');
    }
  }
}
