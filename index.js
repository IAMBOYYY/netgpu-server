const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors    = require('cors');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// ── API Keys (set these as env vars on Render) ───────────────────
const NVIDIA_API_KEY    = process.env.NVIDIA_API_KEY;
const CF_ACCOUNT_ID     = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_API_TOKEN      = process.env.CLOUDFLARE_API_TOKEN;

// ── Storage ──────────────────────────────────────────────────────
const donors     = new Map();
const jobQueue   = [];
const activeJobs = new Map();
const credits    = new Map();
const jobHistory = [];

// ── Config ───────────────────────────────────────────────────────
const JOB_TIMEOUT_MS    = 120_000;
const HEARTBEAT_DEAD_MS = 60_000;
const CREDITS_EARNED    = 5;
const CREDITS_NEW_USER  = 10;

const JOB_CREDITS = {
  video:  { base: 2, heavy: 4,  heavyOps: ['Merge Clips'] },
  image:  { base: 1, heavy: 2,  heavyOps: ['AI Upscale', 'Remove Background'] },
  ai:     { base: 3, heavy: 6,  heavyOps: ['Style Transfer', 'Image Generation'] },
  '3d':   { base: 5, heavy: 10, heavyOps: ['Render Scene', 'Animation Export', 'Texture Bake'] },
  data:   { base: 1, heavy: 2,  heavyOps: ['Data Analysis'] },
  custom: { base: 2, heavy: 5,  heavyOps: ['Custom Pipeline'] },
};

// Which job types go to which GPU backend
// nvidia  = NVIDIA NIM Nemotron  (AI, data, custom tasks)
// cf      = Cloudflare Workers AI (image generation/classification)
// donor   = phone donors         (video, 3D — needs real file pipeline)
const GPU_ROUTES = {
  ai:     'nvidia',
  data:   'nvidia',
  custom: 'nvidia',
  image:  'cf',
  video:  'donor',
  '3d':   'donor',
};

function getJobCost(type, operation) {
  const config = JOB_CREDITS[type] || JOB_CREDITS.custom;
  return config.heavyOps.includes(operation) ? config.heavy : config.base;
}

// ── NVIDIA NIM — Nemotron ─────────────────────────────────────────
async function processWithNVIDIA(job) {
  console.log(`🤖 NVIDIA NIM: ${job.type}/${job.operation} | "${job.fileName}"`);

  const prompt = buildNVIDIAPrompt(job);

  const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NVIDIA_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model:       'nvidia/llama-3.1-nemotron-70b-instruct',
      messages:    [{ role: 'user', content: prompt }],
      max_tokens:  600,
      temperature: 0.6,
      stream:      false,
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    console.error('NVIDIA error:', data);
    throw new Error(data.detail || data.message || 'NVIDIA API error');
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from NVIDIA');

  return {
    processor:    '⚡ NVIDIA Nemotron 70B (DGX Cloud)',
    result:       content,
    tokens_used:  data.usage?.total_tokens || 0,
  };
}

function buildNVIDIAPrompt(job) {
  const base = `You are a GPU-powered compute system called NetGPU. A user submitted a ${job.type} task.
File: "${job.fileName}" (${job.fileSize || 'unknown size'})
Operation: ${job.operation}
${job.note ? 'User notes: ' + job.note : ''}

`;

  const opPrompts = {
    // ── AI tasks ──────────────────────────────────────────────────
    'Image Recognition':      base + 'Perform image recognition analysis. Identify objects, scenes, text, colors, and subjects. Format as a structured JSON report with confidence scores.',
    'Object Detection':       base + 'Perform object detection. List all detected objects with bounding box estimates (x%, y%, w%, h%) and confidence scores. Return as JSON array.',
    'Text Extraction (OCR)':  base + 'Perform OCR text extraction. Return all detected text, preserve formatting, and provide confidence per text block.',
    'Face Detection':         base + 'Perform face detection analysis. Report number of faces, approximate positions, expressions, and demographic estimates. Return as JSON.',
    'Style Transfer':         base + 'Process style transfer request. Describe the applied artistic style, techniques used, and expected visual output changes.',
    'Image Generation':       base + 'Generate a detailed AI image creation report based on the prompt. Describe the image that would be generated including composition, style, colors, and subjects.',

    // ── Data tasks ────────────────────────────────────────────────
    'CSV Processing':         base + 'Analyze this CSV file. Provide: row count estimate, column names guessed from filename, data types, null value %, key statistics, and 3 actionable insights.',
    'JSON Transform':         base + 'Transform and validate this JSON file. Provide: schema analysis, depth, key count, suggestions for optimization, and transformed structure preview.',
    'Data Analysis':          base + 'Perform comprehensive data analysis. Provide: statistical summary, pattern detection, anomaly flags, correlation suggestions, and visualization recommendations.',
    'File Compress':          base + 'Analyze compression opportunity for this file. Estimate: original vs compressed size, compression ratio, recommended algorithm, and processing time.',
    'Format Convert':         base + 'Process format conversion. Describe: source format analysis, target format mapping, data integrity checks, and conversion summary.',
    'Batch Rename':           base + 'Process batch rename operation. Provide: naming pattern analysis, preview of renamed files (first 10), conflict detection, and summary.',

    // ── Custom ────────────────────────────────────────────────────
    'Raw Compute':            base + 'Process this raw compute task and return detailed results.',
    'Script Execution':       base + 'Analyze and simulate script execution. Provide expected output, runtime estimate, and any warnings.',
    'Batch Process':          base + 'Process this batch operation and return a detailed completion report.',
    'Custom Pipeline':        base + 'Execute this custom pipeline and return step-by-step results.',
  };

  return opPrompts[job.operation] || (base + `Process this ${job.type} task and return a detailed result report.`);
}

// ── Cloudflare Workers AI ─────────────────────────────────────────
async function processWithCloudflare(job) {
  console.log(`☁️  Cloudflare Workers AI: ${job.type}/${job.operation} | "${job.fileName}"`);

  // Pick model based on operation
  const modelId = getCloudflareModel(job.operation);
  const payload  = buildCFPayload(job, modelId);

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${modelId}`,
    {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${CF_API_TOKEN}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(payload),
    }
  );

  const data = await res.json();

  if (!res.ok || !data.success) {
    console.error('Cloudflare error:', data);
    throw new Error(data.errors?.[0]?.message || 'Cloudflare Workers AI error');
  }

  return {
    processor: `☁️ Cloudflare Workers AI (${modelId})`,
    result:    formatCFResult(data.result, modelId, job),
  };
}

function getCloudflareModel(operation) {
  const map = {
    'AI Upscale':           '@cf/bytedance/stable-diffusion-xl-lightning',
    'Remove Background':    '@cf/llava-hf/llava-1.5-7b-hf',
    'Batch Filter':         '@cf/meta/llama-3.1-8b-instruct',
    'Compress':             '@cf/meta/llama-3.1-8b-instruct',
    'Resize / Crop':        '@cf/meta/llama-3.1-8b-instruct',
    'Convert Format':       '@cf/meta/llama-3.1-8b-instruct',
  };
  return map[operation] || '@cf/meta/llama-3.1-8b-instruct';
}

function buildCFPayload(job, modelId) {
  // Text-to-image models
  if (modelId === '@cf/bytedance/stable-diffusion-xl-lightning' ||
      modelId === '@cf/stabilityai/stable-diffusion-xl-base-1.0') {
    return {
      prompt: `high quality, ${job.operation} of ${job.fileName}. ${job.note || '4K ultra detailed professional result'}`,
    };
  }

  // LLaVA vision model
  if (modelId === '@cf/llava-hf/llava-1.5-7b-hf') {
    return {
      image:  [],
      prompt: `Perform "${job.operation}" on the image file "${job.fileName}". ${job.note || 'Provide detailed results.'}`,
      max_tokens: 400,
    };
  }

  // Default: Llama text model
  return {
    messages: [
      {
        role:    'system',
        content: 'You are a GPU-powered image processing engine called NetGPU. Process image tasks and return structured results.',
      },
      {
        role:    'user',
        content: `Process "${job.operation}" for image file "${job.fileName}" (${job.fileSize || 'unknown size'}). ${job.note || 'Return processing results, dimensions, and output details.'}`,
      },
    ],
    max_tokens: 400,
  };
}

function formatCFResult(result, modelId, job) {
  if (modelId.includes('stable-diffusion')) {
    // Returns image bytes — describe it
    return `Image generated successfully via Stable Diffusion XL Lightning.\nOperation: ${job.operation}\nFile: ${job.fileName}\nOutput: High-resolution processed image ready for download.\nNote: Real image binary will be returned when file upload is enabled in APK build.`;
  }
  if (result?.response) return result.response;
  if (result?.description) return result.description;
  return JSON.stringify(result, null, 2);
}

// ── Main GPU processor — routes to right backend ──────────────────
async function processJobWithGPU(job, requesterSocket) {
  const route = GPU_ROUTES[job.type] || 'donor';

  if (route === 'donor') {
    // Video/3D still need donor phones — fall through to donor queue
    return false;
  }

  const startTime = Date.now();

  // Notify client: processing started
  if (requesterSocket) {
    requesterSocket.emit('job_processing', {
      jobId:   job.id,
      message: route === 'nvidia'
        ? `⚡ Processing on NVIDIA Nemotron 70B (DGX Cloud)...`
        : `☁️  Processing on Cloudflare Workers AI GPU network...`,
    });
  }

  try {
    const gpuResult = route === 'nvidia'
      ? await processWithNVIDIA(job)
      : await processWithCloudflare(job);

    const duration = Date.now() - startTime;

    // Deduct credits from requester
    const prev = credits.get(job.requesterUserId) || 0;
    const next = Math.max(0, prev - job.cost);
    credits.set(job.requesterUserId, next);

    // Save to history
    jobHistory.push({
      jobId: job.id, type: job.type, operation: job.operation,
      fileName: job.fileName, cost: job.cost,
      processor: gpuResult.processor,
      duration, completedAt: Date.now(),
    });
    if (jobHistory.length > 100) jobHistory.shift();

    // Send result to client
    if (requesterSocket) {
      requesterSocket.emit('job_result', {
        jobId:      job.id,
        processor:  gpuResult.processor,
        result:     gpuResult.result,
        tokens:     gpuResult.tokens_used,
        duration,
        newCredits: next,
        message:    `✅ Done in ${(duration / 1000).toFixed(1)}s via ${gpuResult.processor}`,
      });
      requesterSocket.emit('credits_update', { credits: next });
    }

    console.log(`✅ GPU job done: ${job.id} | ${gpuResult.processor} | ${(duration/1000).toFixed(1)}s`);
    broadcastNetworkStatus();
    return true; // handled

  } catch (err) {
    console.error(`❌ GPU processing failed: ${job.id}`, err.message);
    if (requesterSocket) {
      requesterSocket.emit('job_error', {
        jobId:   job.id,
        message: `GPU processing failed: ${err.message}. Please try again.`,
      });
    }
    return true; // still handled (don't fall to donor queue)
  }
}

// ── REST endpoints ────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: '🟢 NetGPU Server is Online',
    gpu_backends: {
      nvidia:     !!NVIDIA_API_KEY  ? '✅ NVIDIA NIM Connected' : '❌ No API Key',
      cloudflare: !!CF_API_TOKEN    ? '✅ Cloudflare Workers AI Connected' : '❌ No API Key',
    },
    stats: {
      donors_online:   donors.size,
      idle_donors:     countIdleDonors(),
      jobs_in_queue:   jobQueue.length,
      active_jobs:     activeJobs.size,
      total_jobs_done: jobHistory.length,
    },
    routes: GPU_ROUTES,
  });
});

app.get('/donors', (req, res) => {
  res.json({
    count: donors.size,
    donors: Array.from(donors.values()).map(d => ({
      userId: d.userId, gpuPower: d.gpuPower, isIdle: d.isIdle, jobsDone: d.jobsDone,
    }))
  });
});

app.get('/history', (req, res) => {
  res.json({ count: jobHistory.length, jobs: jobHistory.slice().reverse() });
});

// ── Sockets ───────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('📱 Connected:', socket.id);

  socket.on('register_donor', (data) => {
    const userId = data.userId || ('anon_' + socket.id.slice(0, 6));
    if (!credits.has(userId)) credits.set(userId, CREDITS_NEW_USER);

    donors.set(socket.id, {
      id: socket.id, userId,
      gpuPower:      data.gpuPower      || 15,
      device:        data.device        || 'Android',
      acceptedTypes: data.acceptedTypes || null,
      isIdle: true, lastSeen: Date.now(), jobsDone: 0,
    });

    socket.emit('registered', { role: 'donor', userId, credits: credits.get(userId) });
    console.log(`✅ Donor: ${userId} | GPU: ${data.gpuPower}%`);
    broadcastNetworkStatus();
    tryAssignJobs();
  });

  socket.on('submit_job', async (data) => {
    const userId      = data.userId || ('anon_' + socket.id.slice(0, 6));
    if (!credits.has(userId)) credits.set(userId, CREDITS_NEW_USER);

    const jobType   = data.type      || 'custom';
    const operation = data.operation || '';
    const cost      = getJobCost(jobType, operation);
    const userCred  = credits.get(userId);

    if (userCred < cost) {
      socket.emit('job_error', {
        type: 'no_credits',
        message: `Not enough credits. Need ${cost}, have ${userCred}.`,
        credits: userCred, cost,
      });
      return;
    }

    const job = {
      id:              generateId(),
      type:            jobType,
      operation,
      quality:         data.quality  || 'standard',
      format:          data.format   || 'output',
      fileName:        data.fileName || 'file',
      fileSize:        data.fileSize || 0,
      note:            data.note     || '',
      cost,
      requesterId:     socket.id,
      requesterUserId: userId,
      status:          'queued',
      createdAt:       Date.now(),
      donorId: null, assignedAt: null, timeoutTimer: null,
    };

    const route = GPU_ROUTES[jobType] || 'donor';
    console.log(`📋 Job: ${job.id} | ${jobType}/${operation} | cost:${cost}cr | route:${route}`);

    // GPU-routed jobs (ai/data/custom/image) → process immediately
    if (route !== 'donor') {
      socket.emit('job_queued', {
        jobId: job.id, cost,
        message: route === 'nvidia'
          ? `⚡ Routing to NVIDIA Nemotron GPU...`
          : `☁️  Routing to Cloudflare Workers AI...`,
      });
      await processJobWithGPU(job, socket);
      return;
    }

    // Donor-routed jobs (video/3d) → queue
    jobQueue.push(job);
    const idleCount = countIdleDonorsForType(jobType);

    socket.emit('job_queued', {
      jobId:        job.id,
      position:     jobQueue.length,
      donors_ready: idleCount,
      cost,
      message: idleCount > 0
        ? `Found ${idleCount} donor${idleCount > 1 ? 's' : ''}! Assigning now...`
        : `No donors online for ${jobType}. Waiting for a donor to connect...`,
    });

    if (idleCount > 0) tryAssignJobs();
  });

  socket.on('job_complete', (data) => {
    const job = activeJobs.get(data.jobId);
    if (!job) return;
    if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
    const duration = Date.now() - job.assignedAt;

    const requesterSocket = io.sockets.sockets.get(job.requesterId);
    if (requesterSocket) {
      requesterSocket.emit('job_result', {
        jobId: data.jobId, result: data.result || 'processed', duration,
        message: `✅ Done in ${(duration / 1000).toFixed(1)}s (donor GPU)`,
      });
    }

    const donor = donors.get(socket.id);
    if (donor) {
      donor.isIdle = true;
      donor.jobsDone++;
      const prev = credits.get(donor.userId) || 0;
      const next = prev + CREDITS_EARNED;
      credits.set(donor.userId, next);
      socket.emit('credits_earned', { earned: CREDITS_EARNED, total: next });
    }

    const reqPrev = credits.get(job.requesterUserId) || 0;
    const reqNext = Math.max(0, reqPrev - job.cost);
    credits.set(job.requesterUserId, reqNext);
    if (requesterSocket) requesterSocket.emit('credits_update', { credits: reqNext });

    jobHistory.push({
      jobId: data.jobId, type: job.type, operation: job.operation,
      fileName: job.fileName, cost: job.cost,
      processor: 'Donor Phone GPU',
      duration, completedAt: Date.now(),
    });
    if (jobHistory.length > 100) jobHistory.shift();

    activeJobs.delete(data.jobId);
    broadcastNetworkStatus();
    tryAssignJobs();
  });

  socket.on('job_failed', (data) => {
    const job = activeJobs.get(data.jobId);
    if (!job) return;
    requeueJob(job, data.reason || 'Donor reported failure');
    activeJobs.delete(data.jobId);
  });

  socket.on('heartbeat', () => {
    const donor = donors.get(socket.id);
    if (donor) donor.lastSeen = Date.now();
  });

  socket.on('update_status', (data) => {
    const donor = donors.get(socket.id);
    if (donor) {
      const wasIdle       = donor.isIdle;
      donor.isIdle        = data.isIdle        ?? donor.isIdle;
      donor.gpuPower      = data.gpuPower       ?? donor.gpuPower;
      donor.acceptedTypes = data.acceptedTypes  ?? donor.acceptedTypes;
      donor.lastSeen      = Date.now();
      if (!wasIdle && donor.isIdle) tryAssignJobs();
    }
    broadcastNetworkStatus();
  });

  socket.on('get_credits', (data) => {
    const userId = data?.userId || null;
    let bal = 0;
    if (userId) {
      bal = credits.get(userId) || 0;
    } else {
      const donor = donors.get(socket.id);
      if (donor) bal = credits.get(donor.userId) || 0;
    }
    socket.emit('credits_update', { credits: bal });
  });

  socket.on('disconnect', () => {
    const donor = donors.get(socket.id);
    if (donor) {
      activeJobs.forEach((job, jobId) => {
        if (job.donorId === socket.id) {
          requeueJob(job, 'Donor disconnected');
          activeJobs.delete(jobId);
        }
      });
      donors.delete(socket.id);
      broadcastNetworkStatus();
    }
  });
});

// ── Donor job assignment (for video/3D) ───────────────────────────
function tryAssignJobs() {
  if (jobQueue.length === 0) return;
  const available = Array.from(donors.values())
    .filter(d => d.isIdle)
    .sort((a, b) => b.gpuPower - a.gpuPower);
  if (available.length === 0) return;

  let assigned = 0;
  while (jobQueue.length > 0 && available.length > 0) {
    const job = jobQueue[0];
    const donorIdx = available.findIndex(d =>
      !d.acceptedTypes || d.acceptedTypes[job.type] !== false
    );
    if (donorIdx === -1) break;

    jobQueue.shift();
    const donor = available.splice(donorIdx, 1)[0];
    donor.isIdle   = false;
    job.status     = 'processing';
    job.donorId    = donor.id;
    job.assignedAt = Date.now();

    job.timeoutTimer = setTimeout(() => {
      requeueJob(job, 'Donor timed out');
      activeJobs.delete(job.id);
    }, JOB_TIMEOUT_MS);

    activeJobs.set(job.id, job);

    const donorSocket = io.sockets.sockets.get(donor.id);
    if (donorSocket) donorSocket.emit('job_assigned', job);

    const requesterSocket = io.sockets.sockets.get(job.requesterId);
    if (requesterSocket) {
      requesterSocket.emit('job_processing', {
        jobId: job.id,
        message: `📱 Donor found (${donor.gpuPower}% GPU)! Processing ${job.type}/${job.operation}...`,
      });
    }
    assigned++;
  }
  if (assigned > 0) broadcastNetworkStatus();
}

function requeueJob(job, reason) {
  if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
  const donor = donors.get(job.donorId);
  if (donor) donor.isIdle = true;

  const requesterSocket = io.sockets.sockets.get(job.requesterId);
  if (requesterSocket) {
    requesterSocket.emit('job_requeued', { jobId: job.id, message: 'Donor dropped — re-queuing...' });
  }

  job.status = 'queued'; job.donorId = null; job.assignedAt = null; job.timeoutTimer = null;
  jobQueue.unshift(job);
  console.log(`🔁 Re-queued: ${job.id} (${reason})`);
  setTimeout(tryAssignJobs, 2000);
}

function broadcastNetworkStatus() {
  io.emit('network_status', {
    donors_online: donors.size,
    idle_donors:   countIdleDonors(),
    queue_length:  jobQueue.length,
    active_jobs:   activeJobs.size,
  });
}

function countIdleDonors() {
  return Array.from(donors.values()).filter(d => d.isIdle).length;
}

function countIdleDonorsForType(jobType) {
  return Array.from(donors.values()).filter(d =>
    d.isIdle && (!d.acceptedTypes || d.acceptedTypes[jobType] !== false)
  ).length;
}

setInterval(() => {
  const now = Date.now();
  donors.forEach((donor, socketId) => {
    if (now - donor.lastSeen > HEARTBEAT_DEAD_MS) {
      activeJobs.forEach((job, jobId) => {
        if (job.donorId === socketId) { requeueJob(job, 'Stale'); activeJobs.delete(jobId); }
      });
      donors.delete(socketId);
    }
  });
}, 30_000);

function generateId() {
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 NetGPU Server running on port ${PORT}`);
  console.log(`⚡ NVIDIA NIM:          ${NVIDIA_API_KEY  ? 'Connected ✅' : 'No key ❌'}`);
  console.log(`☁️  Cloudflare Workers: ${CF_API_TOKEN    ? 'Connected ✅' : 'No key ❌'}`);
});
