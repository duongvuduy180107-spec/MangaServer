const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const MANGA_DIR = path.join(DATA_DIR, 'manga');
const MANGA_LIST_FILE = path.join(DATA_DIR, 'manga.json');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeRm(targetPath) {
  try {
    if (fs.existsSync(targetPath)) {
      fs.rmSync(targetPath, { recursive: true, force: true });
    }
  } catch (err) {
    console.error('safeRm error:', targetPath, err.message);
  }
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.error(`readJson error: ${filePath}`, err.message);
    return fallback;
  }
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
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

function ensureBaseFiles() {
  ensureDir(DATA_DIR);
  ensureDir(MANGA_DIR);
  if (!fs.existsSync(MANGA_LIST_FILE)) {
    writeJson(MANGA_LIST_FILE, []);
  }
}

function loadMangaList() {
  return readJson(MANGA_LIST_FILE, []);
}

function saveMangaList(list) {
  writeJson(MANGA_LIST_FILE, list);
}

function mangaFilePath(slug) {
  return path.join(MANGA_DIR, `${slug}.json`);
}

function loadMangaDetailBySlug(slug) {
  return readJson(mangaFilePath(slug), null);
}

function saveMangaDetail(detail) {
  writeJson(mangaFilePath(detail.slug), detail);
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

function findMangaById(mangaId) {
  const list = loadMangaList();
  const manga = list.find(m => m.mangaId === mangaId);
  if (!manga) return null;
  const detail = loadMangaDetailBySlug(manga.slug);
  return { list, manga, detail };
}

function chapterCountFromDetail(detail) {
  return Array.isArray(detail?.chapters) ? detail.chapters.length : 0;
}

ensureBaseFiles();

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    message: 'server is alive',
    time: new Date().toISOString(),
  });
});

app.get('/api/genres', (_req, res) => {
  const mangaList = loadMangaList();
  const genres = [...new Set(
    mangaList.flatMap(m => Array.isArray(m.genres) ? m.genres : [])
  )].sort((a, b) => a.localeCompare(b, 'vi'));

  res.json({
    ok: true,
    count: genres.length,
    genres,
  });
});

app.get('/api/manga', (_req, res) => {
  const mangaList = sortNewestFirst(loadMangaList()).map(toPublicManga);
  res.json({
    ok: true,
    count: mangaList.length,
    mangas: mangaList,
  });
});

app.get('/api/manga/:mangaId', (req, res) => {
  const found = findMangaById(req.params.mangaId);

  if (!found) {
    return res.status(404).json({
      ok: false,
      message: 'manga not found',
    });
  }

  if (!found.detail) {
    return res.status(404).json({
      ok: false,
      message: 'manga detail file not found',
      manga: found.manga,
    });
  }

  const detail = toPublicDetail(found.detail);
  detail.chapters = sortChapters(detail.chapters || []);

  res.json({
    ok: true,
    manga: detail,
  });
});

app.get('/api/manga/:mangaId/chapters', (req, res) => {
  const found = findMangaById(req.params.mangaId);

  if (!found) {
    return res.status(404).json({ ok: false, message: 'manga not found' });
  }

  if (!found.detail) {
    return res.status(404).json({ ok: false, message: 'manga detail file not found' });
  }

  res.json({
    ok: true,
    mangaId: found.detail.mangaId,
    slug: found.detail.slug,
    chapters: sortChapters(found.detail.chapters || []),
  });
});

app.post('/api/manga', (req, res) => {
  try {
    const mangaList = loadMangaList();

    const title = sanitizeText(req.body.title);
    const author = sanitizeText(req.body.author);
    const summary = sanitizeText(req.body.summary);
    const description = sanitizeText(req.body.description);
    const rawSlug = sanitizeText(req.body.slug);
    const genres = normalizeGenres(req.body.genres);
    const coverUrl = normalizeUrl(req.body.coverUrl || req.body.cover || req.body.coverLink);

    if (!title) {
      return res.status(400).json({ ok: false, message: 'title is required' });
    }

    const mangaId = nextId('manga_', mangaList, 'mangaId');
    const baseSlug = slugify(rawSlug || title) || mangaId;
    const slug = uniqueSlug(baseSlug, mangaList);
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

    const mangaSummary = buildMangaSummary(mangaDetail);

    mangaList.push(mangaSummary);
    saveMangaList(mangaList);
    saveMangaDetail(mangaDetail);

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
    console.error('POST /api/manga error:', err);
    res.status(500).json({
      ok: false,
      message: 'failed to create manga',
      error: err.message,
    });
  }
});

app.put('/api/manga/:mangaId', (req, res) => {
  try {
    const mangaId = req.params.mangaId;
    const mangaList = loadMangaList();
    const listIndex = mangaList.findIndex(m => m.mangaId === mangaId);

    if (listIndex === -1) {
      return res.status(404).json({ ok: false, message: 'manga not found' });
    }

    const oldManga = mangaList[listIndex];
    const detail = loadMangaDetailBySlug(oldManga.slug);

    if (!detail) {
      return res.status(404).json({ ok: false, message: 'manga detail file not found' });
    }

    const title = req.body.title !== undefined ? sanitizeText(req.body.title) : detail.title;
    const author = req.body.author !== undefined ? sanitizeText(req.body.author) : detail.author;
    const summary = req.body.summary !== undefined ? sanitizeText(req.body.summary) : detail.summary;
    const description = req.body.description !== undefined ? sanitizeText(req.body.description) : detail.description;
    const rawSlug = sanitizeText(req.body.slug);
    const genres = req.body.genres !== undefined ? normalizeGenres(req.body.genres) : detail.genres;
    const coverUrl = req.body.coverUrl !== undefined ? normalizeUrl(req.body.coverUrl) : detail.coverUrl;

    if (!title) {
      return res.status(400).json({ ok: false, message: 'title cannot be empty' });
    }

    let newSlug = detail.slug;
    if (rawSlug || (req.body.title !== undefined && title !== oldManga.title)) {
      const baseSlug = slugify(rawSlug || title) || mangaId;
      if (baseSlug !== detail.slug) {
        const otherMangas = mangaList.filter(m => m.mangaId !== mangaId);
        newSlug = uniqueSlug(baseSlug, otherMangas);
      }
    }

    const now = new Date().toISOString();
    const oldSlug = oldManga.slug;

    detail.title = title;
    detail.author = author;
    detail.summary = summary;
    detail.description = description;
    detail.genres = genres;
    detail.coverUrl = coverUrl || null;
    detail.coverFile = coverUrl ? { originalName: null, mimetype: null, size: null, savedPath: coverUrl } : null;
    detail.updatedAt = now;
    detail.slug = newSlug;

    const updatedSummary = {
      ...oldManga,
      title: detail.title,
      author: detail.author,
      slug: detail.slug,
      genres: detail.genres,
      coverUrl: detail.coverUrl,
      updatedAt: detail.updatedAt,
      summary: detail.summary,
      description: detail.description,
      chapterCount: chapterCountFromDetail(detail),
    };

    mangaList[listIndex] = updatedSummary;
    saveMangaList(mangaList);

    if (newSlug !== oldSlug) {
      safeRm(mangaFilePath(oldSlug));
    }

    saveMangaDetail(detail);

    res.json({
      ok: true,
      message: 'manga updated successfully',
      manga: toPublicDetail(detail),
    });
  } catch (err) {
    console.error('PUT /api/manga/:mangaId error:', err);
    res.status(500).json({
      ok: false,
      message: 'failed to update manga',
      error: err.message,
    });
  }
});

app.delete('/api/manga/:mangaId', (req, res) => {
  try {
    const mangaList = loadMangaList();
    const idx = mangaList.findIndex(m => m.mangaId === req.params.mangaId);

    if (idx === -1) {
      return res.status(404).json({ ok: false, message: 'manga not found' });
    }

    const manga = mangaList[idx];
    mangaList.splice(idx, 1);
    saveMangaList(mangaList);

    safeRm(mangaFilePath(manga.slug));

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
    console.error('DELETE /api/manga/:mangaId error:', err);
    res.status(500).json({
      ok: false,
      message: 'failed to delete manga',
      error: err.message,
    });
  }
});

app.post('/api/chapter', (req, res) => {
  try {
    const mangaId = sanitizeText(req.body.mangaId);
    const chapterNumber = Number(req.body.chapterNumber);
    const chapterTitle = sanitizeText(req.body.chapterTitle);
    const chapterIdInput = sanitizeText(req.body.chapterId);
    const pages = normalizePages(req.body.pages || req.body.pageUrls || req.body.images);

    if (!mangaId) {
      return res.status(400).json({ ok: false, message: 'mangaId is required' });
    }

    if (!Number.isFinite(chapterNumber)) {
      return res.status(400).json({ ok: false, message: 'chapterNumber must be a number' });
    }

    if (!pages.length) {
      return res.status(400).json({ ok: false, message: 'pages is required and must not be empty' });
    }

    const mangaList = loadMangaList();
    const manga = mangaList.find(m => m.mangaId === mangaId);

    if (!manga) {
      return res.status(404).json({ ok: false, message: 'manga not found' });
    }

    const detail = loadMangaDetailBySlug(manga.slug) || { ...manga, chapters: [] };
    detail.chapters = Array.isArray(detail.chapters) ? detail.chapters : [];

    const chapterId = chapterIdInput || nextId('chap_', detail.chapters, 'chapterId');

    if (detail.chapters.find(ch => ch.chapterId === chapterId)) {
      return res.status(409).json({ ok: false, message: 'chapterId already exists' });
    }

    if (detail.chapters.find(ch => Number(ch.chapterNumber) === Number(chapterNumber))) {
      return res.status(409).json({ ok: false, message: 'chapterNumber already exists for this manga' });
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

    manga.chapterCount = detail.chapterCount;
    manga.updatedAt = now;
    mangaList[mangaList.findIndex(m => m.mangaId === mangaId)] = manga;

    saveMangaList(mangaList);
    saveMangaDetail(detail);

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
    console.error('POST /api/chapter error:', err);
    res.status(500).json({
      ok: false,
      message: 'failed to create chapter',
      error: err.message,
    });
  }
});

app.put('/api/chapter/:chapterId', (req, res) => {
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
      return res.status(400).json({ ok: false, message: 'mangaId is required in body to update chapter' });
    }

    const mangaList = loadMangaList();
    const mangaListIndex = mangaList.findIndex(m => m.mangaId === mangaId);
    const manga = mangaList[mangaListIndex];

    if (!manga) {
      return res.status(404).json({ ok: false, message: 'manga not found' });
    }

    const detail = loadMangaDetailBySlug(manga.slug);
    if (!detail || !Array.isArray(detail.chapters)) {
      return res.status(404).json({ ok: false, message: 'manga detail or chapters missing' });
    }

    const chapterIndex = detail.chapters.findIndex(ch => ch.chapterId === chapterId);
    if (chapterIndex === -1) {
      return res.status(404).json({ ok: false, message: 'chapter not found' });
    }

    const chapter = detail.chapters[chapterIndex];

    if (chapterNumberInput !== null) {
      if (!Number.isFinite(chapterNumberInput)) {
        return res.status(400).json({ ok: false, message: 'chapterNumber must be a valid number' });
      }

      const conflict = detail.chapters.find(
        ch => ch.chapterId !== chapterId && Number(ch.chapterNumber) === chapterNumberInput
      );
      if (conflict) {
        return res.status(409).json({ ok: false, message: 'chapterNumber already exists for this manga' });
      }

      chapter.chapterNumber = chapterNumberInput;
    }

    if (req.body.chapterTitle !== undefined) {
      chapter.chapterTitle = chapterTitle;
    }

    if (pages !== null) {
      if (!pages.length) {
        return res.status(400).json({ ok: false, message: 'pages array must not be empty' });
      }
      chapter.pages = pages;
      chapter.pageCount = pages.length;
    }

    const now = new Date().toISOString();
    chapter.updatedAt = now;
    detail.updatedAt = now;

    manga.updatedAt = now;
    manga.chapterCount = chapterCountFromDetail(detail);
    mangaList[mangaListIndex] = manga;

    saveMangaDetail(detail);
    saveMangaList(mangaList);

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
    console.error('PUT /api/chapter/:chapterId error:', err);
    res.status(500).json({
      ok: false,
      message: 'failed to update chapter',
      error: err.message,
    });
  }
});

app.delete('/api/chapter/:chapterId', (req, res) => {
  try {
    const chapterId = req.params.chapterId;
    const mangaId = sanitizeText(req.query.mangaId);

    let detail = null;
    let chapterIndex = -1;

    if (mangaId) {
      const found = findMangaById(mangaId);
      if (!found || !found.detail) {
        return res.status(404).json({ ok: false, message: 'manga not found' });
      }
      detail = found.detail;
      detail.chapters = Array.isArray(detail.chapters) ? detail.chapters : [];
      chapterIndex = detail.chapters.findIndex(ch => ch.chapterId === chapterId);
    } else {
      const mangaList = loadMangaList();
      for (const manga of mangaList) {
        const candidate = loadMangaDetailBySlug(manga.slug);
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
      return res.status(404).json({ ok: false, message: 'chapter not found' });
    }

    const chapter = detail.chapters[chapterIndex];
    detail.chapters.splice(chapterIndex, 1);
    detail.chapterCount = detail.chapters.length;
    detail.updatedAt = new Date().toISOString();
    saveMangaDetail(detail);

    const mangaList = loadMangaList();
    const mangaIdx = mangaList.findIndex(m => m.mangaId === detail.mangaId);
    if (mangaIdx !== -1) {
      mangaList[mangaIdx].chapterCount = detail.chapterCount;
      mangaList[mangaIdx].updatedAt = detail.updatedAt;
      saveMangaList(mangaList);
    }

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
    console.error('DELETE /api/chapter/:chapterId error:', err);
    res.status(500).json({
      ok: false,
      message: 'failed to delete chapter',
      error: err.message,
    });
  }
});

app.get('/api/chapter/:chapterId', (_req, res) => {
  try {
    const mangaList = loadMangaList();
    for (const manga of mangaList) {
      const detail = loadMangaDetailBySlug(manga.slug);
      if (!detail || !Array.isArray(detail.chapters)) continue;

      const chapter = detail.chapters.find(ch => ch.chapterId === _req.params.chapterId);
      if (chapter) {
        return res.json({
          ok: true,
          mangaId: detail.mangaId,
          mangaSlug: detail.slug,
          chapter,
        });
      }
    }

    res.status(404).json({ ok: false, message: 'chapter not found' });
  } catch (err) {
    console.error('GET /api/chapter/:chapterId error:', err);
    res.status(500).json({
      ok: false,
      message: 'failed to load chapter',
      error: err.message,
    });
  }
});

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

app.listen(PORT, HOST, () => {
  console.log(`Server chạy tại http://${HOST}:${PORT}`);
  console.log(`Data folder: ${DATA_DIR}`);
  console.log(`Manga folder: ${MANGA_DIR}`);
});
