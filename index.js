const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// ─── In-Memory Storage ───────────────────────────────────────
const donors     = new Map(); // who is donating power
const requesters = new Map(); // who needs help
const jobQueue   = [];        // waiting jobs
const activeJobs = new Map(); // jobs being processed right now
const credits    = new Map(); // user credits

// ─── Health Check Page ───────────────────────────────────────
// Open your server URL in browser to see this
app.get('/', (req, res) => {
  res.json({
    status: '🟢 NetGPU Server is Online',
    stats: {
      donors_online:     donors.size,
      requesters_online: requesters.size,
      jobs_in_queue:     jobQueue.length,
      active_jobs:       activeJobs.size
    },
    message: 'Server is working correctly'
  });
});

// ─── Socket Connections ──────────────────────────────────────
io.on('connection', (socket) => {
  console.log('📱 New device connected:', socket.id);

  // --- Donor registers (someone offering their GPU) ---
  socket.on('register_donor', (data) => {
    donors.set(socket.id, {
      id:       socket.id,
      userId:   data.userId,
      gpuPower: data.gpuPower,  // 5 to 30 percent
      isIdle:   data.isIdle,
      joinedAt: Date.now()
    });

    if (!credits.has(data.userId)) {
      credits.set(data.userId, 10); // new users start with 10 free credits
    }

    socket.emit('registered', {
      role:    'donor',
      credits: credits.get(data.userId)
    });

    console.log(`✅ Donor online: ${data.userId} | GPU: ${data.gpuPower}%`);
    tryAssignJobs();
  });

  // --- Requester registers (someone needing GPU help) ---
  socket.on('register_requester', (data) => {
    requesters.set(socket.id, {
      id:     socket.id,
      userId: data.userId
    });

    if (!credits.has(data.userId)) {
      credits.set(data.userId, 10);
    }

    socket.emit('registered', {
      role:    'requester',
      credits: credits.get(data.userId)
    });

    console.log(`👤 Requester online: ${data.userId}`);
  });

  // --- Requester submits a job ---
  socket.on('submit_job', (data) => {
    const req = requesters.get(socket.id);
    if (!req) return;

    const userCredits = credits.get(req.userId) || 0;
    if (userCredits < 1) {
      socket.emit('error', {
        message: 'No credits left. Turn on donor mode to earn credits.'
      });
      return;
    }

    const job = {
      id:              generateId(),
      type:            data.type,    // 'video', 'image', 'webpage'
      payload:         data.payload,
      requesterId:     socket.id,
      requesterUserId: req.userId,
      status:          'queued',
      createdAt:       Date.now()
    };

    jobQueue.push(job);
    console.log(`📋 Job queued: ${job.id} | Type: ${job.type}`);
    socket.emit('job_queued', { jobId: job.id, position: jobQueue.length });

    tryAssignJobs();
  });

  // --- Donor finished processing a job ---
  socket.on('job_complete', (data) => {
    const job = activeJobs.get(data.jobId);
    if (!job) return;

    // Send result back to the person who needed help
    const requesterSocket = io.sockets.sockets.get(job.requesterId);
    if (requesterSocket) {
      requesterSocket.emit('job_result', {
        jobId:  data.jobId,
        result: data.result
      });
    }

    // Reward the donor with credits
    const donor = donors.get(socket.id);
    if (donor) {
      const current = credits.get(donor.userId) || 0;
      credits.set(donor.userId, current + 5);
      socket.emit('credits_earned', { earned: 5, total: current + 5 });
      console.log(`💰 Credits +5 for donor: ${donor.userId}`);
    }

    // Deduct 1 credit from the requester
    const reqCredits = credits.get(job.requesterUserId) || 0;
    credits.set(job.requesterUserId, Math.max(0, reqCredits - 1));

    activeJobs.delete(data.jobId);
    console.log(`✅ Job done: ${data.jobId}`);
  });

  // --- Donor updates their availability ---
  socket.on('update_status', (data) => {
    const donor = donors.get(socket.id);
    if (donor) {
      donor.isIdle   = data.isIdle;
      donor.gpuPower = data.gpuPower;
    }
  });

  // --- Device disconnects ---
  socket.on('disconnect', () => {
    const donor = donors.get(socket.id);
    if (donor) {
      // If donor had an active job, put it back in queue
      activeJobs.forEach((job, jobId) => {
        if (job.donorId === socket.id) {
          job.status  = 'queued';
          job.donorId = null;
          jobQueue.unshift(job); // back to front of queue
          activeJobs.delete(jobId);
          console.log(`⚠️ Job ${jobId} re-queued (donor disconnected)`);
        }
      });
      donors.delete(socket.id);
    }
    requesters.delete(socket.id);
    console.log('❌ Device disconnected:', socket.id);
  });
});

// ─── Job Assignment Logic ────────────────────────────────────
function tryAssignJobs() {
  if (jobQueue.length === 0) return;

  const available = Array.from(donors.values()).filter(d => d.isIdle);
  if (available.length === 0) {
    console.log('⏳ Jobs waiting but no idle donors right now');
    return;
  }

  while (jobQueue.length > 0 && available.length > 0) {
    const job   = jobQueue.shift();
    const donor = available.shift();

    job.status     = 'processing';
    job.donorId    = donor.id;
    job.assignedAt = Date.now();
    activeJobs.set(job.id, job);

    const donorSocket = io.sockets.sockets.get(donor.id);
    if (donorSocket) {
      donorSocket.emit('process_job', {
        jobId:   job.id,
        type:    job.type,
        payload: job.payload
      });
    }

    const requesterSocket = io.sockets.sockets.get(job.requesterId);
    if (requesterSocket) {
      requesterSocket.emit('job_processing', { jobId: job.id });
    }

    console.log(`🔄 Job ${job.id} → donor ${donor.userId}`);
  }
}

// ─── Helper ──────────────────────────────────────────────────
function generateId() {
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

// ─── Start Server ────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 NetGPU Server running on port ${PORT}`);
  console.log(`📡 Waiting for devices to connect...`);
});
