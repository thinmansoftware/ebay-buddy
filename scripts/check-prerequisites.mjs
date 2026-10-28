#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

if(Number(process.versions.node.split('.')[0])<22){
  console.error('Node.js 22+ is required.');process.exit(2);
}
const python=process.env.EBAY_BUDDY_TEST_PYTHON ?? (process.platform==='win32'?'python':'python3');
const companion=fileURLToPath(new URL('../companion/cli.py',import.meta.url));
const result=spawnSync(python,[companion,'check'],{encoding:'utf8',timeout:10000,
  env:Object.fromEntries(Object.entries(process.env).filter(([name])=>
    ['PATH','SYSTEMROOT','WINDIR','TEMP','TMP'].includes(name.toUpperCase())))});
let valid=false;
try{valid=result.status===0 && JSON.parse(result.stdout).ready===true;}catch{/* Generic prerequisite error only. */}
if(!valid){
  console.error('Python 3.10+ and the complete companion are required for source qualification. Set EBAY_BUDDY_TEST_PYTHON to your Python executable if needed.');
  process.exit(2);
}
console.log('Node and Python prerequisites passed. No credentials or provider access checked.');
