# NetGPU — Distributed GPU Power Sharing Network

> **Your project master document. Every decision, every file, every plan — all in one place.**
> Keep this file updated as the project grows. Start every new chat session by sharing this file so context is never lost.

---

## Table of Contents
1. [The Idea](#the-idea)
2. [What The App Does](#what-the-app-does)
3. [Key Decisions Made](#key-decisions-made)
4. [Full Architecture](#full-architecture)
5. [Tech Stack](#tech-stack)
6. [Server Files — Complete Code](#server-files)
7. [Mobile App Files — Plan](#mobile-app-files-plan)
8. [Setup Instructions](#setup-instructions)
9. [Roadmap](#roadmap)
10. [Problems Solved In Planning](#problems-solved-in-planning)

---

## The Idea

**Problem:** A user wants to export a video, run a heavy 3D render, game, or open a complex webpage — but their device (especially a mobile phone) is too weak to do it smoothly.

**Solution:** A network of users who voluntarily donate a small percentage of their device's GPU and CPU power (5%–30%) to help other users. The person needing help sends their task to the network. Available donors process it and send the result back. Everything happens in the background with full user consent.

**The Chrome Extension Analogy:** Just like a Chrome extension adds a button inside your browser without you opening a separate app — our app adds an "Export via NetGPU" option inside video editing apps, or works from a persistent notification panel. The user never needs to manually open the app.

### Who It's For
- **Mobile video editors** — export high quality video their phone can't handle alone
- **3D artists** — render frames in Blender, Cinema 4D etc. distributed across the network
- **Gamers** — stream games in real time from a powerful donor device (future feature)
- **Anyone with a weak device** — open heavy websites, run AI tools, process images

### Core Philosophy
- Always ask user permission before using their device
- Donor chooses exactly how much power to share (5% minimum, 30% maximum)
- Credit system — donate power, earn credits, spend credits to get help
- 100% background, 100% consent, 100% free

---

## What The App Does

### Two Modes

**Requester Mode** — You need help
- Pick a video/image/task
- App sends it to the donor network
- Donors process it using their GPU/CPU
- You get the result back, better quality than your phone could do

**Donor Mode** — You're helping others
- Toggle on in settings
- App runs silently in background
- Only activates when your phone is: plugged in + idle + battery above 50%
- Automatically pauses when you start using your phone
- You earn credits for every job completed

### Persistent Notification (Always Visible)
```
┌─────────────────────────────────────┐
│ 🟢 NetGPU — Donating 15% power      │
│ [Pause]  [Export Video]  [Browser]  │
└─────────────────────────────────────┘
```
User taps Export Video → picks file → donors process it → done.
Never needs to open the full app. Like tapping a Chrome extension.

### Built-in Browser
A browser inside the app where heavy pages get pre-rendered on donor devices and sent as lightweight streams. Like Opera Mini but powered by real users instead of a company's servers.

### Donor Settings Panel
```
GPU Power:    [====|----]  20%   (min 5%, max 30%)
CPU Power:    [OFF]              (optional)
RAM Share:    [OFF]              (optional)
Bandwidth:    [==|------]  10 Mbps

Active When:
☑ Phone is idle
☑ Plugged into charger
☑ Battery above 50%
☐ Always (even when I'm using phone)

Auto-Pause When:
☑ I start using the phone
☑ Battery drops below 20%
☑ CPU usage above 70%
☑ Phone gets hot
```

---

## Key Decisions Made

| Decision | What We Chose | Why |
|---|---|---|
| Hosting platform | Render.com | Truly free web service tier. Railway is credit-based, not fully free |
| Code editor/storage | GitHub | Industry standard, works in mobile browser, connects to Render automatically |
| Replit | Rejected | Removed templates, forces AI agent (vibe coding), pushes paid plan |
| Mobile app framework | React Native + Expo | Test on phone immediately with Expo Go app, no PC needed |
| Server language | Node.js | Lightweight, real-time friendly, works perfectly with Socket.io |
| Real-time connections | Socket.io | Handles persistent connections between donors and requesters |
| File splitting | 1 server file (index.js) | Combined coordinator + queue logic into one file. Simpler to manage. Split later when project grows |
| Vibe coding tools | None | User specifically does not want Lovable, Bolt, Cursor etc. All code written manually and explained |

---

## Full Architecture

### How Devices Talk To Each Other
```
User1 Phone (needs help)
        │
        │  "I have a video to process"
        ▼
   NETGPU SERVER (Render.com)
   - Keeps list of who is online
   - Manages job queue
   - Matches requesters to donors
   - Tracks credits
   - Handles failures (re-assigns if donor drops)
        │
        │  "Hey, here's a job for you"
        ▼
User2 Phone (donating power)
        │
        │  Processes the job
        │  Sends result back to server
        ▼
   NETGPU SERVER
        │
        │  Sends result to User1
        ▼
User1 Phone
   Gets their processed video/result
```

### Why A Server Is Needed
Two phones on different networks (different cities, different ISPs) cannot find each other directly. The server is the middleman that introduces them and coordinates the work. Once introduced, data can flow more directly between them.

### The Chunking System (For Video)
Large videos get split into segments (e.g. 10-second chunks). Each chunk goes to a different donor. All donors process simultaneously. Results come back and get stitched together. This means 10 donors = roughly 10x faster processing.

### Credit System
```
Donate 1 hour of GPU power  →  Earn credits
Submit a video job           →  Spend 1 credit
No credits left              →  Must donate first OR wait for free queue
```
The network is self-sustaining. No money needed. Give power, get power.

---

## Tech Stack

### Server
| Technology | Purpose |
|---|---|
| Node.js | Runtime — runs JavaScript on the server |
| Express.js | HTTP server — handles web requests |
| Socket.io | Real-time connections — keeps phones connected |
| CORS | Allows phones to connect from any network |

### Mobile App (Next Phase)
| Technology | Purpose |
|---|---|
| React Native | Write once, runs on Android (and iOS later) |
| Expo | Test on phone without PC using Expo Go app |
| Expo EAS Build | Builds final APK in cloud, no PC needed |
| FFmpeg (React Native) | Handles video chunking and processing on device |

### Infrastructure
| Service | Purpose | Cost |
|---|---|---|
| GitHub | Stores all code | Free |
| Render.com | Runs the server, gives public URL | Free (Web Service) |
| Expo Go | Test app on phone during development | Free |
| Expo EAS | Build final APK | Free tier available |
| UptimeRobot | Keeps Render server awake (pings every 10 min) | Free |

---

## Server Files

### File 1 — `package.json`
```json
{
  "name": "netgpu-server",
  "version": "1.0.0",
  "description": "NetGPU Coordinator Server",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "socket.io": "^4.6.1",
    "cors": "^2.8.5"
  }
}
```

### File 2 — `index.js`
```javascript
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
```

---

## Mobile App Files — Plan

These files are built in future sessions. Listed here so nothing is forgotten.

```
MOBILE APP (React Native + Expo)
├── app.json                        ← App name, icon, permissions config
├── package.json                    ← All app dependencies
├── App.js                          ← Entry point, navigation setup
│
├── screens/
│   ├── HomeScreen.js               ← Main screen, donor toggle, stats
│   ├── DonorSettings.js            ← GPU % slider, CPU toggle, when-to-donate rules
│   ├── ExportScreen.js             ← Pick video → submit to network → progress → save
│   └── BrowserScreen.js           ← Built-in lite browser using donor network
│
├── services/
│   ├── BackgroundService.js        ← Runs silently, monitors idle state
│   ├── NotificationService.js      ← Persistent notification with quick actions
│   └── SocketService.js            ← Connects to our Render server via Socket.io
│
└── components/
    ├── PowerSlider.js              ← The 5%–30% GPU donation slider UI
    └── JobStatus.js                ← Shows job progress, credits earned
```

### What Each Screen Does

**HomeScreen.js**
- Big toggle: Donor Mode ON/OFF
- Live stats: donors online, your credits, jobs you've completed
- Quick links to Export and Browser

**DonorSettings.js**
- GPU power slider (5% to 30%)
- CPU power toggle (optional)
- "When to donate" rules (idle only, plugged in, battery threshold)
- Auto-pause rules (when phone gets hot, when used actively)

**ExportScreen.js**
- Pick video from gallery
- Choose quality (720p, 1080p, 4K)
- Submit to network
- Live progress bar showing which donors are processing which chunks
- Download result when done

**BrowserScreen.js**
- URL bar
- Pages pre-rendered via donor network
- Faster than Chrome on weak phones
- Ad blocking built in

---

## Setup Instructions

### Phase 1 — Server Setup (Current Phase)

#### Step 1: Create GitHub Repository
1. Go to `github.com` on your phone browser
2. Tap the **+** icon → **New repository**
3. Name it: `netgpu-server`
4. Set to **Public**
5. Do NOT tick "Add README" (we add our own files)
6. Tap **Create repository**

#### Step 2: Add Files to GitHub
1. Inside the new repo, tap **Add file** → **Create new file**
2. Name it `package.json`
3. Paste the `package.json` code from this README
4. Tap **Commit changes** → **Commit directly to main** → **Commit**
5. Repeat for `index.js` — paste the full `index.js` code
6. Repeat for `README.md` — paste this entire document

#### Step 3: Connect to Render
1. Go to `render.com` and log in
2. Click **New** → **Web Service**
3. Click **Connect a repository** → select `netgpu-server`
4. Fill in settings:
   - **Name:** `netgpu-server`
   - **Region:** Choose closest to you
   - **Branch:** `main`
   - **Build Command:** `npm install`
   - **Start Command:** `node index.js`
   - **Instance Type:** `Free`
5. Click **Create Web Service**
6. Wait 2-3 minutes for first deploy

#### Step 4: Test Your Server
1. Render gives you a URL like: `https://netgpu-server.onrender.com`
2. Open that URL in your phone browser
3. You should see:
```json
{
  "status": "🟢 NetGPU Server is Online",
  "stats": {
    "donors_online": 0,
    "requesters_online": 0,
    "jobs_in_queue": 0,
    "active_jobs": 0
  }
}
```
4. If you see this — server is working perfectly ✅

#### Step 5: Keep Server Awake (Free Fix)
Render free tier sleeps after 15 min inactivity.
1. Go to `uptimerobot.com` — create free account
2. Add new monitor → HTTP(s)
3. URL: your Render URL
4. Interval: every 5 minutes
5. Save — server stays awake forever, free

### Phase 2 — Mobile App Setup (Next Sessions)
*(Instructions added here as we build each part)*

---

## Roadmap

### Phase 1 — Server ✅ In Progress
- [x] Coordinator server code written
- [x] Job queue logic built
- [x] Credit system built
- [x] Donor/requester registration
- [x] Auto re-queue if donor drops
- [ ] GitHub repository created
- [ ] Render deployment working
- [ ] Server URL confirmed live

### Phase 2 — Mobile App Skeleton
- [ ] Expo project created
- [ ] App runs on phone via Expo Go
- [ ] Navigation between screens working
- [ ] Basic home screen visible

### Phase 3 — Donor System
- [ ] Persistent background notification
- [ ] GPU/CPU donation slider (5%–30%)
- [ ] Idle detection (knows when phone not being used)
- [ ] Auto-pause when phone is in use
- [ ] Socket connection to server

### Phase 4 — Video Export
- [ ] Pick video from phone gallery
- [ ] Send to server job queue
- [ ] Progress tracking
- [ ] Receive processed result
- [ ] Save to phone gallery

### Phase 5 — Built-in Browser
- [ ] URL bar and navigation
- [ ] Pages rendered via donor network
- [ ] Faster than Chrome on weak phones

### Phase 6 — Real-Time Gaming (Advanced)
- [ ] P2P video stream from donor device
- [ ] Input forwarding (touch/keyboard to donor)
- [ ] Latency under 60ms target
- [ ] Works as peer-to-peer cloud gaming

### Phase 7 — Polish & Launch
- [ ] Final APK built via Expo EAS (no PC needed)
- [ ] App icon and splash screen
- [ ] Onboarding flow for new users
- [ ] Share invite link to grow donor network

---

## Problems Solved In Planning

**Problem:** User doesn't want to export from editing software first before using our app.
**Solution:** Plugins built inside editing software (like DaVinci Resolve, Blender) that add "Export via NetGPU" button. Also works via Share intent on Android — any app can share a file to our app.

**Problem:** How do two phones on different networks talk to each other?
**Solution:** They don't directly. Our server on Render acts as the coordinator. Phones connect to the server. Server introduces them and manages the job flow.

**Problem:** What if a donor disconnects mid-job?
**Solution:** Server detects disconnect, automatically re-queues the job chunk, assigns it to next available donor. Requester sees no interruption.

**Problem:** Real-time gaming is much harder than video export.
**Solution:** Separate phase. Gaming requires WebRTC video streaming (donor runs game, streams screen, user sends inputs back). Built after core video export system is proven.

**Problem:** User only has Android phone, no PC.
**Solution:** GitHub (mobile browser) stores code. Render (auto-deploys from GitHub) runs server. Expo Go (Android app) tests the mobile app. Expo EAS (cloud build) creates final APK. No PC needed at any step.

**Problem:** Render free tier sleeps after 15 minutes.
**Solution:** UptimeRobot pings server every 5 minutes. Server stays awake. Free fix.

**Problem:** Replit forces AI agent (vibe coding), removed templates.
**Solution:** Switched to GitHub + Render. Better tools, more professional, fully manual control.

---

## Important Notes For Future Sessions

1. **Always share this README** at the start of a new chat session so Claude has full context
2. **Server URL** — add your Render URL here once live: `https://_____________________.onrender.com`
3. **GitHub repo URL** — add here once created: `https://github.com/___________/netgpu-server`
4. **Expo project** — add Expo project URL here once created
5. **App name** — currently calling it "NetGPU" — can be changed anytime before launch
6. All code is intentionally written in **plain JavaScript, no TypeScript** — simpler to read and debug
7. No vibe coding tools used — every line is written manually and explained

---

*Document created: May 2026 | Project started from a single idea on an Android phone*
