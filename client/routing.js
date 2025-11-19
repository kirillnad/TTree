import { loadArticleView, loadListView } from './article.js';

export const routing = {
  list: '/',
  article: (id) => `/article/${id}`,
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
  const match = pathname.match(/^\/article\/([0-9a-fA-F-]+)/);
  if (match) {
    loadArticleView(match[1]);
    return;
  }
  loadListView();
}

export function initRouting() {
  window.addEventListener('popstate', () => route(window.location.pathname));
}
