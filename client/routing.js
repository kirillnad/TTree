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
    loadArticleView(match[1]);
    return;
  }
  loadListView();
}

export function initRouting() {
  window.addEventListener('popstate', () => route(window.location.pathname));
}
