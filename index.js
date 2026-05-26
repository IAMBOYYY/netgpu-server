const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors    = require('cors');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// ── Storage ──────────────────────────────────────────────────────
const donors     = new Map(); // socketId → donor info
const jobQueue   = [];
const activeJobs = new Map();
const credits    = new Map();
const jobHistory = [];

// ── Config ───────────────────────────────────────────────────────
const JOB_TIMEOUT_MS    = 120_000;
const HEARTBEAT_DEAD_MS = 60_000;
const CREDITS_EARNED    = 5;
const CREDITS_NEW_USER  = 10;

// Variable credit cost per job type + operation heaviness
const JOB_CREDITS = {
  video:  { base: 2, heavy: 4,  heavyOps: ['Merge Clips'] },
  image:  { base: 1, heavy: 2,  heavyOps: ['AI Upscale', 'Remove Background'] },
  ai:     { base: 3, heavy: 6,  heavyOps: ['Style Transfer', 'Image Generation'] },
  '3d':   { base: 5, heavy: 10, heavyOps: ['Render Scene', 'Animation Export', 'Texture Bake'] },
  data:   { base: 1, heavy: 2,  heavyOps: ['Data Analysis'] },
  custom: { base: 2, heavy: 5,  heavyOps: ['Custom Pipeline'] },
};

function getJobCost(type, operation) {
  const config = JOB_CREDITS[type] || JOB_CREDITS.custom;
  return config.heavyOps.includes(operation) ? config.heavy : config.base;
}

// ── REST endpoints ───────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: '🟢 NetGPU Server is Online',
    stats: {
      donors_online:   donors.size,
      idle_donors:     countIdleDonors(),
      jobs_in_queue:   jobQueue.length,
      active_jobs:     activeJobs.size,
      total_jobs_done: jobHistory.length,
    }
  });
});

app.get('/donors', (req, res) => {
  res.json({
    count: donors.size,
    donors: Array.from(donors.values()).map(d => ({
      userId:        d.userId,
      gpuPower:      d.gpuPower,
      isIdle:        d.isIdle,
      jobsDone:      d.jobsDone,
      acceptedTypes: d.acceptedTypes,
    }))
  });
});

app.get('/queue', (req, res) => {
  res.json({
    queue_length: jobQueue.length,
    active_jobs:  activeJobs.size,
    jobs: jobQueue.map(j => ({
      id: j.id, type: j.type, operation: j.operation,
      fileName: j.fileName, status: j.status,
    }))
  });
});

// ── Sockets ──────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('📱 Connected:', socket.id);

  // ── Register as donor ─────────────────────────────────────────
  socket.on('register_donor', (data) => {
    const userId = data.userId || ('anon_' + socket.id.slice(0, 6));
    if (!credits.has(userId)) credits.set(userId, CREDITS_NEW_USER);

    donors.set(socket.id, {
      id:            socket.id,
      userId,
      gpuPower:      data.gpuPower    || 15,
      device:        data.device      || 'Android',
      // Which job types this donor will accept (default: all)
      acceptedTypes: data.acceptedTypes || null, // null = accept all
      isIdle:        true,
      lastSeen:      Date.now(),
      jobsDone:      0,
    });

    socket.emit('registered', { role: 'donor', userId, credits: credits.get(userId) });
    console.log(`✅ Donor: ${userId} | GPU: ${data.gpuPower}% | Types: ${data.acceptedTypes ? Object.keys(data.acceptedTypes).filter(k => data.acceptedTypes[k]).join(',') : 'all'}`);

    broadcastNetworkStatus();
    tryAssignJobs();
  });

  // ── Submit a job ──────────────────────────────────────────────
  socket.on('submit_job', (data) => {
    const userId      = data.userId || ('anon_' + socket.id.slice(0, 6));
    if (!credits.has(userId)) credits.set(userId, CREDITS_NEW_USER);

    const jobType     = data.type || 'custom';
    const operation   = data.operation || '';
    const cost        = getJobCost(jobType, operation);
    const userCredits = credits.get(userId);

    if (userCredits < cost) {
      socket.emit('job_error', {
        type:    'no_credits',
        message: `Not enough credits. This job costs ${cost} credits, you have ${userCredits}.`,
        credits: userCredits,
        cost,
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
      payload:         data.payload  || {},
      cost,
      requesterId:     socket.id,
      requesterUserId: userId,
      status:          'queued',
      createdAt:       Date.now(),
      donorId:         null,
      assignedAt:      null,
      timeoutTimer:    null,
    };

    jobQueue.push(job);
    const idleCount = countIdleDonorsForType(jobType);
    console.log(`📋 Job: ${job.id} | type:${jobType} op:${operation} | cost:${cost}cr | "${job.fileName}" | ${idleCount} eligible donors`);

    socket.emit('job_queued', {
      jobId:        job.id,
      position:     jobQueue.length,
      donors_ready: idleCount,
      has_donors:   idleCount > 0,
      cost,
      message: idleCount > 0
        ? `Found ${idleCount} donor${idleCount > 1 ? 's' : ''}! Assigning now...`
        : 'No donors online for this job type. Will process when one connects.',
    });

    if (idleCount > 0) tryAssignJobs();
  });

  // ── Donor completed a job ─────────────────────────────────────
  socket.on('job_complete', (data) => {
    const job = activeJobs.get(data.jobId);
    if (!job) return;
    if (job.timeoutTimer) clearTimeout(job.timeoutTimer);

    const duration = Date.now() - job.assignedAt;

    const requesterSocket = io.sockets.sockets.get(job.requesterId);
    if (requesterSocket) {
      requesterSocket.emit('job_result', {
        jobId:   data.jobId,
        result:  data.result || 'processed',
        duration,
        message: `Done! Processed in ${(duration / 1000).toFixed(1)}s`,
      });
    }

    // Reward donor
    const donor = donors.get(socket.id);
    if (donor) {
      donor.isIdle = true;
      donor.jobsDone++;
      const prev = credits.get(donor.userId) || 0;
      const next = prev + CREDITS_EARNED;
      credits.set(donor.userId, next);
      socket.emit('credits_earned', { earned: CREDITS_EARNED, total: next });
      console.log(`💰 +${CREDITS_EARNED} → ${donor.userId} (total: ${next})`);
    }

    // Deduct from requester (variable by job type)
    const reqPrev = credits.get(job.requesterUserId) || 0;
    const reqNext = Math.max(0, reqPrev - job.cost);
    credits.set(job.requesterUserId, reqNext);
    if (requesterSocket) {
      requesterSocket.emit('credits_update', { credits: reqNext });
    }

    jobHistory.push({
      jobId: data.jobId, type: job.type, operation: job.operation,
      fileName: job.fileName, cost: job.cost, duration, completedAt: Date.now(),
    });
    if (jobHistory.length > 50) jobHistory.shift();

    activeJobs.delete(data.jobId);
    console.log(`✅ Job done: ${data.jobId} (${job.type}/${job.operation}) in ${(duration/1000).toFixed(1)}s`);

    broadcastNetworkStatus();
    tryAssignJobs();
  });

  // ── Donor reports failure ─────────────────────────────────────
  socket.on('job_failed', (data) => {
    const job = activeJobs.get(data.jobId);
    if (!job) return;
    requeueJob(job, data.reason || 'Donor reported failure');
    activeJobs.delete(data.jobId);
  });

  // ── Heartbeat ─────────────────────────────────────────────────
  socket.on('heartbeat', () => {
    const donor = donors.get(socket.id);
    if (donor) donor.lastSeen = Date.now();
  });

  // ── Donor updates status (after Save Settings) ────────────────
  socket.on('update_status', (data) => {
    const donor = donors.get(socket.id);
    if (donor) {
      const wasIdle        = donor.isIdle;
      donor.isIdle         = data.isIdle        ?? donor.isIdle;
      donor.gpuPower       = data.gpuPower       ?? donor.gpuPower;
      donor.acceptedTypes  = data.acceptedTypes  ?? donor.acceptedTypes;
      donor.lastSeen       = Date.now();
      console.log(`🔄 Status update: ${donor.userId} | GPU:${donor.gpuPower}% | idle:${donor.isIdle}`);
      if (!wasIdle && donor.isIdle) tryAssignJobs();
    }
    broadcastNetworkStatus();
  });

  // ── Get credits ───────────────────────────────────────────────
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

  // ── Disconnect ────────────────────────────────────────────────
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
      console.log(`❌ Donor offline: ${donor.userId}`);
      broadcastNetworkStatus();
    }
    console.log('📴 Disconnected:', socket.id);
  });
});

// ── Job assignment ────────────────────────────────────────────────
function tryAssignJobs() {
  if (jobQueue.length === 0) return;

  const available = Array.from(donors.values())
    .filter(d => d.isIdle)
    .sort((a, b) => b.gpuPower - a.gpuPower);

  if (available.length === 0) return;

  let assigned = 0;
  while (jobQueue.length > 0 && available.length > 0) {
    const job = jobQueue[0];

    // Find a donor who accepts this job type
    const donorIdx = available.findIndex(d =>
      !d.acceptedTypes || d.acceptedTypes[job.type] !== false
    );

    if (donorIdx === -1) {
      // No eligible donor right now — leave in queue
      console.log(`⏳ No eligible donor for ${job.type} job — waiting`);
      break;
    }

    jobQueue.shift();
    const donor = available.splice(donorIdx, 1)[0];

    donor.isIdle   = false;
    job.status     = 'processing';
    job.donorId    = donor.id;
    job.assignedAt = Date.now();

    job.timeoutTimer = setTimeout(() => {
      console.log(`⏰ Timeout: ${job.id} — re-queuing`);
      requeueJob(job, 'Donor timed out');
      activeJobs.delete(job.id);
    }, JOB_TIMEOUT_MS);

    activeJobs.set(job.id, job);

    const donorSocket = io.sockets.sockets.get(donor.id);
    if (donorSocket) {
      donorSocket.emit('job_assigned', {
        jobId:     job.id,
        type:      job.type,
        operation: job.operation,
        quality:   job.quality,
        format:    job.format,
        fileName:  job.fileName,
        fileSize:  job.fileSize,
        note:      job.note,
      });
    }

    const requesterSocket = io.sockets.sockets.get(job.requesterId);
    if (requesterSocket) {
      requesterSocket.emit('job_processing', {
        jobId:      job.id,
        donorPower: donor.gpuPower,
        message:    `Donor found! Processing ${job.type}/${job.operation} with ${donor.gpuPower}% GPU...`,
      });
    }

    console.log(`🔄 ${job.id} (${job.type}/${job.operation}) → ${donor.userId} (GPU: ${donor.gpuPower}%)`);
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
    requesterSocket.emit('job_requeued', {
      jobId:   job.id,
      message: 'A donor dropped — searching for another one...',
    });
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

// Remove stale donors every 30s
setInterval(() => {
  const now = Date.now();
  let removed = 0;
  donors.forEach((donor, socketId) => {
    if (now - donor.lastSeen > HEARTBEAT_DEAD_MS) {
      activeJobs.forEach((job, jobId) => {
        if (job.donorId === socketId) {
          requeueJob(job, 'Stale donor removed');
          activeJobs.delete(jobId);
        }
      });
      donors.delete(socketId);
      removed++;
      console.log(`🧹 Removed stale donor: ${donor.userId}`);
    }
  });
  if (removed > 0) broadcastNetworkStatus();
}, 30_000);

function generateId() {
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 NetGPU Server on port ${PORT}`));
