import esbuild from 'esbuild';
import fs from 'node:fs';

const entries = [
  { in: 'public/js/main.js', out: 'public/build/app.js' },
  { in: 'public/js/lab.js', out: 'public/build/lab.js' },
];
for (const e of entries) {
  await esbuild.build({
    entryPoints: [e.in],
    bundle: true,
    outfile: e.out,
    format: 'iife',
    target: ['es2020'],
    minify: false,
    sourcemap: false,
    logLevel: 'info',
    loader: { '.png': 'file' },
  });
  const size = (fs.statSync(e.out).size / 1024).toFixed(0);
  console.log('构建完成: ' + e.out + ' (' + size + ' KB)');
}
