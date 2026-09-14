import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { checkFitdays, scan } from './fitdays-check.mjs';

const report={synthetic_only:true,fitdays:await checkFitdays()};
for(const file of ['synthetic-cn-sync.json','workout-flow.json']) scan(JSON.parse(await readFile(new URL('../../sanitized-fixtures/'+file,import.meta.url),'utf8')));
await mkdir('.local',{recursive:true});
await build({entryPoints:['worker.mjs'],outfile:'.local/worker.mjs',bundle:true,format:'esm',platform:'neutral',mainFields:['module','main'],conditions:['workerd','worker','browser'],external:['cloudflare:workers','node:*']});
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:'.local/worker.mjs',compatibilityDate:'2026-09-14',compatibilityFlags:['nodejs_compat'],kvNamespaces:['OAUTH_KV'],d1Databases:['DB'],bindings:{SYNTHETIC_ONLY:'true'}}));
try {
  const call=(path,options)=>mf.dispatchFetch('https://localhost'+path,options);
  const runtime=await (await call('/runtime')).json();
  assert.equal(runtime.md5,'900150983cd24fb0d6963f7d28e17f72'); assert.ok(runtime.uuid_ok&&runtime.fetch_ok&&runtime.lossless_numbers);
  report.workerd=runtime;
  const unauth=await call('/mcp'); assert.equal(unauth.status,401); assert.match(unauth.headers.get('www-authenticate'),/resource_metadata/);
  const metadata=await (await call('/.well-known/oauth-authorization-server')).json();
  assert.ok(metadata.code_challenge_methods_supported.includes('S256')); assert.ok(!metadata.code_challenge_methods_supported.includes('plain'));
  const resource=await (await call('/.well-known/oauth-protected-resource/mcp')).json(); assert.equal(resource.resource,'https://localhost/mcp');
  const setup=await (await call('/setup')).json();
  const verifier=randomBytes(32).toString('base64url');
  const challenge=createHash('sha256').update(verifier).digest('base64url');
  const params=new URLSearchParams({client_id:setup.client_id,redirect_uri:'https://localhost/callback',response_type:'code',scope:'body:read workout:write',resource:'https://localhost/mcp',state:'synthetic-state',code_challenge:challenge,code_challenge_method:'S256'});
  const response=await call('/authorize?'+params,{redirect:'manual'});
  assert.equal(response.status,302,response.status!==302?await response.text():undefined);
  const callback=new URL(response.headers.get('location')); assert.equal(callback.searchParams.get('state'),'synthetic-state');
  const exchange=async fields=>call('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields).toString()});
  const code=callback.searchParams.get('code');
  const tokenResponse=await exchange({grant_type:'authorization_code',client_id:setup.client_id,redirect_uri:'https://localhost/callback',code,code_verifier:verifier,resource:'https://localhost/mcp'});
  assert.equal(tokenResponse.status,200); const token=await tokenResponse.json();
  // 合成 token 永不输出、永不落盘。
  async function rpc(access,method,params={}){
    const r=await call('/mcp',{method:'POST',headers:{authorization:'Bearer '+access,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    return {status:r.status,body:await r.json()};
  }
  const list=await rpc(token.access_token,'tools/list'); assert.equal(list.status,200); assert.equal(list.body.result.tools.length,2);
  assert.equal((await rpc(token.access_token,'tools/call',{name:'probe_write',arguments:{}})).body.result.structuredContent.ok,true);
  // Inspector 只连接回环代理；合成 token 仅由代理在内存注入，绝不放在参数/配置文件。
  const proxy=createServer(async(req,res)=>{
    try {
      const chunks=[]; for await(const chunk of req) chunks.push(chunk);
      const upstream=await call('/mcp',{method:req.method,headers:{...req.headers,authorization:'Bearer '+token.access_token},...(req.method==='POST'?{body:Buffer.concat(chunks)}:{})});
      const body=Buffer.from(await upstream.arrayBuffer());
      const headers=Object.fromEntries(upstream.headers); delete headers['content-encoding']; delete headers['content-length']; delete headers['transfer-encoding'];
      res.writeHead(upstream.status,headers); res.end(body);
    } catch (error) {if(!res.headersSent) res.writeHead(500);res.end('SYNTHETIC_PROXY_ERROR'); console.error(req.method,error.name,error.message);}
  });
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  try {
    const url=`http://127.0.0.1:${proxy.address().port}/mcp`;
    const cli='node_modules/@modelcontextprotocol/inspector/clients/cli/build/index.js';
    for(const args of [['--method','tools/list'],['--method','tools/call','--tool-name','probe_read']]){
      const result=await promisify(execFile)(process.execPath,[cli,url,'--transport','http','--format','json','--stored-auth-only',...args],{timeout:30000});
      assert.ok(result.stdout.includes(args[1]==='tools/list'?'probe_read':'true'));
    }
    report.inspector_worker={tools_list:true,tools_call:true,auth_via_synthetic_loopback_proxy:true};
  } finally {await new Promise(resolve=>proxy.close(resolve));}
  const narrowResponse=await exchange({grant_type:'refresh_token',client_id:setup.client_id,refresh_token:token.refresh_token,scope:'body:read',resource:'https://localhost/mcp'});
  assert.equal(narrowResponse.status,200); const narrow=await narrowResponse.json(); assert.equal(narrow.scope,'body:read');
  const denied=await rpc(narrow.access_token,'tools/call',{name:'probe_write',arguments:{}}); assert.equal(denied.body.result.isError,true); assert.match(denied.body.result._meta["mcp/www_authenticate"][0],/error_description="Required scope is missing"/);
  assert.equal((await rpc(narrow.access_token,'tools/call',{name:'probe_read',arguments:{}})).body.result.structuredContent.ok,true);
  assert.equal((await rpc('invalid-synthetic-token','tools/list')).status,401);
  const wrong=await exchange({grant_type:'refresh_token',client_id:setup.client_id,refresh_token:narrow.refresh_token,resource:'https://wrong.invalid/mcp'}); assert.notEqual(wrong.status,200);
  const replay=await exchange({grant_type:'authorization_code',client_id:setup.client_id,redirect_uri:'https://localhost/callback',code,code_verifier:verifier}); assert.notEqual(replay.status,200);
  report.oauth={unauthorized_401:true,metadata:true,pkce_s256:true,code_replay_rejected:true,downscope_write_denied:true,read_allowed:true,wrong_resource_rejected:true,invalid_token_rejected:true,real_idp:false,cimd:false};
  const db=await mf.getD1Database('DB');
  await db.exec('CREATE TABLE events (id TEXT PRIMARY KEY, payload TEXT);');
  const measurement=JSON.parse(await readFile(new URL('../../sanitized-fixtures/synthetic-cn-sync.json',import.meta.url),'utf8')).data.weight_list[0];
  await db.prepare('INSERT INTO events VALUES(?,?)').bind('w1',JSON.stringify(measurement)).run();
  const saved=await db.prepare('SELECT payload FROM events WHERE id=?').bind('w1').first('payload'); assert.deepEqual(JSON.parse(saved),measurement);
  await assert.rejects(()=>db.batch([db.prepare('INSERT INTO events VALUES(?,?)').bind('should-rollback','{}'),db.prepare('INSERT INTO events VALUES(?,?)').bind('w1','{}')]));
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM events WHERE id=?').bind('should-rollback').first('n'),0);
  report.d1={raw_roundtrip:true,batch_constraint_rollback:true,workout_full_flow:false};
} finally {await mf.dispose();}
const sqlite=spawnSync('python',['core-check.py'],{encoding:'utf8'}); assert.equal(sqlite.status,0,sqlite.stderr); report.sqlite=sqlite.stdout.trim();
await writeFile('../spike-results.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
