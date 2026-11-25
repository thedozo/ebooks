/**
 * Catalog Storage Engine — GitHub Pages / Static Hosting (`data/catalog.json`)
 * Para agregar nuevos ebooks: sube el PDF a `books/` y agrega su ficha en `data/catalog.json`.
 */

export class PlatformStorage {
  constructor() {
    this.site = {
      name: 'Nexo Flipbook',
      tagline: 'Plataforma Editorial Interactiva',
      defaultBook: 'ecos-del-mas-alla'
    };
    this.books = [];
  }

  async init() {
    await this.refresh();
    return this;
  }

  async refresh() {
    try {
      const res = await fetch('data/catalog.json', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (data.site) this.site = { ...this.site, ...data.site };
        this.books = Array.isArray(data.books) ? data.books : [];
        return this.books;
      }
    } catch {
      // Fallback de emergencia
    }

    this.books = [{
      id: 'ecos-del-mas-alla',
      slug: 'ecos-del-mas-alla',
      title: 'Ecos del Más Allá',
      subtitle: 'Antología',
      author: 'Varios Autores',
      description: 'Antología literaria en formato flipbook interactivo.',
      pdfUrl: 'books/ecos-del-mas-alla.pdf',
      pageCount: 24,
      theme: 'obsidian',
      accent: '#d8aa54',
      spreadMode: 'auto',
      showCover: true,
      soundEnabled: true
    }];
    return this.books;
  }

  getBookBySlug(slug) {
    if (!slug) return this.books[0] || null;
    return this.books.find((b) => b.slug === slug || b.id === slug) || null;
  }

  getDefaultBook() {
    return this.getBookBySlug(this.site.defaultBook) || this.books[0] || null;
  }

  async getPdfSource(book) {
    if (!book || !book.pdfUrl) throw new Error('Libro no encontrado.');
    return {
      pdfInit: {
        url: book.pdfUrl,
        rangeChunkSize: 65536 * 4,
        disableAutoFetch: true
      }
    };
  }
}
