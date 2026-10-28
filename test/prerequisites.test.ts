import {describe,it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';

const script=resolve('scripts/check-prerequisites.mjs');
describe('source qualification prerequisites',()=>{
  it('reports a missing Python prerequisite without exposing its value',()=>{
    const result=spawnSync(process.execPath,[script],{cwd:tmpdir(),encoding:'utf8',
      env:{...process.env,EBAY_BUDDY_TEST_PYTHON:resolve('synthetic-does-not-exist')}});
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Python 3.10+');
    expect(result.stderr).not.toContain('synthetic-does-not-exist');
  });
  it('checks the installed companion from another working directory',()=>{
    const result=spawnSync(process.execPath,[script],{cwd:tmpdir(),encoding:'utf8',env:process.env});
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Node and Python prerequisites passed');
  });
});
