import { loadArticleView, loadListView, loadPublicArticleView } from './article.js';

export const routing = {
  list: '/',
  article: (id) => `/article/${id}`,
  public: (slug) => `/p/${slug}`,
};

export function navigate(path) {
  if (window.location.pathname === path) {
    route(path);
    return;
  }
  window.history.pushState({}, '', path);
  route(path);
}

export function route(pathname) {
  const publicMatch = pathname.match(/^\/p\/([^/?#]+)/);
  if (publicMatch) {
    loadPublicArticleView(decodeURIComponent(publicMatch[1]));
    return;
  }
  const match = pathname.match(/^\/article\/([0-9a-zA-Z-]+)/);
  if (match) {
    const rawId = String(match[1] || '');
    // Canonicalize inbox route: server expects `/article/inbox` and maps it to the current user's internal inbox ID.
    // Internal IDs like `inbox-<userId>` can be stale (e.g. after user id migration) and must not be routable.
    if (rawId.startsWith('inbox-')) {
      try {
        window.history.replaceState({}, '', routing.article('inbox'));
      } catch {
        // ignore
      }
      loadArticleView('inbox');
      return;
    }
    loadArticleView(rawId);
    return;
  }
  loadListView();
}

export function initRouting() {
  window.addEventListener('popstate', () => route(window.location.pathname));
}
