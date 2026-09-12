// Own the response lifecycle before the first await. No asynchronous producer
// may write without checking the response and its connection again.
export async function streamSse(req,res,{initialCursor=0,loadCursor,eventsAfter,state,authorized=()=>true,onClose=()=>{},intervalMs=500}){
 let cursor=initialCursor,busy=false,closed=false,timer=null,lastSnapshot=0;
 const socket=res.socket;
 const open=()=>!closed&&!req.aborted&&!res.writableEnded&&!res.writableFinished&&!res.destroyed&&!!socket&&!socket.destroyed&&socket.writable!==false;
 const cleanup=()=>{
  if(closed)return;closed=true;clearInterval(timer);timer=null;
  res.off('close',cleanup);res.off('finish',cleanup);req.off('aborted',stop);socket?.off('close',cleanup);
  // Node can enqueue an error event before emitting finish/close. Keep its
  // handler through that turn, then release it; producers are fenced above.
  setImmediate(()=>res.off('error',stop));onClose();
 };
 function stop(){const canEnd=open();cleanup();if(canEnd){try{res.end();}catch{res.destroy();}}}
 const write=text=>{if(!open()){cleanup();return false;}res.write(text);return true;};
 res.on('error',stop);res.on('close',cleanup);res.on('finish',cleanup);req.on('aborted',stop);socket?.on('close',cleanup);
 const push=async()=>{
  if(busy||!open())return;busy=true;
  try{
   if(!authorized()){stop();return;}
   const events=await eventsAfter(cursor);if(!open()){cleanup();return;}
   for(const event of events){if(!write('id: '+event.id+'\nevent: engine\ndata: '+JSON.stringify(event)+'\n\n'))return;cursor=event.id;}
   if(Date.now()-lastSnapshot>=2000){
    const snapshot=await state();if(!open()){cleanup();return;}
    if(!write('event: state\ndata: '+JSON.stringify(snapshot)+'\n\n'))return;lastSnapshot=Date.now();
   }else if(!events.length&&!write(': keepalive\n\n'))return;
   if(res.writableLength>2*1024*1024)stop();
  }catch{stop();}finally{busy=false;}
 };
 try{
  if(!open()){cleanup();return;}
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
  if(!open()){cleanup();return;}res.flushHeaders();
  if(!cursor){cursor=await loadCursor();if(!open()){cleanup();return;}}
  await push();if(open())timer=setInterval(push,intervalMs);else cleanup();
 }catch{stop();}
}
