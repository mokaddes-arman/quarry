import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useApp } from '../store';
import {
  Badge,
  Button,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  cn,
  statusTone,
  useToast,
} from '../components/ui';
import { AlertIcon, CopyIcon, MailIcon, PlusIcon, RefreshIcon, ShieldIcon, TrashIcon, UsersIcon } from '../components/icons';
import { formatDate, formatNumber, formatRelative } from '../lib/format';

/**
 * Administrator dashboard and user management.
 *
 * The admin creates accounts, which triggers a single-use sign-in link. When
 * SMTP is configured the link is emailed; otherwise it is shown once here so
 * it can be handed over by any other channel.
 */

const ROLE_LABEL = { admin: 'Administrator', user: 'User' };
const STATUS_TONE = { active: 'green', invited: 'amber', disabled: 'red' };

function StatCard({ label, value, hint }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{formatNumber(value ?? 0)}</p>
      {hint && <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">{hint}</p>}
    </div>
  );
}

function CopyButton({ value, label = 'Copy link' }) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success('Link copied to the clipboard.');
    } catch {
      window.prompt('Copy this sign-in link:', value);
    }
  };
  return (
    <Button size="sm" variant="outline" onClick={copy}>
      <CopyIcon className="h-3.5 w-3.5" /> {label}
    </Button>
  );
}

function InviteResult({ invite, email, onClose }) {
  if (!invite) return null;
  return (
    <div className="space-y-3">
      <p className="text-sm">
        One-time link for <span className="font-medium">{email}</span>.
      </p>
      {invite.emailSent ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
          The link was emailed to them. It expires {formatRelative(invite.expiresAt)}. You can also
          copy it below and share it directly.
        </p>
      ) : (
        <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Email is not configured or sending failed. Share this one-time link with the user
            yourself. It expires {formatRelative(invite.expiresAt)}.
          </span>
        </p>
      )}
      {invite.loginUrl && (
        <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-950/40">
          <p className="break-all rounded bg-white/80 p-2 font-mono text-[11px] dark:bg-slate-900/60">
            {invite.loginUrl}
          </p>
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Single use · only share it with this user.
            </p>
            <CopyButton value={invite.loginUrl} />
          </div>
        </div>
      )}
      <div className="flex justify-end">
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}

export function AdminView() {
  const { user: me } = useApp();
  const toast = useToast();

  const [overview, setOverview] = useState(null);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteForm, setInviteForm] = useState({ email: '', name: '', role: 'user' });
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState(null);
  const [inviteResult, setInviteResult] = useState(null);

  const [busyId, setBusyId] = useState(null);
  const [resendResult, setResendResult] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [reassignTo, setReassignTo] = useState('');
  const [deleting, setDeleting] = useState(false);

  const [projectTarget, setProjectTarget] = useState(null);
  const [projectRows, setProjectRows] = useState([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectBusyId, setProjectBusyId] = useState(null);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const [overviewData, userData] = await Promise.all([
        api.adminOverview(),
        // Always load the full list: the delete dialog must offer every
        // administrator, even while the table itself is filtered.
        api.adminListUsers(),
      ]);
      setOverview(overviewData.overview);
      setUsers(userData.users || []);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const counts = overview?.counts || {};
  const admins = useMemo(() => users.filter((u) => u.role === 'admin' && u.status !== 'disabled'), [users]);
  const visibleUsers = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return users.filter((u) => {
      if (statusFilter && u.status !== statusFilter) return false;
      if (!needle) return true;
      return (u.name || '').toLowerCase().includes(needle) || u.email.toLowerCase().includes(needle);
    });
  }, [users, search, statusFilter]);

  const submitInvite = async (event) => {
    event.preventDefault();
    if (!inviteForm.email.trim()) {
      setInviteError('Please enter an email address.');
      return;
    }
    setInviting(true);
    setInviteError(null);
    try {
      const data = await api.adminCreateUser({
        email: inviteForm.email.trim(),
        name: inviteForm.name.trim() || null,
        role: inviteForm.role,
      });
      setInviteResult({ invite: data.invite, email: data.user.email });
      setInviteForm({ email: '', name: '', role: 'user' });
      setInviteOpen(false);
      await load({ silent: true });
      toast.success(
        data.invite?.emailSent ? 'Invitation email sent.' : 'Account created. Share the sign-in link.',
      );
    } catch (err) {
      setInviteError(err.message);
    } finally {
      setInviting(false);
    }
  };

  const patchUser = async (target, patch) => {
    setBusyId(target.id);
    try {
      await api.adminUpdateUser(target.id, patch);
      await load({ silent: true });
      toast.success('User updated.');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const resend = async (target) => {
    setBusyId(target.id);
    try {
      const data = await api.adminResendInvite(target.id);
      setResendResult({
        title: 'Sign-in link',
        email: target.email,
        invite: {
          emailSent: data.emailSent,
          loginUrl: data.loginUrl,
          expiresAt: data.expiresAt,
        },
      });
      await load({ silent: true });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const sendPasswordReset = async (target) => {
    setBusyId(target.id);
    try {
      const data = await api.adminSendPasswordReset(target.id);
      setResendResult({
        title: 'Password reset link',
        email: target.email,
        invite: {
          emailSent: data.emailSent,
          loginUrl: data.loginUrl,
          expiresAt: data.expiresAt,
        },
      });
      await load({ silent: true });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const openProjects = async (target) => {
    setProjectTarget(target);
    setProjectsLoading(true);
    setProjectRows([]);
    try {
      const data = await api.adminUserProjects(target.id);
      setProjectRows(data.projects || []);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setProjectsLoading(false);
    }
  };

  const toggleProject = async (project, checked) => {
    if (!projectTarget) return;
    setProjectBusyId(project.id);
    try {
      const data = checked
        ? await api.adminAssignProjects(projectTarget.id, [project.id])
        : await api.adminUnassignProject(projectTarget.id, project.id);
      setProjectRows(data.projects || []);
      toast.success(checked ? 'Project access granted.' : 'Project access removed.');
      await load({ silent: true });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setProjectBusyId(null);
    }
  };

  const revoke = async (target) => {
    setBusyId(target.id);
    try {
      await api.adminRevokeSessions(target.id);
      toast.success(`Signed ${target.email} out of all sessions.`);
      await load({ silent: true });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const result = await api.adminDeleteUser(deleteTarget.id, reassignTo || undefined);
      toast.success(
        result.reassignedProjects
          ? `User deleted. ${result.reassignedProjects} project(s) reassigned.`
          : 'User deleted.',
      );
      setDeleteTarget(null);
      setReassignTo('');
      await load({ silent: true });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <ShieldIcon className="h-5 w-5 text-brand-600" /> Administration
            </h1>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Manage who can use this workspace. Each user sees the projects they own or that you
              assign to them.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => load()} disabled={loading}>
              <RefreshIcon className={cn('h-4 w-4', loading && 'animate-spin')} /> Refresh
            </Button>
            <Button onClick={() => setInviteOpen(true)}>
              <PlusIcon className="h-4 w-4" /> Invite user
            </Button>
          </div>
        </header>

        {overview?.mail && !overview.mail.configured && (
          <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            <MailIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">Email delivery is not configured</p>
              <p className="mt-0.5 text-xs">
                Invitations still work: the one-time link is displayed after you create a user so
                you can share it directly. Set <code className="font-mono">SMTP_HOST</code> and
                friends in <code className="font-mono">.env</code> to send links automatically.
              </p>
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {error.message}
          </div>
        )}

        <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <StatCard label="Users" value={counts.users_total} hint={`${counts.users_active ?? 0} active`} />
          <StatCard label="Pending invites" value={counts.users_invited} hint="Waiting to sign in" />
          <StatCard label="Administrators" value={counts.admins} hint="Full access" />
          <StatCard label="Disabled" value={counts.users_disabled} hint="Cannot sign in" />
          <StatCard label="Projects" value={counts.projects} />
          <StatCard label="Documents" value={counts.documents} />
          <StatCard label="Chunks" value={counts.chunks} hint="Embedded passages" />
          <StatCard label="Conversations" value={counts.conversations} hint={`${counts.active_jobs ?? 0} active jobs`} />
        </section>

        <section className="overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 p-3 dark:border-slate-800">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <UsersIcon className="h-4 w-4" /> Users
              <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
                {visibleUsers.length} shown
              </span>
            </h2>
            <div className="flex items-center gap-2">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name or email"
                className="h-8 w-48 text-xs"
              />
              <Select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="h-8 w-32 text-xs"
              >
                <option value="">All statuses</option>
                <option value="active">Active</option>
                <option value="invited">Invited</option>
                <option value="disabled">Disabled</option>
              </Select>
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-2 p-10 text-sm text-slate-500">
              <Spinner /> Loading users…
            </div>
          ) : visibleUsers.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-500">
              No users match this filter.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-left text-sm">
                <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-950/50 dark:text-slate-400">
                  <tr>
                    <th className="px-3 py-2 font-medium">User</th>
                    <th className="px-3 py-2 font-medium">Role</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Projects</th>
                    <th className="px-3 py-2 font-medium">Last sign-in</th>
                    <th className="px-3 py-2 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleUsers.map((u) => {
                    const isMe = u.id === me?.id;
                    const busy = busyId === u.id;
                    const lastAdmin = u.role === 'admin' && admins.length <= 1;
                    return (
                      <tr key={u.id} className="border-t border-slate-100 dark:border-slate-800">
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold uppercase text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                              {(u.name || u.email).slice(0, 1)}
                            </span>
                            <div className="min-w-0">
                              <p className="truncate font-medium">
                                {u.name || u.email.split('@')[0]}
                                {isMe && <span className="ml-1 text-[11px] font-normal text-slate-500">(you)</span>}
                              </p>
                              <p className="truncate text-xs text-slate-500 dark:text-slate-400">{u.email}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <Badge tone={u.role === 'admin' ? 'blue' : 'slate'}>{ROLE_LABEL[u.role] || u.role}</Badge>
                        </td>
                        <td className="px-3 py-2">
                          <Badge tone={STATUS_TONE[u.status] || statusTone(u.status)}>{u.status}</Badge>
                        </td>
                        <td className="px-3 py-2 tabular-nums text-slate-600 dark:text-slate-300">
                          {formatNumber(u.project_count ?? 0)}
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
                          <span title={u.last_login_at ? formatDate(u.last_login_at) : 'Never'}>
                            {u.last_login_at ? formatRelative(u.last_login_at) : 'Never'}
                          </span>
                          {u.last_seen_at && u.last_seen_at !== u.last_login_at && (
                            <span className="block text-[10px]">session active</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap items-center justify-end gap-1">
                            {u.status !== 'disabled' && (
                              <Button size="sm" variant="ghost" disabled={busy} onClick={() => resend(u)}>
                                <MailIcon className="h-3.5 w-3.5" /> Send link
                              </Button>
                            )}
                            {u.status !== 'disabled' && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                title="Send a link that lets this user choose a new password"
                                onClick={() => sendPasswordReset(u)}
                              >
                                Reset password
                              </Button>
                            )}
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => openProjects(u)}>
                              <UsersIcon className="h-3.5 w-3.5" /> Projects
                            </Button>
                            {u.status === 'disabled' ? (
                              <Button size="sm" variant="ghost" disabled={busy} onClick={() => patchUser(u, { status: 'active' })}>
                                Enable
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy || isMe}
                                title={isMe ? 'You cannot disable your own account' : undefined}
                                onClick={() => patchUser(u, { status: 'disabled' })}
                              >
                                Disable
                              </Button>
                            )}
                            {u.role === 'admin' ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy || lastAdmin}
                                title={lastAdmin ? 'The last administrator cannot be demoted' : undefined}
                                onClick={() => patchUser(u, { role: 'user' })}
                              >
                                Make user
                              </Button>
                            ) : (
                              <Button size="sm" variant="ghost" disabled={busy} onClick={() => patchUser(u, { role: 'admin' })}>
                                Make admin
                              </Button>
                            )}
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => revoke(u)} title="Sign out of all sessions">
                              Sign out
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy || isMe}
                              onClick={() => {
                                setDeleteTarget(u);
                                setReassignTo('');
                              }}
                              title={isMe ? 'You cannot delete your own account' : 'Delete user'}
                            >
                              <TrashIcon className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <p className="text-[11px] text-slate-500 dark:text-slate-500">
          Sign-in links are single use and expire after a short window. Sending a new link
          invalidates the previous one.
        </p>
      </div>

      {/* Invite modal */}
      <Modal
        open={inviteOpen}
        onClose={() => {
          setInviteOpen(false);
          setInviteError(null);
        }}
        title="Invite a user"
        footer={
          <>
            <Button variant="secondary" onClick={() => setInviteOpen(false)} disabled={inviting}>
              Cancel
            </Button>
            <Button onClick={submitInvite} loading={inviting}>
              Create account &amp; send link
            </Button>
          </>
        }
      >
        <form onSubmit={submitInvite} className="space-y-3">
          <Field label="Email address" required error={inviteError}>
            <Input
              type="email"
              autoFocus
              value={inviteForm.email}
              onChange={(e) => setInviteForm((f) => ({ ...f, email: e.target.value }))}
              placeholder="colleague@company.com"
            />
          </Field>
          <Field label="Full name">
            <Input
              value={inviteForm.name}
              onChange={(e) => setInviteForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Jane Doe"
            />
          </Field>
          <Field label="Role" hint="Administrators can manage users and system settings.">
            <Select
              value={inviteForm.role}
              onChange={(e) => setInviteForm((f) => ({ ...f, role: e.target.value }))}
            >
              <option value="user">User</option>
              <option value="admin">Administrator</option>
            </Select>
          </Field>
        </form>
      </Modal>

      {/* New invite / resent link result */}
      <Modal
        open={Boolean(inviteResult || resendResult)}
        onClose={() => {
          setInviteResult(null);
          setResendResult(null);
        }}
        title={inviteResult ? 'Account created' : resendResult?.title || 'Sign-in link'}
      >
        <InviteResult
          invite={(inviteResult || resendResult)?.invite}
          email={(inviteResult || resendResult)?.email}
          onClose={() => {
            setInviteResult(null);
            setResendResult(null);
          }}
        />
      </Modal>

      {/* Project assignment */}
      <Modal
        open={Boolean(projectTarget)}
        onClose={() => {
          setProjectTarget(null);
          setProjectRows([]);
        }}
        title="Project access"
        footer={
          <Button
            variant="secondary"
            onClick={() => {
              setProjectTarget(null);
              setProjectRows([]);
            }}
          >
            Done
          </Button>
        }
      >
        {projectTarget && (
          <div className="space-y-3">
            <p className="text-sm">
              Choose which projects <span className="font-medium">{projectTarget.email}</span> can
              open. Changes take effect immediately.
            </p>
            {projectsLoading ? (
              <div className="flex items-center gap-2 py-6 text-sm text-slate-500">
                <Spinner /> Loading projects…
              </div>
            ) : projectRows.length === 0 ? (
              <p className="rounded-md border border-slate-200 px-3 py-4 text-center text-xs text-slate-500 dark:border-slate-700">
                No projects exist yet. Create one first, then come back to assign it.
              </p>
            ) : (
              <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border border-slate-200 p-2 dark:border-slate-700">
                {projectRows.map((project) => {
                  const checked = Boolean(project.owned || project.assigned);
                  const busy = projectBusyId === project.id;
                  return (
                    <label
                      key={project.id}
                      className={cn(
                        'flex items-center gap-3 rounded-md px-2 py-2 text-sm',
                        checked ? 'bg-brand-50 dark:bg-brand-950/30' : 'hover:bg-slate-50 dark:hover:bg-slate-800/60',
                        project.owned ? 'cursor-default' : 'cursor-pointer',
                        busy && 'opacity-60',
                      )}
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                        checked={checked}
                        disabled={project.owned || busy}
                        onChange={(e) => toggleProject(project, e.target.checked)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{project.name}</span>
                        <span className="block text-[11px] text-slate-500 dark:text-slate-400">
                          {project.status}
                        </span>
                      </span>
                      {project.owned && <Badge tone="blue">Owner</Badge>}
                      {!project.owned && project.assigned && <Badge tone="green">Assigned</Badge>}
                    </label>
                  );
                })}
              </div>
            )}
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              An owner always keeps access. Assigned users can read documents and chat in the
              project, but only the owner can rename or delete it.
            </p>
          </div>
        )}
      </Modal>

      {/* Delete user */}
      <Modal
        open={Boolean(deleteTarget)}
        onClose={() => {
          setDeleteTarget(null);
          setReassignTo('');
        }}
        title="Delete user"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setDeleteTarget(null);
                setReassignTo('');
              }}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={remove}
              loading={deleting}
              disabled={Boolean(deleteTarget?.project_count) && !reassignTo}
            >
              {deleteTarget?.project_count > 0 ? 'Reassign projects & delete' : 'Delete user'}
            </Button>
          </>
        }
      >
        {deleteTarget && (
          <div className="space-y-3 text-sm">
            <p>
              <span className="font-medium">{deleteTarget.email}</span> will lose access immediately.
              This cannot be undone.
            </p>
            {deleteTarget.project_count > 0 && (
              <>
                <p className="text-xs text-slate-600 dark:text-slate-400">
                  This account owns {deleteTarget.project_count} project
                  {deleteTarget.project_count === 1 ? '' : 's'} with their documents and
                  conversations. Choose an administrator to take them over.
                </p>
                <Field label="Reassign projects to" required>
                  <Select value={reassignTo} onChange={(e) => setReassignTo(e.target.value)}>
                    <option value="">Select an administrator…</option>
                    {admins
                      .filter((a) => a.id !== deleteTarget.id)
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name || a.email}
                        </option>
                      ))}
                  </Select>
                </Field>
              </>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
