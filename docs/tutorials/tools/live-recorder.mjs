// Records the owner's Chrome window while we work in it, with no sound. Each piece of work on the screen is one segment; between
// them nothing is recorded, so a pause in the work is a pause in the video. `assemble` joins the segments into one video.
//   const rec = await startSegment(page, 'studio-session');  ...work on the screen...  await rec.stop();
//   node docs/tutorials/tools/live-recorder.mjs assemble studio-session studio/01-session
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const sessionDir = (name) => path.join(ROOT, 'docs/tutorials/.sessions', name);

export async function startSegment(page, session) {
  const dir = sessionDir(session);
  mkdirSync(dir, { recursive: true });
  const n = readdirSync(dir).filter((f) => f.startsWith('segment-')).length;
  const seg = path.join(dir, `segment-${String(n).padStart(3, '0')}`);
  mkdirSync(seg);
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', async (f) => {
    const file = `f${String(frames.length).padStart(6, '0')}.jpg`;
    writeFileSync(path.join(seg, file), Buffer.from(f.data, 'base64'));
    frames.push({ file, at: f.metadata.timestamp });
    await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 });
  const started = Date.now() / 1000;
  return {
    stop: async () => {
      const ended = Date.now() / 1000;
      await cdp.send('Page.stopScreencast').catch(() => undefined);
      await cdp.detach().catch(() => undefined);
      const lines = [];
      frames.forEach((f, i) => {
        const next = frames[i + 1]?.at ?? Math.max(ended, f.at + 0.5);
        lines.push(`file '${f.file}'`, `duration ${Math.max(0.01, next - f.at).toFixed(3)}`);
      });
      if (frames.length) lines.push(`file '${frames.at(-1).file}'`);
      writeFileSync(path.join(seg, 'frames.txt'), lines.join('\n') + '\n');
      return { frames: frames.length, seconds: Math.round(ended - started) };
    },
  };
}

/** Joins every segment of a session, in order, into docs/tutorials/<out>.mp4. */
export function assemble(session, out) {
  const dir = sessionDir(session);
  const target = path.join(ROOT, 'docs/tutorials', out + '.mp4');
  mkdirSync(path.dirname(target), { recursive: true });
  const parts = readdirSync(dir).filter((f) => f.startsWith('segment-') && existsSync(path.join(dir, f, 'frames.txt'))).sort();
  const clips = parts.map((p) => {
    const mp4 = path.join(dir, p + '.mp4');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(dir, p, 'frames.txt'), '-vf', 'fps=25,scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', mp4]);
    return mp4;
  });
  const list = path.join(dir, 'parts.txt');
  writeFileSync(list, clips.map((c) => `file '${c}'`).join('\n') + '\n');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', target]);
  return target;
}

if (process.argv[2] === 'assemble') console.log(assemble(process.argv[3], process.argv[4]));
