/* globals describe, it, expect, vi */
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { createSupabaseStorage } = require('../../src/services/storage/supabase');
const { buildRelativePath, buildEmbedLogoPath, EMBED_LOGO_PREFIX } = require('../../src/services/storage/paths');

const SETTINGS = {
  url: 'https://example.supabase.co',
  serviceRoleKey: 'service-role-secret',
  bucket: 'rag-documents',
};

function response({ ok = true, status = 200, json = null, body = null, headers = {} } = {}) {
  return {
    ok,
    status,
    headers: {
      get: (name) => headers[String(name).toLowerCase()] ?? null,
    },
    json: async () => json,
    arrayBuffer: async () => (body ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : new ArrayBuffer(0)),
  };
}

describe('storage: object keys', () => {
  it('namespaces every object by owner, project and document', () => {
    const key = buildRelativePath({
      ownerUserId: 'user-1',
      projectId: 'project-1',
      documentId: 'document-1',
      versionNumber: 2,
      originalFilename: '../../Report.pdf',
    });
    expect(key).toBe('user-1/project-1/document-1/v2__Report.pdf');
  });

  it('builds storage keys that stay within the ASCII-safe range Supabase accepts', () => {
    const key = buildRelativePath({
      ownerUserId: 'user-1',
      projectId: 'project-1',
      documentId: 'document-1',
      versionNumber: 1,
      originalFilename: 'eSignPro (Signer_Pro) — Product Assessment.pdf',
    });
    expect(key).toBe('user-1/project-1/document-1/v1__eSignPro (Signer_Pro) Product Assessment.pdf');
  });

  it('keeps widget logos in the external_logo folder', () => {
    const key = buildEmbedLogoPath({
      projectId: 'project-1',
      embedId: 'embed-1',
      originalFilename: '../../Brand Logo.png',
    });
    expect(EMBED_LOGO_PREFIX).toBe('external_logo');
    expect(key).toBe('external_logo/project-1/embed-1/v1__Brand Logo.png');
  });

  it('uses a configured widget logo folder', () => {
    const key = buildEmbedLogoPath({
      projectId: 'project-1',
      embedId: 'embed-1',
      originalFilename: 'Brand.png',
      folder: 'production-logos',
    });
    expect(key).toBe('production-logos/project-1/embed-1/v1__Brand.png');
  });
});

describe('storage: Supabase REST adapter', () => {
  it('uploads a local temp file to the private bucket and removes the temp file', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rag-supabase-'));
    const temp = path.join(dir, 'upload.txt');
    await fsp.writeFile(temp, 'hello');

    const fetchImpl = vi.fn().mockResolvedValue(response());
    const storage = createSupabaseStorage({ ...SETTINGS, fetchImpl });
    const key = 'user-1/project-1/document-1/v1__upload.txt';

    await storage.moveFileIntoStorage(temp, key);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      'https://example.supabase.co/storage/v1/object/rag-documents/user-1/project-1/document-1/v1__upload.txt',
    );
    expect(options.method).toBe('POST');
    expect(options.headers.apikey).toBe(SETTINGS.serviceRoleKey);
    expect(options.headers.authorization).toBeUndefined();
    expect(options.headers['x-upsert']).toBe('true');
    expect(Buffer.isBuffer(options.body)).toBe(true);
    expect(options.body.toString('utf8')).toBe('hello');
    await expect(fsp.stat(temp)).rejects.toMatchObject({ code: 'ENOENT' });
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('downloads through the authenticated endpoint', async () => {
    const payload = Buffer.from('stored bytes');
    const fetchImpl = vi.fn().mockResolvedValue(
      response({ headers: { 'content-length': String(payload.length) }, body: payload }),
    );
    const storage = createSupabaseStorage({ ...SETTINGS, fetchImpl });

    const buffer = await storage.readStoredFile('user-1/project-1/document-1/v1__a.txt', 1024);

    expect(buffer.toString('utf8')).toBe('stored bytes');
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toContain('/storage/v1/object/rag-documents/');
    expect(options.method).toBe('GET');
    expect(options.headers.authorization).toBeUndefined();
    expect(options.headers.apikey).toBe(SETTINGS.serviceRoleKey);
  });

  it('includes the truncated Supabase error detail in failed requests', async () => {
    const longDetail = 'x'.repeat(250);
    const fetchImpl = vi.fn().mockResolvedValue(
      response({ ok: false, status: 500, json: { error: { message: longDetail } } }),
    );
    const storage = createSupabaseStorage({ ...SETTINGS, fetchImpl });

    await expect(storage.readStoredFile('user-1/project-1/document-1/v1__a.txt', 1024)).rejects.toThrow(
      `Supabase Storage download failed (500): ${'x'.repeat(200)}.`,
    );
  });

  it('sends secret keys via the apikey header and legacy JWTs via bearer', async () => {
    const secretFetchImpl = vi.fn().mockResolvedValue(response({ ok: true, status: 200, body: Buffer.from('ok') }));
    const secretStorage = createSupabaseStorage({ ...SETTINGS, serviceRoleKey: 'sb_secret_abc', fetchImpl: secretFetchImpl });
    await secretStorage.readStoredFile('user-1/project-1/document-1/v1__a.txt', 1024);

    expect(secretFetchImpl.mock.calls[0][1].headers.apikey).toBe('sb_secret_abc');
    expect(secretFetchImpl.mock.calls[0][1].headers.authorization).toBeUndefined();

    const jwtFetchImpl = vi.fn().mockResolvedValue(response({ ok: true, status: 200, body: Buffer.from('ok') }));
    const jwtStorage = createSupabaseStorage({ ...SETTINGS, serviceRoleKey: 'eyJhbGciOiJIUzI1NiJ9.payload.sig', fetchImpl: jwtFetchImpl });
    await jwtStorage.readStoredFile('user-1/project-1/document-1/v1__a.txt', 1024);

    expect(jwtFetchImpl.mock.calls[0][1].headers.apikey).toBe('eyJhbGciOiJIUzI1NiJ9.payload.sig');
    expect(jwtFetchImpl.mock.calls[0][1].headers.authorization).toBe(`Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig`);
  });

  it('treats missing objects as absent and reports oversized reads', async () => {
    const missing = createSupabaseStorage({
      ...SETTINGS,
      fetchImpl: vi.fn().mockResolvedValue(response({ ok: false, status: 404 })),
    });
    await expect(missing.fileExists('user-1/project-1/document-1/v1__a.txt')).resolves.toBe(false);

    const tooLarge = createSupabaseStorage({
      ...SETTINGS,
      fetchImpl: vi.fn().mockResolvedValue(response({ headers: { 'content-length': '9999' } })),
    });
    await expect(tooLarge.readStoredFile('user-1/project-1/document-1/v1__a.txt', 1024)).rejects.toMatchObject({
      code: 'file_too_large',
    });
  });

  it('lists and deletes every object under a document key', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, options = {}) => {
      calls.push({ url, options });
      if (url.includes('/object/list/')) {
        const body = JSON.parse(options.body);
        if (body.prefix === 'user-1/project-1/document-1') {
          return response({ json: [{ name: 'v1__a.txt' }, { name: 'v2__b.txt' }] });
        }
        return response({ json: [] });
      }
      if (options.method === 'DELETE') return response();
      return response({ ok: false, status: 404 });
    });
    const storage = createSupabaseStorage({ ...SETTINGS, fetchImpl });

    await storage.removeVersionDirectory('project-1', 'document-1', 'user-1');

    const deleted = calls.filter((call) => call.options.method === 'DELETE').map((call) => call.url);
    expect(deleted).toEqual([
      'https://example.supabase.co/storage/v1/object/rag-documents/user-1/project-1/document-1/v1__a.txt',
      'https://example.supabase.co/storage/v1/object/rag-documents/user-1/project-1/document-1/v2__b.txt',
    ]);
    expect(calls.every((call) => !call.url.includes(SETTINGS.serviceRoleKey))).toBe(true);
  });
});
