// 守护 Cloudflare 快速隧道：隧道挂了就自动重开，并把当前外网地址写进
// /tmp/city-tunnel-url.txt（trycloudflare 的随机域名每次重开都会变）
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const BIN = '/tmp/cloudflared';
const PORT = process.env.CITY_PORT || '5180';
const OUT = '/tmp/city-tunnel-url.txt';
let child = null;

function start() {
  child = spawn(BIN, ['tunnel', '--url', 'http://127.0.0.1:' + PORT, '--no-autoupdate'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const onData = (buf) => {
    const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) {
      const url = m[0];
      fs.writeFileSync(OUT, url + '\n');
      console.log('[隧道] 新地址: ' + url + '  (' + new Date().toLocaleTimeString() + ')');
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (code) => {
    console.log('[隧道] 进程退出 code=' + code + '，3 秒后重开');
    setTimeout(start, 3000);
  });
}

start();
setInterval(() => {
  // 每分钟探测一次当前地址，失败立刻重开
  const url = (fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').trim() : '');
  if (!url) return;
  fetch(url, { redirect: 'manual' }).then(() => { }).catch(() => {
    console.log('[隧道] 探测失败，重开');
    try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
  });
}, 60000);
