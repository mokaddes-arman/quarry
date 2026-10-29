import { useEffect, useRef, useState } from 'react';
import { useApp } from '../store';
import { Button, Field, Input } from '../components/ui';
import { AlertIcon, BookIcon, Spinner } from '../components/icons';

/**
 * Passwordless sign-in.
 *
 * Three modes share one screen:
 *   - first run, when no account exists yet, asks for the administrator email;
 *   - a magic link (`/login#token=...`) is verified automatically on load;
 *   - otherwise the user asks for a fresh sign-in link by email.
 *
 * The token lives in the URL fragment, which is never sent to the server, and
 * is removed from the address bar before the verify request is made.
 */

function tokenFromHash(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw) return null;
  return new URLSearchParams(raw).get('token');
}

function tokenFromUrl(url) {
  if (!url) return null;
  const idx = url.indexOf('#');
  return idx === -1 ? null : tokenFromHash(url.slice(idx));
}

export function LoginView() {
  const { login, requestLoginLink, setupFirstAdmin, authInfo } = useApp();

  const [mode, setMode] = useState(() => (tokenFromHash(window.location.hash) ? 'verifying' : 'form'));
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const started = useRef(false);

  const setupRequired = Boolean(authInfo.setupRequired);

  useEffect(() => {
    if (started.current) return;
    const token = tokenFromHash(window.location.hash);
    if (!token) {
      setMode('form');
      return;
    }
    started.current = true;
    // Strip the token from history before doing anything else. Keeping the
    // current path (rather than hard-coding "/login") also works when the app
    // is mounted under a sub-path.
    window.history.replaceState(null, '', window.location.pathname);
    setMode('verifying');
    login(token)
      .then(() => setMode('done'))
      .catch((err) => {
        setError(err.message);
        setMode('form');
      });
  }, [login]);

  const submitEmail = async (event) => {
    event.preventDefault();
    if (!email.trim()) {
      setError('Please enter your email address.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const data = await requestLoginLink(email.trim());
      setNotice(
        data?.emailConfigured
          ? 'If that address belongs to an account, a sign-in link is on its way. Check your inbox and spam folder.'
          : 'If that address belongs to an account, a link was generated. Email is not configured on this server, so ask your administrator for the link.',
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const submitSetup = async (event) => {
    event.preventDefault();
    if (!email.trim()) {
      setError('Please enter your email address.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const data = await setupFirstAdmin({ email: email.trim(), name: name.trim() || null });
      const token = tokenFromUrl(data?.loginUrl);
      if (token) {
        // SMTP is not configured: sign the administrator in immediately instead
        // of leaving them stuck with a link they would have to copy by hand.
        await login(token);
        setMode('done');
      } else {
        setNotice('Administrator created. Check your inbox for the sign-in link.');
        setMode('form');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-10 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-600 text-white">
            <BookIcon className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-lg font-semibold leading-tight">Global Softel RAG Chat</h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Private, project-scoped document assistant
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          {mode === 'verifying' ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <Spinner />
              <p className="text-sm font-medium">Signing you in…</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Verifying your one-time sign-in link.
              </p>
            </div>
          ) : mode === 'done' ? (
            <div className="py-6 text-center">
              <p className="text-sm font-medium">Signed in.</p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Loading your workspace…</p>
            </div>
          ) : setupRequired ? (
            <form onSubmit={submitSetup} className="space-y-4">
              <div>
                <h2 className="text-base font-semibold">Set up the first administrator</h2>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  No accounts exist yet. This address becomes the administrator and can invite
                  everyone else.
                </p>
              </div>
              <Field label="Full name">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Jane Doe"
                  autoComplete="name"
                />
              </Field>
              <Field label="Email address" required>
                <Input
                  type="email"
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  autoComplete="email"
                />
              </Field>
              {error && <ErrorNote message={error} />}
              <Button type="submit" className="w-full" loading={busy}>
                Create administrator
              </Button>
            </form>
          ) : (
            <form onSubmit={submitEmail} className="space-y-4">
              <div>
                <h2 className="text-base font-semibold">Sign in</h2>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Enter your work email and we will send you a single-use sign-in link. There is no
                  password to remember.
                </p>
              </div>
              <Field label="Email address" required>
                <Input
                  type="email"
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  autoComplete="email"
                  disabled={busy}
                />
              </Field>
              {error && <ErrorNote message={error} />}
              {notice && (
                <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
                  {notice}
                </div>
              )}
              <Button type="submit" className="w-full" loading={busy}>
                Email me a sign-in link
              </Button>
            </form>
          )}
        </div>

        <p className="mt-4 text-center text-[11px] text-slate-500 dark:text-slate-500">
          Accounts are created by an administrator. If you cannot sign in, ask them to send you a
          new link.
        </p>
      </div>
    </div>
  );
}

function ErrorNote({ message }) {
  return (
    <p className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
      <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{message}</span>
    </p>
  );
}
