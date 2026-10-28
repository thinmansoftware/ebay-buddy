import {createHash} from "node:crypto";
import {createRemoteJWKSet,jwtVerify} from "jose";
import {requireBearerAuth} from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {InvalidTokenError} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {AuthInfo} from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {RequestHandler} from "express";
import type {BrowseOAuthConfig} from "../browse-core/config.js";

/** Verify only resource-specific access tokens from the configured identity
 * authority. No token store, provider credential forwarding or authorization server.
 */
export function browseOAuthAccess(config:BrowseOAuthConfig):RequestHandler {
  const keys=createRemoteJWKSet(new URL(".well-known/jwks.json",config.issuer),{
    timeoutDuration:3000,cooldownDuration:30000,cacheMaxAge:600000,
  });
  const metadataUrl=new URL("/.well-known/oauth-protected-resource/mcp",config.resource).href;
  const enforce=requireBearerAuth({
    resourceMetadataUrl: metadataUrl,
    expectedResource:new URL(config.resource),
    requiredScopes:[config.scope],
    verifier:{async verifyAccessToken(token:string):Promise<AuthInfo>{
      try {
        if(token.length>8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))throw new Error();
        const {payload}=await jwtVerify(token,keys,{
          issuer:config.issuer,audience:config.resource,algorithms:["RS256"],requiredClaims:["sub","exp"],
        });
        const subject=payload.sub;
        const client=payload.azp??payload.client_id;
        if(typeof subject!=="string" || !subject.trim() || subject.length>256 || subject.endsWith("@clients") ||
          payload.gty==="client-credentials" || payload.gty==="client_credentials" ||
          client!==config.clientId || (payload.azp!==undefined && payload.client_id!==undefined && payload.azp!==payload.client_id) ||
          typeof payload.scope!=="string" || payload.scope.length>2048 || !Number.isFinite(payload.exp))throw new Error();
        return {token,clientId:config.clientId,scopes:payload.scope.split(" ").filter(Boolean),expiresAt:payload.exp,
          resource:new URL(config.resource),extra:{principal:createHash("sha256").update(config.issuer+"\0"+subject+"\0"+config.clientId).digest("hex")}};
      } catch {
        // Neither JOSE diagnostics nor token values may enter HTTP errors/logs.
        throw new InvalidTokenError("Access token is invalid or unavailable.");
      }
    }},
  });
  return (req,res,next)=>{
    const header=req.headers.authorization;
    const headerCount=req.rawHeaders.reduce((count,name,index)=>count+(index%2===0 && name.toLowerCase()==="authorization"?1:0),0);
    if(headerCount>1 || (header && (header.length>8200 || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(header)))){
      res.setHeader("WWW-Authenticate",`Bearer error="invalid_token", error_description="Invalid authorization header.", scope="${config.scope}", resource_metadata="${metadataUrl}"`);
      res.status(401).json({error:"invalid_token"});return;
    }
    return enforce(req,res,next);
  };
}
