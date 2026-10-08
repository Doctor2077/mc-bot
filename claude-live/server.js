const http = require('http');
const fs = require('fs');
const path = require('path');

const LOG = path.join(__dirname, 'claude-live.log');
const PORT = 8900;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  } else if (url === '/log') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    const content = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf-8') : '';
    const lines = content.split('\n').filter(l => l.trim()
      && !l.includes('thinking_tokens')
      && !l.includes('"subtype":"init"')
      && !l.includes('"subtype":"thinking"'));
    const tail = lines.slice(-150).join('\n');
    res.end(JSON.stringify({ size: lines.length, tail }));
  } else {
    res.writeHead(404);
    res.end('404');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Claude Code live panel: http://127.0.0.1:' + PORT);
});
