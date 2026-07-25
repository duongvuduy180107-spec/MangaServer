// github.js
const axios = require('axios');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_OWNER = process.env.GITHUB_OWNER || '';
const GITHUB_REPO = process.env.GITHUB_REPO || '';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

const GH_API_BASE = 'https://api.github.com';
const USE_GITHUB = Boolean(GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO);

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

async function githubReadJson(filePath, fallback = null) {
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

async function githubWriteJson(filePath, data, message = `update ${filePath}`) {
  const existing = await githubGetFileMeta(filePath);

  const body = {
    message,
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

async function githubDeleteFile(filePath, message = `delete ${filePath}`) {
  const existing = await githubGetFileMeta(filePath);
  if (!existing?.sha) return null;

  const body = {
    message,
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

module.exports = {
  USE_GITHUB,
  GITHUB_TOKEN,
  GITHUB_OWNER,
  GITHUB_REPO,
  GITHUB_BRANCH,
  githubRepoPath,
  githubHeaders,
  githubFileUrl,
  githubGetFileMeta,
  githubReadJson,
  githubWriteJson,
  githubDeleteFile,
};