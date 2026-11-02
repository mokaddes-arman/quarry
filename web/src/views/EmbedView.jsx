import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useApp } from '../store';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  Spinner,
  Textarea,
  cn,
  useToast,
} from '../components/ui';
import {
  AlertIcon,
  CopyIcon,
  GlobeIcon,
  RefreshIcon,
  TrashIcon,
  UploadIcon,
  UsersIcon,
} from '../components/icons';

/**
 * Per-project public chat widget settings.
 *
 * The generated <script> tag injects a floating launcher on another website.
 * The visitor identifies themselves before chatting; only the embed key is
 * public. Owners (and administrators) can change branding, consent, allowed
 * origins and rotate the key here.
 */

function emptyForm(projectId) {
  return {
    projectId,
    enabled: true,
    brandName: '',
    slogan: '',
    logoUrl: '',
    themeColor: '#2563eb',
    welcomeMessage: '',
    allowedOrigins: '',
    consentRequired: true,
    consentTitle: 'Before we start',
    consentBody:
      'This assistant answers questions from the project documentation. Your conversation and the name and email you provide are stored so an administrator can review and improve the service.',
    consentUrl: '',
    publicKey: '',
    scriptTag: '',
    widgetUrl: '',
    hasLogo: false,
  };
}

function formFromEmbed(embed) {
  return {
    projectId: embed.projectId,
    enabled: embed.enabled,
    brandName: embed.brandName || '',
    slogan: embed.slogan || '',
    logoUrl: embed.logoUrl || '',
    themeColor: embed.themeColor || '#2563eb',
    welcomeMessage: embed.welcomeMessage || '',
    allowedOrigins: (embed.allowedOrigins || []).join('\n'),
    consentRequired: embed.consentRequired,
    consentTitle: embed.consentTitle || '',
    consentBody: embed.consentBody || '',
    consentUrl: embed.consentUrl || '',
    publicKey: embed.publicKey || '',
    scriptTag: embed.scriptTag || '',
    widgetUrl: embed.widgetUrl || '',
    hasLogo: Boolean(embed.hasLogo),
  };
}

function payloadFor(form) {
  return {
    enabled: form.enabled,
    brandName: form.brandName.trim() || null,
    slogan: form.slogan.trim() || null,
    logoUrl: form.logoUrl.trim() || null,
    themeColor: form.themeColor,
    welcomeMessage: form.welcomeMessage.trim() || null,
    allowedOrigins: form.allowedOrigins
      .split(/[\n,]+/)
      .map((value) => value.trim())
      .filter(Boolean),
    consentRequired: form.consentRequired,
    consentTitle: form.consentTitle.trim(),
    consentBody: form.consentBody.trim(),
    consentUrl: form.consentUrl.trim() || null,
  };
}

async function copyValue(value, toast) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success('Copied to the clipboard.');
  } catch {
    window.prompt('Copy this value:', value);
  }
}

export function EmbedView() {
  const { activeProject, isAdmin, setView } = useApp();
  const toast = useToast();
  const fileRef = useRef(null);

  const [form, setForm] = useState(() => emptyForm(activeProject?.id || null));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [confirmRemoveLogo, setConfirmRemoveLogo] = useState(false);

  const load = useCallback(async () => {
    if (!activeProject) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api.getProjectEmbed(activeProject.id);
      setForm(formFromEmbed(data.embed));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [activeProject]);

  useEffect(() => {
    load();
  }, [load]);

  const logoSrc = useMemo(() => {
    if (form.logoUrl) return form.logoUrl;
    if (form.hasLogo && form.publicKey) return api.publicEmbedLogoUrl(form.publicKey);
    return '';
  }, [form.logoUrl, form.hasLogo, form.publicKey]);

  const update = (patch) => setForm((prev) => ({ ...prev, ...patch }));

  const save = async () => {
    if (!activeProject) return;
    setSaving(true);
    try {
      const data = await api.updateProjectEmbed(activeProject.id, payloadFor(form));
      setForm(formFromEmbed(data.embed));
      toast.success('Widget settings saved.');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const uploadLogo = async (file) => {
    if (!activeProject || !file) return;
    setUploading(true);
    try {
      const data = await api.uploadProjectEmbedLogo(activeProject.id, file);
      setForm(formFromEmbed(data.embed));
      toast.success('Logo uploaded.');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const removeLogo = async () => {
    if (!activeProject) return;
    try {
      // Save any other pending edits is deliberately not implicit: removing the
      // logo only touches the logo fields, then the form is refreshed.
      const data = await api.deleteProjectEmbedLogo(activeProject.id);
      setForm((prev) => ({
        ...prev,
        hasLogo: false,
        logoUrl: '',
        publicKey: data.embed?.publicKey || prev.publicKey,
        scriptTag: data.embed?.scriptTag || prev.scriptTag,
      }));
      toast.success('Logo removed.');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setConfirmRemoveLogo(false);
    }
  };

  const rotate = async () => {
    if (!activeProject) return;
    setRotating(true);
    try {
      const data = await api.rotateProjectEmbedKey(activeProject.id);
      setForm((prev) => ({
        ...prev,
        publicKey: data.embed.publicKey,
        scriptTag: data.embed.scriptTag,
        widgetUrl: data.embed.widgetUrl,
      }));
      toast.success('Embed key rotated. Update the script on every website.');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setRotating(false);
      setConfirmRotate(false);
    }
  };

  if (!activeProject) {
    return (
      <EmptyState
        icon={<GlobeIcon className="h-8 w-8 text-slate-400" />}
        title="No project selected"
        description="Select a project to configure its public chat widget."
      />
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-slate-500">
        <Spinner /> Loading widget settings…
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">Could not open the widget settings</p>
            <p className="mt-1 text-xs">{error.message}</p>
            <p className="mt-2 text-xs">
              Only the project owner and administrators can configure the public widget.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <GlobeIcon className="h-5 w-5 text-blue-600" /> Public chat widget
            </h1>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Embed a floating chat on another website. Visitors do not need an account here, but
              they must identify themselves before the first question.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isAdmin && (
              <Button variant="outline" onClick={() => setView('admin-conversations')}>
                <UsersIcon className="h-4 w-4" /> Visitor conversations
              </Button>
            )}
            <Badge tone={form.enabled ? 'green' : 'slate'}>
              {form.enabled ? 'Widget live' : 'Widget paused'}
            </Badge>
          </div>
        </header>

        <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">Availability</h2>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                Pausing keeps the configuration and history but makes <code>/embed</code> and the
                public API unavailable.
              </p>
            </div>
            <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                checked={form.enabled}
                onChange={(e) => update({ enabled: e.target.checked })}
              />
              Enable widget
            </label>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="text-sm font-semibold">Branding</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Brand name" hint="Shown in the widget header.">
                <Input
                  value={form.brandName}
                  maxLength={120}
                  onChange={(e) => update({ brandName: e.target.value })}
                  placeholder={activeProject.name}
                />
              </Field>
              <Field label="Theme colour" hint="Six-digit hex, e.g. #2563eb.">
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={form.themeColor}
                    onChange={(e) => update({ themeColor: e.target.value })}
                    className="h-9 w-12 cursor-pointer rounded border border-slate-300 bg-white p-0.5 dark:border-slate-600 dark:bg-slate-900"
                    aria-label="Theme colour picker"
                  />
                  <Input
                    value={form.themeColor}
                    maxLength={7}
                    onChange={(e) => update({ themeColor: e.target.value })}
                    className="font-mono text-xs"
                  />
                </div>
              </Field>
            </div>
            <Field label="Slogan" hint="One short line under the brand name.">
              <Input
                value={form.slogan}
                maxLength={300}
                onChange={(e) => update({ slogan: e.target.value })}
                placeholder="Answers from our documentation, with citations."
              />
            </Field>
            <Field label="Welcome message" hint="Shown on the empty chat screen.">
              <Textarea
                rows={3}
                value={form.welcomeMessage}
                maxLength={1000}
                onChange={(e) => update({ welcomeMessage: e.target.value })}
                placeholder="Ask anything about our product. Every answer links back to the source."
              />
            </Field>
          </div>

          <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="text-sm font-semibold">Logo</h2>
            <div className="flex h-24 items-center justify-center rounded-md border border-dashed border-slate-300 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-950/40">
              {logoSrc ? (
                <img
                  src={logoSrc}
                  alt="Widget logo"
                  className="max-h-16 max-w-full object-contain"
                  onError={() => update({ logoUrl: '' })}
                />
              ) : (
                <span className="text-xs text-slate-400">No logo yet</span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={(e) => uploadLogo(e.target.files?.[0])}
              />
              <Button
                variant="outline"
                size="sm"
                loading={uploading}
                onClick={() => fileRef.current?.click()}
              >
                <UploadIcon className="h-3.5 w-3.5" /> Upload image
              </Button>
              {(form.hasLogo || form.logoUrl) && (
                <Button variant="ghost" size="sm" onClick={() => setConfirmRemoveLogo(true)}>
                  <TrashIcon className="h-3.5 w-3.5" /> Remove
                </Button>
              )}
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              PNG, JPEG, WEBP or GIF up to 2 MB. Uploading replaces the current file.
            </p>
            <Field label="Or use an image URL" hint="An uploaded logo takes priority.">
              <Input
                value={form.logoUrl}
                maxLength={2000}
                onChange={(e) => update({ logoUrl: e.target.value })}
                placeholder="https://example.com/logo.png"
              />
            </Field>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="text-sm font-semibold">Where the widget may run</h2>
            <Field
              label="Allowed origins"
              hint="One origin per line, for example https://www.example.com. Leave empty to allow any website."
            >
              <Textarea
                rows={4}
                value={form.allowedOrigins}
                onChange={(e) => update({ allowedOrigins: e.target.value })}
                placeholder={'https://www.example.com\nhttps://help.example.com'}
                className="font-mono text-xs"
              />
            </Field>
            <p className="rounded-md bg-amber-50 p-2 text-[11px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              Origin checks run in the browser-facing API. For stricter guarantees, also restrict
              the script with a Content-Security-Policy on your website.
            </p>
          </div>

          <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="text-sm font-semibold">Consent and visitor details</h2>
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                checked={form.consentRequired}
                onChange={(e) => update({ consentRequired: e.target.checked })}
              />
              Require consent before the first message
            </label>
            <Field label="Consent title">
              <Input
                value={form.consentTitle}
                maxLength={160}
                onChange={(e) => update({ consentTitle: e.target.value })}
              />
            </Field>
            <Field label="Consent text">
              <Textarea
                rows={5}
                value={form.consentBody}
                maxLength={4000}
                onChange={(e) => update({ consentBody: e.target.value })}
              />
            </Field>
            <Field
              label="Privacy policy URL"
              hint="Optional link shown under the consent text."
            >
              <Input
                value={form.consentUrl}
                maxLength={2000}
                onChange={(e) => update({ consentUrl: e.target.value })}
                placeholder="https://example.com/privacy"
              />
            </Field>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Every visitor supplies a name and email address. Their conversations are visible only
              to administrators in the conversation review area.
            </p>
          </div>
        </section>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Changes apply to the next widget load. Existing conversations remain available.
          </p>
          <Button onClick={save} loading={saving}>
            Save settings
          </Button>
        </div>

        <section className="space-y-4 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div>
            <h2 className="text-sm font-semibold">Embed code</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Paste this before the closing <code>&lt;/body&gt;</code> tag on the website that should
              show the floating chat button.
            </p>
          </div>
          <pre className="overflow-x-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">
            {form.scriptTag || 'Loading embed code…'}
          </pre>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!form.scriptTag}
              onClick={() => copyValue(form.scriptTag, toast)}
            >
              <CopyIcon className="h-3.5 w-3.5" /> Copy script tag
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!form.widgetUrl}
              onClick={() => copyValue(form.widgetUrl, toast)}
            >
              <CopyIcon className="h-3.5 w-3.5" /> Copy widget URL
            </Button>
            <a
              href={form.widgetUrl || '#'}
              target="_blank"
              rel="noreferrer noopener"
              className={cn(
                'inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
                !form.widgetUrl && 'pointer-events-none opacity-50',
              )}
            >
              <GlobeIcon className="h-3.5 w-3.5" /> Open widget
            </a>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-3 dark:border-slate-800">
            <div>
              <p className="text-xs font-medium text-slate-600 dark:text-slate-300">Embed key</p>
              <p className="break-all font-mono text-[11px] text-slate-500">{form.publicKey}</p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setConfirmRotate(true)}>
              <RefreshIcon className="h-3.5 w-3.5" /> Rotate key
            </Button>
          </div>
        </section>
      </div>

      <ConfirmDialog
        open={confirmRotate}
        onClose={() => setConfirmRotate(false)}
        onConfirm={rotate}
        loading={rotating}
        title="Rotate embed key"
        confirmLabel="Rotate key"
        message="Every website using the old script stops working immediately. You will need to replace the script tag everywhere it was installed."
      />
      <ConfirmDialog
        open={confirmRemoveLogo}
        onClose={() => setConfirmRemoveLogo(false)}
        onConfirm={removeLogo}
        title="Remove logo"
        confirmLabel="Remove"
        message="Remove the current widget logo? The brand name will still be shown."
      />
    </div>
  );
}
