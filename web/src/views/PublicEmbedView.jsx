import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, publicAskStream } from '../api';
import {
  Button,
  ConfirmDialog,
  Field,
  Input,
  Spinner,
  Textarea,
  useToast,
} from '../components/ui';
import { AlertIcon, SendIcon, StopIcon } from '../components/icons';
import { Markdown } from '../components/Markdown';
import { normaliseSource } from '../lib/sources';

/**
 * Public, unauthenticated widget surface.
 *
 * Rendered outside the application shell at /embed/:key (normally inside an
 * iframe injected by /embed.js). A visitor supplies name, email and consent
 * once; the returned token is stored in localStorage for this embed only.
 */

const TOKEN_PREFIX = 'rag.embed.visitor.';
const WELCOME_TEXT =
  'Welcome to CliqCRM! Answers are grounded in documentation and include their sources.';
const MAX_COMPOSER_HEIGHT = 96;

function tokenKey(embedKey) {
  return `${TOKEN_PREFIX}${embedKey}`;
}

function logoSrcFor(config, key) {
  if (!config) return '';
  if (config.logoSrc) return config.logoSrc;
  if (config.logoUrl) return config.logoUrl;
  if (config.hasLogo) return api.publicEmbedLogoUrl(key);
  return '';
}

/** Ask the host page to hide the floating window (when this page is framed). */
function requestClose() {
  if (typeof window === 'undefined') return;
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: 'gs-rag-widget:close' }, '*');
  }
}

const HEADER_BUTTON =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/85 transition hover:bg-white/15 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-transparent';

const ACTION_FOCUS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950';

function MoreIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="12" cy="19" r="1.7" />
    </svg>
  );
}

function MinimizeIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M5 12h14" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function WidgetFrame({ children }) {
  return (
    <div className="gs-rag-widget flex h-full min-h-0 flex-col overflow-hidden bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      {children}
    </div>
  );
}

function WidgetHeader({
  config,
  embedKey,
  visitor,
  sessionActive = false,
  onMinimize,
  onClose,
  onEndChat,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const logo = logoSrcFor(config, embedKey);
  const brand = config.brandName || config.projectName || '';

  useEffect(() => {
    if (!menuOpen) return undefined;
    const handlePointerDown = (event) => {
      if (!menuRef.current?.contains(event.target)) setMenuOpen(false);
    };
    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [menuOpen]);

  return (
    <header
      className="relative z-20 flex shrink-0 items-center gap-2 px-3 py-2 text-white"
      style={{ backgroundColor: config.themeColor || '#2563eb' }}
    >
      {logo ? (
        <img
          src={logo}
          alt=""
          className="h-9 w-9 shrink-0 rounded-full bg-white/15 object-contain p-0.5"
        />
      ) : (
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/20 text-sm font-bold">
          {brand.charAt(0).toUpperCase()}
        </span>
      )}

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold leading-tight">{brand}</p>
        <p className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] leading-tight text-white/80">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-300" aria-hidden="true" />
          <span className="shrink-0">Online</span>
          {visitor?.name && (
            <>
              <span className="shrink-0" aria-hidden="true">
                ·
              </span>
              <span className="truncate">{visitor.name}</span>
            </>
          )}
        </p>
      </div>

      {sessionActive && (
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((value) => !value)}
            className={HEADER_BUTTON}
            aria-label="Chat options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <MoreIcon />
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full z-30 mt-1 w-36 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 text-slate-700 shadow-xl dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onEndChat?.();
                }}
                className="block w-full px-3 py-2 text-left text-xs font-medium hover:bg-red-50 hover:text-red-700 focus:bg-red-50 focus:text-red-700 focus:outline-none dark:hover:bg-red-950/40 dark:hover:text-red-300 dark:focus:bg-red-950/40"
              >
                End chat
              </button>
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={onMinimize}
        className={HEADER_BUTTON}
        aria-label="Minimize chat"
      >
        <MinimizeIcon />
      </button>
      <button type="button" onClick={onClose} className={HEADER_BUTTON} aria-label="Close chat">
        <CloseIcon />
      </button>
    </header>
  );
}

function TypingIndicator() {
  return (
    <div className="flex justify-start" aria-live="polite">
      <div className="flex items-center gap-1 rounded-2xl rounded-bl-sm border border-slate-200 bg-white px-3 py-3 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <span className="sr-only">Assistant is typing…</span>
        {[0, 160, 320].map((delay) => (
          <span
            key={delay}
            className="gs-typing-dot h-1.5 w-1.5 rounded-full bg-slate-400 dark:bg-slate-500"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

function SourceBadgeList({ sources }) {
  if (!sources.length) return null;
  return (
    <details className="mt-2 max-h-44 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-950/40">
      <summary className="cursor-pointer font-medium text-slate-600 dark:text-slate-300">
        {sources.length} source{sources.length === 1 ? '' : 's'}
      </summary>
      <ul className="mt-1.5 space-y-2">
        {sources.map((source, index) => (
          <li key={source.id || `${source.documentTitle}-${index}`} className="min-w-0 text-[11px]">
            <p className="break-words font-medium text-slate-700 dark:text-slate-200">
              [{source.rank ?? index + 1}] {source.documentTitle}
            </p>
            <p className="break-words text-slate-500 dark:text-slate-400">{source.sourceLocation}</p>
            {source.excerpt && (
              <p className="mt-0.5 line-clamp-3 break-words text-slate-500 dark:text-slate-400">
                {source.excerpt}
              </p>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

function VisitorForm({ config, embedKey, onRegistered, notice }) {
  const toast = useToast();
  const nameRef = useRef(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(!config.consentRequired);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const emailIsValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const canSubmit = Boolean(
    name.trim() && emailIsValid && (!config.consentRequired || consent),
  );

  useEffect(() => {
    const handleMessage = (event) => {
      if (event.source !== window.parent) return;
      if (event.data?.type === 'gs-rag-widget:focus') nameRef.current?.focus();
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const submit = async (event) => {
    event.preventDefault();
    if (!name.trim()) return setError('Please enter your name.');
    if (!emailIsValid) return setError('Please enter a valid email address.');
    if (config.consentRequired && !consent) {
      return setError('Please accept the consent notice before continuing.');
    }
    if (!canSubmit) return undefined;

    setBusy(true);
    setError(null);
    try {
      const data = await api.publicRegisterVisitor(embedKey, {
        name: name.trim(),
        email: email.trim(),
        consent,
      });
      window.localStorage.setItem(tokenKey(embedKey), data.token);
      onRegistered(data);
    } catch (err) {
      setError(err.message);
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  return (
    <WidgetFrame>
      <WidgetHeader config={config} embedKey={embedKey} onMinimize={requestClose} onClose={requestClose} />

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <form
          onSubmit={submit}
          className="space-y-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900"
        >
          <div>
            <h1 className="text-base font-semibold">{config.consentTitle || 'Before we start'}</h1>
            {config.slogan && (
              <p className="mt-0.5 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                {config.slogan}
              </p>
            )}
            <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-slate-600 dark:text-slate-300">
              {config.consentBody}
            </p>
            {config.consentUrl && (
              <a
                href={config.consentUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-1 inline-block text-xs font-medium underline"
                style={{ color: config.themeColor || '#2563eb' }}
              >
                Read the privacy policy
              </a>
            )}
          </div>

          {notice && (
            <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              {notice}
            </p>
          )}

          <Field label="Your name" required>
            <Input
              ref={nameRef}
              autoFocus
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jane Doe"
              autoComplete="name"
            />
          </Field>
          <Field label="Email address" required hint="Used to let the team follow up if needed.">
            <Input
              type="email"
              value={email}
              maxLength={320}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jane@example.com"
              autoComplete="email"
            />
          </Field>
          {config.consentRequired && (
            <label className="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-300">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 dark:border-slate-600 dark:bg-slate-900"
              />
              <span>I agree to the consent notice and to my conversation being stored for review.</span>
            </label>
          )}

          {error && (
            <p className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
              <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
            </p>
          )}

          <Button
            type="submit"
            loading={busy}
            disabled={!canSubmit}
            className={`w-full ${ACTION_FOCUS}`}
          >
            Start chat
          </Button>
          <p className="text-center text-[10px] text-slate-400">
            No account is created. Your name and email are shown only to the site's administrators.
          </p>
        </form>
      </div>
    </WidgetFrame>
  );
}

function MessageBubble({ message, sources, accent }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div
          className="gs-rag-bubble max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm px-3 py-2 text-sm text-white shadow-sm"
          style={{ backgroundColor: accent }}
        >
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="gs-rag-bubble w-full max-w-[92%] min-w-0 rounded-2xl rounded-bl-sm border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm dark:border-slate-700 dark:bg-slate-900">
        {message.content ? <Markdown>{message.content}</Markdown> : null}
        <SourceBadgeList sources={sources} />
      </div>
    </div>
  );
}

function ChatPane({
  config,
  embedKey,
  token,
  visitor,
  conversationId,
  initialMessages,
  initialSources,
  onConversation,
  onExpired,
  onEndChat,
}) {
  const toast = useToast();
  const [messages, setMessages] = useState(initialMessages || []);
  const [sources, setSources] = useState(initialSources || []);
  const [text, setText] = useState('');
  const [ask, setAsk] = useState(null);
  const [askError, setAskError] = useState(null);
  const [conversation, setConversation] = useState(conversationId || null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const scrollRef = useRef(null);
  const composerRef = useRef(null);
  const controllerRef = useRef(null);

  const accent = config.themeColor || '#2563eb';

  const sourcesByMessage = useMemo(() => {
    const map = new Map();
    for (const raw of sources) {
      const source = normaliseSource(raw);
      if (!source?.id) continue;
      const messageId = raw.messageId || raw.message_id;
      if (!messageId) continue;
      if (!map.has(messageId)) map.set(messageId, []);
      map.get(messageId).push(source);
    }
    for (const list of map.values()) list.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    return map;
  }, [sources]);

  const welcomeMessage = useMemo(() => {
    const configured = (config.welcomeMessage || '').trim();
    const content =
      !configured || configured === WELCOME_TEXT
        ? WELCOME_TEXT
        : `${WELCOME_TEXT}\n\n${configured}`;
    return { id: 'gs-welcome-message', role: 'assistant', content };
  }, [config.welcomeMessage]);

  const allMessages = useMemo(() => [welcomeMessage, ...messages], [welcomeMessage, messages]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
  }, [allMessages.length, ask?.content, ask?.question, askError]);

  useLayoutEffect(() => {
    const element = composerRef.current;
    if (!element) return;
    element.style.height = 'auto';
    const next = Math.min(element.scrollHeight, MAX_COMPOSER_HEIGHT);
    element.style.height = `${next}px`;
    element.style.overflowY = element.scrollHeight > MAX_COMPOSER_HEIGHT ? 'auto' : 'hidden';
  }, [text]);

  useEffect(() => {
    const timeout = window.setTimeout(() => composerRef.current?.focus(), 60);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    const handleMessage = (event) => {
      if (event.source !== window.parent) return;
      if (event.data?.type === 'gs-rag-widget:focus') composerRef.current?.focus();
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      if (confirmEnd) {
        setConfirmEnd(false);
        return;
      }
      requestClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [confirmEnd]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const reload = useCallback(
    async (id) => {
      if (!id) return;
      try {
        const data = await api.publicConversationMessages(embedKey, id, token);
        setMessages(data.messages || []);
        setSources(data.sources || []);
      } catch (err) {
        if (err.status === 401) onExpired?.();
        else toast.error(err.message);
      }
    },
    [embedKey, token, onExpired, toast],
  );

  const stop = () => controllerRef.current?.abort();

  const send = async () => {
    const question = text.trim();
    if (!question || ask?.streaming) return;
    setAskError(null);
    let cid = conversation;
    try {
      if (!cid) {
        const data = await api.publicCreateExternalConversation(embedKey, token);
        cid = data.conversation.id;
        setConversation(cid);
        onConversation?.(data.conversation);
      }
    } catch (err) {
      if (err.status === 401) onExpired?.();
      else toast.error(err.message);
      return;
    }

    setText('');
    const controller = new AbortController();
    controllerRef.current = controller;
    setAsk({
      question,
      content: '',
      sources: [],
      status: 'Starting…',
      streaming: true,
    });

    try {
      await publicAskStream(
        embedKey,
        cid,
        token,
        { question },
        {
          signal: controller.signal,
          onUnauthorised: onExpired,
          onEvent: (event) => {
            switch (event.type) {
              case 'status':
                setAsk((prev) => (prev ? { ...prev, status: event.message || event.stage } : prev));
                break;
              case 'sources':
                setAsk((prev) =>
                  prev
                    ? { ...prev, sources: (event.sources || []).map(normaliseSource).filter(Boolean) }
                    : prev,
                );
                break;
              case 'token':
                setAsk((prev) =>
                  prev ? { ...prev, content: prev.content + event.text } : prev,
                );
                break;
              case 'error':
                setAskError(event.message || 'The answer could not be generated.');
                break;
              default:
                break;
            }
          },
        },
      );
    } catch (err) {
      if (!controller.signal.aborted) setAskError(err.message);
    } finally {
      controllerRef.current = null;
      setAsk(null);
      await reload(cid);
    }
  };

  const endChat = () => {
    controllerRef.current?.abort();
    setConfirmEnd(false);
    onEndChat?.();
  };

  return (
    <WidgetFrame>
      <WidgetHeader
        config={config}
        embedKey={embedKey}
        visitor={visitor}
        sessionActive
        onMinimize={requestClose}
        onClose={requestClose}
        onEndChat={() => setConfirmEnd(true)}
      />

      <div
        ref={scrollRef}
        className="gs-rag-messages min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3"
      >
        {allMessages.map((message) => (
          <MessageBubble
            key={message.id}
            message={message}
            sources={sourcesByMessage.get(message.id) || []}
            accent={accent}
          />
        ))}

        {ask && (
          <>
            <MessageBubble
              message={{ id: 'pending-user', role: 'user', content: ask.question }}
              sources={[]}
              accent={accent}
            />
            {ask.content ? (
              <MessageBubble
                message={{ id: 'live-assistant', role: 'assistant', content: ask.content }}
                sources={ask.sources}
                accent={accent}
              />
            ) : (
              <TypingIndicator />
            )}
          </>
        )}

        {askError && (
          <p className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {askError}
          </p>
        )}
      </div>

      <div className="shrink-0 border-t border-slate-200 bg-white p-2 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-end gap-1.5">
          <Textarea
            ref={composerRef}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Ask a question…"
            aria-label="Message"
            className="!min-h-0 flex-1 !resize-none !py-2 text-sm"
            style={{ maxHeight: MAX_COMPOSER_HEIGHT }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          {ask?.streaming && (
            <Button
              variant="outline"
              onClick={stop}
              aria-label="Stop answer"
              className={`!h-9 !w-9 shrink-0 !rounded-full !p-0 ${ACTION_FOCUS}`}
            >
              <StopIcon className="h-4 w-4" />
            </Button>
          )}
          <Button
            onClick={send}
            disabled={!text.trim() || ask?.streaming}
            aria-label="Send question"
            className={`!h-9 !w-9 shrink-0 !rounded-full !p-0 ${ACTION_FOCUS}`}
          >
            <SendIcon className="h-4 w-4" />
          </Button>
        </div>
        <p className="mt-1 text-center text-[10px] text-slate-400">
          Powered by Global Softel RAG · answers may be imperfect, check the sources.
        </p>
      </div>

      <ConfirmDialog
        open={confirmEnd}
        onClose={() => setConfirmEnd(false)}
        onConfirm={endChat}
        title="End chat"
        confirmLabel="End chat"
        message="End this chat and clear the conversation? You will be asked for your details again before starting a new chat."
      />
    </WidgetFrame>
  );
}

export function PublicEmbedView({ embedKey }) {
  const [config, setConfig] = useState(null);
  const [token, setToken] = useState(null);
  const [visitor, setVisitor] = useState(null);
  const [conversation, setConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      setLoading(true);
      setError(null);
      try {
        const data = await api.publicEmbedConfig(embedKey);
        if (cancelled) return;
        setConfig(data.embed);
        setToken(null);
        setVisitor(null);
        setConversation(null);
        setMessages([]);
        setSources([]);

        const stored = window.localStorage.getItem(tokenKey(embedKey));
        if (!stored) return;
        try {
          const session = await api.publicEmbedSession(embedKey, stored);
          if (cancelled) return;
          setToken(stored);
          setVisitor(session.visitor || null);
          setConversation(session.conversation || null);
          setMessages(session.messages || []);
          setSources(session.sources || []);
        } catch (err) {
          if (cancelled) return;
          if (err.status === 401) {
            window.localStorage.removeItem(tokenKey(embedKey));
            setNotice('Your previous session expired. Please enter your details again.');
          } else {
            throw err;
          }
        }
      } catch (err) {
        if (!cancelled) setError(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    boot();
    return () => {
      cancelled = true;
    };
  }, [embedKey, reloadToken]);

  const registered = (data) => {
    setToken(data.token);
    setVisitor(data.visitor || null);
    setConversation(data.conversation || null);
    setMessages([]);
    setSources([]);
    setNotice('');
  };

  const expired = useCallback(() => {
    window.localStorage.removeItem(tokenKey(embedKey));
    setToken(null);
    setVisitor(null);
    setConversation(null);
    setMessages([]);
    setSources([]);
    setNotice('Your session expired. Please enter your details again.');
    setReloadToken((value) => value + 1);
  }, [embedKey]);

  const endChat = useCallback(() => {
    window.localStorage.removeItem(tokenKey(embedKey));
    setToken(null);
    setVisitor(null);
    setConversation(null);
    setMessages([]);
    setSources([]);
    setNotice('');
  }, [embedKey]);

  if (loading) {
    return (
      <div className="gs-rag-widget flex h-full items-center justify-center bg-slate-50 text-slate-500 dark:bg-slate-900 dark:text-slate-400">
        <div className="flex flex-col items-center gap-2">
          <Spinner className="h-5 w-5" />
          <p className="text-xs">Loading chat…</p>
        </div>
      </div>
    );
  }

  if (error || !config) {
    return (
      <div className="gs-rag-widget flex h-full items-center justify-center bg-slate-50 p-5 text-center dark:bg-slate-900">
        <div>
          <AlertIcon className="mx-auto h-8 w-8 text-amber-500" />
          <h1 className="mt-2 text-sm font-semibold">Chat unavailable</h1>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {error?.message || 'This chat widget is not configured.'}
          </p>
          <p className="mt-3 text-[10px] text-slate-400">
            You can close this window and try again later.
          </p>
        </div>
      </div>
    );
  }

  if (!token || !visitor) {
    return (
      <VisitorForm
        config={config}
        embedKey={embedKey}
        onRegistered={registered}
        notice={notice}
      />
    );
  }

  return (
    <ChatPane
      config={config}
      embedKey={embedKey}
      token={token}
      visitor={visitor}
      conversationId={conversation?.id || null}
      initialMessages={messages}
      initialSources={sources}
      onConversation={setConversation}
      onExpired={expired}
      onEndChat={endChat}
    />
  );
}
