import { initRouting, route } from './routing.js';
import { attachEvents } from './events.js';
import { loadLastChangeFromChangelog } from './changelog.js';

/**
 * Инициализация приложения
 */
function init() {
  initRouting();
  attachEvents();
  loadLastChangeFromChangelog();
  route(window.location.pathname);
}

init();
