import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useApp } from '../store';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Input,
  Select,
  Spinner,
  cn,
  useToast,
} from '../components/ui';
import { AlertIcon, ChatIcon, RefreshIcon, ShieldIcon, TrashIcon, UsersIcon } from '../components/icons';
import { Markdown } from '../components/Markdown';
import { SourceList } from '../components/SourceList';
import { groupSourcesByMessage } from '../lib/sources';
import { formatDate, formatRelative } from '../lib/format';

/**
 * Administrator conversation review.
 *
 * A separate area from the normal chat: administrators can read (and delete)
 * their own chats, other users' chats and conversations started by external
 * widget visitors. There is intentionally no reply or impersonation action.
 */

const SCOPES = [
  { id: 'mine', label: 'My chats', icon: ChatIcon, hint: 'Your own internal conversations' },
  { id: 'users', label: 'Other users', icon: UsersIcon, hint: 'Internal conversations owned by somebody else' },
  { id: 'external', label: 'Widget visitors', icon: ShieldIcon, hint: 'Conversations from the public chat widget' },
  { id: 'all', label: 'All', icon: ChatIcon, hint: 'Every internal and widget conversation' },
];

function personFor(row) {
  if (row.channel === 'external') {
    return {
      name: row.visitor_name || 'Anonymous visitor',
      email: row.visitor_email || 'No email supplied',
      kind: 'External visitor',
    };
  }
  return {
    name: row.owner_name || (row.owner_email ? row.owner_email.split('@')[0] : 'Unknown user'),
    email: row.owner_email || 'Account removed',
    kind: 'Workspace user',
  };
}

function MessageBubble({ message, sources }) {
  const isUser = message.role === 'user';
  const failed = message.status === 'error' || message.status === 'aborted';
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div className={cn('max-w-[92%]', isUser ? 'text-right' : 'w-full')}>
        <div className="mb-1 flex items-center gap-2 text-[11px] text-slate-400">
          <span>{isUser ? 'Visitor/user' : 'Assistant'}</span>
          <span>{formatDate(message.created_at)}</span>
          {message.model && <span>· {message.model}</span>}
          {failed && <span className="text-red-500">· {message.status}</span>}
        </div>
        <div
          className={cn(
            'inline-block max-w-full rounded-2xl border px-4 py-3 text-left',
            isUser
              ? 'rounded-br-sm border-brand-600 bg-brand-600 text-sm text-white'
              : failed
                ? 'rounded-bl-sm border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40'
                : 'rounded-bl-sm border-slate-200 bg-white text-sm dark:border-slate-700 dark:bg-slate-900',
          )}
        >
          {isUser ? (
            <p className="whitespace-pre-wrap">{message.content}</p>
          ) : (
            <>
              {message.content ? <Markdown>{message.content}</Markdown> : <p className="text-slate-400">No content</p>}
              {message.error_message && failed && (
                <p className="mt-2 text-xs text-red-600 dark:text-red-300">{message.error_message}</p>
              )}
              {sources.length > 0 && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs font-medium text-slate-500 dark:text-slate-400">
                    {sources.length} source{sources.length === 1 ? '' : 's'}
                  </summary>
                  <div className="mt-2">
                    <SourceList sources={sources} />
                  </div>
                </details>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function AdminConversationsView() {
  const { projects } = useApp();
  const toast = useToast();

  const [scope, setScope] = useState('all');
  const [projectId, setProjectId] = useState('');
  const [userId, setUserId] = useState('');
  const [search, setSearch] = useState('');
  const [users, setUsers] = useState([]);

  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState({ mine: 0, users: 0, external: 0, all: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(null);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(
    async ({ silent = false } = {}) => {
      if (!silent) setLoading(true);
      try {
        const data = await api.adminConversationsList({
          scope,
          projectId: projectId || undefined,
          userId: userId || undefined,
          search: search.trim() || undefined,
          limit: 100,
        });
        setRows(data.conversations || []);
        setCounts(data.counts || { mine: 0, users: 0, external: 0, all: 0 });
        setError(null);
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
      }
    },
    [scope, projectId, userId, search],
  );

  useEffect(() => {
    api
      .adminListUsers()
      .then((data) => setUsers(data.users || []))
      .catch(() => setUsers([]));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => load(), 250);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return undefined;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    api
      .adminConversationGet(selectedId)
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch((err) => {
        if (!cancelled) setDetailError(err);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const sourcesByMessage = useMemo(
    () => groupSourcesByMessage(detail?.sources || []),
    [detail?.sources],
  );

  const selectedRow = useMemo(
    () => detail?.conversation || rows.find((row) => row.id === selectedId) || null,
    [detail?.conversation, rows, selectedId],
  );

  const remove = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.adminConversationDelete(deleteTarget.id);
      toast.success('Conversation deleted');
      if (selectedId === deleteTarget.id) setSelectedId(null);
      setDeleteTarget(null);
      await load({ silent: true });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-950">
        <div className="mx-auto flex max-w-7xl flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold">
              <ShieldIcon className="h-5 w-5 text-brand-600" /> Conversation review
            </h1>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Read-only access to internal and widget conversations. Administrators can delete a
              conversation but cannot reply as a user or visitor.
            </p>
          </div>
          <Button variant="outline" onClick={() => load()} disabled={loading}>
            <RefreshIcon className={cn('h-4 w-4', loading && 'animate-spin')} /> Refresh
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="mx-auto flex h-full max-w-7xl flex-col gap-3 p-3 lg:flex-row lg:p-4">
          <aside className="flex min-h-0 w-full shrink-0 flex-col rounded-lg border border-slate-200 bg-white lg:w-[380px] dark:border-slate-800 dark:bg-slate-900">
            <div className="border-b border-slate-200 p-2 dark:border-slate-800">
              <div className="grid grid-cols-2 gap-1">
                {SCOPES.map((item) => {
                  const Icon = item.icon;
                  const active = scope === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      title={item.hint}
                      onClick={() => {
                        setScope(item.id);
                        setSelectedId(null);
                      }}
                      className={cn(
                        'flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium',
                        active
                          ? 'bg-brand-50 text-brand-700 dark:bg-brand-950/50 dark:text-brand-200'
                          : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
                      )}
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{item.label}</span>
                      <span className="ml-auto tabular-nums text-[10px] opacity-70">
                        {counts[item.id] ?? 0}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="mt-2 space-y-1.5">
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search title, name or email"
                  className="h-8 text-xs"
                />
                <div className="grid grid-cols-2 gap-1.5">
                  <Select
                    value={projectId}
                    onChange={(e) => {
                      setProjectId(e.target.value);
                      setSelectedId(null);
                    }}
                    className="h-8 text-xs"
                    aria-label="Filter by project"
                  >
                    <option value="">All projects</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </Select>
                  <Select
                    value={userId}
                    onChange={(e) => {
                      setUserId(e.target.value);
                      setSelectedId(null);
                    }}
                    className="h-8 text-xs"
                    aria-label="Filter by user"
                  >
                    <option value="">All users</option>
                    {users.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.name || user.email}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {loading && !rows.length ? (
                <div className="flex items-center justify-center gap-2 p-8 text-sm text-slate-500">
                  <Spinner /> Loading conversations…
                </div>
              ) : error ? (
                <div className="m-3 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                  {error.message}
                </div>
              ) : rows.length === 0 ? (
                <p className="p-8 text-center text-sm text-slate-500">
                  No conversations match these filters.
                </p>
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {rows.map((row) => {
                    const person = personFor(row);
                    const active = row.id === selectedId;
                    return (
                      <li key={row.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedId(row.id)}
                          className={cn(
                            'w-full px-3 py-2.5 text-left',
                            active
                              ? 'bg-brand-50 dark:bg-brand-950/40'
                              : 'hover:bg-slate-50 dark:hover:bg-slate-800/60',
                          )}
                        >
                          <div className="flex items-start gap-2">
                            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[10px] font-semibold uppercase text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                              {person.name.slice(0, 1)}
                            </span>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium">
                                {row.title || 'Untitled conversation'}
                              </p>
                              <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">
                                {person.name} · {row.project_name}
                              </p>
                              <div className="mt-1 flex flex-wrap items-center gap-1">
                                <Badge tone={row.channel === 'external' ? 'amber' : 'slate'}>
                                  {row.channel === 'external' ? 'Widget' : 'Internal'}
                                </Badge>
                                <span className="text-[10px] text-slate-400">
                                  {row.message_count ?? 0} msg · {formatRelative(row.updated_at)}
                                </span>
                              </div>
                            </div>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </aside>

          <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            {!selectedId ? (
              <div className="flex h-full items-center justify-center p-6">
                <EmptyState
                  icon={<ChatIcon className="h-8 w-8 text-slate-400" />}
                  title="Choose a conversation"
                  description="Messages, citations and the identity supplied by the visitor are shown here. This view never sends a message."
                />
              </div>
            ) : detailLoading ? (
              <div className="flex flex-1 items-center justify-center gap-2 text-sm text-slate-500">
                <Spinner /> Loading conversation…
              </div>
            ) : detailError ? (
              <div className="m-4 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" /> {detailError.message}
              </div>
            ) : (
              <>
                <header className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
                  <div className="min-w-0">
                    <h2 className="truncate text-sm font-semibold">
                      {selectedRow?.title || 'Untitled conversation'}
                    </h2>
                    <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                      {selectedRow?.project_name || 'Project'}
                      {selectedRow?.channel === 'external'
                        ? ` · ${selectedRow.visitor_name || 'Visitor'} <${selectedRow.visitor_email || 'no email'}>`
                        : ` · ${selectedRow?.owner_name || ''} ${selectedRow?.owner_email || ''}`}
                    </p>
                    {selectedRow?.consent_accepted_at && (
                      <p className="mt-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                        Consent accepted {formatDate(selectedRow.consent_accepted_at)}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Badge tone={selectedRow?.channel === 'external' ? 'amber' : 'slate'}>
                      {selectedRow?.channel === 'external' ? 'External visitor' : 'Internal user'}
                    </Badge>
                    <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(selectedRow)}>
                      <TrashIcon className="h-3.5 w-3.5" /> Delete
                    </Button>
                  </div>
                </header>

                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
                  {!(detail?.messages || []).length ? (
                    <p className="py-8 text-center text-sm text-slate-500">
                      This conversation has no messages.
                    </p>
                  ) : (
                    detail.messages.map((message) => (
                      <MessageBubble
                        key={message.id}
                        message={message}
                        sources={sourcesByMessage.get(message.id) || []}
                      />
                    ))
                  )}
                </div>

                <div className="border-t border-slate-200 px-4 py-2 text-[11px] text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  Review only. Replies and impersonation are not available here.
                </div>
              </>
            )}
          </section>
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={remove}
        loading={deleting}
        title="Delete conversation"
        confirmLabel="Delete permanently"
        message={`Delete "${deleteTarget?.title || 'this conversation'}" and all of its messages? This cannot be undone.`}
      />
    </div>
  );
}
