/**
 * Library Catalog Gallery & Share / QR / Embed Controller
 */
import { inspectPdfFile } from './flipbook.js';

export const THEMES = [
  { id: 'obsidian', label: 'Noche Editorial', bg: '#0e1017', accent: '#d8aa54' },
  { id: 'midnight', label: 'Azul Medianoche', bg: '#0b1424', accent: '#62b6ff' },
  { id: 'velvet', label: 'Burdeos Clásico', bg: '#1b0d12', accent: '#e0a96d' },
  { id: 'parchment', label: 'Papel Cálido', bg: '#ece4d5', accent: '#8c5a2b' },
  { id: 'gallery', label: 'Galería Clara', bg: '#f1f3f6', accent: '#2563eb' }
];

const coverCache = new Map();

export class StudioController {
  constructor(storage, callbacks = {}) {
    this.storage = storage;
    this.onOpenBook = callbacks.onOpenBook || (() => {});
    this.onToast = callbacks.onToast || (() => {});

    this._cacheElements();
    this._bindEvents();
  }

  _cacheElements() {
    this.studioModal = document.getElementById('studio-modal');
    this.closeStudioBtn = document.getElementById('btn-close-studio');
    this.libraryGrid = document.getElementById('library-grid');
    this.bookCountLabel = document.getElementById('library-count-label');

    // Share modal elements
    this.shareModal = document.getElementById('share-modal');
    this.closeShareBtn = document.getElementById('btn-close-share');
    this.shareTitle = document.getElementById('share-book-title');
    this.shareUrlInput = document.getElementById('share-url-input');
    this.shareIncludePageCheck = document.getElementById('share-include-page');
    this.shareCopyUrlBtn = document.getElementById('btn-copy-share-url');
    this.embedCodeArea = document.getElementById('embed-code-textarea');
    this.copyEmbedBtn = document.getElementById('btn-copy-embed');
    this.qrContainer = document.getElementById('share-qr-container');
    this.downloadQrBtn = document.getElementById('btn-download-qr');
  }

  _bindEvents() {
    this.closeStudioBtn?.addEventListener('click', () => this.close());
    this.studioModal?.addEventListener('click', (e) => {
      if (e.target === this.studioModal) this.close();
    });

    this.closeShareBtn?.addEventListener('click', () => this.closeShare());
    this.shareModal?.addEventListener('click', (e) => {
      if (e.target === this.shareModal) this.closeShare();
    });
    this.shareIncludePageCheck?.addEventListener('change', () => this._refreshShareOutputs());
    this.shareCopyUrlBtn?.addEventListener('click', () => {
      this._copyText(this.shareUrlInput.value, 'Enlace copiado al portapapeles.');
    });
    this.copyEmbedBtn?.addEventListener('click', () => {
      this._copyText(this.embedCodeArea.value, 'Código iframe copiado.');
    });
    this.downloadQrBtn?.addEventListener('click', () => this._downloadQrSvg());
  }

  cacheCover(bookId, dataUrl) {
    if (bookId && dataUrl) {
      coverCache.set(bookId, dataUrl);
    }
  }

  open(activeBookId = null) {
    this.renderLibrary(activeBookId);
    this.studioModal.hidden = false;
    requestAnimationFrame(() => {
      this.studioModal.classList.add('is-open');
      this.closeStudioBtn?.focus();
    });
  }

  close() {
    this.studioModal.classList.remove('is-open');
    setTimeout(() => {
      this.studioModal.hidden = true;
    }, 200);
  }

  isOpen() {
    return !this.studioModal.hidden;
  }

  renderLibrary(activeBookId = null) {
    const books = this.storage.books;
    this.bookCountLabel.textContent = `${books.length} ${books.length === 1 ? 'publicación' : 'publicaciones'}`;
    this.libraryGrid.innerHTML = '';

    for (const book of books) {
      const card = document.createElement('article');
      card.className = 'book-card';
      if (activeBookId && book.id === activeBookId) {
        card.classList.add('is-current');
      }

      const themeMeta = THEMES.find((t) => t.id === book.theme) || THEMES[0];

      card.innerHTML = `
        <div class="book-card-cover" style="--card-bg:${themeMeta.bg}; --card-accent:${book.accent || themeMeta.accent}">
          <div class="book-card-thumb" data-cover-id="${book.id}">
            <div class="book-card-placeholder">
              <span class="book-card-placeholder-title">${this._escape(book.title)}</span>
              ${book.subtitle ? `<span class="book-card-placeholder-sub">${this._escape(book.subtitle)}</span>` : ''}
            </div>
          </div>
          ${activeBookId && book.id === activeBookId ? '<span class="book-card-badge">Leyendo</span>' : ''}
        </div>
        <div class="book-card-body">
          <h3 class="book-card-title">${this._escape(book.title)}</h3>
          <p class="book-card-meta">
            ${book.author ? `<span>${this._escape(book.author)}</span>` : ''}
            ${book.pageCount ? `<span>${book.pageCount} págs.</span>` : ''}
          </p>
          ${book.description ? `<p class="book-card-desc">${this._escape(book.description)}</p>` : ''}
          <div class="book-card-actions">
            <button type="button" class="btn-primary btn-sm" data-action="open">Leer</button>
            <button type="button" class="btn-ghost btn-sm" data-action="share" title="Compartir o embeber">Compartir</button>
          </div>
        </div>
      `;

      card.querySelector('[data-action="open"]').addEventListener('click', () => {
        this.close();
        this.onOpenBook(book);
      });
      card.querySelector('[data-action="share"]').addEventListener('click', () => {
        this.openShare(book, 1);
      });

      this.libraryGrid.appendChild(card);
      this._hydrateCardCover(book, card.querySelector('.book-card-thumb'));
    }
  }

  async _hydrateCardCover(book, container) {
    if (!container) return;
    const cached = book.coverUrl || coverCache.get(book.id);
    if (cached) {
      container.innerHTML = `<img src="${cached}" alt="Portada de ${this._escape(book.title)}" loading="lazy" draggable="false" />`;
      return;
    }

    try {
      const src = await this.storage.getPdfSource(book);
      const result = await inspectPdfFile(src.pdfInit.url);
      if (result.coverDataUrl) {
        coverCache.set(book.id, result.coverDataUrl);
        container.innerHTML = `<img src="${result.coverDataUrl}" alt="Portada de ${this._escape(book.title)}" loading="lazy" draggable="false" />`;
      }
    } catch {
      // Keep clean typographic cover fallback
    }
  }

  // Share & Embed Modal
  openShare(book, currentPage = 1) {
    this._shareBook = book;
    this._sharePage = currentPage || 1;
    this.shareTitle.textContent = book.title;
    this.shareIncludePageCheck.checked = currentPage > 1;
    this._refreshShareOutputs();

    this.shareModal.hidden = false;
    requestAnimationFrame(() => {
      this.shareModal.classList.add('is-open');
      this.closeShareBtn?.focus();
    });
  }

  closeShare() {
    this.shareModal.classList.remove('is-open');
    setTimeout(() => {
      this.shareModal.hidden = true;
    }, 180);
  }

  _refreshShareOutputs() {
    const book = this._shareBook;
    if (!book) return;
    const base = `${window.location.origin}${window.location.pathname}`;
    const pageHash = this.shareIncludePageCheck.checked && this._sharePage > 1 ? `#page=${this._sharePage}` : '';
    const directUrl = `${base}?book=${encodeURIComponent(book.slug)}${pageHash}`;
    const embedUrl = `${base}?book=${encodeURIComponent(book.slug)}&embed=1${pageHash}`;

    this.shareUrlInput.value = directUrl;
    this.embedCodeArea.value = `<iframe src="${embedUrl}" title="${this._escape(book.title)}" width="100%" height="680" style="border:0;border-radius:12px;overflow:hidden;box-shadow:0 16px 40px rgba(0,0,0,0.22);" allowfullscreen loading="lazy"></iframe>`;

    if (window.qrcode && this.qrContainer) {
      try {
        const qr = window.qrcode(0, 'M');
        qr.addData(directUrl);
        qr.make();
        this.qrContainer.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 3, scalable: true });
      } catch {
        this.qrContainer.innerHTML = '<p class="muted-note">QR no disponible para esta URL.</p>';
      }
    }
  }

  _downloadQrSvg() {
    const svg = this.qrContainer?.querySelector('svg');
    if (!svg || !this._shareBook) return;
    const data = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([data], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `qr-${this._shareBook.slug}.svg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async _copyText(text, successMsg) {
    try {
      await navigator.clipboard.writeText(text);
      this.onToast(successMsg, 'success');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      this.onToast(successMsg, 'success');
    }
  }

  _escape(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
}
