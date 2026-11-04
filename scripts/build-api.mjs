import {build} from '../mockup/node_modules/esbuild/lib/main.js';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../mockup/',import.meta.url));
await build({entryPoints:[root+'api/service.js'],outfile:root+'api/service.bundle.js',bundle:true,platform:'node',target:'node22',format:'esm'});
