/**
 * Main Application Orchestrator — Nexo Flipbook Platform
 */
import { PlatformStorage } from './storage.js';
import { PageSoundEngine } from './sound.js';
import { ZoomPanController } from './zoom-pan.js';
import { FlipbookEngine, normalizeSpanish } from './flipbook.js';
import { StudioController, THEMES } from './studio.js';

class FlipbookApp {
  constructor() {
    this.storage = new PlatformStorage();
    this.sound = new PageSoundEngine(true);
    this.currentBook = null;
    this.isPseudoFullscreen = false;
    this.activeDrawer = null; // 'toc' | 'thumbs' | 'search' | null
    this.thumbObserver = null;

    this._cacheDom();
  }

  _cacheDom() {
    this.appShell = document.getElementById('app-shell');
    this.srAnnouncer = document.getElementById('sr-announcer');

    // Top Header
    this.topBar = document.getElementById('reader-topbar');
    this.bookTitleEl = document.getElementById('header-book-title');
    this.bookSubtitleEl = document.getElementById('header-book-subtitle');
    this.btnOpenLibrary = document.getElementById('btn-open-library');
    this.btnThemeMenu = document.getElementById('btn-theme-menu');
    this.themePopover = document.getElementById('theme-popover');
    this.btnShare = document.getElementById('btn-share');
    this.btnHelp = document.getElementById('btn-help');
    this.btnTopFullscreen = document.getElementById('btn-top-fullscreen');

    // Stage & Flipbook
    this.stageViewport = document.getElementById('stage-viewport');
    this.zoomLayer = document.getElementById('zoom-layer');
    this.bookShift = document.getElementById('book-shift');
    this.bookShell = document.getElementById('book-shell');
    this.hiresOverlay = document.getElementById('hires-overlay');
    this.edgePrevBtn = document.getElementById('btn-edge-prev');
    this.edgeNextBtn = document.getElementById('btn-edge-next');
    this.zoomBanner = document.getElementById('zoom-hint-banner');
    this.btnResetZoomBanner = document.getElementById('btn-reset-zoom-banner');

    // Loading Overlay
    this.loaderOverlay = document.getElementById('book-loader');
    this.loaderTitle = document.getElementById('loader-book-title');
    this.loaderStage = document.getElementById('loader-stage-text');
    this.loaderBar = document.getElementById('loader-progress-bar');
    this.loaderPercent = document.getElementById('loader-percent');

    // Error state
    this.errorBox = document.getElementById('book-error');
    this.errorMsg = document.getElementById('book-error-msg');
    this.btnErrorLibrary = document.getElementById('btn-error-library');

    // Bottom Dock Controls
    this.btnFirst = document.getElementById('btn-first-page');
    this.btnPrev = document.getElementById('btn-prev-page');
    this.btnNext = document.getElementById('btn-next-page');
    this.btnLast = document.getElementById('btn-last-page');
    this.pageInput = document.getElementById('page-jump-input');
    this.pageTotalEl = document.getElementById('page-total-label');
    this.pageRangeLabel = document.getElementById('page-spread-label');
    this.scrubber = document.getElementById('page-scrubber');
    this.scrubberTooltip = document.getElementById('scrubber-tooltip');

    this.btnZoomOut = document.getElementById('btn-zoom-out');
    this.btnZoomReset = document.getElementById('btn-zoom-reset');
    this.btnZoomIn = document.getElementById('btn-zoom-in');
    this.btnSpreadToggle = document.getElementById('btn-spread-toggle');
    this.btnSoundToggle = document.getElementById('btn-sound-toggle');
    this.btnToc = document.getElementById('btn-drawer-toc');
    this.btnThumbs = document.getElementById('btn-drawer-thumbs');
    this.btnSearch = document.getElementById('btn-drawer-search');
    this.btnFullscreen = document.getElementById('btn-fullscreen');

    // Side Drawer
    this.sideDrawer = document.getElementById('side-drawer');
    this.drawerBackdrop = document.getElementById('drawer-backdrop');
    this.drawerTitle = document.getElementById('drawer-title');
    this.btnCloseDrawer = document.getElementById('btn-close-drawer');
    this.paneToc = document.getElementById('drawer-pane-toc');
    this.paneThumbs = document.getElementById('drawer-pane-thumbs');
    this.paneSearch = document.getElementById('drawer-pane-search');
    this.tocList = document.getElementById('toc-list');
    this.thumbsGrid = document.getElementById('thumbs-grid');
    this.searchForm = document.getElementById('pdf-search-form');
    this.searchInput = document.getElementById('pdf-search-input');
    this.searchStatus = document.getElementById('pdf-search-status');
    this.searchResults = document.getElementById('pdf-search-results');

    // Help Modal & Toast
    this.helpModal = document.getElementById('help-modal');
    this.btnCloseHelp = document.getElementById('btn-close-help');
    this.toastContainer = document.getElementById('toast-container');
  }

  async init() {
    const params = new URLSearchParams(window.location.search);
    const isEmbed = params.get('embed') === '1' || params.get('embed') === 'true';
    if (isEmbed) {
      this.appShell.classList.add('is-embed-mode');
    }

    // Build theme quick-switcher
    this._renderThemePopover();

    // Initialize storage
    await this.storage.init();

    // Initialize Zoom & Pan
    this.zoomPan = new ZoomPanController(this.stageViewport, this.zoomLayer, {
      minScale: 1.0,
      maxScale: 4.0,
      doubleTapScale: 2.25,
      onChange: ({ scale, isZoomed }) => {
        const pct = Math.round(scale * 100);
        this.btnZoomReset.textContent = `${pct}%`;
        this.btnZoomOut.disabled = scale <= 1.01;
        this.btnZoomIn.disabled = scale >= 3.98;
        this.zoomBanner.hidden = !isZoomed;
        if (!isZoomed) {
          this.flipbook?.clearHiResOverlay();
        }
      },
      onZoomSettled: ({ scale, isZoomed }) => {
        if (isZoomed && scale > 1.28) {
          this.flipbook?.renderHiResOverlay(scale);
        } else {
          this.flipbook?.clearHiResOverlay();
        }
        this._announce(`Zoom al ${Math.round(scale * 100)} por ciento`);
      }
    });

    // Initialize Flipbook Engine
    this.flipbook = new FlipbookEngine(
      {
        stageEl: this.stageViewport,
        bookShiftEl: this.bookShift,
        bookShellEl: this.bookShell,
        hiresOverlayEl: this.hiresOverlay
      },
      {
        sound: this.sound,
        onLoadProgress: ({ percent, stage }) => {
          this.loaderBar.style.width = `${percent}%`;
          this.loaderPercent.textContent = `${percent}%`;
          if (stage) this.loaderStage.textContent = stage;
        },
        onReady: ({ totalPages, outline, mode, coverDataUrl }) => {
          this.loaderOverlay.classList.add('is-hidden');
          this.errorBox.hidden = true;
          if (this.currentBook) {
            if (!this.currentBook.pageCount) this.currentBook.pageCount = totalPages;
            if (coverDataUrl) this.studio?.cacheCover(this.currentBook.id, coverDataUrl);
          }
          this.pageTotalEl.textContent = `/ ${totalPages}`;
          this.pageInput.max = String(totalPages);
          this.scrubber.max = String(totalPages);
          this._updateSpreadButton(mode);
          this._renderToc(outline);
          this._buildThumbnailsSkeleton(totalPages);
          this.zoomPan.reset(false);
          this._announce(`Libro cargado: ${this.currentBook?.title}. ${totalPages} páginas.`);
        },
        onPageChange: (info) => this._handlePageChange(info),
        onModeChange: (mode) => {
          this._updateSpreadButton(mode);
          this.zoomPan.reset(false);
        },
        onError: (err) => {
          this.loaderOverlay.classList.add('is-hidden');
          this.errorBox.hidden = false;
          this.errorMsg.textContent = err?.message || 'No se pudo cargar el archivo PDF.';
        }
      }
    );

    // Initialize Library & Share Controller
    this.studio = new StudioController(this.storage, {
      onOpenBook: (book) => this.openBook(book, 1),
      onToast: (msg, type) => this.showToast(msg, type)
    });

    this._bindUiEvents();

    // Determine initial book and page from URL
    const requestedSlug = params.get('book');
    const hashPage = this._parseHashPage();
    const initialBook = this.storage.getBookBySlug(requestedSlug) || this.storage.getDefaultBook();

    if (initialBook) {
      await this.openBook(initialBook, hashPage || 1, false);
    } else {
      this.loaderOverlay.classList.add('is-hidden');
      this.errorBox.hidden = false;
      this.errorMsg.textContent = 'No hay publicaciones configuradas en data/catalog.json.';
    }

    const viewParam = params.get('view');
    if (viewParam === 'library' || viewParam === 'biblioteca') {
      this.studio.open(this.currentBook?.id);
    }
  }

  _parseHashPage() {
    const match = window.location.hash.match(/page=(\d+)/i);
    return match ? Math.max(1, parseInt(match[1], 10)) : null;
  }

  async openBook(book, startPage = 1, updateUrl = true) {
    if (!book) return;
    this.currentBook = book;

    this.closeDrawer();
    this.zoomPan.reset(false);
    this._applyBookSettings(book);

    // Show loader
    this.errorBox.hidden = true;
    this.loaderOverlay.classList.remove('is-hidden');
    this.loaderTitle.textContent = book.title;
    this.loaderStage.textContent = 'Preparando lectura…';
    this.loaderBar.style.width = '5%';
    this.loaderPercent.textContent = '5%';

    // Update browser URL cleanly without reload
    if (updateUrl) {
      const url = new URL(window.location.href);
      url.searchParams.set('book', book.slug);
      url.searchParams.delete('view');
      url.hash = startPage > 1 ? `page=${startPage}` : '';
      window.history.replaceState({}, '', url.toString());
    }

    try {
      const source = await this.storage.getPdfSource(book);

      await this.flipbook.load(source.pdfInit, {
        startPage,
        spreadMode: book.spreadMode || 'auto',
        showCover: book.showCover !== false
      });
    } catch (err) {
      this.loaderOverlay.classList.add('is-hidden');
      this.errorBox.hidden = false;
      this.errorMsg.textContent = err?.message || 'Error al abrir el documento PDF.';
    }
  }

  _applyBookSettings(book) {
    document.title = `${book.title}${book.subtitle ? ` — ${book.subtitle}` : ''} | ${this.storage.site.name}`;
    this.bookTitleEl.textContent = book.title;
    this.bookSubtitleEl.textContent = book.subtitle || book.author || '';
    this.bookSubtitleEl.hidden = !(book.subtitle || book.author);

    this.setTheme(book.theme || 'obsidian', book.accent || null);
    this.sound.setEnabled(book.soundEnabled !== false);
    this._updateSoundButton();
  }

  setTheme(themeId, customAccent = null) {
    const theme = THEMES.find((t) => t.id === themeId) || THEMES[0];
    document.documentElement.dataset.theme = theme.id;
    document.documentElement.style.setProperty('--accent', customAccent || theme.accent);

    this.themePopover?.querySelectorAll('.theme-swatch-btn').forEach((btn) => {
      const active = btn.dataset.themeId === theme.id;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  }

  _renderThemePopover() {
    if (!this.themePopover) return;
    this.themePopover.innerHTML = `<div class="popover-title">Ambiente de lectura</div>` + THEMES.map((t) => `
      <button type="button" class="theme-swatch-btn" data-theme-id="${t.id}" aria-pressed="false">
        <span class="swatch-dot" style="background:${t.bg}; border-color:${t.accent}"></span>
        <span>${t.label}</span>
      </button>
    `).join('');

    this.themePopover.querySelectorAll('.theme-swatch-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.setTheme(btn.dataset.themeId);
        this.themePopover.hidden = true;
        this.btnThemeMenu.setAttribute('aria-expanded', 'false');
      });
    });
  }

  _bindUiEvents() {
    // Top bar actions
    this.btnOpenLibrary?.addEventListener('click', () => this.studio.open(this.currentBook?.id));
    this.btnErrorLibrary?.addEventListener('click', () => this.studio.open(this.currentBook?.id));

    // Prevent right-click "Save image" on book pages & thumbnails
    this.stageViewport?.addEventListener('contextmenu', (e) => e.preventDefault());
    this.thumbsGrid?.addEventListener('contextmenu', (e) => e.preventDefault());

    this.btnThemeMenu?.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = this.themePopover.hidden;
      this.themePopover.hidden = !willOpen;
      this.btnThemeMenu.setAttribute('aria-expanded', String(willOpen));
    });
    document.addEventListener('click', (e) => {
      if (!this.themePopover.hidden && !e.target.closest('#theme-popover, #btn-theme-menu')) {
        this.themePopover.hidden = true;
        this.btnThemeMenu.setAttribute('aria-expanded', 'false');
      }
    });

    this.btnShare?.addEventListener('click', () => {
      if (!this.currentBook) return;
      const pageNum = this.flipbook.getPageInfo().pageNumber || 1;
      this.studio.openShare(this.currentBook, pageNum);
    });

    // Help modal
    this.btnHelp?.addEventListener('click', () => this._toggleHelpModal(true));
    this.btnCloseHelp?.addEventListener('click', () => this._toggleHelpModal(false));
    this.helpModal?.addEventListener('click', (e) => {
      if (e.target === this.helpModal) this._toggleHelpModal(false);
    });

    // Page Navigation
    const goPrev = () => {
      if (this.zoomPan.isZoomed()) this.zoomPan.reset(false);
      this.flipbook.flipPrev();
    };
    const goNext = () => {
      if (this.zoomPan.isZoomed()) this.zoomPan.reset(false);
      this.flipbook.flipNext();
    };

    this.btnPrev?.addEventListener('click', goPrev);
    this.btnNext?.addEventListener('click', goNext);
    this.edgePrevBtn?.addEventListener('click', goPrev);
    this.edgeNextBtn?.addEventListener('click', goNext);
    this.btnFirst?.addEventListener('click', () => {
      this.zoomPan.reset(false);
      this.flipbook.goFirst();
    });
    this.btnLast?.addEventListener('click', () => {
      this.zoomPan.reset(false);
      this.flipbook.goLast();
    });

    // Page input jump
    this.pageInput?.addEventListener('change', () => {
      const target = parseInt(this.pageInput.value, 10);
      if (!Number.isNaN(target)) {
        this.zoomPan.reset(false);
        this.flipbook.goToPage(target, false);
      }
      this.pageInput.blur();
    });
    this.pageInput?.addEventListener('focus', () => this.pageInput.select());

    // Scrubber slider with live preview tooltip
    this.scrubber?.addEventListener('input', () => {
      const val = parseInt(this.scrubber.value, 10);
      const max = parseInt(this.scrubber.max, 10) || 1;
      const pct = max > 1 ? ((val - 1) / (max - 1)) * 100 : 0;
      this.scrubber.style.setProperty('--progress', `${pct}%`);
      if (this.scrubberTooltip) {
        this.scrubberTooltip.textContent = `Pág. ${val}`;
        this.scrubberTooltip.style.left = `${pct}%`;
        this.scrubberTooltip.classList.add('is-visible');
      }
    });
    this.scrubber?.addEventListener('change', () => {
      const val = parseInt(this.scrubber.value, 10);
      this.zoomPan.reset(false);
      this.flipbook.goToPage(val, false);
      this.scrubberTooltip?.classList.remove('is-visible');
    });
    ['pointerup', 'pointercancel', 'blur'].forEach((ev) => {
      this.scrubber?.addEventListener(ev, () => this.scrubberTooltip?.classList.remove('is-visible'));
    });

    // Zoom Controls
    this.btnZoomIn?.addEventListener('click', () => this.zoomPan.zoomIn(0.35));
    this.btnZoomOut?.addEventListener('click', () => this.zoomPan.zoomOut(0.35));
    this.btnZoomReset?.addEventListener('click', () => this.zoomPan.reset(true));
    this.btnResetZoomBanner?.addEventListener('click', () => this.zoomPan.reset(true));

    // Spread mode toggle (1 page vs 2 pages)
    this.btnSpreadToggle?.addEventListener('click', () => {
      const nextMode = this.flipbook.effectiveMode === 'double' ? 'single' : 'double';
      this.flipbook.setSpreadMode(nextMode);
      this.showToast(nextMode === 'double' ? 'Vista de doble página' : 'Vista de página única', 'info');
    });

    // Sound toggle
    this.btnSoundToggle?.addEventListener('click', () => {
      this.sound.setEnabled(!this.sound.enabled);
      this._updateSoundButton();
      this.showToast(this.sound.enabled ? 'Sonido de páginas activado' : 'Sonido desactivado', 'info');
    });

    // Drawers (TOC, Thumbnails, Search)
    this.btnToc?.addEventListener('click', () => this.toggleDrawer('toc'));
    this.btnThumbs?.addEventListener('click', () => this.toggleDrawer('thumbs'));
    this.btnSearch?.addEventListener('click', () => this.toggleDrawer('search'));
    this.btnCloseDrawer?.addEventListener('click', () => this.closeDrawer());
    this.drawerBackdrop?.addEventListener('click', () => this.closeDrawer());

    // PDF Full-Text Search
    this.searchForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      this._runSearch();
    });

    // Fullscreen buttons (Top bar & Bottom dock)
    const toggleFs = () => this.toggleFullscreen();
    this.btnFullscreen?.addEventListener('click', toggleFs);
    this.btnTopFullscreen?.addEventListener('click', toggleFs);

    document.addEventListener('fullscreenchange', () => this._syncFullscreenState());
    document.addEventListener('webkitfullscreenchange', () => this._syncFullscreenState());

    // Keyboard shortcuts (accessible & comprehensive)
    document.addEventListener('keydown', (e) => this._handleKeydown(e));
  }

  _handlePageChange(info) {
    this.pageInput.value = String(info.pageNumber);
    this.pageRangeLabel.textContent = info.label;
    this.scrubber.value = String(info.pageNumber);
    const pct = info.totalPages > 1 ? ((info.pageNumber - 1) / (info.totalPages - 1)) * 100 : 100;
    this.scrubber.style.setProperty('--progress', `${pct}%`);

    this.btnFirst.disabled = info.isFirst;
    this.btnPrev.disabled = info.isFirst;
    this.edgePrevBtn.disabled = info.isFirst;

    this.btnNext.disabled = info.isLast;
    this.btnLast.disabled = info.isLast;
    this.edgeNextBtn.disabled = info.isLast;

    // Highlight active thumbnails
    const visibleSet = new Set(info.visiblePages);
    this.thumbsGrid?.querySelectorAll('.thumb-item').forEach((item) => {
      const p = parseInt(item.dataset.page, 10);
      item.classList.toggle('is-active', visibleSet.has(p));
    });

    // Update URL hash quietly
    if (this.currentBook) {
      const targetHash = info.pageNumber > 1 ? `#page=${info.pageNumber}` : '';
      if (window.location.hash !== targetHash) {
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${targetHash}`);
      }
    }

    this._announce(`Página ${info.label} de ${info.totalPages}`);
  }

  _updateSpreadButton(mode) {
    const isDouble = mode === 'double';
    this.btnSpreadToggle.setAttribute('aria-pressed', String(isDouble));
    this.btnSpreadToggle.title = isDouble ? 'Cambiar a página única' : 'Cambiar a doble página';
    this.btnSpreadToggle.classList.toggle('is-active', isDouble);
  }

  _updateSoundButton() {
    this.btnSoundToggle.setAttribute('aria-pressed', String(this.sound.enabled));
    this.btnSoundToggle.classList.toggle('is-muted', !this.sound.enabled);
    this.btnSoundToggle.title = this.sound.enabled ? 'Silenciar sonido de paso de página (M)' : 'Activar sonido de paso de página (M)';
  }

  // Side Drawer Management
  toggleDrawer(pane) {
    if (this.activeDrawer === pane) {
      this.closeDrawer();
      return;
    }
    this.activeDrawer = pane;

    const titles = {
      toc: 'Índice de Contenidos',
      thumbs: 'Miniaturas de Páginas',
      search: 'Buscar en el Ebook'
    };
    this.drawerTitle.textContent = titles[pane] || '';

    this.paneToc.hidden = pane !== 'toc';
    this.paneThumbs.hidden = pane !== 'thumbs';
    this.paneSearch.hidden = pane !== 'search';

    this.btnToc.classList.toggle('is-active', pane === 'toc');
    this.btnThumbs.classList.toggle('is-active', pane === 'thumbs');
    this.btnSearch.classList.toggle('is-active', pane === 'search');

    this.sideDrawer.hidden = false;
    this.drawerBackdrop.hidden = false;
    requestAnimationFrame(() => {
      this.sideDrawer.classList.add('is-open');
      this.drawerBackdrop.classList.add('is-open');
      if (pane === 'search') {
        this.searchInput.focus();
      } else {
        this.btnCloseDrawer.focus();
      }
    });

    if (pane === 'thumbs') {
      const activeThumb = this.thumbsGrid.querySelector('.thumb-item.is-active');
      if (activeThumb) {
        activeThumb.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }

  closeDrawer() {
    if (!this.activeDrawer) return;
    this.activeDrawer = null;
    this.sideDrawer.classList.remove('is-open');
    this.drawerBackdrop.classList.remove('is-open');
    this.btnToc.classList.remove('is-active');
    this.btnThumbs.classList.remove('is-active');
    this.btnSearch.classList.remove('is-active');
    setTimeout(() => {
      if (!this.activeDrawer) {
        this.sideDrawer.hidden = true;
        this.drawerBackdrop.hidden = true;
      }
    }, 220);
  }

  _renderToc(outline) {
    if (!outline || !outline.length) {
      this.tocList.innerHTML = `
        <div class="drawer-empty">
          <p>Este PDF no incluye marcadores de índice integrados.</p>
          <p class="muted-note">Puedes navegar visualmente usando las <strong>Miniaturas</strong> o buscar cualquier título en el panel de <strong>Búsqueda</strong>.</p>
        </div>
      `;
      return;
    }

    this.tocList.innerHTML = '';
    for (const item of outline) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `toc-item level-${Math.min(item.level, 3)}`;
      btn.innerHTML = `
        <span class="toc-item-title">${this._escape(item.title)}</span>
        <span class="toc-item-page">${item.page}</span>
      `;
      btn.addEventListener('click', () => {
        this.zoomPan.reset(false);
        this.flipbook.goToPage(item.page, false);
        if (window.innerWidth < 900) this.closeDrawer();
      });
      this.tocList.appendChild(btn);
    }
  }

  _buildThumbnailsSkeleton(totalPages) {
    if (this.thumbObserver) {
      this.thumbObserver.disconnect();
    }
    this.thumbsGrid.innerHTML = '';

    this.thumbObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const item = entry.target;
          if (item.dataset.rendered === '1') continue;
          item.dataset.rendered = '1';
          const pageNum = parseInt(item.dataset.page, 10);
          const canvas = item.querySelector('canvas');
          this.flipbook.renderThumbnail(pageNum, canvas, 165);
          this.thumbObserver.unobserve(item);
        }
      },
      { root: this.paneThumbs, rootMargin: '220px 0px' }
    );

    const frag = document.createDocumentFragment();
    for (let p = 1; p <= totalPages; p++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'thumb-item';
      btn.dataset.page = String(p);
      btn.setAttribute('aria-label', `Ir a la página ${p}`);
      btn.innerHTML = `
        <div class="thumb-canvas-wrap"><canvas></canvas></div>
        <span class="thumb-num">${p}</span>
      `;
      btn.addEventListener('click', () => {
        this.zoomPan.reset(false);
        this.flipbook.goToPage(p, false);
        if (window.innerWidth < 900) this.closeDrawer();
      });
      frag.appendChild(btn);
      this.thumbObserver.observe(btn);
    }
    this.thumbsGrid.appendChild(frag);
  }

  async _runSearch() {
    const query = this.searchInput.value.trim();
    if (query.length < 2) {
      this.searchStatus.textContent = 'Escribe al menos 2 caracteres para buscar.';
      this.searchResults.innerHTML = '';
      return;
    }

    this.searchStatus.textContent = 'Buscando en todo el libro… 0%';
    this.searchResults.innerHTML = '';

    const results = await this.flipbook.searchText(query, (pct) => {
      this.searchStatus.textContent = `Buscando en todo el libro… ${pct}%`;
    });

    if (!results.length) {
      this.searchStatus.textContent = `Sin coincidencias para "${query}".`;
      return;
    }

    this.searchStatus.textContent = `${results.length} ${results.length === 1 ? 'página encontrada' : 'páginas encontradas'} para "${query}"`;

    const normQ = normalizeSpanish(query);
    for (const r of results) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'search-result-item';
      btn.innerHTML = `
        <div class="search-result-head">
          <strong>Página ${r.page}</strong>
          <span class="search-match-badge">${r.count} ${r.count === 1 ? 'vez' : 'veces'}</span>
        </div>
        <p class="search-result-snippet">${this._highlightMatch(r.snippet, normQ)}</p>
      `;
      btn.addEventListener('click', () => {
        this.zoomPan.reset(false);
        this.flipbook.goToPage(r.page, false);
        if (window.innerWidth < 900) this.closeDrawer();
      });
      this.searchResults.appendChild(btn);
    }
  }

  _highlightMatch(snippet, normQuery) {
    const escaped = this._escape(snippet);
    const norm = normalizeSpanish(escaped);
    const idx = norm.indexOf(normQuery);
    if (idx === -1) return escaped;
    return (
      escaped.slice(0, idx) +
      `<mark>${escaped.slice(idx, idx + normQuery.length)}</mark>` +
      escaped.slice(idx + normQuery.length)
    );
  }

  // Fullscreen with iOS Safari graceful fallback
  async toggleFullscreen() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) {
      try {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
      } catch {}
      return;
    }

    if (this.isPseudoFullscreen) {
      this.isPseudoFullscreen = false;
      this.appShell.classList.remove('is-fullscreen');
      this._syncFullscreenState();
      setTimeout(() => this.flipbook.relayout(), 80);
      return;
    }

    const target = document.documentElement;
    const req = target.requestFullscreen || target.webkitRequestFullscreen;
    if (req) {
      try {
        await req.call(target);
        return;
      } catch {
        // Fallback to immersive pseudo-fullscreen (e.g. iOS Safari)
      }
    }

    this.isPseudoFullscreen = true;
    this.appShell.classList.add('is-fullscreen');
    this._syncFullscreenState();
    setTimeout(() => this.flipbook.relayout(), 80);
  }

  _syncFullscreenState() {
    const isFs = Boolean(document.fullscreenElement || document.webkitFullscreenElement || this.isPseudoFullscreen);
    this.appShell.classList.toggle('is-fullscreen', isFs);
    [this.btnFullscreen, this.btnTopFullscreen].forEach((btn) => {
      if (!btn) return;
      btn.setAttribute('aria-pressed', String(isFs));
      btn.classList.toggle('is-active', isFs);
      btn.title = isFs ? 'Salir de pantalla completa (F)' : 'Pantalla completa (F)';
    });
    setTimeout(() => this.flipbook?.relayout(), 120);
  }

  _toggleHelpModal(open) {
    if (open) {
      this.helpModal.hidden = false;
      requestAnimationFrame(() => {
        this.helpModal.classList.add('is-open');
        this.btnCloseHelp?.focus();
      });
    } else {
      this.helpModal.classList.remove('is-open');
      setTimeout(() => { this.helpModal.hidden = true; }, 180);
    }
  }

  _handleKeydown(e) {
    // Block Save / Print shortcuts to discourage downloading the ebook
    if ((e.ctrlKey || e.metaKey) && ['s', 'S', 'p', 'P'].includes(e.key)) {
      e.preventDefault();
      return;
    }

    const tag = e.target?.tagName;
    const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable;

    if (e.key === 'Escape') {
      if (this.studio.isOpen()) return this.studio.close();
      if (!this.studio.shareModal.hidden) return this.studio.closeShare();
      if (!this.helpModal.hidden) return this._toggleHelpModal(false);
      if (this.activeDrawer) return this.closeDrawer();
      if (this.zoomPan.isZoomed()) return this.zoomPan.reset(true);
      if (this.isPseudoFullscreen) return this.toggleFullscreen();
      return;
    }

    if (isTyping || this.studio.isOpen() || !this.studio.shareModal.hidden) return;

    switch (e.key) {
      case 'ArrowRight':
      case 'PageDown':
        e.preventDefault();
        if (this.zoomPan.isZoomed()) this.zoomPan.reset(false);
        this.flipbook.flipNext();
        break;
      case 'ArrowLeft':
      case 'PageUp':
        e.preventDefault();
        if (this.zoomPan.isZoomed()) this.zoomPan.reset(false);
        this.flipbook.flipPrev();
        break;
      case 'Home':
        e.preventDefault();
        this.zoomPan.reset(false);
        this.flipbook.goFirst();
        break;
      case 'End':
        e.preventDefault();
        this.zoomPan.reset(false);
        this.flipbook.goLast();
        break;
      case '+':
      case '=':
        e.preventDefault();
        this.zoomPan.zoomIn(0.35);
        break;
      case '-':
      case '_':
        e.preventDefault();
        this.zoomPan.zoomOut(0.35);
        break;
      case '0':
        e.preventDefault();
        this.zoomPan.reset(true);
        break;
      case 'f':
      case 'F':
        e.preventDefault();
        this.toggleFullscreen();
        break;
      case 'm':
      case 'M':
        e.preventDefault();
        this.btnSoundToggle.click();
        break;
      case 't':
      case 'T':
        e.preventDefault();
        this.toggleDrawer('thumbs');
        break;
      case '/':
        e.preventDefault();
        this.toggleDrawer('search');
        break;
      case '?':
        e.preventDefault();
        this._toggleHelpModal(this.helpModal.hidden);
        break;
    }
  }

  _announce(text) {
    if (!this.srAnnouncer) return;
    this.srAnnouncer.textContent = '';
    requestAnimationFrame(() => {
      this.srAnnouncer.textContent = text;
    });
  }

  showToast(message, type = 'info') {
    if (!this.toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', 'status');
    toast.textContent = message;
    this.toastContainer.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('is-visible'));
    setTimeout(() => {
      toast.classList.remove('is-visible');
      setTimeout(() => toast.remove(), 260);
    }, 3400);
  }

  _escape(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const app = new FlipbookApp();
  app.init();
  window.__nexoFlipbookApp = app;
});
