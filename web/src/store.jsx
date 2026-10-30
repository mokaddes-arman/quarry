import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api, askStream } from './api';
import { useToast } from './components/ui';
import { normaliseSource } from './lib/sources';

/**
 * A single small store for cross-cutting UI state: which project is active,
 * which conversation is open, theme, and the cached system status. Views fetch
 * their own detailed data; this keeps the shared state minimal and avoids
 * prop-drilling through the shell.
 */

const AppContext = createContext(null);
// Chat messages and the live generation live in their own context: the stream
// updates on every token, and only the chat view needs to re-render for that.
const AskContext = createContext(null);

const THEME_KEY = 'rag.theme';
const PROJECT_KEY = 'rag.activeProjectId';

function prefersDark() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

function applyTheme(theme) {
  const dark = theme === 'dark' || (theme === 'system' && prefersDark());
  document.documentElement.classList.toggle('dark', dark);
}

/**
 * Drop the `/login` path (and its one-time token) once a session is active.
 * Without this the address bar keeps showing `/login` while the user works in
 * Chat, Documents and the other views, because view changes do not navigate.
 */
function clearLoginPath() {
  const match = window.location.pathname.match(/^(.*?)\/login\/?$/i);
  if (!match) return;
  const base = match[1] || '/';
  window.history.replaceState(null, '', `${base}${window.location.search}`);
}

export function AppProvider({ children }) {
  const [projects, setProjects] = useState([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState(null);

  const [activeProjectId, setActiveProjectIdState] = useState(
    () => localStorage.getItem(PROJECT_KEY) || null,
  );

  const [theme, setThemeState] = useState(() => localStorage.getItem(THEME_KEY) || 'system');
  const [view, setView] = useState('chat');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [systemStatus, setSystemStatus] = useState(null);

  const [conversations, setConversations] = useState([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [activeConversationId, setActiveConversationId] = useState(null);

  // Messages of the open conversation and the one in-flight generation live
  // here, not in ChatView. ChatView unmounts when you open Documents, Search or
  // Settings; keeping the stream in the provider means switching pages never
  // interrupts an answer and the text is still there when you come back.
  const [messages, setMessages] = useState([]);
  const [messageSources, setMessageSources] = useState([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState(null);
  const [ask, setAsk] = useState(null);

  const activeConversationIdRef = useRef(null);
  const askControllerRef = useRef(null);
  const askStreamingRef = useRef(null); // conversation id currently streaming
  const askSeqRef = useRef(0);
  const toast = useToast();

  // --- authentication ---------------------------------------------------------
  // `user` is null while signed out. Everything that fetches project data waits
  // for it, so a signed-out page never sends a burst of unauthenticated calls.
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState(null);
  const [authInfo, setAuthInfo] = useState({ setupRequired: false, emailConfigured: false });

  const refreshAuth = useCallback(async () => {
    try {
      const data = await api.authStatus();
      setUser(data.user || null);
      setAuthInfo({
        setupRequired: Boolean(data.setupRequired),
        emailConfigured: Boolean(data.emailConfigured),
      });
      setAuthError(null);
      return data;
    } catch (err) {
      setUser(null);
      setAuthError(err);
      return null;
    } finally {
      setAuthLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshAuth();
  }, [refreshAuth]);

  useEffect(() => {
    if (user) clearLoginPath();
  }, [user]);

  // Any API call that comes back 401 means the session expired or was revoked.
  useEffect(() => {
    const onUnauthorised = () => {
      setUser(null);
      setProjects([]);
      setSystemStatus(null);
      setConversations([]);
      setActiveConversationId(null);
      setMessages([]);
      setMessageSources([]);
      setAsk(null);
    };
    window.addEventListener('rag:unauthorized', onUnauthorised);
    return () => window.removeEventListener('rag:unauthorized', onUnauthorised);
  }, []);

  const finishLogin = useCallback((data) => {
    setUser(data.user);
    setAuthInfo((prev) => ({ ...prev, setupRequired: false }));
    setView('chat');
    return data.user;
  }, []);

  /** Consume a magic link. `password` is set when the user chose one. */
  const login = useCallback(
    async (token, password) => {
      const data = await api.verifyLogin(token, password);
      return finishLogin(data);
    },
    [finishLogin],
  );

  const loginWithPassword = useCallback(
    async ({ email, password }) => {
      const data = await api.loginWithPassword(email, password);
      return finishLogin(data);
    },
    [finishLogin],
  );

  const requestLoginLink = useCallback((email) => api.requestLoginLink(email), []);
  const requestPasswordReset = useCallback((email) => api.requestPasswordReset(email), []);

  const setupFirstAdmin = useCallback(async ({ email, name }) => {
    const data = await api.setupAdmin({ email, name });
    setAuthInfo((prev) => ({ ...prev, setupRequired: false }));
    return data;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* the local state is cleared regardless */
    }
    setUser(null);
    setView('chat');
    setProjects([]);
    setProjectsLoading(false);
    setSystemStatus(null);
    setConversations([]);
    setActiveConversationId(null);
    setMessages([]);
    setMessageSources([]);
    setAsk(null);
    localStorage.removeItem(PROJECT_KEY);
  }, []);

  // --- theme -----------------------------------------------------------------
  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return undefined;
    const handler = () => {
      if (theme === 'system') applyTheme('system');
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  const setTheme = useCallback((next) => {
    setThemeState(next);
    // Best-effort persistence server-side; the UI does not depend on it.
    api.updateSetting('ui_theme', next).catch(() => {});
  }, []);

  // --- projects --------------------------------------------------------------
  const refreshProjects = useCallback(async ({ includeArchived = false } = {}) => {
    setProjectsLoading(true);
    try {
      const data = await api.listProjects(includeArchived);
      const list = data.projects || [];
      setProjects(list);
      setProjectsError(null);
      return list;
    } catch (err) {
      setProjectsError(err);
      throw err;
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setProjects([]);
      setProjectsError(null);
      setProjectsLoading(false);
      return;
    }
    refreshProjects().catch(() => {});
  }, [authLoading, user, refreshProjects]);

  // Keep the active project valid as the list changes. Wait until the list has
  // actually loaded, otherwise a page reload would clear the persisted choice
  // (projects=[] on first render) and silently fall back to the first project.
  useEffect(() => {
    if (projectsLoading) return;
    if (!projects.length) {
      if (activeProjectId) {
        setActiveProjectIdState(null);
        localStorage.removeItem(PROJECT_KEY);
      }
      return;
    }
    if (!projects.some((p) => p.id === activeProjectId)) {
      const first = projects[0].id;
      setActiveProjectIdState(first);
      localStorage.setItem(PROJECT_KEY, first);
    }
  }, [projects, activeProjectId, projectsLoading]);

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) || null,
    [projects, activeProjectId],
  );

  const selectProject = useCallback((id, nextView = 'chat') => {
    setActiveProjectIdState(id || null);
    if (id) localStorage.setItem(PROJECT_KEY, id);
    else localStorage.removeItem(PROJECT_KEY);
    setActiveConversationId(null);
    setConversations([]);
    setView(nextView);
    setSidebarOpen(false);
  }, []);

  const createProject = useCallback(
    async (body) => {
      const data = await api.createProject(body);
      await refreshProjects();
      if (data?.project?.id) {
        // A brand-new project has no knowledge yet. Land on Documents so the
        // next step is obvious: upload or link something to ask questions about.
        selectProject(data.project.id, 'documents');
      }
      return data.project;
    },
    [refreshProjects, selectProject],
  );

  const updateProject = useCallback(
    async (id, patch) => {
      const data = await api.updateProject(id, patch);
      await refreshProjects();
      return data.project;
    },
    [refreshProjects],
  );

  const archiveProject = useCallback(
    async (id) => {
      await api.archiveProject(id);
      await refreshProjects();
    },
    [refreshProjects],
  );

  const removeProject = useCallback(
    async (id) => {
      await api.deleteProject(id);
      if (activeProjectId === id) selectProject(null);
      await refreshProjects();
    },
    [activeProjectId, refreshProjects, selectProject],
  );

  // --- conversations ---------------------------------------------------------
  const refreshConversations = useCallback(async () => {
    if (!activeProjectId) {
      setConversations([]);
      return [];
    }
    setConversationsLoading(true);
    try {
      const data = await api.projectConversations(activeProjectId, { limit: 200 });
      const list = data.conversations || [];
      setConversations(list);
      return list;
    } catch {
      return [];
    } finally {
      setConversationsLoading(false);
    }
  }, [activeProjectId]);

  // Keep a ref in sync so async loads can tell whether their conversation is
  // still the one on screen.
  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  const loadMessages = useCallback(async (id) => {
    if (!id) {
      setMessages([]);
      setMessageSources([]);
      setMessagesError(null);
      setMessagesLoading(false);
      return;
    }
    // While a generation is streaming into this conversation the live buffer in
    // `ask` is authoritative; reloading now would duplicate the exchange.
    if (askStreamingRef.current === id) return;
    setMessagesLoading(true);
    setMessagesError(null);
    try {
      const data = await api.conversationMessages(id);
      if (activeConversationIdRef.current !== id || askStreamingRef.current === id) return;
      setMessages(data.messages || []);
      setMessageSources(data.sources || []);
      setMessagesLoading(false);
    } catch (err) {
      if (activeConversationIdRef.current !== id || askStreamingRef.current === id) return;
      setMessagesError(err);
      setMessages([]);
      setMessageSources([]);
      setMessagesLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMessages(activeConversationId);
  }, [activeConversationId, loadMessages]);

  /** Stop the generation that is currently running, if any. */
  const stopAsk = useCallback(() => {
    askControllerRef.current?.abort();
  }, []);

  /**
   * Ask a question and stream the answer into `ask`.
   *
   * The request is owned by the provider rather than by ChatView, so opening
   * another page does not abort it. Only one generation runs at a time.
   */
  const askQuestion = useCallback(
    async ({ question, crossProject = false, allowUngrounded = false, llmConfigId = '' }) => {
      if (!activeProject) return;
      if (askControllerRef.current) return;

      let conversationId = activeConversationId;
      if (!conversationId) {
        try {
          const data = await api.createConversation(activeProject.id, {});
          conversationId = data.conversation.id;
          setActiveConversationId(conversationId);
          await refreshConversations();
        } catch (err) {
          toast.error(err.message);
          return;
        }
      }

      const seq = ++askSeqRef.current;
      const controller = new AbortController();
      askControllerRef.current = controller;
      askStreamingRef.current = conversationId;

      setAsk({
        id: seq,
        conversationId,
        projectId: activeProject.id,
        question,
        content: '',
        sources: [],
        stats: null,
        status: { stage: 'starting', message: 'Starting…' },
        streaming: true,
      });

      const patch = (update) =>
        setAsk((prev) => (prev && prev.id === seq ? { ...prev, ...update } : prev));

      try {
        await askStream(
          conversationId,
          {
            question,
            crossProject,
            allowUngroundedAnswer: allowUngrounded,
            llmConfigId: llmConfigId || undefined,
          },
          {
            signal: controller.signal,
            onEvent: (event) => {
              if (askSeqRef.current !== seq) return;
              switch (event.type) {
                case 'status':
                  patch({ status: { stage: event.stage, message: event.message } });
                  break;
                case 'retrieval':
                  patch({ stats: event.stats });
                  break;
                case 'sources':
                  patch({ sources: (event.sources || []).map(normaliseSource).filter(Boolean) });
                  break;
                case 'token':
                  setAsk((prev) =>
                    prev && prev.id === seq ? { ...prev, content: prev.content + event.text } : prev,
                  );
                  break;
                case 'error':
                  if (!controller.signal.aborted) {
                    toast.error(event.message || 'Generation failed');
                  }
                  break;
                default:
                  break;
              }
            },
          },
        );
      } catch (err) {
        if (!controller.signal.aborted) toast.error(err.message);
      } finally {
        askControllerRef.current = null;
        askStreamingRef.current = null;
        patch({ streaming: false });
        await Promise.allSettled([loadMessages(conversationId), refreshConversations()]);
        setAsk((prev) => (prev && prev.id === seq ? null : prev));
      }
    },
    [activeProject, activeConversationId, refreshConversations, loadMessages, toast],
  );

  useEffect(() => {
    setActiveConversationId(null);
    refreshConversations();
  }, [activeProjectId, refreshConversations]);

  // --- system status ---------------------------------------------------------
  const refreshSystemStatus = useCallback(async () => {
    try {
      const status = await api.systemStatus();
      setSystemStatus(status);
      return status;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!user) {
      setSystemStatus(null);
      return undefined;
    }
    refreshSystemStatus();
    const timer = window.setInterval(refreshSystemStatus, 20_000);
    return () => window.clearInterval(timer);
  }, [user, refreshSystemStatus]);

  const value = useMemo(
    () => ({
      // authentication
      user,
      authLoading,
      authError,
      authInfo,
      refreshAuth,
      login,
      loginWithPassword,
      logout,
      requestLoginLink,
      requestPasswordReset,
      setupFirstAdmin,
      isAdmin: user?.role === 'admin',
      projects,
      projectsLoading,
      projectsError,
      refreshProjects,
      activeProject,
      activeProjectId,
      selectProject,
      createProject,
      updateProject,
      archiveProject,
      removeProject,
      conversations,
      conversationsLoading,
      refreshConversations,
      activeConversationId,
      setActiveConversationId,
      theme,
      setTheme,
      view,
      setView,
      sidebarOpen,
      setSidebarOpen,
      systemStatus,
      refreshSystemStatus,
    }),
    [
      user,
      authLoading,
      authError,
      authInfo,
      refreshAuth,
      login,
      loginWithPassword,
      logout,
      requestLoginLink,
      requestPasswordReset,
      setupFirstAdmin,
      projects,
      projectsLoading,
      projectsError,
      refreshProjects,
      activeProject,
      activeProjectId,
      selectProject,
      createProject,
      updateProject,
      archiveProject,
      removeProject,
      conversations,
      conversationsLoading,
      refreshConversations,
      activeConversationId,
      theme,
      setTheme,
      view,
      sidebarOpen,
      systemStatus,
      refreshSystemStatus,
    ],
  );

  const askValue = useMemo(
    () => ({
      messages,
      messageSources,
      messagesLoading,
      messagesError,
      ask,
      askQuestion,
      stopAsk,
    }),
    [messages, messageSources, messagesLoading, messagesError, ask, askQuestion, stopAsk],
  );

  return (
    <AppContext.Provider value={value}>
      <AskContext.Provider value={askValue}>{children}</AskContext.Provider>
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}

export function useAsk() {
  const ctx = useContext(AskContext);
  if (!ctx) throw new Error('useAsk must be used inside <AppProvider>');
  return ctx;
}
