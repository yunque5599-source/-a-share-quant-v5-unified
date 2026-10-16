import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('research dashboard JavaScript remains syntactically valid after V12 panel update', async () => {
  const html = await readFile(new URL('../../../index.html', import.meta.url), 'utf8');
  const match = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(match, 'dashboard script block missing');
  assert.doesNotThrow(() => new vm.Script(match[1], {filename:'index.html<script>'}));
  assert.match(html, /id="v12Btn"/);
  assert.match(html, /\/api\/v12_decision/);
});
