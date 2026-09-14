// 仅本地合成实验：含自动授权测试入口，禁止部署或注入真实凭据。
import { WorkerEntrypoint } from 'cloudflare:workers';
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { md5Hex, newRequestId, FitDaysClient } from 'fitdays-api';
import { z } from 'zod';

class Api extends WorkerEntrypoint {
  async fetch(request) {
    const bearer = request.headers.get('authorization')?.slice(7);
    const auth = await this.env.OAUTH_PROVIDER.unwrapToken(bearer);
    if (!auth || auth.audience !== 'https://localhost/mcp') return new Response(null,{status:401});
    if(request.method==='GET') return new Response(null,{status:405,headers:{Allow:'POST'}});
    const server = new McpServer({name:'kinetrail-offline-spike',version:'0.0.0'});
    for (const [name,scope,readOnly] of [['probe_read','body:read',true],['probe_write','workout:write',false]]) {
      server.registerTool(name,{
        description:'本地合成协议探针，不代表训练已保存',
        inputSchema:{}, outputSchema:{ok:z.boolean()},
        annotations:{readOnlyHint:readOnly,destructiveHint:false,openWorldHint:false},
        _meta:{securitySchemes:[{type:'oauth2',scopes:[scope]}]}
      },async()=>auth.scope.includes(scope)?{structuredContent:{ok:true},content:[{type:'text',text:'探针通过'}]}:{isError:true,content:[{type:'text',text:'INSUFFICIENT_SCOPE：未持久化'}],_meta:{'mcp/www_authenticate':[`Bearer error="insufficient_scope", error_description="Required scope is missing", scope="${scope}"`]}});
    }
    const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    await server.connect(transport);
    return transport.handleRequest(request);
  }
}
const handler={async fetch(request,env){
  const url=new URL(request.url);
  if (url.hostname!=='localhost' || env.SYNTHETIC_ONLY!=='true') return new Response(null,{status:403});
  if(url.pathname==='/setup'){
    const client=await env.OAUTH_PROVIDER.createClient({clientId:'fixture-client',clientName:'离线客户端',redirectUris:['https://localhost/callback'],tokenEndpointAuthMethod:'none',grantTypes:['authorization_code','refresh_token'],responseTypes:['code']});
    return Response.json({client_id:client.clientId});
  }
  if(url.pathname==='/authorize'){
    try {
      const auth=await env.OAUTH_PROVIDER.parseAuthRequest(request);
      const result=await env.OAUTH_PROVIDER.completeAuthorization({request:auth,userId:'fixture-owner',scope:auth.scope,metadata:{synthetic:true},props:{owner:'fixture-owner',scopes:auth.scope}});
      return Response.redirect(result.redirectTo);
    } catch (error) {return Response.json({error:'invalid_request',reason:error.description??error.message},{status:400});}
  }
  if(url.pathname==='/runtime'){
    const client=new FitDaysClient({region:'cn',fetchImpl:async()=>Response.json({code:0,data:{weight_list:[],hr_list:null}})});
    const raw=await client.request('api/sync/syncFromServer',{});
    const numeric='{"future_number":9007199254740993,"tiny":1.2300e-20}';
    const preserved=JSON.stringify(JSON.parse(numeric,(_key,value,context)=>typeof value==='number'?JSON.rawJSON(context.source):value));
    return Response.json({md5:md5Hex('abc'),uuid_ok:/^[a-f0-9]{32}$/.test(newRequestId()),fetch_ok:raw.data.hr_list===null,lossless_numbers:preserved===numeric});
  }
  return new Response(null,{status:404});
}};
const provider=new OAuthProvider({apiRoute:'/mcp',apiHandler:Api,defaultHandler:handler,authorizeEndpoint:'/authorize',tokenEndpoint:'/oauth/token',allowPlainPKCE:false,scopesSupported:['body:read','workout:write'],resourceMetadata:{resource:'https://localhost/mcp',authorization_servers:['https://localhost'],scopes_supported:['body:read','workout:write']}});
export default {fetch(request,env,ctx){
  if(new URL(request.url).hostname!=='localhost' || env.SYNTHETIC_ONLY!=='true') return new Response(null,{status:403});
  return provider.fetch(request,env,ctx);
}};
