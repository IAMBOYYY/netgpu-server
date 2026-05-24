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
const jobQueue   = [];        // pending jobs
const activeJobs = new Map(); // jobId → job info
const credits    = new Map(); // userId → credit count
const jobHistory = [];        // last 50 completed jobs

// ── Config ───────────────────────────────────────────────────────
const JOB_TIMEOUT_MS    = 120_000;
const HEARTBEAT_DEAD_MS = 60_000;
const CREDITS_EARNED    = 5;
const CREDITS_NEW_USER  = 10;
const CREDITS_JOB_COST  = 1;

// ── REST endpoints ───────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: '🟢 NetGPU Server is Online',
    stats: {
      donors_online:  donors.size,
      idle_donors:    countIdleDonors(),
      jobs_in_queue:  jobQueue.length,
      active_jobs:    activeJobs.size,
      total_jobs_done: jobHistory.length,
    }
  });
});

app.get('/donors', (req, res) => {
  res.json({
    count: donors.size,
    donors: Array.from(donors.values()).map(d => ({
      userId: d.userId, gpuPower: d.gpuPower,
      isIdle: d.isIdle, jobsDone: d.jobsDone,
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
      id:       socket.id,
      userId,
      gpuPower: data.gpuPower || 15,
      device:   data.device   || 'Android',
      isIdle:   true,
      lastSeen: Date.now(),
      jobsDone: 0,
    });

    socket.emit('registered', { role: 'donor', userId, credits: credits.get(userId) });
    console.log(`✅ Donor: ${userId} | GPU: ${data.gpuPower}%`);

    broadcastNetworkStatus();
    tryAssignJobs();
  });

  // ── Submit a job ──────────────────────────────────────────────
  // No register_requester needed — any connected socket can submit.
  // userId is sent in the payload so credits work correctly.
  socket.on('submit_job', (data) => {
    const userId      = data.userId || ('anon_' + socket.id.slice(0, 6));
    if (!credits.has(userId)) credits.set(userId, CREDITS_NEW_USER);

    const userCredits = credits.get(userId);
    if (userCredits < CREDITS_JOB_COST) {
      socket.emit('job_error', {
        type:    'no_credits',
        message: 'No credits left. Turn on Donor Mode to earn credits.',
        credits: userCredits,
      });
      return;
    }

    const job = {
      id:              generateId(),
      type:            data.type     || 'video',
      quality:         data.quality  || '720p',
      format:          data.format   || 'MP4',
      fileName:        data.fileName || 'video.mp4',
      fileSize:        data.fileSize || 0,
      payload:         data.payload  || {},
      requesterId:     socket.id,
      requesterUserId: userId,
      status:          'queued',
      createdAt:       Date.now(),
      donorId:         null,
      assignedAt:      null,
      timeoutTimer:    null,
    };

    jobQueue.push(job);
    const idleCount = countIdleDonors();
    console.log(`📋 Job: ${job.id} | "${job.fileName}" | ${idleCount} idle donors`);

    socket.emit('job_queued', {
      jobId:        job.id,
      position:     jobQueue.length,
      donors_ready: idleCount,
      has_donors:   idleCount > 0,
      message: idleCount > 0
        ? `Found ${idleCount} donor${idleCount > 1 ? 's' : ''}! Assigning now...`
        : "No donors online. Job saved — will process when a donor connects.",
    });

    if (idleCount > 0) tryAssignJobs();
  });

  // ── Donor completed a job ─────────────────────────────────────
  socket.on('job_complete', (data) => {
    const job = activeJobs.get(data.jobId);
    if (!job) return;
    if (job.timeoutTimer) clearTimeout(job.timeoutTimer);

    const duration = Date.now() - job.assignedAt;

    // Notify requester
    const requesterSocket = io.sockets.sockets.get(job.requesterId);
    if (requesterSocket) {
      requesterSocket.emit('job_result', {
        jobId:    data.jobId,
        result:   data.result || 'processed',
        duration,
        message:  `Done! Processed in ${(duration / 1000).toFixed(1)}s`,
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

    // Deduct from requester
    const reqPrev = credits.get(job.requesterUserId) || 0;
    const reqNext = Math.max(0, reqPrev - CREDITS_JOB_COST);
    credits.set(job.requesterUserId, reqNext);
    if (requesterSocket) {
      requesterSocket.emit('credits_update', { credits: reqNext });
    }

    jobHistory.push({ jobId: data.jobId, type: job.type, fileName: job.fileName, duration, completedAt: Date.now() });
    if (jobHistory.length > 50) jobHistory.shift();

    activeJobs.delete(data.jobId);
    console.log(`✅ Job done: ${data.jobId} in ${(duration / 1000).toFixed(1)}s`);

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

  // ── Donor heartbeat ───────────────────────────────────────────
  socket.on('heartbeat', () => {
    const donor = donors.get(socket.id);
    if (donor) donor.lastSeen = Date.now();
  });

  // ── Donor updates availability ────────────────────────────────
  socket.on('update_status', (data) => {
    const donor = donors.get(socket.id);
    if (donor) {
      const wasIdle  = donor.isIdle;
      donor.isIdle   = data.isIdle   ?? donor.isIdle;
      donor.gpuPower = data.gpuPower ?? donor.gpuPower;
      donor.lastSeen = Date.now();
      if (!wasIdle && donor.isIdle) tryAssignJobs();
    }
    broadcastNetworkStatus();
  });

  // ── Get credits balance ───────────────────────────────────────
  socket.on('get_credits', (data) => {
    // Client can send userId directly, or we look up by socketId
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

  if (available.length === 0) {
    console.log(`⏳ ${jobQueue.length} job(s) waiting — no idle donors`);
    return;
  }

  while (jobQueue.length > 0 && available.length > 0) {
    const job   = jobQueue.shift();
    const donor = available.shift();

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
        jobId:    job.id,
        type:     job.type,
        quality:  job.quality,
        format:   job.format,
        fileName: job.fileName,
        fileSize: job.fileSize,
        payload:  job.payload,
      });
    }

    const requesterSocket = io.sockets.sockets.get(job.requesterId);
    if (requesterSocket) {
      requesterSocket.emit('job_processing', {
        jobId:      job.id,
        donorPower: donor.gpuPower,
        message:    `Donor found! Processing with ${donor.gpuPower}% GPU power...`,
      });
    }

    console.log(`🔄 ${job.id} → ${donor.userId} (GPU: ${donor.gpuPower}%)`);
  }
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

  job.status     = 'queued';
  job.donorId    = null;
  job.assignedAt = null;
  job.timeoutTimer = null;
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
server.listen(PORT, () => {
  console.log(`🚀 NetGPU Server on port ${PORT}`);
});
