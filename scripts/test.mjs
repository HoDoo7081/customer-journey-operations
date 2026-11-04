import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
for(const file of ['payment-first.mjs','payment-first-server.mjs','manual-confirmation.mjs','reliability.mjs','mail-lock.mjs','test-delete.mjs','application-errors.mjs']){const r=spawnSync(process.execPath,[root+'tests/'+file],{cwd:root,stdio:'inherit'});if(r.status!==0)process.exit(r.status||1);}
