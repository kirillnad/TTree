import { refs } from './refs.js';
import { fetchUsers, deleteUser } from './api.js';
import { showToast } from './toast.js';
import { showPrompt } from './modal.js';

function hideAllPanels() {
  if (refs.articleListView) refs.articleListView.classList.add('hidden');
  if (refs.articleView) refs.articleView.classList.add('hidden');
  if (refs.graphView) refs.graphView.classList.add('hidden');
}

function showUsersPanel() {
  hideAllPanels();
  if (refs.usersView) refs.usersView.classList.remove('hidden');
}

function hideUsersPanel() {
  if (refs.usersView) refs.usersView.classList.add('hidden');
  if (refs.articleListView) refs.articleListView.classList.remove('hidden');
  if (refs.articleView) refs.articleView.classList.add('hidden');
}

async function loadUsers(adminPassword) {
  if (!refs.usersList) return;
  refs.usersList.textContent = '';
  try {
    const users = await fetchUsers(adminPassword);
    if (!users.length) {
      const li = document.createElement('li');
      li.textContent = 'Пользователей нет';
      refs.usersList.appendChild(li);
      return;
    }
    users.forEach((user) => {
      const li = document.createElement('li');
      li.className = 'users-list-item';
      const info = document.createElement('span');
      info.className = 'users-list-item__info';
      info.textContent = `${user.username}${
        user.displayName && user.displayName !== user.username ? ` (${user.displayName})` : ''
      }`;
      if (user.isSuperuser) {
        const badge = document.createElement('span');
        badge.className = 'users-list-item__badge';
        badge.textContent = 'superuser';
        info.appendChild(badge);
      }
      li.appendChild(info);

      if (!user.isSuperuser) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ghost small users-list-item__delete';
        btn.textContent = 'Удалить';
        btn.addEventListener('click', async () => {
          const confirmed = window.confirm(
            `Удалить пользователя "${user.username}" со всеми статьями и файлами?`,
          );
          if (!confirmed) return;
          try {
            await deleteUser(user.id);
            showToast('Пользователь удалён');
            await loadUsers();
          } catch (error) {
            showToast(error.message || 'Не удалось удалить пользователя');
          }
        });
        li.appendChild(btn);
      }
      refs.usersList.appendChild(li);
    });
  } catch (error) {
    const li = document.createElement('li');
    li.textContent = error.message || 'Ошибка загрузки пользователей';
    refs.usersList.appendChild(li);
  }
}

export async function openUsersPage(adminPassword) {
  showUsersPanel();
  await loadUsers(adminPassword);
}

export function initUsersPanel() {
  if (refs.openUsersViewBtn) {
    refs.openUsersViewBtn.addEventListener('click', async () => {
      let password = '';
      try {
        password = await showPrompt({
          title: 'Доступ к управлению пользователями',
          message: 'Введите пароль администратора.',
          confirmText: 'Открыть',
          cancelText: 'Отмена',
          placeholder: 'Пароль',
          inputType: 'password',
        });
      } catch (_) {
        password = '';
      }
      if (!password) return;
      openUsersPage(password);
    });
  }
  if (refs.usersBackBtn) {
    refs.usersBackBtn.addEventListener('click', () => {
      hideUsersPanel();
    });
  }
}
