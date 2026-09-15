// 等价验证 session_index.rs 的追加/去重逻辑
const fs = require('fs');
const os = require('os');
const path = require('path');

function appendIndex(indexPath, id, threadName, updatedAt) {
  if (fs.existsSync(indexPath)) {
    const lines = fs.readFileSync(indexPath, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const l of lines) {
      try { if (JSON.parse(l).id === id) return false; } catch {}
    }
  }
  fs.appendFileSync(indexPath, JSON.stringify({ id, thread_name: threadName, updated_at: updatedAt }) + '\n');
  return true;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-'));
const idx = path.join(dir, 'session_index.jsonl');
fs.writeFileSync(idx, JSON.stringify({ id: 'old', thread_name: '已有对话', updated_at: '2026-01-01T00:00:00Z' }) + '\n');

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n)); };

check('append new id', appendIndex(idx, 'new', '导入的对话', '2026-09-15T00:00:00Z') === true);
check('dedupe same id', appendIndex(idx, 'new', '导入的对话', '2026-09-15T00:00:00Z') === false);

const lines = fs.readFileSync(idx, 'utf8').trim().split('\n');
check('existing line preserved', lines[0].includes('"id":"old"') && lines[0].includes('已有对话'));
check('new line appended', lines.length === 2 && lines[1].includes('"id":"new"') && lines[1].includes('导入的对话'));
check('format matches codex (3 keys)', Object.keys(JSON.parse(lines[1])).sort().join() === 'id,thread_name,updated_at');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
