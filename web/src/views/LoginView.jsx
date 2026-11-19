import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useApp } from '../store';
import { Button, Field, Input, cn } from '../components/ui';
import { AlertIcon, Spinner } from '../components/icons';
import { LogoMark, Wordmark } from '../components/Logo';

/**
 * Sign-in.
 *
 * Five situations share one screen:
 *   - first run, when no account exists yet, asks for the administrator email;
 *   - a magic link (`/login#token=...`) is inspected first; invitations and
 *     password resets ask the user to choose a password before it is consumed;
 *   - ordinary links sign the user in automatically;
 *   - email + password is the default form, for accounts that set one;
 *   - "forgot password" requests a reset link.
 *
 * The token lives in the URL fragment, which is never sent to the server, and
 * is removed from the address bar before any request is made.
 */

/**
 * Shared demo account so visitors can try the messaging without an invitation.
 * It is a regular (non-admin) user; its credentials are intentionally public.
 */
const DEMO_ACCOUNT = {
  email: 'mokaddes.arman.2111+testuser@gmail.com',
  password: 'Mokaddes@123',
};

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

function Notice({ children, tone = 'success' }) {
  const styles =
    tone === 'success'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200'
      : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200';
  return <div className={cn('rounded-md border px-3 py-2 text-xs', styles)}>{children}</div>;
}

function ErrorNote({ message }) {
  return (
    <p className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
      <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{message}</span>
    </p>
  );
}

export function LoginView() {
  const {
    login,
    loginWithPassword,
    requestLoginLink,
    requestPasswordReset,
    setupFirstAdmin,
    authInfo,
  } = useApp();

  const [mode, setMode] = useState(() => (tokenFromHash(window.location.hash) ? 'checking' : 'form'));
  const [formMode, setFormMode] = useState('password'); // password | link | forgot
  const [token, setToken] = useState(() => tokenFromHash(window.location.hash));
  const [linkInfo, setLinkInfo] = useState(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const started = useRef(false);

  const setupRequired = Boolean(authInfo.setupRequired);

  useEffect(() => {
    if (started.current) return;
    const initialToken = tokenFromHash(window.location.hash);
    if (!initialToken) {
      setMode('form');
      return;
    }
    started.current = true;
    setToken(initialToken);
    // Strip the token from history before doing anything else. Keeping the
    // current path (rather than hard-coding "/login") also works when the app
    // is mounted under a sub-path.
    window.history.replaceState(null, '', window.location.pathname);
    setMode('checking');

    api
      .loginLinkInfo(initialToken)
      .then(async (info) => {
        if (info.canSetPassword) {
          setLinkInfo(info);
          setEmail(info.email || '');
          setMode('set-password');
          return;
        }
        await login(initialToken);
        setMode('done');
      })
      .catch((err) => {
        setError(err.message);
        setMode('form');
      });
  }, [login]);

  const switchForm = (next) => {
    setFormMode(next);
    setError(null);
    setNotice(null);
  };

  const submitPassword = async (event) => {
    event.preventDefault();
    if (!email.trim() || !password) {
      setError('Please enter your email address and password.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await loginWithPassword({ email: email.trim(), password });
      setMode('done');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const signInAsDemo = async () => {
    setFormMode('password');
    setEmail(DEMO_ACCOUNT.email);
    setPassword(DEMO_ACCOUNT.password);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await loginWithPassword({ email: DEMO_ACCOUNT.email, password: DEMO_ACCOUNT.password });
      setMode('done');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const submitLink = async (event) => {
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

  const submitForgot = async (event) => {
    event.preventDefault();
    if (!email.trim()) {
      setError('Please enter the email address of your account.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const data = await requestPasswordReset(email.trim());
      setNotice(
        data?.emailConfigured
          ? 'If that address belongs to an account, a password reset link is on its way. Check your inbox and spam folder.'
          : 'If that address belongs to an account, a reset link was generated. Email is not configured on this server, so ask your administrator for the link.',
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const submitSetPassword = async (event) => {
    event.preventDefault();
    if (password.length < 8) {
      setError('Password must be at least 8 characters long.');
      return;
    }
    if (password !== confirmPassword) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await login(token, password);
      setMode('done');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const skipSetPassword = async () => {
    setBusy(true);
    setError(null);
    try {
      await login(token);
      setMode('done');
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
      const setupToken = tokenFromUrl(data?.loginUrl);
      if (setupToken) {
        // SMTP is not configured: sign the administrator in immediately instead
        // of leaving them stuck with a link they would have to copy by hand.
        await login(setupToken);
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
    <div className="flex min-h-screen items-center justify-center bg-limestone px-4 py-10 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-3">
          <LogoMark size={44} className="shrink-0" />
          <div>
            <h1 className="text-2xl leading-tight text-brand-950 dark:text-slate-50">
              <Wordmark />
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Answers from your documents, with the page they came from.
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          {mode === 'checking' || mode === 'verifying' ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <Spinner />
              <p className="text-sm font-medium">Checking your link…</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Verifying your one-time sign-in link.
              </p>
            </div>
          ) : mode === 'done' ? (
            <div className="py-6 text-center">
              <p className="text-sm font-medium">Signed in.</p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Loading your workspace…</p>
            </div>
          ) : mode === 'set-password' ? (
            <form onSubmit={submitSetPassword} className="space-y-4">
              <div>
                <h2 className="text-base font-semibold">
                  {linkInfo?.purpose === 'password_reset' ? 'Choose a new password' : 'Set a password'}
                </h2>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {linkInfo?.email ? (
                    <>
                      Signing in as <span className="font-medium">{linkInfo.email}</span>. Choose a
                      password so you can sign in without waiting for a link next time.
                    </>
                  ) : (
                    'Choose a password so you can sign in without waiting for a link next time.'
                  )}
                </p>
              </div>
              <Field label="New password" required hint="At least 8 characters.">
                <Input
                  type="password"
                  autoFocus
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                />
              </Field>
              <Field label="Confirm password" required>
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  disabled={busy}
                />
              </Field>
              {error && <ErrorNote message={error} />}
              <Button type="submit" className="w-full" loading={busy}>
                Set password &amp; sign in
              </Button>
              <button
                type="button"
                className="w-full text-center text-xs text-slate-500 hover:text-slate-700 disabled:opacity-50 dark:text-slate-400 dark:hover:text-slate-200"
                onClick={skipSetPassword}
                disabled={busy}
              >
                Skip for now and sign in with the link
              </button>
            </form>
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
          ) : formMode === 'forgot' ? (
            <form onSubmit={submitForgot} className="space-y-4">
              <div>
                <h2 className="text-base font-semibold">Forgot your password?</h2>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Enter your work email and we will send you a single-use link to choose a new
                  password.
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
              {notice && <Notice>{notice}</Notice>}
              <Button type="submit" className="w-full" loading={busy}>
                Send reset link
              </Button>
              <button
                type="button"
                className="w-full text-center text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                onClick={() => switchForm('password')}
              >
                Back to sign in
              </button>
            </form>
          ) : (
            <form
              onSubmit={formMode === 'link' ? submitLink : submitPassword}
              className="space-y-4"
            >
              <div>
                <h2 className="text-base font-semibold">Sign in</h2>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Use your password, or ask for a single-use sign-in link by email.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 text-xs dark:bg-slate-950/60">
                {[
                  ['password', 'Password'],
                  ['link', 'Email link'],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => switchForm(value)}
                    className={cn(
                      'rounded-md px-2 py-1.5 font-medium transition',
                      formMode === value
                        ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-slate-100'
                        : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200',
                    )}
                  >
                    {label}
                  </button>
                ))}
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

              {formMode === 'password' && (
                <Field label="Password" required>
                  <Input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={busy}
                  />
                </Field>
              )}

              {formMode === 'password' && (
                <div className="flex justify-end">
                  <button
                    type="button"
                    className="text-xs text-brand-600 hover:underline dark:text-brand-300"
                    onClick={() => switchForm('forgot')}
                  >
                    Forgot password?
                  </button>
                </div>
              )}

              {error && <ErrorNote message={error} />}
              {notice && <Notice>{notice}</Notice>}

              <Button type="submit" className="w-full" loading={busy}>
                {formMode === 'link' ? 'Email me a sign-in link' : 'Sign in'}
              </Button>
            </form>
          )}
        </div>

        {mode === 'form' && !setupRequired && (
          <div className="mt-4 rounded-xl border border-brand-200 bg-brand-50 p-4 text-xs text-brand-900 dark:border-brand-900 dark:bg-brand-950/40 dark:text-brand-100">
            <p className="font-semibold">Just want to try it? Use the demo account</p>
            <dl className="mt-2 space-y-1">
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-brand-700 dark:text-brand-300">Email:</dt>
                <dd className="break-all font-mono select-all">{DEMO_ACCOUNT.email}</dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-brand-700 dark:text-brand-300">Password:</dt>
                <dd className="font-mono select-all">{DEMO_ACCOUNT.password}</dd>
              </div>
            </dl>
            <Button
              type="button"
              variant="secondary"
              className="mt-3 w-full"
              onClick={signInAsDemo}
              disabled={busy}
            >
              Use demo account
            </Button>
          </div>
        )}

        <p className="mt-4 text-center text-[11px] text-slate-500 dark:text-slate-500">
          Accounts are created by an administrator. If you cannot sign in, ask them to send you a
          new link or a password reset.
        </p>
      </div>
    </div>
  );
}
