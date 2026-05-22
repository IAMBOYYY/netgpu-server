const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors    = require('cors');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// ─── In-Memory Storage ──────────────────────────────────────────
const donors     = new Map(); // socketId → donor info
const requesters = new Map(); // socketId → requester info
const jobQueue   = [];        // pending jobs (array, front = next job)
const activeJobs = new Map(); // jobId → job info
const credits    = new Map(); // userId → credit count
const jobHistory = [];        // last 50 completed jobs (global log)

// ─── Config ─────────────────────────────────────────────────────
const JOB_TIMEOUT_MS    = 120_000; // 2 min — re-queue if donor goes silent
const HEARTBEAT_DEAD_MS = 60_000;  // remove donor if no heartbeat in 60s
const CREDITS_EARNED    = 5;       // donor earns per completed job
const CREDITS_NEW_USER  = 10;      // free credits for brand new users
const CREDITS_JOB_COST  = 1;       // requester spends per job

// ─── REST Endpoints ─────────────────────────────────────────────

// Main health check — open server URL in browser to see this
app.get('/', (req, res) => {
  res.json({
    status: '🟢 NetGPU Server is Online',
    stats: {
      donors_online:     donors.size,
      idle_donors:       countIdleDonors(),
      requesters_online: requesters.size,
      jobs_in_queue:     jobQueue.length,
      active_jobs:       activeJobs.size,
      total_jobs_done:   jobHistory.length,
    },
    message: 'Server is running correctly'
  });
});

// Live donor list
app.get('/donors', (req, res) => {
  const list = Array.from(donors.values()).map(d => ({
    userId:   d.userId,
    gpuPower: d.gpuPower,
    device:   d.device,
    isIdle:   d.isIdle,
    jobsDone: d.jobsDone,
  }));
  res.json({ count: list.length, donors: list });
});

// Job queue status
app.get('/queue', (req, res) => {
  res.json({
    queued: jobQueue.length,
    active: activeJobs.size,
    recent: jobHistory.slice(-10),
  });
});

// ─── Socket Connections ─────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('📱 Device connected:', socket.id);

  // ── DONOR REGISTERS ────────────────────────────────────────────
  socket.on('register_donor', (data) => {
    const userId = data.userId || ('anon_' + socket.id.slice(0, 6));

    if (!credits.has(userId)) credits.set(userId, CREDITS_NEW_USER);

    donors.set(socket.id, {
      id:       socket.id,
      userId,
      gpuPower: data.gpuPower || 15,
      device:   data.device   || 'Android',
      isIdle:   true,           // ← FIXED: always start as available
      lastSeen: Date.now(),
      jobsDone: 0,
    });

    socket.emit('registered', {
      role:    'donor',
      userId,
      credits: credits.get(userId),
    });

    console.log(`✅ Donor online: ${userId} | GPU: ${data.gpuPower}%`);

    // Tell everyone a new donor is available
    broadcastNetworkStatus();

    // Immediately assign any waiting jobs to this new donor
    tryAssignJobs();
  });

  // ── REQUESTER REGISTERS ────────────────────────────────────────
  socket.on('register_requester', (data) => {
    const userId = data.userId || ('anon_' + socket.id.slice(0, 6));

    if (!credits.has(userId)) credits.set(userId, CREDITS_NEW_USER);

    requesters.set(socket.id, { id: socket.id, userId });

    socket.emit('registered', {
      role:    'requester',
      userId,
      credits: credits.get(userId),
    });

    // Immediately tell this requester how many donors are available
    socket.emit('network_status', {
      donors_online: donors.size,
      idle_donors:   countIdleDonors(),
      queue_length:  jobQueue.length,
    });

    console.log(`👤 Requester online: ${userId}`);
  });

  // ── JOB SUBMITTED BY REQUESTER ─────────────────────────────────
  socket.on('submit_job', (data) => {
    // Both requesters and donors can submit jobs
    const actor = requesters.get(socket.id) || donors.get(socket.id);
    if (!actor) {
      socket.emit('job_error', { message: 'Not registered. Reconnect and try again.' });
      return;
    }

    const userId      = actor.userId;
    const userCredits = credits.get(userId) || 0;

    if (userCredits < CREDITS_JOB_COST) {
      socket.emit('job_error', {
        type:    'no_credits',
        message: 'You have no credits. Turn on Donor Mode to earn credits first.',
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
    console.log(`📋 Job queued: ${job.id} | "${job.fileName}" | ${idleCount} idle donor(s) available`);

    if (idleCount === 0) {
      // No donors right now — job is saved, we'll assign when someone connects
      socket.emit('job_queued', {
        jobId:        job.id,
        position:     jobQueue.length,
        donors_ready: 0,
        has_donors:   false,
        message:      'No donors online right now. Your job is saved — we\'ll start it the moment a donor connects.',
      });
    } else {
      socket.emit('job_queued', {
        jobId:        job.id,
        position:     jobQueue.length,
        donors_ready: idleCount,
        has_donors:   true,
        message:      `Found ${idleCount} donor${idleCount > 1 ? 's' : ''} ready. Assigning your job now...`,
      });
      tryAssignJobs();
    }
  });

  // ── DONOR COMPLETED A JOB ──────────────────────────────────────
  socket.on('job_complete', (data) => {
    const job = activeJobs.get(data.jobId);
    if (!job) {
      console.log(`⚠️ Unknown job_complete for: ${data.jobId}`);
      return;
    }

    if (job.timeoutTimer) clearTimeout(job.timeoutTimer);

    const duration = Date.now() - job.assignedAt;

    // Notify the requester
    const requesterSocket = io.sockets.sockets.get(job.requesterId);
    if (requesterSocket) {
      requesterSocket.emit('job_result', {
        jobId:    data.jobId,
        result:   data.result   || 'processed',
        duration,
        message:  `Done! Processed in ${(duration / 1000).toFixed(1)}s`,
      });
    }

    // Reward donor
    const donor = donors.get(socket.id);
    if (donor) {
      donor.isIdle = true; // donor is free again
      donor.jobsDone++;
      const prev = credits.get(donor.userId) || 0;
      const next = prev + CREDITS_EARNED;
      credits.set(donor.userId, next);
      socket.emit('credits_earned', { earned: CREDITS_EARNED, total: next });
      console.log(`💰 +${CREDITS_EARNED} credits → ${donor.userId} (total: ${next})`);
    }

    // Deduct from requester
    const reqPrev = credits.get(job.requesterUserId) || 0;
    const reqNext = Math.max(0, reqPrev - CREDITS_JOB_COST);
    credits.set(job.requesterUserId, reqNext);

    if (requesterSocket) {
      requesterSocket.emit('credits_update', { credits: reqNext });
    }

    // Global job history (keep last 50)
    jobHistory.push({
      jobId:       data.jobId,
      type:        job.type,
      fileName:    job.fileName,
      duration,
      completedAt: Date.now(),
    });
    if (jobHistory.length > 50) jobHistory.shift();

    activeJobs.delete(data.jobId);
    console.log(`✅ Job done: ${data.jobId} | ${(duration / 1000).toFixed(1)}s`);

    broadcastNetworkStatus();
    tryAssignJobs(); // give this donor the next job in queue
  });

  // ── DONOR REPORTS A JOB FAILED ─────────────────────────────────
  socket.on('job_failed', (data) => {
    const job = activeJobs.get(data.jobId);
    if (!job) return;
    console.log(`❌ Job ${data.jobId} failed: ${data.reason || 'unknown'}`);
    requeueJob(job, data.reason || 'Donor reported failure');
    activeJobs.delete(data.jobId);
  });

  // ── DONOR HEARTBEAT ────────────────────────────────────────────
  // Donors send this every 25 seconds to prove they are still alive
  socket.on('heartbeat', () => {
    const donor = donors.get(socket.id);
    if (donor) donor.lastSeen = Date.now();
  });

  // ── DONOR UPDATES THEIR STATUS ─────────────────────────────────
  socket.on('update_status', (data) => {
    const donor = donors.get(socket.id);
    if (donor) {
      const wasIdle   = donor.isIdle;
      donor.isIdle    = data.isIdle   ?? donor.isIdle;
      donor.gpuPower  = data.gpuPower ?? donor.gpuPower;
      donor.lastSeen  = Date.now();

      // If donor just became idle, try to assign waiting jobs
      if (!wasIdle && donor.isIdle) tryAssignJobs();
    }
    broadcastNetworkStatus();
  });

  // ── GET CREDITS ────────────────────────────────────────────────
  socket.on('get_credits', () => {
    const actor = donors.get(socket.id) || requesters.get(socket.id);
    if (actor) {
      socket.emit('credits_update', { credits: credits.get(actor.userId) || 0 });
    }
  });

  // ── DISCONNECT ─────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const donor = donors.get(socket.id);
    if (donor) {
      // Re-queue any job this donor was handling
      activeJobs.forEach((job, jobId) => {
        if (job.donorId === socket.id) {
          requeueJob(job, 'Donor disconnected mid-job');
          activeJobs.delete(jobId);
        }
      });
      donors.delete(socket.id);
      console.log(`❌ Donor offline: ${donor.userId}`);
      broadcastNetworkStatus();
    }

    requesters.delete(socket.id);
    console.log('📴 Disconnected:', socket.id);
  });
});

// ─── Core Job Assignment ────────────────────────────────────────
function tryAssignJobs() {
  if (jobQueue.length === 0) return;

  // Sort idle donors by GPU power — best donor gets the job
  const available = Array.from(donors.values())
    .filter(d => d.isIdle)
    .sort((a, b) => b.gpuPower - a.gpuPower);

  if (available.length === 0) {
    console.log(`⏳ ${jobQueue.length} job(s) queued — no idle donors right now`);
    return;
  }

  while (jobQueue.length > 0 && available.length > 0) {
    const job   = jobQueue.shift();
    const donor = available.shift();

    // Mark donor as busy
    donor.isIdle = false;

    // Update job
    job.status     = 'processing';
    job.donorId    = donor.id;
    job.assignedAt = Date.now();

    // Safety net: if donor doesn't respond in JOB_TIMEOUT_MS, re-queue
    job.timeoutTimer = setTimeout(() => {
      console.log(`⏰ Timeout: job ${job.id} — re-queuing`);
      requeueJob(job, 'Donor timed out (no response in 2 minutes)');
      activeJobs.delete(job.id);
    }, JOB_TIMEOUT_MS);

    activeJobs.set(job.id, job);

    // Send job to donor
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

    // Tell requester a donor picked up their job
    const requesterSocket = io.sockets.sockets.get(job.requesterId);
    if (requesterSocket) {
      requesterSocket.emit('job_processing', {
        jobId:      job.id,
        donorPower: donor.gpuPower,
        message:    `Donor found! Processing with ${donor.gpuPower}% GPU power...`,
      });
    }

    console.log(`🔄 Assigned: job ${job.id} → donor ${donor.userId} (GPU: ${donor.gpuPower}%)`);
  }
}

// ─── Re-queue a Job ─────────────────────────────────────────────
function requeueJob(job, reason) {
  if (job.timeoutTimer) clearTimeout(job.timeoutTimer);

  // Free up the donor that was handling it
  const donor = donors.get(job.donorId);
  if (donor) donor.isIdle = true;

  // Notify the requester
  const requesterSocket = io.sockets.sockets.get(job.requesterId);
  if (requesterSocket) {
    requesterSocket.emit('job_requeued', {
      jobId:   job.id,
      message: 'A donor dropped — searching for another one...',
    });
  }

  // Reset job and put it at the front of the queue
  job.status       = 'queued';
  job.donorId      = null;
  job.assignedAt   = null;
  job.timeoutTimer = null;
  jobQueue.unshift(job);

  console.log(`🔁 Re-queued: ${job.id} (reason: ${reason})`);

  // Try again after a short delay
  setTimeout(tryAssignJobs, 2000);
}

// ─── Broadcast Network Status to All Connected Clients ──────────
function broadcastNetworkStatus() {
  io.emit('network_status', {
    donors_online: donors.size,
    idle_donors:   countIdleDonors(),
    queue_length:  jobQueue.length,
    active_jobs:   activeJobs.size,
  });
}

// ─── Count Available (Idle) Donors ──────────────────────────────
function countIdleDonors() {
  return Array.from(donors.values()).filter(d => d.isIdle).length;
}

// ─── Stale Donor Cleanup (runs every 30s) ───────────────────────
// Removes donors who haven't sent a heartbeat recently
setInterval(() => {
  const now = Date.now();
  let removed = 0;
  donors.forEach((donor, socketId) => {
    if (now - donor.lastSeen > HEARTBEAT_DEAD_MS) {
      // Re-queue any job this stale donor had
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

// ─── Helper ─────────────────────────────────────────────────────
function generateId() {
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

// ─── Start Server ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 NetGPU Server running on port ${PORT}`);
  console.log(`📡 Waiting for devices to connect...`);
});
