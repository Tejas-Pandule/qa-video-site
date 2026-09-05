const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SUPABASE_BUCKET || 'qa-videos';
const MAX_VIDEO_MB = Number(process.env.MAX_VIDEO_MB || 50);

if (!ADMIN_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing required environment variables: ADMIN_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const allowedOrigins = (process.env.FRONTEND_URL || '*')
  .split(',').map(v => v.trim()).filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('CORS origin not allowed'));
  }
}));
app.use(express.json({ limit: '1mb' }));

const ALLOWED_TYPES = new Set(['video/mp4', 'video/webm', 'video/ogg']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => ALLOWED_TYPES.has(file.mimetype)
    ? cb(null, true)
    : cb(new Error('Only mp4, webm, or ogg video files are allowed.'))
});

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Invalid or missing admin token.' });
  }
  next();
}

function publicVideoUrl(videoPath) {
  return supabase.storage.from(BUCKET).getPublicUrl(videoPath).data.publicUrl;
}

function toApiQuestion(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    questionNumber: row.question_number,
    question: row.question,
    note: row.note || '',
    videoFile: row.video_path ? path.basename(row.video_path) : '',
    videoPath: row.video_path,
    videoUrl: row.video_path ? publicVideoUrl(row.video_path) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseProjectId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id >= 1 ? id : null;
}

function parseQuestionNumber(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : null;
}

async function ensureBucket() {
  const { data: buckets, error: listError } = await supabase.storage.listBuckets();
  if (listError) throw listError;
  const existing = buckets.find(b => b.name === BUCKET);
  if (!existing) {
    const { error } = await supabase.storage.createBucket(BUCKET, {
      public: true,
      fileSizeLimit: `${MAX_VIDEO_MB}MB`,
      allowedMimeTypes: Array.from(ALLOWED_TYPES)
    });
    if (error && !/already exists/i.test(error.message || '')) throw error;
  }
}

async function getProjects() {
  const { data, error } = await supabase.from('projects')
    .select('id, name, display_order')
    .order('display_order', { ascending: true });
  if (error) throw error;
  return data;
}

async function getQuestions(projectId) {
  const { data, error } = await supabase.from('questions')
    .select('id, project_id, question_number, question, note, video_path, created_at, updated_at')
    .eq('project_id', projectId)
    .order('question_number', { ascending: true });
  if (error) throw error;
  return data.map(toApiQuestion);
}

async function getQuestion(id) {
  const { data, error } = await supabase.from('questions')
    .select('id, project_id, question_number, question, note, video_path, created_at, updated_at')
    .eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.get('/api/projects', async (req, res, next) => {
  try { res.json(await getProjects()); } catch (err) { next(err); }
});

app.get('/api/projects/:projectId/questions', async (req, res, next) => {
  try {
    const projectId = parseProjectId(req.params.projectId);
    if (!projectId) return res.status(400).json({ error: 'Invalid project id.' });
    res.json(await getQuestions(projectId));
  } catch (err) { next(err); }
});

app.post('/api/admin/verify', (req, res) => {
  if ((req.body || {}).token === ADMIN_TOKEN) return res.json({ valid: true });
  res.status(401).json({ valid: false });
});

app.post('/api/projects/:projectId/questions', requireAdmin, upload.single('video'), async (req, res, next) => {
  let uploadedPath = null;
  try {
    const projectId = parseProjectId(req.params.projectId);
    const questionNumber = parseQuestionNumber(req.body.questionNumber);
    if (!projectId || !questionNumber) return res.status(400).json({ error: 'Project and question number (1-10) are required.' });

    const { data: project, error: projectError } = await supabase.from('projects').select('id').eq('id', projectId).maybeSingle();
    if (projectError) throw projectError;
    if (!project) return res.status(404).json({ error: 'Project not found.' });

    const question = String(req.body.question || '').trim();
    const note = String(req.body.note || '').trim();
    if (!question) return res.status(400).json({ error: 'Question text is required.' });
    if (!req.file) return res.status(400).json({ error: 'A video file is required.' });

    const { data: existing, error: existingError } = await supabase.from('questions')
      .select('id, video_path').eq('project_id', projectId).eq('question_number', questionNumber).maybeSingle();
    if (existingError) throw existingError;
    if (existing) return res.status(409).json({ error: 'This question slot already exists. Use Edit/Replace instead.' });

    uploadedPath = `${projectId}/${uuidv4()}${path.extname(req.file.originalname) || '.mp4'}`;
    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(uploadedPath, req.file.buffer, {
      contentType: req.file.mimetype, upsert: false, cacheControl: '31536000'
    });
    if (uploadError) throw uploadError;

    const { data, error: insertError } = await supabase.from('questions')
      .insert({ project_id: projectId, question_number: questionNumber, question, note, video_path: uploadedPath })
      .select('id, project_id, question_number, question, note, video_path, created_at, updated_at').single();
    if (insertError) {
      await supabase.storage.from(BUCKET).remove([uploadedPath]);
      throw insertError;
    }
    res.status(201).json(toApiQuestion(data));
  } catch (err) { next(err); }
});

app.put('/api/questions/:id', requireAdmin, upload.single('video'), async (req, res, next) => {
  let newPath = null;
  try {
    const existing = await getQuestion(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Question not found.' });

    const patch = {};
    if (req.body.question !== undefined) {
      const question = String(req.body.question).trim();
      if (!question) return res.status(400).json({ error: 'Question text cannot be empty.' });
      patch.question = question;
    }
    if (req.body.note !== undefined) patch.note = String(req.body.note).trim();

    if (req.file) {
      newPath = `${existing.project_id}/${uuidv4()}${path.extname(req.file.originalname) || '.mp4'}`;
      const { error } = await supabase.storage.from(BUCKET).upload(newPath, req.file.buffer, {
        contentType: req.file.mimetype, upsert: false, cacheControl: '31536000'
      });
      if (error) throw error;
      patch.video_path = newPath;
    }

    const { data: updated, error: updateError } = await supabase.from('questions')
      .update(patch).eq('id', req.params.id)
      .select('id, project_id, question_number, question, note, video_path, created_at, updated_at').single();
    if (updateError) {
      if (newPath) await supabase.storage.from(BUCKET).remove([newPath]);
      throw updateError;
    }
    if (newPath && existing.video_path) await supabase.storage.from(BUCKET).remove([existing.video_path]);
    res.json(toApiQuestion(updated));
  } catch (err) { next(err); }
});

app.delete('/api/questions/:id', requireAdmin, async (req, res, next) => {
  try {
    const existing = await getQuestion(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Question not found.' });

    const { error: deleteError } = await supabase.from('questions').delete().eq('id', req.params.id);
    if (deleteError) throw deleteError;
    if (existing.video_path) {
      const { error } = await supabase.storage.from(BUCKET).remove([existing.video_path]);
      if (error) console.error('Storage cleanup failed:', error.message);
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

app.use((err, req, res, next) => {
  console.error(err);
  const message = err instanceof multer.MulterError
    ? (err.code === 'LIMIT_FILE_SIZE' ? `Video is too large. Maximum is ${MAX_VIDEO_MB}MB.` : err.message)
    : (err.message || 'Something went wrong.');
  const status = /CORS origin not allowed/i.test(message) ? 403 : 400;
  res.status(status).json({ error: message });
});

(async () => {
  try {
    await ensureBucket();
    app.listen(PORT, '0.0.0.0', () => console.log(`API listening on port ${PORT}`));
  } catch (err) {
    console.error('Startup failed:', err);
    process.exit(1);
  }
})();
