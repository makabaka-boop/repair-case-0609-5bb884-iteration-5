#!/usr/bin/env node
/** 验收前等待 web 服务返回 200，最多 60 秒。 */
const http = require('http');

const url = process.env.WAIT_URL ?? 'http://web:8080/';
const deadline = Date.now() + 60_000;

function check() {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

(async () => {
  while (Date.now() < deadline) {
    if (await check()) {
      console.log(`web 服务已就绪：${url}`);
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error(`等待超时：${url} 未就绪`);
  process.exit(1);
})();
