import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
for(const mode of ['share','stop'])test(`optional location schema activates only on first ${mode} and reset remains fail-closed`,()=>{
 const result=spawnSync(process.execPath,['--conditions=react-server','--experimental-strip-types','tests/optional-location-schema.fixture.mjs',mode],{encoding:'utf8',timeout:30000});
 assert.equal(result.status,0,result.stderr||result.stdout);
});
