import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3001);
const DATA_DIR = path.join(__dirname, 'data');
const QUESTIONS_DIR = path.join(DATA_DIR, 'questions');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml; charset=utf-8'
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'cache-control': 'no-store', ...headers });
  res.end(body);
}
function json(res, status, data) { send(res, status, JSON.stringify(data), { 'content-type': 'application/json; charset=utf-8' }); }
function fail(res, status, message) { json(res, status, { ok: false, error: message }); }
async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function writeJsonAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp_${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await fs.rename(tmp, file);
}
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function safeKey(key) {
  if (!/^[a-zA-Z0-9_-]+$/.test(String(key || ''))) throw new Error('非法科目Key');
  return key;
}
function questionFile(subjectKey) { return path.join(QUESTIONS_DIR, `${safeKey(subjectKey)}.json`); }
function isAuthed(req) {
  if (!ADMIN_TOKEN) return true;
  return req.headers.authorization === `Bearer ${ADMIN_TOKEN}` || new URL(req.url, 'http://x').searchParams.get('token') === ADMIN_TOKEN;
}
function normalizeQuestion(q, subjectKey) {
  const now = new Date().toISOString();
  const out = {
    id: q.id || `${subjectKey}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    subject_key: subjectKey,
    subject: q.subject || '',
    official_exam_part: q.official_exam_part || '',
    chapter: q.chapter || '',
    type: q.type || '单选',
    difficulty: q.difficulty || '普通',
    stem: String(q.stem || '').trim(),
    options: Array.isArray(q.options) ? q.options.filter(v => String(v).trim()).map(String) : [],
    answer: Array.isArray(q.answer) ? q.answer : String(q.answer || '').trim(),
    explanation: String(q.explanation || '').trim(),
    source_name: q.source_name || '后台录入',
    source_url: q.source_url || '',
    license: q.license || 'custom',
    license_note: q.license_note || '',
    review_status: q.review_status || 'approved',
    updated_at: now
  };
  if (!out.stem) throw new Error('题干不能为空');
  if (!out.answer || (Array.isArray(out.answer) && !out.answer.length)) throw new Error('答案不能为空');
  if (out.type === '多选' && !Array.isArray(out.answer)) out.answer = String(out.answer).split(/[、,，\s]+/).filter(Boolean).sort();
  return out;
}
function computeTypeCounts(questions) {
  const counts = {};
  for (const q of questions) if (q.review_status === 'approved') counts[q.type || '简答'] = (counts[q.type || '简答'] || 0) + 1;
  return counts;
}
async function refreshSubjectCount(subjectKey) {
  const subjectsFile = path.join(DATA_DIR, 'subjects.json');
  const bank = await readJson(subjectsFile);
  const data = await readJson(questionFile(subjectKey)).catch(() => ({ questions: [] }));
  const approved = (data.questions || []).filter(q => q.review_status === 'approved');
  if (bank.subjects?.[subjectKey]) {
    bank.subjects[subjectKey].question_count = approved.length;
    bank.subjects[subjectKey].type_counts = computeTypeCounts(data.questions || []);
  }
  await writeJsonAtomic(subjectsFile, bank);
}
async function backupData() {
  const dir = path.join(__dirname, 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.mkdir(path.join(dir, 'questions'), { recursive: true });
  await fs.cp(DATA_DIR, dir, { recursive: true });
  return dir;
}
async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/health') return json(res, 200, { ok: true, time: new Date().toISOString(), auth: !!ADMIN_TOKEN });
  if (url.pathname === '/api/subjects' && req.method === 'GET') return json(res, 200, await readJson(path.join(DATA_DIR, 'subjects.json')));

  if (url.pathname === '/api/admin/backup' && req.method === 'POST') {
    if (!isAuthed(req)) return fail(res, 401, '未授权');
    const dir = await backupData();
    return json(res, 200, { ok: true, backup: dir });
  }

  const subjectMatch = url.pathname.match(/^\/api\/subjects\/([^/]+)\/questions$/);
  if (subjectMatch && req.method === 'GET') {
    const subjectKey = safeKey(subjectMatch[1]);
    const data = await readJson(questionFile(subjectKey)).catch(() => ({ subject_key: subjectKey, questions: [] }));
    let qs = data.questions || [];
    const type = url.searchParams.get('type') || '';
    const status = url.searchParams.get('status') || '';
    const keyword = (url.searchParams.get('q') || '').trim().toLowerCase();
    const page = Math.max(1, Number(url.searchParams.get('page') || 1));
    const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get('pageSize') || 50)));
    if (type) qs = qs.filter(q => q.type === type);
    if (status) qs = qs.filter(q => q.review_status === status);
    if (keyword) qs = qs.filter(q => [q.stem, q.chapter, q.explanation, ...(q.options || [])].join(' ').toLowerCase().includes(keyword));
    const total = qs.length;
    qs = qs.slice((page - 1) * pageSize, page * pageSize);
    return json(res, 200, { ok: true, subject_key: subjectKey, total, page, pageSize, questions: qs });
  }

  const questionMatch = url.pathname.match(/^\/api\/subjects\/([^/]+)\/questions\/?([^/]*)$/);
  if (questionMatch && ['POST', 'PUT', 'DELETE'].includes(req.method)) {
    if (!isAuthed(req)) return fail(res, 401, '未授权');
    const subjectKey = safeKey(questionMatch[1]);
    const qid = decodeURIComponent(questionMatch[2] || '');
    const file = questionFile(subjectKey);
    const data = await readJson(file).catch(() => ({ subject_key: subjectKey, questions: [] }));
    data.subject_key = subjectKey;
    data.questions = data.questions || [];

    if (req.method === 'POST') {
      const body = await readBody(req);
      const q = normalizeQuestion(body, subjectKey);
      if (data.questions.some(item => item.id === q.id)) q.id = `${subjectKey}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      data.questions.unshift(q);
      await writeJsonAtomic(file, data);
      await refreshSubjectCount(subjectKey);
      return json(res, 200, { ok: true, question: q });
    }

    const index = data.questions.findIndex(q => q.id === qid);
    if (index < 0) return fail(res, 404, '题目不存在');
    if (req.method === 'PUT') {
      const body = await readBody(req);
      const q = normalizeQuestion({ ...data.questions[index], ...body, id: qid }, subjectKey);
      data.questions[index] = q;
      await writeJsonAtomic(file, data);
      await refreshSubjectCount(subjectKey);
      return json(res, 200, { ok: true, question: q });
    }
    if (req.method === 'DELETE') {
      const [removed] = data.questions.splice(index, 1);
      await writeJsonAtomic(file, data);
      await refreshSubjectCount(subjectKey);
      return json(res, 200, { ok: true, removed });
    }
  }
  return fail(res, 404, '接口不存在');
}
function safeStaticPath(reqPath) {
  const decoded = decodeURIComponent(reqPath.split('?')[0]);
  const target = path.normalize(decoded === '/' ? '/index.html' : decoded).replace(/^[/\\]+/, '');
  const full = path.join(__dirname, target);
  if (!full.startsWith(__dirname)) throw new Error('非法路径');
  return full;
}
async function serveStatic(req, res) {
  let file = safeStaticPath(req.url);
  let stat;
  try { stat = await fs.stat(file); } catch { return fail(res, 404, '文件不存在'); }
  if (stat.isDirectory()) file = path.join(file, 'index.html');
  const ext = path.extname(file).toLowerCase();
  send(res, 200, await fs.readFile(file), { 'content-type': MIME[ext] || 'application/octet-stream' });
}
const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) return await handleApi(req, res);
    return await serveStatic(req, res);
  } catch (error) {
    return fail(res, 500, error.message || '服务器错误');
  }
});
server.listen(PORT, () => console.log(`备考刷题站后端已启动：http://127.0.0.1:${PORT}`));
