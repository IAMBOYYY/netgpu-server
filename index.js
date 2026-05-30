const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT              = process.env.PORT || 10000;
const NVIDIA_API_KEY    = process.env.NVIDIA_API_KEY;
const CF_ACCOUNT_ID     = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_API_TOKEN      = process.env.CLOUDFLARE_API_TOKEN;

const GPU_ROUTES = {
  ai:     'nvidia',
  data:   'nvidia',
  custom: 'nvidia',
  image:  'cloudflare',
  video:  'donor',
  '3d':   'donor',
};

const CREDIT_COSTS = {
  ai:     1,
  image:  1,
  video:  2,
  data:   1,
  custom: 2,
  '3d':   4,
};

// ─── State ────────────────────────────────────────────────────────────────────
const donors     = new Map();   // socketId → donor info
const credits    = new Map();   // userId   → credit balance
const jobQueue   = [];          // pending jobs waiting for a donor
const activeJobs = new Map();   // jobId    → full job object (ALL jobs ever)

let totalJobsDone = 0;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getCredits(userId) {
  if (!credits.has(userId)) credits.set(userId, 10); // 10 free starter credits
  return credits.get(userId);
}

function generateId(prefix = 'job') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

function getBestDonor(jobType) {
  let best = null;
  let bestPower = 0;
  for (const [, donor] of donors) {
    if (
      donor.isIdle &&
      donor.socket?.connected &&
      (!donor.acceptedTypes || donor.acceptedTypes[jobType] !== false) &&
      donor.gpuPower > bestPower
    ) {
      best = donor;
      bestPower = donor.gpuPower;
    }
  }
  return best;
}

// ─── NVIDIA NIM ───────────────────────────────────────────────────────────────
async function processWithNVIDIA(job) {
  const prompt = `Process this ${job.type} task: ${job.operation || job.type}. File: ${job.fileName || 'input'}. Provide a brief result summary.`;

  const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${NVIDIA_API_KEY}`,
    },
    body: JSON.stringify({
      model:       'nvidia/llama-3.1-nemotron-70b-instruct',
      max_tokens:  256,
      temperature: 0.7,
      messages: [
        { role: 'system', content: 'You are a GPU compute processor. Be concise.' },
        { role: 'user',   content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`NVIDIA API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || 'Processed successfully.';
}

// ─── Cloudflare Workers AI ────────────────────────────────────────────────────
async function processWithCloudflare(job) {
  const model    = '@cf/stabilityai/stable-diffusion-xl-base-1.0';
  const prompt   = `${job.operation || 'process'}: ${job.fileName || 'image'}`;

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${model}`,
    {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${CF_API_TOKEN}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ prompt }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Cloudflare API error ${response.status}: ${err}`);
  }

  return `Image processed via Cloudflare Workers AI. Operation: ${job.operation || 'transform'} complete.`;
}

// ─── Job Processor ────────────────────────────────────────────────────────────
async function processJob(job) {
  const start    = Date.now();
  const jobObj   = activeJobs.get(job.id);
  if (!jobObj) return;

  jobObj.status = 'processing';
  jobObj.startedAt = Date.now();

  // Notify requester
  const requesterSocket = io.sockets.sockets.get(job.socketId);
  if (requesterSocket) {
    requesterSocket.emit('job_processing', {
      jobId:   job.id,
      message: `Processing on ${jobObj.processor === 'nvidia' ? '⚡ NVIDIA NIM' : '☁️ Cloudflare'} GPU...`,
    });
  }

  try {
    let result;
    if (jobObj.processor === 'nvidia') {
      result = await processWithNVIDIA(job);
    } else if (jobObj.processor === 'cloudflare') {
      result = await processWithCloudflare(job);
    } else {
      result = 'Queued for donor processing.';
    }

    const duration = Date.now() - start;

    // Update job record
    jobObj.status   = 'completed';
    jobObj.result   = result;
    jobObj.duration = duration;
    jobObj.completedAt = Date.now();
    totalJobsDone++;

    // Deduct credits from requester
    const currentCredits = getCredits(job.userId);
    credits.set(job.userId, Math.max(0, currentCredits - (job.creditCost || 1)));

    // Notify requester
    if (requesterSocket) {
      requesterSocket.emit('job_result', {
        jobId:    job.id,
        result,
        duration,
        message:  `✅ Job complete in ${(duration / 1000).toFixed(1)}s`,
        credits:  getCredits(job.userId),
      });
      requesterSocket.emit('credits_update', { credits: getCredits(job.userId) });
    }

    console.log(`✅ Job done: ${job.id} | ${job.type} | ${(duration / 1000).toFixed(1)}s`);

  } catch (err) {
    console.error(`❌ Job failed: ${job.id}`, err.message);

    jobObj.status = 'failed';
    jobObj.error  = err.message;

    if (requesterSocket) {
      requesterSocket.emit('job_error', {
        jobId:   job.id,
        message: `❌ Processing failed: ${err.message}`,
        credits: getCredits(job.userId),
      });
    }
  }
}

// ─── Donor Job Assignment ─────────────────────────────────────────────────────
function tryAssignQueuedJobs() {
  for (let i = jobQueue.length - 1; i >= 0; i--) {
    const job    = jobQueue[i];
    const jobObj = activeJobs.get(job.id);

    // Skip cancelled jobs
    if (!jobObj || jobObj.status === 'cancelled') {
      jobQueue.splice(i, 1);
      continue;
    }

    const donor = getBestDonor(job.type);
    if (donor) {
      jobQueue.splice(i, 1);
      jobObj.status  = 'processing';
      jobObj.donorId = donor.userId;

      donor.isIdle     = false;
      donor.currentJob = job.id;

      donor.socket.emit('job_assigned', {
        id:        job.id,
        type:      job.type,
        operation: job.operation,
        fileName:  job.fileName,
        fileSize:  job.fileSize,
      });

      // Timeout: re-queue if donor doesn't complete in 2 min
      setTimeout(() => {
        const j = activeJobs.get(job.id);
        if (j && j.status === 'processing') {
          j.status = 'queued';
          jobQueue.push(job);
          donor.isIdle     = true;
          donor.currentJob = null;
          const s = io.sockets.sockets.get(job.socketId);
          if (s) s.emit('job_requeued', { jobId: job.id, message: '⚠️ Donor timed out — requeued.' });
          console.log(`⚠️ Job requeued (donor timeout): ${job.id}`);
        }
      }, 120000);

      const s = io.sockets.sockets.get(job.socketId);
      if (s) s.emit('job_processing', { jobId: job.id, message: `⚡ Donor GPU assigned (${donor.gpuPower}% power)` });

      console.log(`📱 Job assigned to donor: ${job.id} → ${donor.userId}`);
    }
  }
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`🔌 Connected: ${socket.id}`);

  // ── Register as donor ──────────────────────────────────────────────────────
  socket.on('register_donor', (data) => {
    const userId = data.userId || socket.id;
    donors.set(socket.id, {
      socket,
      socketId:      socket.id,
      userId,
      gpuPower:      data.gpuPower || 15,
      device:        data.device   || 'Unknown',
      acceptedTypes: data.acceptedTypes || null,
      isIdle:        true,
      currentJob:    null,
      joinedAt:      Date.now(),
    });

    socket.emit('registered', {
      role:    'donor',
      userId,
      credits: getCredits(userId),
    });

    console.log(`✅ Donor online: ${userId} | GPU: ${data.gpuPower}%`);
    tryAssignQueuedJobs();

    io.emit('network_status', getNetworkStats());
  });

  // ── Submit job ─────────────────────────────────────────────────────────────
  socket.on('submit_job', (data) => {
    const userId     = data.userId || socket.id;
    const jobType    = data.type   || 'ai';
    const creditCost = data.creditCost || CREDIT_COSTS[jobType] || 1;
    const userCreds  = getCredits(userId);

    if (userCreds < creditCost) {
      socket.emit('job_error', {
        type:    'insufficient_credits',
        message: `❌ Not enough credits. Need ${creditCost}, have ${userCreds}.`,
        credits: userCreds,
      });
      return;
    }

    const jobId = generateId('job');
    const processor = GPU_ROUTES[jobType] || 'donor';

    const job = {
      id:          jobId,
      socketId:    socket.id,
      userId,
      type:        jobType,
      operation:   data.operation || '',
      fileName:    data.fileName  || 'unknown',
      fileSize:    data.fileSize  || '0',
      creditCost,
      processor,
      status:      'queued',
      timestamp:   Date.now(),
      result:      null,
      duration:    null,
      credits_cost: creditCost,
    };

    activeJobs.set(jobId, job);

    socket.emit('job_queued', {
      jobId,
      position:     jobQueue.length + 1,
      message:      `⏳ Job queued — routing to ${processor === 'nvidia' ? '⚡ NVIDIA NIM' : processor === 'cloudflare' ? '☁️ Cloudflare' : '📱 Donor'}`,
      has_donors:   donors.size > 0,
      donors_ready: getBestDonor(jobType) !== null,
    });

    console.log(`📥 Job submitted: ${jobId} | ${jobType} | ${processor} | User: ${userId}`);

    if (processor === 'nvidia' || processor === 'cloudflare') {
      // Process immediately on GPU backend
      processJob(job);
    } else {
      // Queue for donor
      jobQueue.push(job);
      tryAssignQueuedJobs();
    }

    io.emit('network_status', getNetworkStats());
  });

  // ── Cancel job ─────────────────────────────────────────────────────────────
  socket.on('cancel_job', ({ jobId }) => {
    const job = activeJobs.get(jobId);
    if (!job) return;

    if (job.status === 'queued' || job.status === 'processing') {
      job.status = 'cancelled';

      // Remove from queue if still there
      const idx = jobQueue.findIndex(j => j.id === jobId);
      if (idx !== -1) jobQueue.splice(idx, 1);

      // Free up donor if assigned
      for (const [, donor] of donors) {
        if (donor.currentJob === jobId) {
          donor.isIdle     = true;
          donor.currentJob = null;
          donor.socket.emit('job_cancelled', { jobId });
        }
      }

      socket.emit('job_cancelled', { jobId });
      console.log(`🚫 Job cancelled: ${jobId}`);
      io.emit('network_status', getNetworkStats());
    }
  });

  // ── Donor: job complete ────────────────────────────────────────────────────
  socket.on('job_complete', ({ jobId, result }) => {
    const job    = activeJobs.get(jobId);
    const donor  = donors.get(socket.id);
    if (!job || !donor) return;

    const duration = Date.now() - (job.startedAt || job.timestamp);
    job.status     = 'completed';
    job.result     = result || 'Processed successfully.';
    job.duration   = duration;
    job.completedAt = Date.now();
    totalJobsDone++;

    donor.isIdle     = true;
    donor.currentJob = null;

    // Pay donor
    const donorCreds = getCredits(donor.userId);
    credits.set(donor.userId, donorCreds + 5);
    donor.socket.emit('credits_earned', { earned: 5, total: getCredits(donor.userId) });
    donor.socket.emit('credits_update',  { credits: getCredits(donor.userId) });

    // Deduct from requester
    const requesterCreds = getCredits(job.userId);
    credits.set(job.userId, Math.max(0, requesterCreds - job.creditCost));

    // Notify requester
    const requesterSocket = io.sockets.sockets.get(job.socketId);
    if (requesterSocket) {
      requesterSocket.emit('job_result', {
        jobId,
        result:   job.result,
        duration,
        message:  `✅ Job complete in ${(duration / 1000).toFixed(1)}s`,
        credits:  getCredits(job.userId),
      });
      requesterSocket.emit('credits_update', { credits: getCredits(job.userId) });
    }

    console.log(`✅ Donor completed job: ${jobId}`);
    tryAssignQueuedJobs();
    io.emit('network_status', getNetworkStats());
  });

  // ── Donor: job failed ──────────────────────────────────────────────────────
  socket.on('job_failed', ({ jobId, reason }) => {
    const job   = activeJobs.get(jobId);
    const donor = donors.get(socket.id);
    if (!job) return;

    job.status = 'failed';
    job.error  = reason || 'Donor reported failure';

    if (donor) {
      donor.isIdle     = true;
      donor.currentJob = null;
    }

    const requesterSocket = io.sockets.sockets.get(job.socketId);
    if (requesterSocket) {
      requesterSocket.emit('job_error', {
        jobId,
        message: `❌ Job failed: ${reason || 'Unknown error'}`,
        credits: getCredits(job.userId),
      });
    }

    console.log(`❌ Donor job failed: ${jobId} | ${reason}`);
    tryAssignQueuedJobs();
    io.emit('network_status', getNetworkStats());
  });

  // ── Heartbeat ──────────────────────────────────────────────────────────────
  socket.on('heartbeat', () => {
    socket.emit('heartbeat_ack', { ts: Date.now() });
  });

  // ── Update donor status ────────────────────────────────────────────────────
  socket.on('update_status', ({ isIdle, gpuPower }) => {
    const donor = donors.get(socket.id);
    if (donor) {
      donor.isIdle    = isIdle;
      donor.gpuPower  = gpuPower || donor.gpuPower;
    }
    if (isIdle) tryAssignQueuedJobs();
    io.emit('network_status', getNetworkStats());
  });

  // ── Get credits ────────────────────────────────────────────────────────────
  socket.on('get_credits', ({ userId }) => {
    socket.emit('credits_update', { credits: getCredits(userId || socket.id) });
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const donor = donors.get(socket.id);
    if (donor) {
      // Re-queue any active job
      if (donor.currentJob) {
        const job = activeJobs.get(donor.currentJob);
        if (job && job.status === 'processing') {
          job.status = 'queued';
          jobQueue.push(job);
          const s = io.sockets.sockets.get(job.socketId);
          if (s) s.emit('job_requeued', { jobId: job.id, message: '⚠️ Donor disconnected — requeued.' });
        }
      }
      donors.delete(socket.id);
      console.log(`🔴 Donor offline: ${donor.userId}`);
      io.emit('network_status', getNetworkStats());
    }
    console.log(`❌ Disconnected: ${socket.id}`);
  });
});

// ─── Network Stats ────────────────────────────────────────────────────────────
function getNetworkStats() {
  const idleDonors = Array.from(donors.values()).filter(d => d.isIdle).length;
  return {
    donors_online:   donors.size,
    idle_donors:     idleDonors,
    jobs_in_queue:   jobQueue.filter(j => activeJobs.get(j.id)?.status === 'queued').length,
    active_jobs:     Array.from(activeJobs.values()).filter(j => j.status === 'processing').length,
    total_jobs_done: totalJobsDone,
  };
}

// ─── REST Endpoints ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const nvidiaOk     = !!NVIDIA_API_KEY;
  const cloudflareOk = !!CF_ACCOUNT_ID && !!CF_API_TOKEN;

  res.json({
    status:       '🟢 NetGPU Server is Online',
    gpu_backends: {
      nvidia:     nvidiaOk     ? '✅ NVIDIA NIM Connected'          : '❌ NVIDIA_API_KEY missing',
      cloudflare: cloudflareOk ? '✅ Cloudflare Workers AI Connected' : '❌ Cloudflare keys missing',
    },
    stats:  getNetworkStats(),
    routes: GPU_ROUTES,
  });
});

app.get('/donors', (req, res) => {
  const list = Array.from(donors.values()).map(d => ({
    userId:   d.userId,
    gpuPower: d.gpuPower,
    device:   d.device,
    isIdle:   d.isIdle,
    joinedAt: d.joinedAt,
  }));
  res.json({ donors: list, total: list.length });
});

app.get('/history', (req, res) => {
  const all = Array.from(activeJobs.values())
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 100);
  res.json({ jobs: all, total: all.length });
});

app.get('/queue', (req, res) => {
  const queued = jobQueue
    .map(j => activeJobs.get(j.id))
    .filter(Boolean)
    .filter(j => j.status === 'queued');
  res.json({ queue: queued, length: queued.length });
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('/////////////////////////////////////////////////////');
  console.log(`🚀 NetGPU Server running on port ${PORT}`);
  console.log(`⚡ NVIDIA NIM:           ${NVIDIA_API_KEY     ? 'Connected ✅' : 'Missing key ❌'}`);
  console.log(`☁️  Cloudflare Workers:  ${CF_ACCOUNT_ID && CF_API_TOKEN ? 'Connected ✅' : 'Missing keys ❌'}`);
  console.log('/////////////////////////////////////////////////////');
});
