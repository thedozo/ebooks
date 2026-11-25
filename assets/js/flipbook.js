/**
 * Heyzine-Grade Flipbook Engine
 * Integrates PDF.js v4 + StPageFlip v2 with:
 * - Responsive single/double spread auto-adaptation + manual toggle
 * - Smooth centered front/back cover animation
 * - Priority lazy canvas rendering & memory eviction for large PDFs
 * - Razor-sharp Hi-DPI re-rendering overlay when zoomed in
 * - PDF Outline (TOC), lazy Thumbnails, and accent-insensitive Full-Text Search
 */
import * as pdfjsLib from '../../vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  '../../vendor/pdfjs/pdf.worker.min.mjs',
  import.meta.url
).href;

export function normalizeSpanish(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export class FlipbookEngine {
  constructor(elements, options = {}) {
    this.stageEl = elements.stageEl;
    this.bookShiftEl = elements.bookShiftEl;
    this.bookShellEl = elements.bookShellEl;
    this.hiresOverlayEl = elements.hiresOverlayEl;

    this.sound = options.sound || null;
    this.onLoadProgress = options.onLoadProgress || (() => {});
    this.onReady = options.onReady || (() => {});
    this.onPageChange = options.onPageChange || (() => {});
    this.onModeChange = options.onModeChange || (() => {});
    this.onError = options.onError || (() => {});

    this.pdfDoc = null;
    this.pdfLoadingTask = null;
    this.totalPages = 0;
    this.pageAspect = 0.707; // default A4 portrait until PDF page 1 measured
    this.pageFlip = null;
    this.currentPageIndex = 0; // 0-based

    this.preferredSpreadMode = 'auto'; // 'auto' | 'double' | 'single'
    this.effectiveMode = 'double'; // 'double' | 'single'
    this.showCover = true;
    this.pageWidth = 420;
    this.pageHeight = 594;

    // Rendering management
    this.pageNodes = []; // [{ el, canvas, loader, rendered, renderScale, renderTask }]
    this.renderQueue = [];
    this.isRenderingQueue = false;
    this.loadSessionId = 0;
    this.renderSessionId = 0;
    this.isLoaded = false;

    // Hi-DPI Zoom Overlay
    this.hiresRenderToken = 0;
    this.hiresRenderTasks = [];
    this.currentZoomScale = 1.0;

    // Cached text for full-text search
    this.textCache = new Map();
    this.outlineItems = [];

    // Resize observer
    this._resizeTimer = null;
    this._boundResize = () => {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => this.relayout(), 160);
    };
    window.addEventListener('resize', this._boundResize);
  }

  destroy() {
    window.removeEventListener('resize', this._boundResize);
    clearTimeout(this._resizeTimer);
    this._teardownBook();
  }

  _teardownBook() {
    this.loadSessionId++;
    this.renderSessionId++;
    this.hiresRenderToken++;
    this.isLoaded = false;
    this.clearHiResOverlay();

    for (const node of this.pageNodes) {
      if (node.renderTask) {
        try { node.renderTask.cancel(); } catch {}
      }
    }
    this.pageNodes = [];
    this.renderQueue = [];
    this.isRenderingQueue = false;
    this.textCache.clear();
    this.outlineItems = [];

    if (this.pageFlip) {
      try { this.pageFlip.destroy(); } catch {}
      this.pageFlip = null;
    }
    this.bookShellEl.innerHTML = '';

    if (this.pdfLoadingTask) {
      try { this.pdfLoadingTask.destroy(); } catch {}
      this.pdfLoadingTask = null;
    }
    if (this.pdfDoc) {
      try { this.pdfDoc.destroy(); } catch {}
      this.pdfDoc = null;
    }
  }

  async load(pdfInit, config = {}) {
    this._teardownBook();
    const loadSession = this.loadSessionId;

    this.preferredSpreadMode = config.spreadMode || 'auto';
    this.showCover = config.showCover !== false;
    this.currentPageIndex = Math.max(0, (config.startPage || 1) - 1);

    try {
      this.onLoadProgress({ percent: 4, stage: 'Conectando con el documento PDF…' });

      const loadingTask = pdfjsLib.getDocument({
        ...pdfInit,
        isEvalSupported: false,
        useSystemFonts: true
      });
      this.pdfLoadingTask = loadingTask;

      loadingTask.onProgress = (progress) => {
        if (loadSession !== this.loadSessionId || this.isLoaded) return;
        if (progress.total > 0) {
          const pct = Math.min(86, Math.max(6, Math.round((progress.loaded / progress.total) * 84)));
          this.onLoadProgress({
            percent: pct,
            loaded: progress.loaded,
            total: progress.total,
            stage: 'Descargando páginas en alta definición…'
          });
        } else {
          this.onLoadProgress({ percent: 35, stage: 'Cargando documento PDF…' });
        }
      };

      const pdfDoc = await loadingTask.promise;
      if (loadSession !== this.loadSessionId) {
        pdfDoc.destroy();
        return;
      }

      this.pdfDoc = pdfDoc;
      this.totalPages = pdfDoc.numPages;
      if (this.currentPageIndex >= this.totalPages) {
        this.currentPageIndex = 0;
      }

      this.onLoadProgress({ percent: 90, stage: 'Preparando encuadernación interactiva…' });

      // Measure page 1 aspect ratio
      const firstPage = await pdfDoc.getPage(1);
      if (loadSession !== this.loadSessionId) return;
      const vp = firstPage.getViewport({ scale: 1 });
      this.pageAspect = vp.width / vp.height;

      // Read metadata & outline
      let metadata = {};
      try {
        const metaObj = await pdfDoc.getMetadata();
        metadata = metaObj?.info || {};
      } catch {
        metadata = {};
      }

      this.outlineItems = await this._extractOutline(pdfDoc);
      if (loadSession !== this.loadSessionId) return;

      // Mount PageFlip (increments renderSessionId, NOT loadSessionId)
      this._buildFlipbook(this.currentPageIndex);

      // Render initial visible page(s) before dismissing loader
      await this._renderVisiblePriority(this.currentPageIndex);
      if (loadSession !== this.loadSessionId) return;

      this.isLoaded = true;
      this.onLoadProgress({ percent: 100, stage: '¡Listo!' });

      // Snapshot page 1 cover if already rendered so Library displays real cover immediately
      let coverDataUrl = '';
      if (this.pageNodes[0]?.rendered && this.pageNodes[0].canvas.width > 0) {
        try {
          coverDataUrl = this.pageNodes[0].canvas.toDataURL('image/jpeg', 0.8);
        } catch {}
      }

      this.onReady({
        totalPages: this.totalPages,
        aspect: this.pageAspect,
        metadata,
        outline: this.outlineItems,
        mode: this.effectiveMode,
        currentPageIndex: this.currentPageIndex,
        coverDataUrl
      });

      // Kick off background pre-render of nearby pages
      this._scheduleNearbyPages(this.currentPageIndex);
    } catch (err) {
      if (loadSession !== this.loadSessionId) return;
      console.error('Flipbook load error:', err);
      this.onError(err);
    }
  }

  async _extractOutline(pdfDoc) {
    try {
      const raw = await pdfDoc.getOutline();
      if (!raw || !raw.length) return [];

      const flatten = async (items, level = 0) => {
        const out = [];
        for (const item of items) {
          let pageNum = null;
          try {
            let dest = item.dest;
            if (typeof dest === 'string') {
              dest = await pdfDoc.getDestination(dest);
            }
            if (Array.isArray(dest) && dest[0]) {
              const pageIdx = await pdfDoc.getPageIndex(dest[0]);
              pageNum = pageIdx + 1;
            }
          } catch {
            pageNum = null;
          }
          if (pageNum !== null) {
            out.push({ title: item.title || `Página ${pageNum}`, page: pageNum, level });
          }
          if (item.items && item.items.length) {
            const children = await flatten(item.items, level + 1);
            out.push(...children);
          }
        }
        return out;
      };

      return await flatten(raw, 0);
    } catch {
      return [];
    }
  }

  _computeLayout() {
    const rect = this.stageEl.getBoundingClientRect();
    const isSmallScreen = window.innerWidth < 768;
    const padX = isSmallScreen ? 20 : 96;
    const padY = isSmallScreen ? 22 : 34;

    const availW = Math.max(220, rect.width - padX);
    const availH = Math.max(260, rect.height - padY);

    let mode = this.preferredSpreadMode;
    if (mode === 'auto') {
      mode = (rect.width < 760 || rect.width < rect.height * 0.96) ? 'single' : 'double';
    }
    if (this.totalPages <= 1) {
      mode = 'single';
    }

    let pageW, pageH;
    if (mode === 'double') {
      const maxSingleW = availW / 2;
      pageW = Math.min(maxSingleW, availH * this.pageAspect);
      pageH = pageW / this.pageAspect;
    } else {
      pageW = Math.min(availW, availH * this.pageAspect);
      pageH = pageW / this.pageAspect;
    }

    return {
      mode,
      pageW: Math.max(160, Math.floor(pageW)),
      pageH: Math.max(200, Math.floor(pageH))
    };
  }

  _buildFlipbook(startPageIndex = 0) {
    if (!this.pdfDoc) return;

    // Cancel any running page renders
    this.renderSessionId++;
    const session = this.renderSessionId;
    for (const node of this.pageNodes) {
      if (node.renderTask) {
        try { node.renderTask.cancel(); } catch {}
      }
    }
    this.pageNodes = [];
    this.renderQueue = [];
    this.clearHiResOverlay();

    if (this.pageFlip) {
      try { this.pageFlip.destroy(); } catch {}
      this.pageFlip = null;
    }

    const { mode, pageW, pageH } = this._computeLayout();
    this.effectiveMode = mode;
    this.pageWidth = pageW;
    this.pageHeight = pageH;

    const shellW = mode === 'double' ? pageW * 2 : pageW;
    this.bookShellEl.innerHTML = '';
    this.bookShellEl.style.width = `${shellW}px`;
    this.bookShellEl.style.height = `${pageH}px`;
    this.bookShellEl.dataset.mode = mode;

    this.hiresOverlayEl.style.width = `${shellW}px`;
    this.hiresOverlayEl.style.height = `${pageH}px`;

    const mountEl = document.createElement('div');
    mountEl.className = 'flipbook-mount';
    this.bookShellEl.appendChild(mountEl);

    const isCoverActive = mode === 'double' && this.showCover;

    // Create page DOM nodes
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < this.totalPages; i++) {
      const pageDiv = document.createElement('div');
      pageDiv.className = 'flip-page';
      pageDiv.dataset.pageNumber = String(i + 1);

      const isFrontCover = isCoverActive && i === 0;
      const isBackCover = isCoverActive && i === this.totalPages - 1 && this.totalPages % 2 === 0;
      if (isFrontCover || isBackCover) {
        pageDiv.dataset.density = 'hard';
        pageDiv.classList.add('is-hard-cover');
      } else {
        pageDiv.dataset.density = 'soft';
      }

      // Determine left/right side styling for spine shadow
      if (mode === 'double') {
        const isRight = isCoverActive ? (i % 2 === 0) : (i % 2 === 1);
        pageDiv.classList.add(isRight ? 'page-right' : 'page-left');
      } else {
        pageDiv.classList.add('page-single');
      }

      const canvas = document.createElement('canvas');
      canvas.className = 'page-canvas';

      const loader = document.createElement('div');
      loader.className = 'page-skeleton';
      loader.innerHTML = `<span class="page-skeleton-num">${i + 1}</span>`;

      const spine = document.createElement('div');
      spine.className = 'page-spine-shadow';

      pageDiv.appendChild(canvas);
      pageDiv.appendChild(loader);
      pageDiv.appendChild(spine);
      fragment.appendChild(pageDiv);

      this.pageNodes.push({
        index: i,
        el: pageDiv,
        canvas,
        loader,
        rendered: false,
        renderTask: null
      });
    }
    mountEl.appendChild(fragment);

    // Initialize St.PageFlip
    const PageFlipCtor = window.St?.PageFlip;
    if (!PageFlipCtor) {
      throw new Error('No se pudo cargar la librería StPageFlip.');
    }

    const clampedStart = Math.max(0, Math.min(this.totalPages - 1, startPageIndex));

    const pf = new PageFlipCtor(mountEl, {
      width: pageW,
      height: pageH,
      size: 'fixed',
      minWidth: pageW,
      maxWidth: pageW,
      minHeight: pageH,
      maxHeight: pageH,
      drawShadow: true,
      maxShadowOpacity: 0.52,
      showCover: isCoverActive,
      usePortrait: mode === 'single',
      startPage: clampedStart,
      flippingTime: 660,
      useMouseEvents: true,
      swipeDistance: 28,
      showPageCorners: true,
      clickEventForward: false,
      mobileScrollSupport: false,
      autoSize: false
    });

    pf.loadFromHTML(mountEl.querySelectorAll('.flip-page'));
    this.pageFlip = pf;
    this.currentPageIndex = clampedStart;

    // Sync cover centering & visual book edges
    this._updateCoverShift(clampedStart, false);

    let lastPageBeforeFlip = clampedStart;

    pf.on('changeState', (e) => {
      if (session !== this.renderSessionId) return;
      const state = e.data; // 'read' | 'flipping' | 'user_fold' | 'fold_corner'
      if (state === 'flipping' || state === 'user_fold') {
        this.clearHiResOverlay();
      }
      if (state === 'flipping') {
        this.bookShellEl.classList.add('is-flipping');
      } else if (state === 'read') {
        this.bookShellEl.classList.remove('is-flipping');
        if (this.currentZoomScale > 1.28) {
          this.renderHiResOverlay(this.currentZoomScale);
        }
      }
    });

    pf.on('flip', (e) => {
      if (session !== this.renderSessionId) return;
      const newIdx = Number(e.data);
      const direction = newIdx >= lastPageBeforeFlip ? 'next' : 'prev';
      lastPageBeforeFlip = newIdx;
      this.currentPageIndex = newIdx;

      if (this.sound) {
        this.sound.playFlip(direction);
      }

      this._updateCoverShift(newIdx, true);
      this._scheduleNearbyPages(newIdx);
      this.onPageChange(this.getPageInfo());
    });

    this.onModeChange(mode);
    this.onPageChange(this.getPageInfo());
  }

  _updateCoverShift(pageIndex, animate = true) {
    if (!animate) {
      this.bookShiftEl.classList.add('no-transition');
    } else {
      this.bookShiftEl.classList.remove('no-transition');
    }

    const isCoverActive = this.effectiveMode === 'double' && this.showCover;
    let shiftX = '0%';
    let stackState = 'open';

    if (isCoverActive) {
      if (pageIndex === 0) {
        shiftX = '-25%';
        stackState = 'front-cover';
      } else if (this.totalPages % 2 === 0 && pageIndex === this.totalPages - 1) {
        shiftX = '25%';
        stackState = 'back-cover';
      }
    } else if (this.effectiveMode === 'single') {
      stackState = 'single';
    }

    this.bookShiftEl.style.transform = `translate3d(${shiftX}, 0, 0)`;
    this.bookShellEl.dataset.spreadState = stackState;

    if (!animate) {
      // Force reflow so future transitions animate smoothly
      void this.bookShiftEl.offsetWidth;
      this.bookShiftEl.classList.remove('no-transition');
    }
  }

  relayout() {
    if (!this.pdfDoc) return;
    const { mode, pageW, pageH } = this._computeLayout();
    const changed =
      mode !== this.effectiveMode ||
      Math.abs(pageW - this.pageWidth) > 10 ||
      Math.abs(pageH - this.pageHeight) > 10;

    if (!changed) return;

    const currentIdx = this.currentPageIndex;
    this._buildFlipbook(currentIdx);
    this._scheduleNearbyPages(currentIdx);
  }

  setSpreadMode(mode) {
    if (!['auto', 'double', 'single'].includes(mode)) return;
    this.preferredSpreadMode = mode;
    if (this.pdfDoc) {
      const currentIdx = this.currentPageIndex;
      this._buildFlipbook(currentIdx);
      this._scheduleNearbyPages(currentIdx);
    }
  }

  getSpreadIndices(pageIndex = this.currentPageIndex) {
    if (this.effectiveMode === 'single') {
      return [pageIndex];
    }
    if (!this.showCover) {
      const left = pageIndex % 2 === 0 ? pageIndex : pageIndex - 1;
      const indices = [left];
      if (left + 1 < this.totalPages) indices.push(left + 1);
      return indices;
    }
    // showCover = true
    if (pageIndex === 0) return [0];
    if (this.totalPages % 2 === 0 && pageIndex === this.totalPages - 1) {
      return [this.totalPages - 1];
    }
    const left = pageIndex % 2 === 1 ? pageIndex : pageIndex - 1;
    const indices = [left];
    if (left + 1 < this.totalPages) indices.push(left + 1);
    return indices;
  }

  getPageInfo() {
    const visible = this.getSpreadIndices(this.currentPageIndex);
    const first = (visible[0] ?? 0) + 1;
    const last = (visible[visible.length - 1] ?? 0) + 1;
    const label = first === last ? `${first}` : `${first}–${last}`;
    const progress = this.totalPages > 1 ? this.currentPageIndex / (this.totalPages - 1) : 1;

    return {
      currentPageIndex: this.currentPageIndex,
      pageNumber: this.currentPageIndex + 1,
      visiblePages: visible.map((i) => i + 1),
      label,
      totalPages: this.totalPages,
      progress,
      isFirst: this.currentPageIndex <= 0,
      isLast: last >= this.totalPages,
      mode: this.effectiveMode
    };
  }

  // Navigation methods
  flipNext() {
    if (!this.pageFlip) return;
    const info = this.getPageInfo();
    if (info.isLast) return;
    this.clearHiResOverlay();
    this.pageFlip.flipNext('top');
  }

  flipPrev() {
    if (!this.pageFlip) return;
    const info = this.getPageInfo();
    if (info.isFirst) return;
    this.clearHiResOverlay();
    this.pageFlip.flipPrev('top');
  }

  goToPage(pageNumber, animate = true) {
    if (!this.pageFlip || !this.totalPages) return;
    const targetIdx = Math.max(0, Math.min(this.totalPages - 1, Math.round(pageNumber) - 1));
    if (targetIdx === this.currentPageIndex) return;

    this.clearHiResOverlay();
    this._scheduleNearbyPages(targetIdx);

    const distance = Math.abs(targetIdx - this.currentPageIndex);
    if (animate && distance <= 4) {
      this.pageFlip.flip(targetIdx, 'top');
    } else {
      this.pageFlip.turnToPage(targetIdx);
      this.currentPageIndex = targetIdx;
      this._updateCoverShift(targetIdx, true);
      this.onPageChange(this.getPageInfo());
    }
  }

  goFirst() {
    this.goToPage(1, false);
  }

  goLast() {
    this.goToPage(this.totalPages, false);
  }

  // Priority PDF page rendering
  async _renderVisiblePriority(centerIdx) {
    const visible = this.getSpreadIndices(centerIdx);
    const session = this.renderSessionId;
    await Promise.all(visible.map((idx) => this._renderPageToNode(idx, session)));
  }

  _scheduleNearbyPages(centerIdx) {
    if (!this.pdfDoc || !this.pageNodes.length) return;

    const visible = this.getSpreadIndices(centerIdx);
    const prioritySet = new Set(visible);
    const ordered = [...visible];

    // Add neighbors outward up to ±6 pages
    for (let d = 1; d <= 6; d++) {
      if (centerIdx + d < this.totalPages && !prioritySet.has(centerIdx + d)) {
        ordered.push(centerIdx + d);
        prioritySet.add(centerIdx + d);
      }
      if (centerIdx - d >= 0 && !prioritySet.has(centerIdx - d)) {
        ordered.push(centerIdx - d);
        prioritySet.add(centerIdx - d);
      }
    }

    // Evict far-away pages if book is large (> 36 pages) to protect mobile memory
    if (this.totalPages > 36) {
      for (const node of this.pageNodes) {
        if (node.rendered && Math.abs(node.index - centerIdx) > 16) {
          node.rendered = false;
          node.canvas.width = 0;
          node.canvas.height = 0;
          node.loader.classList.remove('is-hidden');
        }
      }
    }

    this.renderQueue = ordered.filter((idx) => {
      const n = this.pageNodes[idx];
      return n && !n.rendered;
    });

    if (!this.isRenderingQueue) {
      this._drainRenderQueue(this.renderSessionId);
    }
  }

  async _drainRenderQueue(session) {
    this.isRenderingQueue = true;
    while (this.renderQueue.length > 0 && session === this.renderSessionId) {
      const idx = this.renderQueue.shift();
      const node = this.pageNodes[idx];
      if (!node || node.rendered) continue;
      await this._renderPageToNode(idx, session);
    }
    this.isRenderingQueue = false;
  }

  async _renderPageToNode(index, session) {
    const node = this.pageNodes[index];
    if (!node || node.rendered || !this.pdfDoc || session !== this.renderSessionId) return;

    try {
      const page = await this.pdfDoc.getPage(index + 1);
      if (session !== this.renderSessionId) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const baseVp = page.getViewport({ scale: 1 });
      const targetPixelW = Math.min(1800, Math.round(this.pageWidth * dpr * 1.15));
      const scale = targetPixelW / baseVp.width;
      const viewport = page.getViewport({ scale });

      const canvas = node.canvas;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);

      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const renderTask = page.render({ canvasContext: ctx, viewport });
      node.renderTask = renderTask;

      await renderTask.promise;
      if (session !== this.renderSessionId) return;

      node.renderTask = null;
      node.rendered = true;
      node.loader.classList.add('is-hidden');
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException') {
        console.warn(`Error renderizando página ${index + 1}:`, err);
      }
    }
  }

  /**
   * Razor-Sharp Hi-DPI Overlay when Free Zoom > 1.28x
   * Renders the visible page(s) at high vector resolution so typography stays crisp at 300-400% zoom.
   */
  async renderHiResOverlay(zoomScale) {
    this.currentZoomScale = zoomScale;
    if (!this.pdfDoc || zoomScale <= 1.28) {
      this.clearHiResOverlay();
      return;
    }

    this._cancelHiResTasks();
    const token = ++this.hiresRenderToken;
    const visible = this.getSpreadIndices(this.currentPageIndex);
    const isCoverActive = this.effectiveMode === 'double' && this.showCover;

    const frag = document.createDocumentFragment();

    try {
      for (const pageIdx of visible) {
        if (token !== this.hiresRenderToken) return;

        // Wait briefly if base page render is currently in flight for this same page
        const baseNode = this.pageNodes[pageIdx];
        if (baseNode?.renderTask) {
          try { await baseNode.renderTask.promise; } catch {}
        }
        if (token !== this.hiresRenderToken) return;

        const canvas = document.createElement('canvas');
        canvas.className = 'hires-page-canvas';

        let leftPx = 0;
        if (this.effectiveMode === 'double') {
          const isRight = isCoverActive ? (pageIdx % 2 === 0) : (pageIdx % 2 === 1);
          leftPx = isRight ? this.pageWidth : 0;
        }

        canvas.style.left = `${leftPx}px`;
        canvas.style.top = '0px';
        canvas.style.width = `${this.pageWidth}px`;
        canvas.style.height = `${this.pageHeight}px`;

        const page = await this.pdfDoc.getPage(pageIdx + 1);
        if (token !== this.hiresRenderToken) return;

        const baseVp = page.getViewport({ scale: 1 });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const maxDim = 2048;
        const desiredW = Math.min(maxDim, Math.round(this.pageWidth * zoomScale * dpr));
        const scale = desiredW / baseVp.width;
        const vp = page.getViewport({ scale });

        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const task = page.render({ canvasContext: ctx, viewport: vp });
        this.hiresRenderTasks.push(task);
        await task.promise;
        if (token !== this.hiresRenderToken) return;

        frag.appendChild(canvas);
      }

      if (token !== this.hiresRenderToken) return;
      this.hiresOverlayEl.innerHTML = '';
      this.hiresOverlayEl.appendChild(frag);
      this.hiresOverlayEl.classList.add('is-visible');
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException') {
        console.warn('Hi-res zoom render skipped:', err);
      }
    }
  }

  _cancelHiResTasks() {
    for (const t of this.hiresRenderTasks) {
      try { t.cancel(); } catch {}
    }
    this.hiresRenderTasks = [];
  }

  clearHiResOverlay() {
    this.hiresRenderToken++;
    this._cancelHiResTasks();
    this.hiresOverlayEl.classList.remove('is-visible');
    this.hiresOverlayEl.innerHTML = '';
  }

  /**
   * Render a single thumbnail canvas on demand (for Thumbnails Drawer or Library cover).
   */
  async renderThumbnail(pageNumber, canvas, targetWidth = 170) {
    if (!this.pdfDoc) return;
    try {
      const page = await this.pdfDoc.getPage(pageNumber);
      const baseVp = page.getViewport({ scale: 1 });
      const scale = targetWidth / baseVp.width;
      const vp = page.getViewport({ scale });

      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
    } catch {
      // Ignore
    }
  }

  /**
   * Full-text accent-insensitive search across the PDF.
   */
  async searchText(query, onProgress = null) {
    if (!this.pdfDoc) return [];
    const normQuery = normalizeSpanish(query).trim();
    if (normQuery.length < 2) return [];

    const results = [];
    const total = this.totalPages;

    for (let p = 1; p <= total; p++) {
      let text = this.textCache.get(p);
      if (text === undefined) {
        try {
          const page = await this.pdfDoc.getPage(p);
          const content = await page.getTextContent();
          text = content.items.map((item) => item.str).join(' ').replace(/\s+/g, ' ').trim();
        } catch {
          text = '';
        }
        this.textCache.set(p, text);
      }

      const normText = normalizeSpanish(text);
      const idx = normText.indexOf(normQuery);
      if (idx !== -1) {
        const start = Math.max(0, idx - 42);
        const end = Math.min(text.length, idx + normQuery.length + 62);
        const snippet = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
        // Count occurrences on this page
        let count = 0;
        let pos = 0;
        while ((pos = normText.indexOf(normQuery, pos)) !== -1) {
          count++;
          pos += normQuery.length;
        }
        results.push({ page: p, snippet, count });
      }

      if (onProgress && (p % 6 === 0 || p === total)) {
        onProgress(Math.round((p / total) * 100));
      }
    }

    return results;
  }
}

/**
 * Standalone helper to inspect any uploaded PDF File or URL (extracts cover preview, page count, title, author).
 */
export async function inspectPdfFile(fileOrUrl) {
  let init;
  if (fileOrUrl instanceof File || fileOrUrl instanceof Blob) {
    const buf = await fileOrUrl.arrayBuffer();
    init = { data: new Uint8Array(buf), isEvalSupported: false };
  } else {
    init = {
      url: String(fileOrUrl),
      isEvalSupported: false,
      disableAutoFetch: true,
      rangeChunkSize: 65536 * 4
    };
  }

  const loadingTask = pdfjsLib.getDocument(init);
  const pdfDoc = await loadingTask.promise;

  try {
    const pageCount = pdfDoc.numPages;
    let info = {};
    try {
      const meta = await pdfDoc.getMetadata();
      info = meta?.info || {};
    } catch {}

    // Render crisp cover thumbnail from page 1
    const page1 = await pdfDoc.getPage(1);
    const baseVp = page1.getViewport({ scale: 1 });
    const targetW = 360;
    const vp = page1.getViewport({ scale: targetW / baseVp.width });

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page1.render({ canvasContext: ctx, viewport: vp }).promise;
    const coverDataUrl = canvas.toDataURL('image/jpeg', 0.84);

    return {
      pageCount,
      title: info.Title || '',
      author: info.Author || '',
      subject: info.Subject || '',
      coverDataUrl
    };
  } finally {
    pdfDoc.destroy();
  }
}
