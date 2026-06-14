const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 4e6,   // 4 MB — allows full JPEG frames from Remote Browser
});

app.use(cors());
app.use(express.json());

const PORT           = process.env.PORT || 10000;
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const CF_ACCOUNT_ID  = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_API_TOKEN   = process.env.CLOUDFLARE_API_TOKEN;

const GPU_ROUTES   = { ai:'nvidia', data:'nvidia', custom:'nvidia', image:'cloudflare', video:'donor', '3d':'donor' };
const CREDIT_COSTS = { ai:1, image:1, video:2, data:1, custom:2, '3d':4 };

// ── State ─────────────────────────────────────────────────────────────────────
const donors          = new Map();   // socketId → donor info
const credits         = new Map();   // userId   → balance
const jobQueue        = [];
const activeJobs      = new Map();
const boostUsers      = new Map();
const streamSessions  = new Map();   // GPU Camera Stream sessions
const remoteSessions  = new Map();   // Remote Browser sessions

let totalJobsDone = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────
function getCredits(userId) {
  if (!credits.has(userId)) credits.set(userId, 10);
  return credits.get(userId);
}
function genId(pfx = 'job') { return `${pfx}_${Date.now()}_${Math.random().toString(36).substr(2,6)}`; }

function getBestDonor(jobType, caps = {}) {
  let best = null, bestPower = 0;
  for (const [, d] of donors) {
    if (!d.isIdle || !d.socket?.connected) continue;
    if (caps.streamGPU    && !d.capabilities?.streamGPU)    continue;
    if (caps.remoteBrowser && !d.capabilities?.remoteBrowser) continue;
    if (d.gpuPower > bestPower) { best = d; bestPower = d.gpuPower; }
  }
  return best;
}

function releaseDonor(socketId) {
  const d = donors.get(socketId);
  if (d) { d.isIdle = true; d.currentJob = null; }
}

// ── NVIDIA NIM ────────────────────────────────────────────────────────────────
async function processWithNVIDIA(job) {
  const boosted    = boostUsers.has(job.userId);
  const boostPower = boosted ? boostUsers.get(job.userId).boostPower : 0;
  const prompt     = boosted
    ? `You are a high-performance GPU compute processor running at ${100+boostPower}% capacity (boosted by NetGPU network). Process this ${job.type} task thoroughly: "${job.operation||job.type}". File: ${job.fileName||'input'}. Give a detailed, high-quality result in 4-5 sentences.`
    : `You are a GPU compute processor. Process this ${job.type} task: "${job.operation||job.type}". File: ${job.fileName||'input'}. Provide a brief result in 2-3 sentences.`;
  const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${NVIDIA_API_KEY}`},
    body: JSON.stringify({ model:'meta/llama-3.1-8b-instruct', max_tokens:boosted?400:256, temperature:0.7,
      messages:[{role:'system',content:'You are a GPU compute processor. Be concise.'},{role:'user',content:prompt}] }),
  });
  if (!res.ok) throw new Error(`NVIDIA ${res.status}`);
  const result = (await res.json()).choices?.[0]?.message?.content || 'Processed.';
  return boosted ? `⚡ [GPU Boosted +${boostPower}%]\n\n${result}` : result;
}

// ── Cloudflare Workers AI ─────────────────────────────────────────────────────
async function processWithCloudflare(job) {
  const boosted    = boostUsers.has(job.userId);
  const boostPower = boosted ? boostUsers.get(job.userId).boostPower : 0;
  const prompt     = boosted
    ? `Process image task at high quality (+${boostPower}% GPU): ${job.operation||'transform'} on ${job.fileName||'image'}. Describe result in 4-5 sentences.`
    : `Process image task: ${job.operation||'transform'} on ${job.fileName||'image'}. Describe result in 2-3 sentences.`;
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/meta/llama-3.1-8b-instruct`, {
    method:'POST', headers:{'Authorization':`Bearer ${CF_API_TOKEN}`,'Content-Type':'application/json'},
    body: JSON.stringify({ messages:[{role:'system',content:'You are a GPU image processor.'},{role:'user',content:prompt}], max_tokens:boosted?400:200 }),
  });
  if (!res.ok) throw new Error(`Cloudflare ${res.status}`);
  const result = (await res.json()).result?.response || `Processed: ${job.operation||'transform'} complete.`;
  return boosted ? `⚡ [GPU Boosted +${boostPower}%]\n\n${result}` : result;
}

// ── Process job ───────────────────────────────────────────────────────────────
async function processJob(job) {
  const jobObj = activeJobs.get(job.id);
  if (!jobObj) return;
  jobObj.status = 'processing'; jobObj.startedAt = Date.now();
  const sock   = io.sockets.sockets.get(job.socketId);
  const boosted = boostUsers.has(job.userId);
  sock?.emit('job_processing', { jobId:job.id, message:`Processing on ${jobObj.processor==='nvidia'?'⚡ NVIDIA NIM':'☁️ Cloudflare'}${boosted?' (Boosted ⚡)':''}…` });
  try {
    const result = jobObj.processor==='nvidia' ? await processWithNVIDIA(job) : await processWithCloudflare(job);
    const dur    = Date.now()-jobObj.startedAt;
    jobObj.status='completed'; jobObj.result=result; jobObj.duration=dur; totalJobsDone++;
    credits.set(job.userId, Math.max(0, getCredits(job.userId)-(job.creditCost||1)));
    sock?.emit('job_result',     { jobId:job.id, result, duration:dur, credits:getCredits(job.userId) });
    sock?.emit('credits_update', { credits:getCredits(job.userId) });
  } catch(err) {
    jobObj.status='failed'; jobObj.error=err.message;
    sock?.emit('job_error', { jobId:job.id, message:`❌ ${err.message}`, credits:getCredits(job.userId) });
  }
}

function tryAssignQueuedJobs() {
  for (let i=jobQueue.length-1; i>=0; i--) {
    const job  = jobQueue[i];
    const jobj = activeJobs.get(job.id);
    if (!jobj || jobj.status==='cancelled') { jobQueue.splice(i,1); continue; }
    const donor = getBestDonor(job.type);
    if (!donor) continue;
    jobQueue.splice(i,1);
    jobj.status='processing'; jobj.donorId=donor.userId;
    donor.isIdle=false; donor.currentJob=job.id;
    donor.socket.emit('job_assigned', { id:job.id, type:job.type, operation:job.operation, fileName:job.fileName });
    io.sockets.sockets.get(job.socketId)?.emit('job_processing', { jobId:job.id, message:`⚡ Donor GPU assigned` });
  }
}

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`🔌 ${socket.id}`);

  // ── Register donor ─────────────────────────────────────────────────────────
  socket.on('register_donor', data => {
    const userId = data.userId||socket.id;
    donors.set(socket.id, { socket, socketId:socket.id, userId, gpuPower:data.gpuPower||15,
      device:data.device||'Android', capabilities:data.capabilities||{}, isIdle:true, currentJob:null, joinedAt:Date.now() });
    socket.emit('registered', { role:'donor', userId, credits:getCredits(userId) });
    console.log(`✅ Donor: ${userId} | GPU:${data.gpuPower}% | caps:${JSON.stringify(data.capabilities)}`);
    tryAssignQueuedJobs();
    io.emit('network_status', getStats());
  });

  // ── Submit job ─────────────────────────────────────────────────────────────
  socket.on('submit_job', data => {
    const userId    = data.userId||socket.id;
    const jobType   = data.type||'ai';
    const cost      = CREDIT_COSTS[jobType]||1;
    if (getCredits(userId) < cost) {
      socket.emit('job_error',{type:'insufficient_credits',message:`❌ Need ${cost} credits.`,credits:getCredits(userId)}); return;
    }
    const jobId     = genId('job');
    const processor = GPU_ROUTES[jobType]||'donor';
    const job = { id:jobId, socketId:socket.id, userId, type:jobType, operation:data.operation||'',
      fileName:data.fileName||'unknown', fileSize:data.fileSize||'0', creditCost:cost, processor, status:'queued', timestamp:Date.now() };
    activeJobs.set(jobId, job);
    socket.emit('job_queued', { jobId, message:`⏳ Routing to ${processor==='nvidia'?'⚡ NVIDIA':processor==='cloudflare'?'☁️ Cloudflare':'📱 Donor'}…` });
    if (processor==='nvidia'||processor==='cloudflare') processJob(job);
    else { jobQueue.push(job); tryAssignQueuedJobs(); }
    io.emit('network_status', getStats());
  });

  // ── Boost ──────────────────────────────────────────────────────────────────
  socket.on('activate_boost', ({userId,boostPower,boostRam,duration}) => {
    boostUsers.set(userId,{boostPower:boostPower||10,boostRam,startTime:Date.now(),endTime:Date.now()+(duration||1800000),socketId:socket.id});
    socket.emit('boost_activated',{boostPower,message:`🚀 GPU Boost active! +${boostPower}%`});
    io.emit('network_status', getStats());
  });
  socket.on('deactivate_boost', ({userId}) => { boostUsers.delete(userId); socket.emit('boost_deactivated',{}); });
  socket.on('boost_credit_drain', ({userId,amount}) => {
    const rem = Math.max(0, getCredits(userId)-amount); credits.set(userId,rem);
    socket.emit('credits_update',{credits:rem});
    if (rem<=0) { boostUsers.delete(userId); socket.emit('boost_deactivated',{message:'⚠️ Boost stopped — out of credits.'}); }
  });

  // ── Donor job complete / fail ──────────────────────────────────────────────
  socket.on('job_complete', ({jobId,result}) => {
    const job=activeJobs.get(jobId), donor=donors.get(socket.id);
    if (!job||!donor) return;
    const dur=Date.now()-(job.startedAt||job.timestamp);
    job.status='completed'; job.result=result||'Done.'; job.duration=dur; totalJobsDone++;
    releaseDonor(socket.id);
    credits.set(donor.userId, getCredits(donor.userId)+5);
    donor.socket.emit('credits_earned',{earned:5,total:getCredits(donor.userId)});
    credits.set(job.userId, Math.max(0,getCredits(job.userId)-job.creditCost));
    const rs=io.sockets.sockets.get(job.socketId);
    rs?.emit('job_result',    {jobId,result:job.result,duration:dur,credits:getCredits(job.userId)});
    rs?.emit('credits_update',{credits:getCredits(job.userId)});
    tryAssignQueuedJobs();
    io.emit('network_status', getStats());
  });
  socket.on('job_failed', ({jobId,reason}) => {
    const job=activeJobs.get(jobId); if (!job) return;
    job.status='failed'; job.error=reason; releaseDonor(socket.id);
    io.sockets.sockets.get(job.socketId)?.emit('job_error',{jobId,message:`❌ ${reason}`});
    tryAssignQueuedJobs();
  });

  // ── Misc ───────────────────────────────────────────────────────────────────
  socket.on('heartbeat',     ()           => socket.emit('heartbeat_ack',{ts:Date.now()}));
  socket.on('update_status', ({isIdle,gpuPower}) => { const d=donors.get(socket.id); if(d){d.isIdle=isIdle;d.gpuPower=gpuPower||d.gpuPower;} if(isIdle)tryAssignQueuedJobs(); io.emit('network_status',getStats()); });
  socket.on('get_credits',   ({userId})   => socket.emit('credits_update',{credits:getCredits(userId||socket.id)}));
  socket.on('cancel_job',    ({jobId})    => {
    const job=activeJobs.get(jobId); if(!job) return;
    job.status='cancelled';
    const idx=jobQueue.findIndex(j=>j.id===jobId); if(idx!==-1) jobQueue.splice(idx,1);
    for(const[,d] of donors) if(d.currentJob===jobId){d.isIdle=true;d.currentJob=null;d.socket.emit('job_cancelled',{jobId});}
    socket.emit('job_cancelled',{jobId});
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ── GPU CAMERA STREAM RELAY ─────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  socket.on('stream_start', ({userId, effect}) => {
    const donor = getBestDonor(null, {streamGPU:true});
    if (!donor) { socket.emit('stream_no_donor',{message:'No stream-capable donor online.'}); return; }
    const sid = genId('stream');
    streamSessions.set(sid,{requesterId:socket.id,donorSocketId:donor.socketId,effect:effect||'enhance',startTime:Date.now(),frameCount:0});
    donor.isIdle=false; donor.currentJob=sid;
    donor.socket.emit('stream_assigned',{sessionId:sid,effect:effect||'enhance',requesterId:socket.id});
    socket.emit('stream_session_ready',{sessionId:sid,donor:{userId:donor.userId,gpuPower:donor.gpuPower,device:donor.device}});
    console.log(`🎮 Stream: ${sid}`);
    io.emit('network_status', getStats());
  });

  socket.on('stream_frame', ({sessionId,frameId,base64}) => {
    const s=streamSessions.get(sessionId); if(!s||s.requesterId!==socket.id) return;
    s.frameCount++;
    io.sockets.sockets.get(s.donorSocketId)?.emit('stream_frame_relay',{sessionId,frameId,base64});
  });

  socket.on('stream_result', ({sessionId,frameId,base64,processingMs,effect}) => {
    const s=streamSessions.get(sessionId); if(!s||s.donorSocketId!==socket.id) return;
    io.sockets.sockets.get(s.requesterId)?.emit('stream_result_relay',{sessionId,frameId,base64,processingMs,effect});
  });

  socket.on('stream_effect_change', ({sessionId,effect}) => {
    const s=streamSessions.get(sessionId); if(!s||s.requesterId!==socket.id) return;
    s.effect=effect;
    io.sockets.sockets.get(s.donorSocketId)?.emit('stream_effect_relay',{sessionId,effect});
  });

  socket.on('stream_stop', ({sessionId}) => _cleanStream(sessionId, socket.id, 'stopped'));

  // ═══════════════════════════════════════════════════════════════════════════
  // ── REMOTE BROWSER RELAY ───────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  // GPU Taker requests a website be opened on donor GPU
  socket.on('remote_browse_start', ({userId, url}) => {
    if (!url) { socket.emit('remote_browse_no_donor',{message:'No URL provided.'}); return; }
    const donor = getBestDonor(null, {remoteBrowser:true});
    if (!donor) {
      socket.emit('remote_browse_no_donor',{message:'No donor GPU available for Remote Browser. Ask a friend to enable Donor Mode!'});
      return;
    }
    const sid = genId('rb');
    remoteSessions.set(sid, {requesterId:socket.id,requesterUser:userId||socket.id,donorSocketId:donor.socketId,url,startTime:Date.now(),frameCount:0});
    donor.isIdle=false; donor.currentJob=sid;

    // Tell donor: open this URL and start streaming frames
    donor.socket.emit('remote_browse_assigned', {sessionId:sid, url});

    // Tell requester: session is ready
    socket.emit('remote_browse_session_ready', {sessionId:sid, donor:{userId:donor.userId,gpuPower:donor.gpuPower,device:donor.device}, url});

    console.log(`🌐 Remote Browse: ${sid} | url:${url} | donor:${donor.socketId}`);
    io.emit('network_status', getStats());
  });

  // Donor sends a captured canvas frame → relay to GPU Taker
  socket.on('remote_browse_frame', ({sessionId, frameId, base64, width, height, ts}) => {
    const s=remoteSessions.get(sessionId); if(!s||s.donorSocketId!==socket.id) return;
    s.frameCount++;
    io.sockets.sockets.get(s.requesterId)?.emit('remote_browse_frame_relay',{sessionId,frameId,base64,width,height,ts});
  });

  // GPU Taker stops the session
  socket.on('remote_browse_stop', ({sessionId}) => _cleanRemote(sessionId, socket.id, 'requester_stopped'));

  // Donor manually stops (pressed Stop button in their UI)
  socket.on('remote_browse_donor_stop', ({sessionId}) => _cleanRemote(sessionId, socket.id, 'donor_stopped'));

  // ── Disconnect: clean up all sessions this socket was part of ──────────────
  socket.on('disconnect', () => {
    // Donor cleanup
    const donor = donors.get(socket.id);
    if (donor) {
      if (donor.currentJob) {
        const job = activeJobs.get(donor.currentJob);
        if (job && job.status==='processing') {
          job.status='queued'; jobQueue.push(job);
          io.sockets.sockets.get(job.socketId)?.emit('job_requeued',{jobId:job.id,message:'⚠️ Donor disconnected — requeued.'});
        }
      }
      donors.delete(socket.id);
    }
    for(const[,b] of boostUsers) if(b.socketId===socket.id) boostUsers.delete(b.userId||socket.id);

    // Stream sessions
    for(const[sid,s] of streamSessions) {
      if(s.requesterId===socket.id||s.donorSocketId===socket.id) _cleanStream(sid,socket.id,'disconnect');
    }

    // Remote browse sessions
    for(const[sid,s] of remoteSessions) {
      if(s.requesterId===socket.id||s.donorSocketId===socket.id) _cleanRemote(sid,socket.id,'disconnect');
    }

    console.log(`❌ ${socket.id}`);
    io.emit('network_status', getStats());
  });
});

// ── Session cleanup helpers ────────────────────────────────────────────────────
function _cleanStream(sid, triggerSocket, reason) {
  const s = streamSessions.get(sid); if (!s) return;
  releaseDonor(s.donorSocketId);
  if (triggerSocket!==s.donorSocketId)
    io.sockets.sockets.get(s.donorSocketId)?.emit('stream_session_ended',{sessionId:sid});
  if (triggerSocket!==s.requesterId)
    io.sockets.sockets.get(s.requesterId)?.emit('stream_error',{message:'Stream ended.'});
  streamSessions.delete(sid);
  tryAssignQueuedJobs();
  io.emit('network_status', getStats());
  console.log(`⏹ Stream cleaned: ${sid} (${reason})`);
}

function _cleanRemote(sid, triggerSocket, reason) {
  const s = remoteSessions.get(sid); if (!s) return;
  releaseDonor(s.donorSocketId);
  if (triggerSocket!==s.donorSocketId)
    io.sockets.sockets.get(s.donorSocketId)?.emit('remote_browse_stop_relay',{sessionId:sid});
  if (triggerSocket!==s.requesterId)
    io.sockets.sockets.get(s.requesterId)?.emit('remote_browse_error',{message:'Remote session ended.'});
  remoteSessions.delete(sid);
  tryAssignQueuedJobs();
  io.emit('network_status', getStats());
  console.log(`⏹ Remote cleaned: ${sid} (${reason})`);
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function getStats() {
  return {
    donors_online:          donors.size,
    idle_donors:            [...donors.values()].filter(d=>d.isIdle).length,
    stream_capable:         [...donors.values()].filter(d=>d.capabilities?.streamGPU&&d.isIdle).length,
    remote_browse_capable:  [...donors.values()].filter(d=>d.capabilities?.remoteBrowser&&d.isIdle).length,
    active_streams:         streamSessions.size,
    active_remote_sessions: remoteSessions.size,
    boost_users:            boostUsers.size,
    jobs_queued:            jobQueue.length,
    total_jobs_done:        totalJobsDone,
  };
}

// ── REST ──────────────────────────────────────────────────────────────────────
app.get('/', (_,res) => res.json({
  status: '🟢 NetGPU Server Online',
  nvidia:     NVIDIA_API_KEY                ? '✅ Connected' : '❌ Missing',
  cloudflare: CF_ACCOUNT_ID&&CF_API_TOKEN   ? '✅ Connected' : '❌ Missing',
  stats: getStats(),
}));
app.get('/donors',  (_,res) => res.json([...donors.values()].map(d=>({userId:d.userId,gpuPower:d.gpuPower,isIdle:d.isIdle,caps:d.capabilities}))));
app.get('/streams', (_,res) => res.json([...streamSessions.entries()].map(([id,s])=>({id,frames:s.frameCount,effect:s.effect}))));
app.get('/remote',  (_,res) => res.json([...remoteSessions.entries()].map(([id,s])=>({id,url:s.url,frames:s.frameCount}))));
app.get('/queue',   (_,res) => res.json(jobQueue.map(j=>activeJobs.get(j.id)).filter(Boolean)));

server.listen(PORT, () => {
  console.log('═══════════════════════════════════════════');
  console.log(`🚀 NetGPU Server on port ${PORT}`);
  console.log(`⚡ NVIDIA NIM:        ${NVIDIA_API_KEY               ?'✅':'❌'}`);
  console.log(`☁️  Cloudflare AI:    ${CF_ACCOUNT_ID&&CF_API_TOKEN  ?'✅':'❌'}`);
  console.log(`🎮 GPU Camera Stream: ✅ Ready`);
  console.log(`🌐 Remote Browser:    ✅ Ready`);
  console.log('═══════════════════════════════════════════');
});
