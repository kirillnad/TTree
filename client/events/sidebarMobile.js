// Вынесено из `TTree/client/events.js`:
// - открытие/закрытие мобильного сайдбара (кнопки, backdrop, auto-close по клику).
import { state } from '../state.js';
import { refs } from '../refs.js';
import { closeSidebarMobile, setSidebarMobileOpen, setSidebarCollapsed } from '../sidebar.js';

export function attachSidebarMobileHandlers() {
  if (refs.mobileSidebarBtn) {
    refs.mobileSidebarBtn.addEventListener('click', (event) => {
      event.preventDefault();
      setSidebarCollapsed(false);
      setSidebarMobileOpen(true);
    });
  }
  if (refs.listSidebarBtn) {
    refs.listSidebarBtn.addEventListener('click', (event) => {
      event.preventDefault();
      setSidebarCollapsed(false);
      setSidebarMobileOpen(true);
    });
  }
  if (refs.sidebarBackdrop) {
    refs.sidebarBackdrop.addEventListener('click', () => {
      closeSidebarMobile();
    });
  }
  if (refs.sidebar) {
    refs.sidebar.addEventListener(
      'click',
      (event) => {
        if (!state.isSidebarMobileOpen) return;
        const target = event.target;
        const btn = target.closest('button');
        if (!btn) return;
        // Не закрываем мобильный сайдбар при клике по статьям в дереве сайдбара:
        // там одиночный клик используется только для сворачивания/разворачивания узлов.
        if (btn.closest('.sidebar-article-item')) {
          return;
        }
        // Не закрываем мобильный сайдбар при клике по меню пользователя
        // и по самому попапу аккаунта.
        if (
          (refs.userMenuBtn && btn === refs.userMenuBtn) ||
          (refs.userMenu && refs.userMenu.contains(target))
        ) {
          return;
        }
        // Не закрываем мобильный сайдбар при клике по крестику очистки фильтра.
        if (refs.sidebarQuickFilterClear && btn === refs.sidebarQuickFilterClear) {
          return;
        }
        // Не закрываем мобильный сайдбар при переключении режима списка в сайдбаре.
        if (refs.sidebarRecentBtn && btn === refs.sidebarRecentBtn) {
          return;
        }
        // Не закрываем мобильный сайдбар при переключении режима поиска.
        if (refs.searchModeToggle && btn === refs.searchModeToggle) {
          return;
        }
        closeSidebarMobile();
      },
      true,
    );
  }
  document.addEventListener(
    'click',
    (event) => {
      const isDesktop = window.matchMedia('(min-width: 768px)').matches;
      if (isDesktop || !state.isSidebarMobileOpen) return;
      if (!refs.sidebar) return;
      const target = event.target;
      if (refs.sidebar.contains(target)) return;
      if (refs.mobileSidebarBtn && refs.mobileSidebarBtn.contains(target)) return;
      closeSidebarMobile();
    },
    true,
  );
}
