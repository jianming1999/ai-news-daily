import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3001);
const DATA_DIR = path.join(__dirname, 'data');
const QUESTIONS_DIR = path.join(DATA_DIR, 'questions');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const sessions = new Map();

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
function json(res, status, data, headers = {}) { send(res, status, JSON.stringify(data), { 'content-type': 'application/json; charset=utf-8', ...headers }); }
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
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.createHash('sha256').update(salt + password).digest('hex') };
}
function publicUser(user) {
  return { id: user.id, username: user.username, role: user.role || 'editor', status: user.status || 'active', created_at: user.created_at, updated_at: user.updated_at, last_login_at: user.last_login_at || '' };
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1));
  }
  return out;
}
async function findSessionUser(req) {
  const sid = parseCookies(req).exam_admin_sid;
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session || session.expiresAt < Date.now()) { sessions.delete(sid); return null; }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  const db = await readJson(USERS_FILE).catch(() => ({ users: [] }));
  const user = (db.users || []).find(u => u.id === session.userId && u.status !== 'disabled');
  return user || null;
}
async function requireAuth(req, res) {
  const user = await findSessionUser(req);
  if (!user) { fail(res, 401, '请先登录'); return null; }
  return user;
}
async function requireAdmin(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return null;
  if (user.role !== 'admin') { fail(res, 403, '需要管理员权限'); return null; }
  return user;
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
async function handleAuth(req, res, url) {
  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await readBody(req);
    const db = await readJson(USERS_FILE).catch(() => ({ users: [] }));
    const user = (db.users || []).find(u => u.username === String(body.username || '').trim() && u.status !== 'disabled');
    if (!user) return fail(res, 401, '账号或密码错误');
    const hashed = hashPassword(String(body.password || ''), user.password_salt);
    if (hashed.hash !== user.password_hash) return fail(res, 401, '账号或密码错误');
    user.last_login_at = new Date().toISOString();
    await writeJsonAtomic(USERS_FILE, db);
    const sid = crypto.randomBytes(32).toString('hex');
    sessions.set(sid, { userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS });
    return json(res, 200, { ok: true, user: publicUser(user) }, { 'set-cookie': `exam_admin_sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}` });
  }
  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    const sid = parseCookies(req).exam_admin_sid;
    if (sid) sessions.delete(sid);
    return json(res, 200, { ok: true }, { 'set-cookie': 'exam_admin_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  }
  if (url.pathname === '/api/auth/me' && req.method === 'GET') {
    const user = await findSessionUser(req);
    return json(res, 200, { ok: true, user: user ? publicUser(user) : null });
  }
  return false;
}
async function handleUsers(req, res, url) {
  if (url.pathname === '/api/admin/users' && req.method === 'GET') {
    if (!await requireAdmin(req, res)) return true;
    const db = await readJson(USERS_FILE).catch(() => ({ users: [] }));
    return json(res, 200, { ok: true, users: (db.users || []).map(publicUser) });
  }
  if (url.pathname === '/api/admin/users' && req.method === 'POST') {
    if (!await requireAdmin(req, res)) return true;
    const body = await readBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '').trim();
    if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) return fail(res, 400, '用户名需为3-32位字母数字下划线或横线');
    if (password.length < 8) return fail(res, 400, '密码至少8位');
    const db = await readJson(USERS_FILE).catch(() => ({ users: [] }));
    if ((db.users || []).some(u => u.username === username)) return fail(res, 409, '用户名已存在');
    const hp = hashPassword(password);
    const now = new Date().toISOString();
    const user = { id: crypto.randomUUID(), username, password_salt: hp.salt, password_hash: hp.hash, role: body.role === 'admin' ? 'admin' : 'editor', status: body.status === 'disabled' ? 'disabled' : 'active', created_at: now, updated_at: now };
    db.users = db.users || [];
    db.users.push(user);
    await writeJsonAtomic(USERS_FILE, db);
    return json(res, 200, { ok: true, user: publicUser(user) });
  }
  const match = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (match && req.method === 'PUT') {
    const actor = await requireAdmin(req, res); if (!actor) return true;
    const body = await readBody(req);
    const db = await readJson(USERS_FILE).catch(() => ({ users: [] }));
    const user = (db.users || []).find(u => u.id === decodeURIComponent(match[1]));
    if (!user) return fail(res, 404, '用户不存在');
    if (body.role) user.role = body.role === 'admin' ? 'admin' : 'editor';
    if (body.status) user.status = body.status === 'disabled' ? 'disabled' : 'active';
    if (body.password) {
      if (String(body.password).length < 8) return fail(res, 400, '密码至少8位');
      const hp = hashPassword(String(body.password));
      user.password_salt = hp.salt; user.password_hash = hp.hash;
    }
    user.updated_at = new Date().toISOString();
    await writeJsonAtomic(USERS_FILE, db);
    return json(res, 200, { ok: true, user: publicUser(user) });
  }
  if (match && req.method === 'DELETE') {
    const actor = await requireAdmin(req, res); if (!actor) return true;
    const db = await readJson(USERS_FILE).catch(() => ({ users: [] }));
    const id = decodeURIComponent(match[1]);
    if (actor.id === id) return fail(res, 400, '不能删除当前登录用户');
    const before = db.users.length;
    db.users = (db.users || []).filter(u => u.id !== id);
    if (db.users.length === before) return fail(res, 404, '用户不存在');
    await writeJsonAtomic(USERS_FILE, db);
    return json(res, 200, { ok: true });
  }
  return false;
}
async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const authHandled = await handleAuth(req, res, url);
  if (authHandled !== false) return;
  const userHandled = await handleUsers(req, res, url);
  if (userHandled !== false) return;
  if (url.pathname === '/api/health') return json(res, 200, { ok: true, time: new Date().toISOString(), auth: true });
  if (url.pathname === '/api/subjects' && req.method === 'GET') return json(res, 200, await readJson(path.join(DATA_DIR, 'subjects.json')));

  if (url.pathname === '/api/admin/backup' && req.method === 'POST') {
    if (!await requireAuth(req, res)) return;
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
    if (!await requireAuth(req, res)) return;
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
