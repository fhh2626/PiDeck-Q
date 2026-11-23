import assert from 'node:assert/strict';
import test from 'node:test';
import { withHookHost } from './helpers/l5_hookHost.mjs';

async function withStream(run) {
  await withHookHost(async (host) => {
    let time = 100;
    const { useSmoothStream } = host.load('src/renderer/src/utils/useSmoothStream.ts', {
      globals: {
        performance: { now: () => time },
        requestAnimationFrame: (callback) => host.globals.requestAnimationFrame(() => callback(time)),
      },
    });
    const step = async () => { time += 40; await host.flushFrames(); };
    await run({ ...host, useSmoothStream, step });
  });
}

test('an empty stream has no frame loop, and sparse text wakes it on every arrival', async () => {
  await withStream(async ({ mount, useSmoothStream, pendingFrames, step }) => {
    const stream = await mount(useSmoothStream, { content: 'base', isStreaming: true });
    assert.equal(pendingFrames(), 0);
    for (const content of ['base 中', 'base 中🙂']) {
      await stream.rerender({ content, isStreaming: true });
      for (let i = 0; i < 5 && pendingFrames(); i++) await step();
      assert.equal(stream.result().displayedContent, content);
      assert.equal(pendingFrames(), 0, 'no frame remains once the displayed text catches up');
    }
  });
});

test('completion and message replacement cancel queued frames immediately', async () => {
  await withStream(async ({ mount, useSmoothStream, pendingFrames, step }) => {
    const stream = await mount(useSmoothStream, { content: '', isStreaming: true });
    const content = 'text with a long backlog '.repeat(50);
    await stream.rerender({ content, isStreaming: true });
    await step();
    assert.equal(pendingFrames(), 1);
    await stream.rerender({ content: content + 'final', isStreaming: false });
    assert.equal(stream.result().displayedContent, content + 'final');
    assert.equal(pendingFrames(), 0);
    await stream.rerender({ content: 'new message', isStreaming: true });
    await stream.rerender({ content: 'new message with a backlog', isStreaming: true });
    assert.equal(pendingFrames(), 1);
    await stream.rerender({ content: 'replacement', isStreaming: true });
    assert.equal(stream.result().displayedContent, 'replacement');
    assert.equal(pendingFrames(), 0);
    await stream.rerender({ content: 'replacement with a backlog', isStreaming: true });
    assert.equal(pendingFrames(), 1);
    await stream.unmount();
    assert.equal(pendingFrames(), 0);
  });
});

test('disabling a busy stream discards queued text without replay when reenabled', async () => {
  await withStream(async ({ mount, useSmoothStream, pendingFrames, step }) => {
    const streaming = { isStreaming: true };
    const stream = await mount(useSmoothStream, { ...streaming, content: '' });
    await stream.rerender({ ...streaming, content: 'a long queued response' });
    assert.ok(pendingFrames());
    await stream.rerender({ ...streaming, content: 'a long queued response', disabled: true });
    assert.equal(stream.result().displayedContent, 'a long queued response');
    assert.equal(pendingFrames(), 0);
    await stream.rerender({ ...streaming, content: 'a long queued response' });
    assert.equal(stream.result().displayedContent, 'a long queued response');
    await stream.rerender({ ...streaming, content: 'a long queued response!' });
    await step();
    assert.equal(stream.result().displayedContent, 'a long queued response!');
    assert.equal(pendingFrames(), 0);
  });
});
