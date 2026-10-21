import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// Synthetic executor only. Each process owns a fresh filesystem fixture.
async function main() {
 const root = await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'hvo-chat-'))
 process.env.DATA_DIR = root
 process.env.HVO_HERMES_ROOT = path.join(root, 'hermes')
 process.env.HERMES_HOME = process.env.HVO_HERMES_ROOT
 const chat = await import('../src/lib/hermes/chat')
 const store = path.join(root, 'chat-sessions.json')
 const seed = { id:'seed_id', agent:'seed', profile:'seed', title:'seed', createdAt:'2026-01-01', updatedAt:'2026-01-01', messageCount:2 }
 await writeFile(store, JSON.stringify({seed}))
 const deferred = () => { let resolve!:()=>void; const promise=new Promise<void>(r=>{resolve=r}); return {promise,resolve} }
 const allEntered=deferred(), release=deferred()
 const count=24
 let entered=0
 chat._setChatExecutorForTest(async (_file,args)=>{
  const agent=args[1]
  entered++
  if(entered===count) allEntered.resolve()
  await release.promise
  return {stdout:'ok',stderr:`session_id: sid_${agent}`}
 })
 const sends=Array.from({length:count},(_,i)=>chat.sendChatMessage(`agent${i}`,`agent${i}`,'hello'))
 await allEntered.promise // all model calls overlap; not serialized globally
 release.resolve()
 await Promise.all(sends)
 const index=JSON.parse(await readFile(store,'utf8'))
 assert.equal(Object.keys(index).length,count+1,'lost updates after simultaneous model completion')
 assert.equal(index.seed.id,'seed_id')
 assert.equal((await stat(store)).mode & 0o777,0o600)
 // Same-agent turn must resume, failure releases queue, reset shares mutation fence.
 let n=0
 chat._setChatExecutorForTest(async(_f,args)=>{
  n++
  if(n===1) throw new Error('synthetic failure')
  if(n===3) assert.equal(args[args.indexOf('--resume')+1],'retry_session')
  return {stdout:'ok',stderr:'session_id: retry_session'}
 })
 const failed=chat.sendChatMessage('retry','retry','fail')
 const recovered=chat.sendChatMessage('retry','retry','recover')
 await assert.rejects(failed)
 await recovered
 await chat.sendChatMessage('retry','retry','resume')
 await Promise.all([chat.resetChatSession('retry'),chat.resetChatSession('agent0'),chat.sendChatMessage('new','new','new')])
 assert.equal(await chat.getChatSession('retry'),null)
 assert.equal(await chat.getChatSession('agent0'),null)
 assert.equal((await chat.getChatSession('seed'))?.id,'seed_id')
 assert.ok(await chat.getChatSession('new'))
 assert.equal(chat._chatQueueSizeForTest(),0)
 chat._setChatExecutorForTest(null)
 console.log('chat-concurrency PASS: overlapping model barrier; all 25 pointers; resume/failure/reset; mode0600')
}
main().catch(e=>{console.error(e);process.exitCode=1})
