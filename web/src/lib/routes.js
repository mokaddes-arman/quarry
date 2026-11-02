/**
 * Small dependency-free URL router.
 *
 * Every page has a stable path so it can be bookmarked, refreshed and opened in
 * a second window. The active project travels in `?project=<id>`.
 */

export const VIEW_PATHS = {
  chat: '/chats',
  documents: '/documents',
  search: '/search',
  dashboard: '/dashboard',
  embed: '/embed',
  admin: '/admin',
  'admin-conversations': '/admin/conversations',
  'model-usage': '/model-usage',
  settings: '/settings',
};

// Views that do not depend on a project being selected.
export const GLOBAL_VIEWS = new Set([
  'admin',
  'admin-conversations',
  'model-usage',
  'settings',
]);

const PATH_VIEWS = Object.fromEntries(
  Object.entries(VIEW_PATHS).map(([view, path]) => [path, view]),
);

function canonicalPath(value) {
  const path = String(value || '/').replace(/\/+$/, '');
  return path || '/';
}

/**
 * Resolve the current URL.
 *
 * @returns {{ view: string|null, projectId: string|null, embedKey?: string, conversationId?: string, params: URLSearchParams }}
 */
export function readRoute(location = window.location) {
  const path = canonicalPath(location.pathname);
  const params = new URLSearchParams(location.search || '');

  // Public widget: rendered outside the authenticated shell.
  const embedMatch = path.match(/^\/embed\/([^/]+)$/);
  if (embedMatch) {
    return {
      view: 'public-embed',
      embedKey: decodeURIComponent(embedMatch[1]),
      projectId: null,
      conversationId: params.get('conversation'),
      params,
    };
  }

  const view = path === '/' || path === '' ? 'chat' : PATH_VIEWS[path] || null;
  return {
    view,
    projectId: params.get('project'),
    conversationId: params.get('conversation'),
    params,
  };
}

export function pathForView(view) {
  return VIEW_PATHS[view] || VIEW_PATHS.chat;
}

/** Build a path + query string for a view, preserving unrelated parameters. */
export function buildUrl(view, { projectId = null, conversationId = undefined, params } = {}) {
  const search = new URLSearchParams(params || window.location.search || '');
  search.delete('project');
  search.delete('conversation');
  if (projectId) search.set('project', projectId);
  if (conversationId) search.set('conversation', conversationId);
  const query = search.toString();
  return `${pathForView(view)}${query ? `?${query}` : ''}`;
}

export function isPublicEmbedPath(pathname = window.location.pathname) {
  return /^\/embed\/[^/]+$/.test(canonicalPath(pathname));
}
