/** Peek at a stored session: header, tail event types, and a hint of what it chats about. */
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

for (const file of process.argv.slice(2)) {
  console.log(`\n=== ${file} ===`);
  let text;
  try {
    text = zstdDecompressSync(readFileSync(file)).toString('utf8');
  } catch (err) {
    console.log('  decompress failed:', err.message);
    continue;
  }
  const lines = text.split('\n').filter(Boolean);
  console.log(`  ${lines.length} records, ${(text.length / 1024).toFixed(0)} KB of jsonl`);
  const head = lines[0];
  try {
    const first = JSON.parse(head);
    const h = first.header ?? first;
    console.log('  header:', JSON.stringify({ cwd: h.cwd, agentPreset: h.agentPreset, createdAt: h.createdAt, id: h.id }));
  } catch { console.log('  head:', head.slice(0, 200)); }
  const types = new Map();
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      const type = record?.event?.type ?? record?.type ?? '?';
      types.set(type, (types.get(type) ?? 0) + 1);
    } catch { /* skip */ }
  }
  console.log('  event types:', [...types.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}×${v}`).join(' '));
  // the last assistant text says what it was doing
  for (let i = lines.length - 1; i >= 0 && i > lines.length - 40; i--) {
    try {
      const record = JSON.parse(lines[i]);
      const event = record?.event;
      if (event?.type === 'assistant/message') {
        const blocks = event.data?.message?.content ?? [];
        const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
        if (text) { console.log('  last assistant text:', JSON.stringify(text.slice(0, 160))); break; }
      }
    } catch { /* skip */ }
  }
}
