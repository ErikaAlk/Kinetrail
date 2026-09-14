// 仅回环、合成数据，验证 Node 22 Streamable HTTP + Inspector。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { checkFitdays } from './fitdays-check.mjs';
const server=createServer(async(req,res)=>{
  if(req.method!=='POST'){res.writeHead(405);res.end();return;}
  const mcp=new McpServer({name:'kinetrail-node-fixture',version:'0.0.0'});
  mcp.registerTool('probe_read',{description:'只读合成探针',inputSchema:{},outputSchema:{ok:z.boolean()},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}},async()=>({structuredContent:{ok:true},content:[{type:'text',text:'离线验证通过'}]}));
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  await mcp.connect(transport);
  res.on('close',()=>{void transport.close();void mcp.close();});
  await transport.handleRequest(req,res);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try{
  const url=`http://127.0.0.1:${server.address().port}/mcp`;
  for(const args of [['--method','tools/list'],['--method','tools/call','--tool-name','probe_read']]){
    const result=await promisify(execFile)(process.execPath,['node_modules/@modelcontextprotocol/inspector/clients/cli/build/index.js',url,'--format','json','--stored-auth-only',...args],{timeout:30000});
    assert.ok(result.stdout.includes(args[1]==='tools/list'?'probe_read':'true'));
  }
  const report={runtime:process.version,fitdays:await checkFitdays(),inspector:{tools_list:true,tools_call:true},docker:false,node_oauth:false};
  await writeFile('../node-results.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}finally{await new Promise(resolve=>server.close(resolve));}
