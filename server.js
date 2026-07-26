const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
const api = express.Router();

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_OWNER = process.env.GITHUB_OWNER || '';
const GITHUB_REPO = process.env.GITHUB_REPO || '';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const USE_GITHUB = Boolean(GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO);

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const MANGA_DIR = path.join(DATA_DIR, 'manga');
const MANGA_LIST_FILE = path.join(DATA_DIR, 'manga.json');

const GH_API_BASE = 'https://api.github.com';

let mangaListCache = [];
const detailCache = new Map();

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function localReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.error(`localReadJson error: ${filePath}`, err.message);
    return fallback;
  }
}

function localWriteJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function localDeletePath(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { recursive: true, force: true });
    }
  } catch (err) {
    console.error(`localDeletePath error: ${filePath}`, err.message);
  }
}

function sanitizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeGenres(value) {
  if (Array.isArray(value)) {
    return value.map(v => String(v).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map(v => v.trim()).filter(Boolean);
  }
  return [];
}

function slugify(input) {
  const base = String(input || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');

  return base || '';
}

function uniqueSlug(baseSlug, existingList) {
  let slug = baseSlug || 'manga';
  let n = 2;
  while (existingList.some(item => item.slug === slug)) {
    slug = `${baseSlug || 'manga'}-${n++}`;
  }
  return slug;
}

function nextId(prefix, existingList, keyName) {
  let max = 0;
  for (const item of existingList) {
    const raw = String(item?.[keyName] || '');
    if (!raw.startsWith(prefix)) continue;
    const num = Number(raw.slice(prefix.length));
    if (Number.isFinite(num)) max = Math.max(max, num);
  }
  return `${prefix}${String(max + 1).padStart(4, '0')}`;
}

function mangaFilePath(slug) {
  return path.join(MANGA_DIR, `${slug}.json`);
}

function isAbsoluteUrl(url) {
  return /^https?:\/\//i.test(url) || /^data:/i.test(url) || /^blob:/i.test(url);
}

function normalizeUrl(url) {
  const raw = sanitizeText(url);
  if (!raw) return '';
  try {
    if (isAbsoluteUrl(raw)) return encodeURI(raw);
    if (raw.startsWith('/')) return encodeURI(raw);
    return encodeURI(raw);
  } catch {
    return raw;
  }
}

function normalizePages(value) {
  let list = value;

  if (typeof list === 'string') {
    try {
      const parsed = JSON.parse(list);
      list = Array.isArray(parsed) ? parsed : [];
    } catch {
      list = [];
    }
  }

  if (!Array.isArray(list)) list = [];

  return list
    .map((item, index) => {
      if (typeof item === 'string') {
        const url = normalizeUrl(item);
        if (!url) return null;
        return {
          page: index + 1,
          imageUrl: url,
          savedPath: url,
        };
      }

      if (item && typeof item === 'object') {
        const url = normalizeUrl(item.imageUrl || item.savedPath || item.url);
        if (!url) return null;
        const pageNum = Number(item.page);
        return {
          page: Number.isFinite(pageNum) ? pageNum : index + 1,
          imageUrl: url,
          savedPath: url,
        };
      }

      return null;
    })
    .filter(Boolean)
    .sort((a, b) => Number(a.page) - Number(b.page));
}

function toPublicManga(manga) {
  return {
    ...manga,
    coverUrl: manga.coverUrl || manga.coverFile?.savedPath || null,
  };
}

function toPublicDetail(detail) {
  return {
    ...detail,
    coverUrl: detail.coverUrl || detail.coverFile?.savedPath || null,
  };
}

function buildMangaSummary(detail) {
  return {
    mangaId: detail.mangaId,
    slug: detail.slug,
    title: detail.title,
    author: detail.author,
    genres: Array.isArray(detail.genres) ? detail.genres : [],
    summary: detail.summary || '',
    description: detail.description || '',
    coverUrl: detail.coverUrl || detail.coverFile?.savedPath || null,
    chapterCount: detail.chapterCount || 0,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
  };
}

function sortNewestFirst(list) {
  return list.slice().sort((a, b) => {
    const at = new Date(a.createdAt || 0).getTime();
    const bt = new Date(b.createdAt || 0).getTime();
    return bt - at;
  });
}

function sortChapters(list) {
  return (Array.isArray(list) ? list : [])
    .slice()
    .sort((a, b) => {
      const an = Number(a.chapterNumber);
      const bn = Number(b.chapterNumber);
      if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
      return String(a.chapterId || '').localeCompare(String(b.chapterId || ''));
    });
}

function chapterCountFromDetail(detail) {
  return Array.isArray(detail?.chapters) ? detail.chapters.length : 0;
}

function ensureBaseFilesLocal() {
  ensureDir(DATA_DIR);
  ensureDir(MANGA_DIR);
  if (!fs.existsSync(MANGA_LIST_FILE)) {
    localWriteJson(MANGA_LIST_FILE, []);
  }
}

function githubRepoPath(filePath) {
  return String(filePath || '')
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}

function githubHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'MangaServer',
  };
}

function githubFileUrl(filePath) {
  return `${GH_API_BASE}/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/contents/${githubRepoPath(filePath)}`;
}

async function githubGetFileMeta(filePath) {
  const url = `${githubFileUrl(filePath)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
  const res = await axios.get(url, {
    headers: githubHeaders(),
    validateStatus: () => true,
  });

  if (res.status === 404) return null;
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`GitHub GET failed for ${filePath}: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

async function githubReadJson(filePath, fallback) {
  try {
    const meta = await githubGetFileMeta(filePath);
    if (!meta || !meta.content) return fallback;

    const text = Buffer.from(String(meta.content).replace(/\n/g, ''), 'base64').toString('utf8');
    if (!text.trim()) return fallback;
    return JSON.parse(text);
  } catch (err) {
    console.error(`githubReadJson error: ${filePath}`, err.message);
    return fallback;
  }
}

async function githubWriteJson(filePath, data, message) {
  const existing = await githubGetFileMeta(filePath);

  const body = {
    message: message || `update ${filePath}`,
    content: Buffer.from(JSON.stringify(data, null, 2), 'utf8').toString('base64'),
    branch: GITHUB_BRANCH,
  };

  if (existing?.sha) body.sha = existing.sha;

  const res = await axios.put(githubFileUrl(filePath), body, {
    headers: githubHeaders(),
    validateStatus: () => true,
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`GitHub PUT failed for ${filePath}: ${res.status} ${JSON.stringify(res.data)}`);
  }

  return res.data;
}

async function githubDeleteFile(filePath, message) {
  const existing = await githubGetFileMeta(filePath);
  if (!existing?.sha) return null;

  const body = {
    message: message || `delete ${filePath}`,
    sha: existing.sha,
    branch: GITHUB_BRANCH,
  };

  const res = await axios.delete(githubFileUrl(filePath), {
    headers: githubHeaders(),
    data: body,
    validateStatus: () => true,
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`GitHub DELETE failed for ${filePath}: ${res.status} ${JSON.stringify(res.data)}`);
  }

  return res.data;
}

async function storeReadJson(filePath, fallback) {
  if (USE_GITHUB) return githubReadJson(filePath, fallback);
  return localReadJson(filePath, fallback);
}

async function storeWriteJson(filePath, data, message) {
  if (USE_GITHUB) return githubWriteJson(filePath, data, message);
  localWriteJson(filePath, data);
  return { ok: true };
}

async function storeDelete(filePath, message) {
  if (USE_GITHUB) return githubDeleteFile(filePath, message);
  localDeletePath(filePath);
  return { ok: true };
}

async function bootstrap() {
  ensureBaseFilesLocal();

  mangaListCache = await storeReadJson(MANGA_LIST_FILE, []);
  if (!Array.isArray(mangaListCache)) mangaListCache = [];

  detailCache.clear();
  for (const manga of mangaListCache) {
    if (!manga?.slug) continue;
    const detail = await storeReadJson(mangaFilePath(manga.slug), null);
    if (detail) detailCache.set(manga.slug, detail);
  }

  console.log(`[BOOT] mode=${USE_GITHUB ? 'github' : 'local'} mangas=${mangaListCache.length}`);
}

function getMangaSummaryById(mangaId) {
  return mangaListCache.find(m => m.mangaId === mangaId) || null;
}

async function ensureDetailLoaded(slug) {
  if (!slug) return null;
  if (detailCache.has(slug)) return detailCache.get(slug);
  const detail = await storeReadJson(mangaFilePath(slug), null);
  if (detail) detailCache.set(slug, detail);
  return detail;
}

async function findMangaById(mangaId) {
  const manga = getMangaSummaryById(mangaId);
  if (!manga) return null;
  const detail = await ensureDetailLoaded(manga.slug);
  return { manga, detail };
}

async function persistMangaList() {
  await storeWriteJson(MANGA_LIST_FILE, mangaListCache, 'update manga list');
}

async function persistMangaDetail(detail) {
  if (!detail?.slug) return;
  detailCache.set(detail.slug, detail);
  await storeWriteJson(mangaFilePath(detail.slug), detail, `update detail ${detail.slug}`);
}

async function removeMangaDetail(slug) {
  if (!slug) return;
  detailCache.delete(slug);
  await storeDelete(mangaFilePath(slug), `delete detail ${slug}`);
}

function upsertSummaryFromDetail(detail) {
  const summary = buildMangaSummary(detail);
  const idx = mangaListCache.findIndex(m => m.mangaId === detail.mangaId);
  if (idx === -1) {
    mangaListCache.push(summary);
  } else {
    mangaListCache[idx] = summary;
  }
}

function sendError(res, status, message, extra = {}) {
  return res.status(status).json({
    ok: false,
    message,
    ...extra,
  });
}

api.get('/health', (_req, res) => {
  res.json({
    ok: true,
    message: 'server is alive',
    time: new Date().toISOString(),
    store: USE_GITHUB ? 'github' : 'local',
    mangaCount: mangaListCache.length,
  });
});

api.get('/debug/state', (_req, res) => {
  res.json({
    ok: true,
    store: USE_GITHUB ? 'github' : 'local',
    mangaCount: mangaListCache.length,
    cachedDetails: detailCache.size,
    github: {
      configured: USE_GITHUB,
      owner: GITHUB_OWNER || null,
      repo: GITHUB_REPO || null,
      branch: GITHUB_BRANCH || null,
    },
  });
});

api.get('/genres', (_req, res) => {
  const genres = [...new Set(
    mangaListCache.flatMap(m => Array.isArray(m.genres) ? m.genres : [])
  )].sort((a, b) => a.localeCompare(b, 'vi'));

  res.json({
    ok: true,
    count: genres.length,
    genres,
  });
});

api.get('/manga', (_req, res) => {
  const mangaList = sortNewestFirst(mangaListCache).map(toPublicManga);
  res.json({
    ok: true,
    count: mangaList.length,
    mangas: mangaList,
  });
});

api.get('/manga/:mangaId/chapters', async (req, res) => {
  try {
    const found = await findMangaById(req.params.mangaId);

    if (!found) return sendError(res, 404, 'manga not found');
    if (!found.detail) return sendError(res, 404, 'manga detail file not found', { manga: found.manga });

    res.json({
      ok: true,
      mangaId: found.detail.mangaId,
      slug: found.detail.slug,
      chapters: sortChapters(found.detail.chapters || []),
    });
  } catch (err) {
    console.error('GET /manga/:mangaId/chapters error:', err);
    sendError(res, 500, 'failed to load chapters', { error: err.message });
  }
});

api.get('/manga/:mangaId', async (req, res) => {
  try {
    const found = await findMangaById(req.params.mangaId);

    if (!found) return sendError(res, 404, 'manga not found');
    if (!found.detail) return sendError(res, 404, 'manga detail file not found', { manga: found.manga });

    const detail = toPublicDetail(found.detail);
    detail.chapters = sortChapters(detail.chapters || []);

    res.json({
      ok: true,
      manga: detail,
    });
  } catch (err) {
    console.error('GET /manga/:mangaId error:', err);
    sendError(res, 500, 'failed to load manga', { error: err.message });
  }
});

api.post('/manga', async (req, res) => {
  try {
    const title = sanitizeText(req.body.title);
    const author = sanitizeText(req.body.author);
    const summary = sanitizeText(req.body.summary);
    const description = sanitizeText(req.body.description);
    const rawSlug = sanitizeText(req.body.slug);
    const genres = normalizeGenres(req.body.genres);
    const coverUrl = normalizeUrl(req.body.coverUrl || req.body.cover || req.body.coverLink);

    if (!title) return sendError(res, 400, 'title is required');

    const mangaId = nextId('manga_', mangaListCache, 'mangaId');
    const baseSlug = slugify(rawSlug || title) || mangaId;
    const slug = uniqueSlug(baseSlug, mangaListCache);
    const now = new Date().toISOString();

    const mangaDetail = {
      mangaId,
      slug,
      title,
      author,
      genres,
      summary,
      description,
      coverUrl: coverUrl || null,
      coverFile: coverUrl ? { originalName: null, mimetype: null, size: null, savedPath: coverUrl } : null,
      chapters: [],
      chapterCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    upsertSummaryFromDetail(mangaDetail);
    detailCache.set(slug, mangaDetail);

    await persistMangaList();
    await persistMangaDetail(mangaDetail);

    res.json({
      ok: true,
      message: 'manga created',
      received: {
        title,
        author,
        genres,
        summary,
        description,
        slug: rawSlug || null,
        coverUrl: coverUrl || null,
      },
      manga: toPublicDetail(mangaDetail),
    });
  } catch (err) {
    console.error('POST /manga error:', err);
    sendError(res, 500, 'failed to create manga', { error: err.message });
  }
});

api.put('/manga/:mangaId', async (req, res) => {
  try {
    const mangaId = req.params.mangaId;
    const listIndex = mangaListCache.findIndex(m => m.mangaId === mangaId);

    if (listIndex === -1) return sendError(res, 404, 'manga not found');

    const oldManga = mangaListCache[listIndex];
    const oldDetail = await ensureDetailLoaded(oldManga.slug);

    if (!oldDetail) return sendError(res, 404, 'manga detail file not found');

    const title = req.body.title !== undefined ? sanitizeText(req.body.title) : oldDetail.title;
    const author = req.body.author !== undefined ? sanitizeText(req.body.author) : oldDetail.author;
    const summary = req.body.summary !== undefined ? sanitizeText(req.body.summary) : oldDetail.summary;
    const description = req.body.description !== undefined ? sanitizeText(req.body.description) : oldDetail.description;
    const rawSlug = sanitizeText(req.body.slug);
    const genres = req.body.genres !== undefined ? normalizeGenres(req.body.genres) : oldDetail.genres;
    const coverUrl = req.body.coverUrl !== undefined ? normalizeUrl(req.body.coverUrl) : oldDetail.coverUrl;

    if (!title) return sendError(res, 400, 'title cannot be empty');

    let newSlug = oldDetail.slug;
    if (rawSlug || (req.body.title !== undefined && title !== oldManga.title)) {
      const baseSlug = slugify(rawSlug || title) || mangaId;
      if (baseSlug !== oldDetail.slug) {
        const otherMangas = mangaListCache.filter(m => m.mangaId !== mangaId);
        newSlug = uniqueSlug(baseSlug, otherMangas);
      }
    }

    const now = new Date().toISOString();
    const oldSlug = oldDetail.slug;

    const updatedDetail = {
      ...oldDetail,
      title,
      author,
      summary,
      description,
      genres,
      coverUrl: coverUrl || null,
      coverFile: coverUrl ? { originalName: null, mimetype: null, size: null, savedPath: coverUrl } : null,
      updatedAt: now,
      slug: newSlug,
    };

    mangaListCache[listIndex] = buildMangaSummary(updatedDetail);
    detailCache.delete(oldSlug);
    detailCache.set(newSlug, updatedDetail);

    await persistMangaList();
    await persistMangaDetail(updatedDetail);

    if (newSlug !== oldSlug) {
      await removeMangaDetail(oldSlug);
    }

    res.json({
      ok: true,
      message: 'manga updated successfully',
      manga: toPublicDetail(updatedDetail),
    });
  } catch (err) {
    console.error('PUT /manga/:mangaId error:', err);
    sendError(res, 500, 'failed to update manga', { error: err.message });
  }
});

api.delete('/manga/:mangaId', async (req, res) => {
  try {
    const mangaId = req.params.mangaId;
    const idx = mangaListCache.findIndex(m => m.mangaId === mangaId);

    if (idx === -1) return sendError(res, 404, 'manga not found');

    const manga = mangaListCache[idx];
    mangaListCache.splice(idx, 1);

    await persistMangaList();
    await removeMangaDetail(manga.slug);

    res.json({
      ok: true,
      message: 'manga deleted',
      deleted: {
        mangaId: manga.mangaId,
        slug: manga.slug,
        detailFile: `data/manga/${manga.slug}.json`,
      },
    });
  } catch (err) {
    console.error('DELETE /manga/:mangaId error:', err);
    sendError(res, 500, 'failed to delete manga', { error: err.message });
  }
});

api.post('/chapter', async (req, res) => {
  try {
    const mangaId = sanitizeText(req.body.mangaId);
    const chapterNumber = Number(req.body.chapterNumber);
    const chapterTitle = sanitizeText(req.body.chapterTitle);
    const chapterIdInput = sanitizeText(req.body.chapterId);
    const pages = normalizePages(req.body.pages || req.body.pageUrls || req.body.images);

    if (!mangaId) return sendError(res, 400, 'mangaId is required');
    if (!Number.isFinite(chapterNumber)) return sendError(res, 400, 'chapterNumber must be a number');
    if (!pages.length) return sendError(res, 400, 'pages is required and must not be empty');

    const mangaIndex = mangaListCache.findIndex(m => m.mangaId === mangaId);
    if (mangaIndex === -1) return sendError(res, 404, 'manga not found');

    const manga = mangaListCache[mangaIndex];
    const detail = (await ensureDetailLoaded(manga.slug)) || { ...manga, chapters: [] };
    detail.chapters = Array.isArray(detail.chapters) ? detail.chapters : [];

    const chapterId = chapterIdInput || nextId('chap_', detail.chapters, 'chapterId');

    if (detail.chapters.find(ch => ch.chapterId === chapterId)) {
      return sendError(res, 409, 'chapterId already exists');
    }

    if (detail.chapters.find(ch => Number(ch.chapterNumber) === Number(chapterNumber))) {
      return sendError(res, 409, 'chapterNumber already exists for this manga');
    }

    const now = new Date().toISOString();
    const chapter = {
      chapterId,
      mangaId,
      chapterNumber,
      chapterTitle,
      pageCount: pages.length,
      pages,
      createdAt: now,
      updatedAt: now,
    };

    detail.chapters.push(chapter);
    detail.chapterCount = detail.chapters.length;
    detail.updatedAt = now;

    mangaListCache[mangaIndex] = buildMangaSummary(detail);
    detailCache.set(detail.slug, detail);

    await persistMangaList();
    await persistMangaDetail(detail);

    res.json({
      ok: true,
      message: 'chapter created',
      received: {
        mangaId,
        chapterNumber,
        chapterTitle,
        chapterId: chapterIdInput || null,
        pageCount: pages.length,
        pages,
      },
      chapter,
      manga: {
        mangaId: detail.mangaId,
        slug: detail.slug,
        title: detail.title,
        chapterCount: detail.chapterCount,
      },
    });
  } catch (err) {
    console.error('POST /chapter error:', err);
    sendError(res, 500, 'failed to create chapter', { error: err.message });
  }
});

api.put('/chapter/:chapterId', async (req, res) => {
  try {
    const chapterId = req.params.chapterId;
    const mangaId = sanitizeText(req.body.mangaId);
    const chapterNumberInput =
      req.body.chapterNumber !== undefined && String(req.body.chapterNumber).trim() !== ''
        ? Number(req.body.chapterNumber)
        : null;
    const chapterTitle = sanitizeText(req.body.chapterTitle);
    const pages = req.body.pages !== undefined ? normalizePages(req.body.pages) : null;

    if (!mangaId) {
      return sendError(res, 400, 'mangaId is required in body to update chapter');
    }

    const mangaIndex = mangaListCache.findIndex(m => m.mangaId === mangaId);
    if (mangaIndex === -1) return sendError(res, 404, 'manga not found');

    const manga = mangaListCache[mangaIndex];
    const detail = await ensureDetailLoaded(manga.slug);

    if (!detail || !Array.isArray(detail.chapters)) {
      return sendError(res, 404, 'manga detail or chapters missing');
    }

    const chapterIndex = detail.chapters.findIndex(ch => ch.chapterId === chapterId);
    if (chapterIndex === -1) return sendError(res, 404, 'chapter not found');

    const chapter = detail.chapters[chapterIndex];

    if (chapterNumberInput !== null) {
      if (!Number.isFinite(chapterNumberInput)) {
        return sendError(res, 400, 'chapterNumber must be a valid number');
      }

      const conflict = detail.chapters.find(
        ch => ch.chapterId !== chapterId && Number(ch.chapterNumber) === chapterNumberInput
      );
      if (conflict) return sendError(res, 409, 'chapterNumber already exists for this manga');

      chapter.chapterNumber = chapterNumberInput;
    }

    if (req.body.chapterTitle !== undefined) {
      chapter.chapterTitle = chapterTitle;
    }

    if (pages !== null) {
      if (!pages.length) return sendError(res, 400, 'pages array must not be empty');
      chapter.pages = pages;
      chapter.pageCount = pages.length;
    }

    const now = new Date().toISOString();
    chapter.updatedAt = now;
    detail.updatedAt = now;

    mangaListCache[mangaIndex] = buildMangaSummary(detail);
    detailCache.set(detail.slug, detail);

    await persistMangaList();
    await persistMangaDetail(detail);

    res.json({
      ok: true,
      message: 'chapter updated successfully',
      chapter,
      manga: {
        mangaId: detail.mangaId,
        slug: detail.slug,
        title: detail.title,
        chapterCount: detail.chapterCount,
      },
    });
  } catch (err) {
    console.error('PUT /chapter/:chapterId error:', err);
    sendError(res, 500, 'failed to update chapter', { error: err.message });
  }
});

api.delete('/chapter/:chapterId', async (req, res) => {
  try {
    const chapterId = req.params.chapterId;
    const mangaId = sanitizeText(req.query.mangaId);

    let detail = null;
    let chapterIndex = -1;

    if (mangaId) {
      const found = await findMangaById(mangaId);
      if (!found || !found.detail) return sendError(res, 404, 'manga not found');

      detail = found.detail;
      detail.chapters = Array.isArray(detail.chapters) ? detail.chapters : [];
      chapterIndex = detail.chapters.findIndex(ch => ch.chapterId === chapterId);
    } else {
      for (const manga of mangaListCache) {
        const candidate = await ensureDetailLoaded(manga.slug);
        if (!candidate || !Array.isArray(candidate.chapters)) continue;
        const idx = candidate.chapters.findIndex(ch => ch.chapterId === chapterId);
        if (idx !== -1) {
          detail = candidate;
          chapterIndex = idx;
          break;
        }
      }
    }

    if (!detail || chapterIndex === -1) {
      return sendError(res, 404, 'chapter not found');
    }

    const chapter = detail.chapters[chapterIndex];
    detail.chapters.splice(chapterIndex, 1);
    detail.chapterCount = detail.chapters.length;
    detail.updatedAt = new Date().toISOString();

    const mangaIdx = mangaListCache.findIndex(m => m.mangaId === detail.mangaId);
    if (mangaIdx !== -1) {
      mangaListCache[mangaIdx] = buildMangaSummary(detail);
    }

    detailCache.set(detail.slug, detail);

    await persistMangaList();
    await persistMangaDetail(detail);

    res.json({
      ok: true,
      message: 'chapter deleted',
      deleted: {
        mangaId: detail.mangaId,
        chapterId: chapter.chapterId,
        chapterNumber: chapter.chapterNumber,
      },
    });
  } catch (err) {
    console.error('DELETE /chapter/:chapterId error:', err);
    sendError(res, 500, 'failed to delete chapter', { error: err.message });
  }
});

api.get('/chapter/:chapterId', async (req, res) => {
  try {
    for (const manga of mangaListCache) {
      const detail = await ensureDetailLoaded(manga.slug);
      if (!detail || !Array.isArray(detail.chapters)) continue;

      const chapter = detail.chapters.find(ch => ch.chapterId === req.params.chapterId);
      if (chapter) {
        return res.json({
          ok: true,
          mangaId: detail.mangaId,
          mangaSlug: detail.slug,
          chapter,
        });
      }
    }

    sendError(res, 404, 'chapter not found');
  } catch (err) {
    console.error('GET /chapter/:chapterId error:', err);
    sendError(res, 500, 'failed to load chapter', { error: err.message });
  }
});

app.use('/api', api);
app.use('/api/admin', api);

app.get('/', (_req, res) => {
  res.send('<h1>MangaServer is running</h1><p>Try <a href="/api/health">/api/health</a></p>');
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    ok: false,
    message: err.message || 'internal server error',
  });
});

async function main() {
  await bootstrap();

  app.listen(PORT, HOST, () => {
    console.log(`Server chạy tại http://${HOST}:${PORT}`);
    console.log(`Store mode: ${USE_GITHUB ? 'GitHub API' : 'Local filesystem'}`);
    console.log(`Data folder: ${DATA_DIR}`);
    console.log(`Manga folder: ${MANGA_DIR}`);
  });
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});