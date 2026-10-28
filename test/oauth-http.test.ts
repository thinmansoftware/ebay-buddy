import {beforeAll,afterEach,describe,it,expect,vi} from 'vitest';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {createServer,request as httpRequest,type Server} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {auth,UnauthorizedError,type OAuthClientProvider} from '@modelcontextprotocol/sdk/client/auth.js';
import type {OAuthTokens} from '@modelcontextprotocol/sdk/shared/auth.js';
import {createBrowseApp} from '../src/browse-core/http.js';
import {createBrowseContext,loadBrowseConfig} from '../src/browse-core/runtime.js';

const nativeFetch=globalThis.fetch;
let signing:CryptoKey;
let publicKey:Record<string,unknown>;
const issuer='https://identity.example/';
const scope='ebay:browse:read';
const clientId='synthetic-registered-client';
beforeAll(async()=>{
  const pair=await generateKeyPair('RS256');signing=pair.privateKey;
  publicKey={...await exportJWK(pair.publicKey),kid:'fixture-key',alg:'RS256',use:'sig'};
});
afterEach(()=>vi.unstubAllGlobals());
async function setup(stateful=false,authorizationFixture=false,rateLimit=120,refreshMode?:"rotate"|"revoked"|"temporary"){
  const listener:Server=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');
  const origin=`http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  let refreshCalls=0;let providerCalls=0;let appTokenOnly=true;let authorizationUrl:URL|undefined;let pkceExchangeVerified=false;
  vi.stubGlobal('fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=String(input);
    if(url===issuer+'.well-known/jwks.json')return new Response(JSON.stringify({keys:[publicKey]}),{headers:{'content-type':'application/json'}});
    if(authorizationFixture && [issuer+'.well-known/oauth-authorization-server',issuer+'.well-known/openid-configuration'].includes(url)){
      return new Response(JSON.stringify({issuer,authorization_endpoint:issuer+'authorize',token_endpoint:issuer+'oauth/token',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none'],scopes_supported:[scope,'offline_access']}),{headers:{'content-type':'application/json'}});
    }
    if(authorizationFixture && url===issuer+'oauth/token'){
      const params=new URLSearchParams(String(init?.body||''));
      if(params.get('grant_type')==='refresh_token'){
        refreshCalls++;
        if(params.get('refresh_token')!=='synthetic-refresh-a' || params.get('client_id')!==clientId || params.get('resource')!==origin+'/mcp')throw new Error('Invalid synthetic refresh binding');
        if(refreshMode==='revoked')return new Response(JSON.stringify({error:'invalid_grant'}),{status:400,headers:{'content-type':'application/json'}});
        if(refreshMode==='temporary')return new Response(JSON.stringify({error:'temporarily_unavailable'}),{status:503,headers:{'content-type':'application/json'}});
        return new Response(JSON.stringify({access_token:await token(),token_type:'Bearer',expires_in:300,refresh_token:'synthetic-refresh-b',scope:scope+' offline_access'}),{headers:{'content-type':'application/json'}});
      }
      const verifier=params.get('code_verifier')||'';
      pkceExchangeVerified=Boolean(authorizationUrl && params.get('grant_type')==='authorization_code' && params.get('code')==='synthetic-code' && params.get('client_id')===clientId && params.get('resource')===origin+'/mcp' && params.get('redirect_uri')==='https://client.example/callback' && createHash('sha256').update(verifier).digest('base64url')===authorizationUrl.searchParams.get('code_challenge') && authorizationUrl.searchParams.get('code_challenge_method')==='S256');
      if(!pkceExchangeVerified)return new Response(JSON.stringify({error:'invalid_grant'}),{status:400,headers:{'content-type':'application/json'}});
      return new Response(JSON.stringify({access_token:await token(),token_type:'Bearer',expires_in:300,scope}),{headers:{'content-type':'application/json'}});
    }
    if(new URL(url).origin===origin)return nativeFetch(input,init);
    throw new Error('Unexpected fixture network destination');
  });
  const config=loadBrowseConfig({MCP_AUTH_MODE:'oauth',MCP_OAUTH_ISSUER:issuer,MCP_OAUTH_CLIENT_ID:clientId,PUBLIC_BASE_URL:origin,EBAY_CLIENT_ID:'synthetic-app',EBAY_CLIENT_SECRET:'synthetic-secret',MCP_RATE_LIMIT_PER_MINUTE:String(rateLimit)});
  const app=createBrowseApp(createBrowseContext(config,{fetchImpl:async(url,init)=>{
    providerCalls++;
    if(!url.includes('/identity/'))appTokenOnly &&=new Headers(init?.headers).get('authorization')==='Bearer synthetic-provider-token';
    return new Response(JSON.stringify(url.includes('/identity/')?{access_token:'synthetic-provider-token',expires_in:7200}:url.includes('item_summary')?{total:1,itemSummaries:[{itemId:'v1|123456789012|0',title:'Synthetic fixture comic'}]}:{itemId:'v1|123456789012|0',title:'Synthetic fixture comic'}),{headers:{'content-type':'application/json'}});
  }}),{sessionCancellation:stateful});
  listener.on('request',app);
  const token=async(changes:Record<string,unknown>={})=>new SignJWT({scope,azp:clientId,sub:'synthetic-user',iss:issuer,aud:origin+'/mcp',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+300,...changes}).setProtectedHeader({alg:'RS256',kid:'fixture-key'}).sign(signing);
  const rpc=(credential?:string,extra:Record<string,string>={})=>nativeFetch(origin+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',...(credential?{authorization:'Bearer '+credential}:{}),...extra},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})});
  const close=async()=>{app.locals.closeBrowseSessions();listener.closeAllConnections();await new Promise<void>(r=>listener.close(()=>r()));};
  return {origin,token,rpc,close,refreshCalls:()=>refreshCalls,providerCalls:()=>providerCalls,appTokenOnly:()=>appTokenOnly,recordAuthorization:(url:URL)=>{authorizationUrl=url;},pkceVerified:()=>pkceExchangeVerified};
}
describe('OAuth protected Browse transport',()=>{
  it('accepts a renewed same-principal JWT on its existing session and denies an expired JWT',async()=>{
    const h=await setup(true);const client=new Client({name:'synthetic-renewed-session',version:'1'});
    const transport=new StreamableHTTPClientTransport(new URL(h.origin+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+await h.token({jti:'before-renewal'})}}});
    try{
      await client.connect(transport);
      const session={'mcp-session-id':transport.sessionId!};
      expect((await h.rpc(await h.token({jti:'after-renewal',exp:Math.floor(Date.now()/1000)+600}),session)).status).toBe(200);
      expect((await h.rpc(await h.token({jti:'expired',exp:Math.floor(Date.now()/1000)-1}),session)).status).toBe(401);
      const terminated=await nativeFetch(h.origin+'/mcp',{method:'DELETE',headers:{authorization:'Bearer '+await h.token(),...session}});
      expect(terminated.status).toBe(204);
      expect((await h.rpc(await h.token(),session)).status).toBe(404);
      await client.close();
      await client.connect(new StreamableHTTPClientTransport(new URL(h.origin+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+await h.token({jti:'reinitialize'})}}}));
      expect((await client.listTools()).tools.length).toBe(3);
      expect(h.providerCalls()).toBe(0);
    }finally{await client.close();await h.close();}
  });
  it('does not let rejected callers exhaust the authenticated request quota',async()=>{
    const h=await setup(false,false,2);try{
      for(let i=0;i<4;i++)await h.rpc(i%2?'synthetic-invalid':undefined);
      expect((await h.rpc(await h.token())).status).toBe(200);
      expect((await h.rpc(await h.token())).status).toBe(200);
      expect((await h.rpc(await h.token())).status).toBe(429);
    }finally{await h.close();}
  });
  it('publishes canonical protected-resource metadata and a discovery challenge before login',async()=>{
    const h=await setup();try{
      for(const path of ['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp']){
        const res=await nativeFetch(h.origin+path);expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({resource:h.origin+'/mcp',authorization_servers:[issuer],scopes_supported:[scope],bearer_methods_supported:['header']});
      }
      const res=await h.rpc();expect(res.status).toBe(401);
      const challenge=res.headers.get('www-authenticate')||'';
      expect(challenge.includes('resource_metadata="'+h.origin+'/.well-known/oauth-protected-resource/mcp"')).toBe(true);
      expect(challenge.includes(scope)).toBe(true);expect(h.providerCalls()).toBe(0);
    }finally{await h.close();}
  });
  it('rejects wrong issuer,resource,client,scope,expiry,nbf,machine identity and missing expiry',async()=>{
    const h=await setup();try{
      const now=Math.floor(Date.now()/1000);
      for(const change of [{iss:'https://wrong.example/'},{aud:'some-other-api'},{azp:'another-client'},{scope:'ebay:seller:write'},{exp:now-1},{nbf:now+300},{gty:'client-credentials'},{sub:'machine@clients'},{sub:''},{exp:undefined}]){
        const res=await h.rpc(await h.token(change));
        expect([401,403].includes(res.status)).toBe(true);
      }
      expect(h.providerCalls()).toBe(0);
    }finally{await h.close();}
  });
  it('never accepts an old fixed bearer or query credential in OAuth mode',async()=>{
    const h=await setup();try{
      expect((await h.rpc('synthetic-'+ 'm'.repeat(43))).status).toBe(401);
      const res=await nativeFetch(h.origin+'/mcp?access_token=synthetic-not-a-token',{headers:{authorization:'Bearer '+await h.token()}});
      expect(res.status).toBe(400);expect(h.providerCalls()).toBe(0);
    }finally{await h.close();}
  });
  it('rejects a forged signature and ambiguous authorization header without trusting a token key URL',async()=>{
    const h=await setup();try{
      const wrong=await generateKeyPair('RS256');
      const forged=await new SignJWT({sub:'synthetic-user',scope,azp:clientId}).setIssuer(issuer).setAudience(h.origin+'/mcp').setExpirationTime('5m').setProtectedHeader({alg:'RS256',kid:'fixture-key',jku:'https://attacker.invalid/keys'}).sign(wrong.privateKey);
      expect((await h.rpc(forged)).status).toBe(401);
      const valid=await h.token();
      const ambiguous=await h.rpc(undefined,{authorization:'Bearer '+valid+' extra'});
      expect(ambiguous.status).toBe(401);expect(h.providerCalls()).toBe(0);
    }finally{await h.close();}
  });
  it('rejects duplicate raw Authorization header lines even when Node exposes only the first',async()=>{
    const h=await setup();try{
      const valid=await h.token();
      const status=await new Promise<number>((resolve,reject)=>{
        const request=httpRequest(new URL(h.origin+'/mcp'),{method:'POST',headers:['Host',new URL(h.origin).host,'Content-Type','application/json','Accept','application/json, text/event-stream','Authorization','Bearer '+valid,'authorization','Bearer synthetic-invalid']},response=>{response.resume();resolve(response.statusCode||0);});
        request.on('error',reject);request.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}}));
      });
      expect(status).toBe(401);expect(h.providerCalls()).toBe(0);
    }finally{await h.close();}
  });
  it('serves only the three scoped read tools through a real SDK client and exact linked item lookup',async()=>{
    const h=await setup(true);const client=new Client({name:'synthetic-oauth-sdk',version:'1'});
    const transport=new StreamableHTTPClientTransport(new URL(h.origin+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+await h.token()}}});
    try{
      await client.connect(transport);
      const tools=(await client.listTools()).tools;
      expect(tools.map(t=>t.name).sort()).toEqual(['get_connection_status','get_ebay_item','search_ebay']);
      // SDK1.32.1's client schema strips unknown top-level descriptor fields;
      // verify the published wire contract and its backwards-compatible mirror.
      const wire=await h.rpc(await h.token(),{'mcp-session-id':transport.sessionId!});
      expect(wire.status).toBe(200);
      for(const tool of (await wire.json()).result.tools)expect(tool).toMatchObject({securitySchemes:[{type:'oauth2',scopes:[scope]}],annotations:{readOnlyHint:true,destructiveHint:false}});
      for(const tool of tools)expect(tool._meta).toMatchObject({securitySchemes:[{type:'oauth2',scopes:[scope]}]});
      const status=(await client.callTool({name:'get_connection_status',arguments:{}})).structuredContent!;
      expect(status).toMatchObject({read_only:true,provider_access:'not_checked',authentication_mode:'oauth'});
      expect(typeof status.expires_at).toBe('string');
      const result=await client.callTool({name:'search_ebay',arguments:{q:'synthetic comic'}});
      const id=(result.structuredContent!.items as {item_id:string}[])[0].item_id;
      expect((await client.callTool({name:'get_ebay_item',arguments:{item_id:id}})).structuredContent).toMatchObject({item_id:id});
      expect(h.appTokenOnly()).toBe(true);
      expect((await client.callTool({name:'get_orders',arguments:{}})).isError).toBe(true);
    }finally{await client.close();await h.close();}
  });
  it('completes resource-bound authorization code and S256 PKCE with the SDK and a mocked external identity provider',async()=>{
    const h=await setup(true,true);let saved:OAuthTokens|undefined;let verifier='';let redirected:URL|undefined;
    const provider:OAuthClientProvider={
      redirectUrl:'https://client.example/callback',
      clientMetadata:{redirect_uris:['https://client.example/callback'],grant_types:['authorization_code'],response_types:['code'],token_endpoint_auth_method:'none',scope},
      state:()=> 'synthetic-state',clientInformation:()=>({client_id:clientId,issuer}),tokens:()=>saved,
      saveTokens:(tokens)=>{saved=tokens;},saveCodeVerifier:(value)=>{verifier=value;},codeVerifier:()=>verifier,
      redirectToAuthorization:(url)=>{redirected=url;h.recordAuthorization(url);},
    };
    const client=new Client({name:'synthetic-oauth-flow',version:'1'});
    const transport=new StreamableHTTPClientTransport(new URL(h.origin+'/mcp'),{authProvider:provider});
    try{
      let requestedLogin=false;
      try{await client.connect(transport);}catch(error){requestedLogin=error instanceof UnauthorizedError;}
      expect(requestedLogin).toBe(true);
      expect(redirected?.origin).toBe('https://identity.example');
      expect(redirected?.searchParams.get('resource')).toBe(h.origin+'/mcp');
      expect(redirected?.searchParams.get('state')).toBe('synthetic-state');
      expect(redirected?.searchParams.get('code_challenge_method')).toBe('S256');
      await transport.finishAuth('synthetic-code');
      expect(h.pkceVerified()).toBe(true);
      await client.close();
      await client.connect(new StreamableHTTPClientTransport(new URL(h.origin+'/mcp'),{authProvider:provider}));
      expect((await client.listTools()).tools.length).toBe(3);
      expect((await client.callTool({name:'get_connection_status',arguments:{}})).structuredContent).toMatchObject({authentication_mode:'oauth',read_only:true});
    }finally{await client.close();await h.close();}
  });
  it('denies another authenticated user access to a session it did not initialize',async()=>{
    const h=await setup(true);const client=new Client({name:'synthetic-session-owner',version:'1'});
    const transport=new StreamableHTTPClientTransport(new URL(h.origin+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+await h.token()}}});
    try{
      await client.connect(transport);
      const res=await h.rpc(await h.token({sub:'different-synthetic-user'}),{'mcp-session-id':transport.sessionId!});
      expect(res.status).toBe(404);expect(h.providerCalls()).toBe(0);
      const deleted=await nativeFetch(h.origin+'/mcp',{method:'DELETE',headers:{authorization:'Bearer '+await h.token({sub:'different-synthetic-user'}),'mcp-session-id':transport.sessionId!}});
      expect(deleted.status).toBe(404);
      expect((await h.rpc(await h.token({exp:Math.floor(Date.now()/1000)-1}),{'mcp-session-id':transport.sessionId!})).status).toBe(401);
      expect((await client.listTools()).tools.length).toBe(3);
    }finally{await client.close();await h.close();}
  });
});


describe('local SDK caller-token renewal qualification (not live Grok)',()=>{
  for(const mode of ['rotate','revoked','temporary','no-refresh'] as const){
    it('handles '+mode+' without provider credentials or business replay',async()=>{
      const h=await setup(true,true,120,mode==='no-refresh'?undefined:mode);
      let saved:OAuthTokens|undefined={access_token:await h.token({exp:Math.floor(Date.now()/1000)-30}),token_type:'Bearer',issuer,expires_in:1,scope:scope+' offline_access',...(mode==='no-refresh'?{}:{refresh_token:'synthetic-refresh-a'})};
      let redirects=0;let redirected:URL|undefined;let verifier='';
      const provider:OAuthClientProvider={
        redirectUrl:'https://client.example/callback',
        clientMetadata:{redirect_uris:['https://client.example/callback'],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none',scope:scope+' offline_access'},
        state:()=> 'synthetic-renewal-state',clientInformation:()=>({client_id:clientId,issuer}),tokens:()=>saved,
        saveTokens:(tokens)=>{saved=tokens;},saveCodeVerifier:(value)=>{verifier=value;},codeVerifier:()=>verifier,
        redirectToAuthorization:(url)=>{redirects++;redirected=url;},
        invalidateCredentials:()=>{saved=undefined;},
      };
      const client=new Client({name:'synthetic-renewal-'+mode,version:'1'});
      try{
        const transport=new StreamableHTTPClientTransport(new URL(h.origin+'/mcp'),{authProvider:provider});
        if(mode==='rotate'){
          await client.connect(transport);
          expect((await client.listTools()).tools.map(t=>t.name).sort()).toEqual(['get_connection_status','get_ebay_item','search_ebay']);
          expect((await client.callTool({name:'get_connection_status',arguments:{}})).structuredContent).toMatchObject({read_only:true,authentication_mode:'oauth'});
          expect(h.refreshCalls()).toBe(1);expect(saved?.refresh_token).toBe('synthetic-refresh-b');expect(redirects).toBe(0);
        }else{
          await expect(client.connect(transport)).rejects.toThrow();
          expect(h.refreshCalls()).toBe(mode==='no-refresh'?0:1);
          if(mode!=='temporary'){
            expect(redirects).toBe(1);
            // Current SDK prioritizes the protected-resource scope over client metadata.
            expect(redirected?.searchParams.get('scope')).toBe(scope);
            expect(redirected?.searchParams.get('resource')).toBe(h.origin+'/mcp');
            expect(redirected?.searchParams.get('code_challenge_method')).toBe('S256');
          }
        }
        expect(h.providerCalls()).toBe(0);
      }finally{await client.close();await h.close();}
    });
  }
});


it('preserves explicit offline_access in a resource-bound normal reconnect request',async()=>{
  const h=await setup(true,true);let redirected:URL|undefined;let verifier='';
  const provider:OAuthClientProvider={
    redirectUrl:'https://client.example/callback',
    clientMetadata:{redirect_uris:['https://client.example/callback'],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none',scope:scope+' offline_access'},
    state:()=> 'synthetic-explicit-scopes',clientInformation:()=>({client_id:clientId,issuer}),tokens:()=>undefined,
    saveTokens:()=>{},saveCodeVerifier:(value)=>{verifier=value;},codeVerifier:()=>verifier,
    redirectToAuthorization:(url)=>{redirected=url;},
  };
  try{
    expect(await auth(provider,{serverUrl:new URL(h.origin+'/mcp'),scope:scope+' offline_access'})).toBe('REDIRECT');
    expect(redirected?.searchParams.get('scope')?.split(' ').sort()).toEqual(['ebay:browse:read','offline_access']);
    expect(redirected?.searchParams.get('resource')).toBe(h.origin+'/mcp');
    expect(redirected?.searchParams.get('client_id')).toBe(clientId);
    expect(redirected?.searchParams.get('code_challenge_method')).toBe('S256');
    expect(h.providerCalls()).toBe(0);
  }finally{await h.close();}
});
