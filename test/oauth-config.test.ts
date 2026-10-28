import {describe,it,expect} from 'vitest';
import {loadBrowseConfig} from '../src/browse-core/config.js';

const oauth = {
  MCP_AUTH_MODE:'oauth',
  PUBLIC_BASE_URL:'https://browse.example',
  MCP_OAUTH_ISSUER:'https://identity.example/',
  MCP_OAUTH_CLIENT_ID:'synthetic-registered-client',
};
describe('protected Browse OAuth configuration',()=>{
  it('selects explicit OAuth without a legacy fixed credential and binds the exact resource',()=>{
    const config=loadBrowseConfig(oauth);
    expect(config).toMatchObject({authMode:'oauth',oauth:{issuer:'https://identity.example/',clientId:'synthetic-registered-client',resource:'https://browse.example/mcp',scope:'ebay:browse:read'}});
    expect(config.testTokenHash).toBe('');
  });
  it('never silently falls back from invalid OAuth to a valid legacy test key',()=>{
    const legacy={MCP_TEST_TOKEN_SHA256:'a'.repeat(64),MCP_TEST_EXPIRES_AT:new Date(Date.now()+3600000).toISOString()};
    for(const extra of [{MCP_OAUTH_ISSUER:''},{MCP_OAUTH_ISSUER:'http://identity.example/'},{MCP_OAUTH_ISSUER:'https://user:pass@identity.example/'},{MCP_OAUTH_CLIENT_ID:''},{MCP_AUTH_MODE:'anonymous'}]){
      expect(()=>loadBrowseConfig({...oauth,...legacy,...extra})).toThrow();
    }
  });
  it('keeps the original fixed-expiry HTTP policy as the default',()=>{
    expect(()=>loadBrowseConfig({})).toThrow();
    const expiry=new Date(Date.now()+3600000).toISOString();
    const config=loadBrowseConfig({MCP_TEST_TOKEN_SHA256:'a'.repeat(64),MCP_TEST_EXPIRES_AT:expiry});
    expect(config).toMatchObject({authMode:'test-token',testExpiresAt:Date.parse(expiry),oauth:undefined});
  });
});
