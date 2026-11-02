import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, publicAskStream } from '../api';
import { Badge, Button, Field, Input, Spinner, Textarea, cn, useToast } from '../components/ui';
import { AlertIcon, ChatIcon, SendIcon, StopIcon } from '../components/icons';
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

function SourceBadgeList({ sources }) {
  if (!sources.length) return null;
  return (
    <details className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-950/40">
      <summary className="cursor-pointer font-medium text-slate-600 dark:text-slate-300">
        {sources.length} source{sources.length === 1 ? '' : 's'}
      </summary>
      <ul className="mt-1.5 space-y-1.5">
        {sources.map((source, index) => (
          <li key={source.id || `${source.documentTitle}-${index}`} className="text-[11px]">
            <p className="font-medium text-slate-700 dark:text-slate-200">
              [{source.rank ?? index + 1}] {source.documentTitle}
            </p>
            <p className="text-slate-500 dark:text-slate-400">{source.sourceLocation}</p>
            {source.excerpt && (
              <p className="mt-0.5 line-clamp-3 text-slate-500 dark:text-slate-400">{source.excerpt}</p>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

function BrandHeader({ config, embedKey, compact = false }) {
  const logo = logoSrcFor(config, embedKey);
  const brand = config.brandName || config.projectName || 'Chat with us';
  return (
    <header
      className={cn('flex items-center gap-2 px-3 text-white', compact ? 'py-2' : 'py-3')}
      style={{ backgroundColor: config.themeColor || '#2563eb' }}
    >
      {logo ? (
        <img src={logo} alt="" className="h-8 w-8 shrink-0 rounded bg-white/10 object-contain p-0.5" />
      ) : (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/20 text-sm font-bold">
          {brand.slice(0, 1).toUpperCase()}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{brand}</p>
        {config.slogan && <p className="truncate text-[11px] text-white/80">{config.slogan}</p>}
      </div>
    </header>
  );
}

function VisitorForm({ config, embedKey, onRegistered, notice }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(!config.consentRequired);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    if (!name.trim()) return setError('Please enter your name.');
    if (!email.trim()) return setError('Please enter your email address.');
    if (config.consentRequired && !consent) {
      return setError('Please accept the consent notice before continuing.');
    }
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
  };

  return (
    <div className="flex min-h-full flex-col bg-slate-50 dark:bg-slate-950">
      <BrandHeader config={config} embedKey={embedKey} />
      <div className="flex flex-1 items-center justify-center p-4">
        <form onSubmit={submit} className="w-full space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div>
            <h1 className="text-base font-semibold">{config.consentTitle || 'Before we start'}</h1>
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
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              <span>I agree to the consent notice and to my conversation being stored for review.</span>
            </label>
          )}

          {error && (
            <p className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
              <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
            </p>
          )}

          <Button type="submit" loading={busy} className="w-full">
            Start chat
          </Button>
          <p className="text-center text-[10px] text-slate-400">
            No account is created. Your name and email are shown only to the site's administrators.
          </p>
        </form>
      </div>
    </div>
  );
}

function MessageBubble({ message, sources }) {
  const isUser = message.role === 'user';
  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-blue-600 px-3 py-2 text-sm text-white">
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[94%] rounded-2xl rounded-bl-sm border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm dark:border-slate-700 dark:bg-slate-900">
        {message.content ? (
          <Markdown>{message.content}</Markdown>
        ) : (
          <span className="inline-flex items-center gap-2 text-xs text-slate-400">
            <Spinner className="h-3 w-3" /> Thinking…
          </span>
        )}
        <SourceBadgeList sources={sources} />
      </div>
    </div>
  );
}

function ChatPane({ config, embedKey, token, visitor, conversationId, initialMessages, initialSources, onConversation, onExpired }) {
  const toast = useToast();
  const [messages, setMessages] = useState(initialMessages || []);
  const [sources, setSources] = useState(initialSources || []);
  const [text, setText] = useState('');
  const [ask, setAsk] = useState(null);
  const [askError, setAskError] = useState(null);
  const [conversation, setConversation] = useState(conversationId || null);
  const bottomRef = useRef(null);
  const controllerRef = useRef(null);

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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, ask?.content, ask?.question]);

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

  const allMessages = messages;
  const empty = !allMessages.length && !ask;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-slate-50 dark:bg-slate-950">
      <BrandHeader config={config} embedKey={embedKey} compact />
      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-3 py-1.5 text-[11px] text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
        <span className="truncate">
          Chatting as <span className="font-medium text-slate-700 dark:text-slate-200">{visitor?.name || 'visitor'}</span>
        </span>
        <Badge tone="green">Private chat</Badge>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {empty && (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-center dark:border-slate-700 dark:bg-slate-900">
            <ChatIcon className="mx-auto h-7 w-7 text-slate-300 dark:text-slate-600" />
            <p className="mt-2 text-sm font-medium">
              {config.welcomeMessage || `Ask anything about ${config.projectName || 'this project'}.`}
            </p>
            <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
              Answers are grounded in documentation and include their sources.
            </p>
          </div>
        )}

        {allMessages.map((message) => (
          <MessageBubble
            key={message.id}
            message={message}
            sources={sourcesByMessage.get(message.id) || []}
          />
        ))}

        {ask && (
          <>
            <MessageBubble
              message={{ id: 'pending-user', role: 'user', content: ask.question }}
              sources={[]}
            />
            <MessageBubble
              message={{ id: 'live-assistant', role: 'assistant', content: ask.content }}
              sources={ask.sources}
            />
            {ask.streaming && !ask.content && (
              <p className="pl-1 text-[11px] text-slate-400">{ask.status}</p>
            )}
          </>
        )}

        {askError && (
          <p className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {askError}
          </p>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-slate-200 bg-white p-2 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-end gap-1.5">
          <Textarea
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Ask a question…"
            className="!resize-none text-sm"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          {ask?.streaming ? (
            <Button variant="danger" onClick={stop} aria-label="Stop answer">
              <StopIcon className="h-4 w-4" />
            </Button>
          ) : (
            <Button onClick={send} disabled={!text.trim()} aria-label="Send question">
              <SendIcon className="h-4 w-4" />
            </Button>
          )}
        </div>
        <p className="mt-1 text-center text-[10px] text-slate-400">
          Powered by Global Softel RAG · answers may be imperfect, check the sources.
        </p>
      </div>
    </div>
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

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-50 text-slate-500 dark:bg-slate-950">
        <div className="flex flex-col items-center gap-2">
          <Spinner className="h-5 w-5" />
          <p className="text-xs">Loading chat…</p>
        </div>
      </div>
    );
  }

  if (error || !config) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-50 p-5 text-center dark:bg-slate-950">
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
    />
  );
}
