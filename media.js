// Uploaded photos and videos. Files are streamed to DATA_DIR/media (never
// held in memory), then ffmpeg/ffprobe:
//   - converts videos to H.264/AAC MP4, the format WhatsApp plays everywhere
//     (iPhone .mov / HEVC included); already-compatible videos are only
//     remuxed, which is instant
//   - measures width/height (and video length) and makes a small JPEG
//     thumbnail — sent with the post so WhatsApp shows it at its real
//     aspect ratio instead of a square crop
//
// If ffmpeg isn't installed (some local setups), photos still work, just
// without the size info.

import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const err = (message, status) => Object.assign(new Error(message), { status });

export const LIMITS = { image: 15 * 1024 * 1024, video: 100 * 1024 * 1024 };
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const THUMB_PX = 96;
const STALE_MS = 24 * 60 * 60 * 1000; // uploads never posted are removed after a day

export function kindOf(type) {
  if (IMAGE_TYPES[type]) return 'image';
  if (/^video\//.test(type)) return 'video';
  return null;
}

async function probe(path) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path,
  ]);
  const info = JSON.parse(stdout);
  const v = info.streams.find((s) => s.codec_type === 'video');
  const a = info.streams.find((s) => s.codec_type === 'audio');
  // Phone videos are often stored sideways with a rotation flag.
  const rot = Math.abs(Number(v?.tags?.rotate ?? v?.side_data_list?.find((d) => 'rotation' in d)?.rotation ?? 0));
  const sideways = rot === 90 || rot === 270;
  return {
    width: sideways ? v?.height : v?.width,
    height: sideways ? v?.width : v?.height,
    seconds: Math.round(Number(info.format?.duration) || 0),
    videoCodec: v?.codec_name,
    audioCodec: a?.codec_name ?? null,
    container: info.format?.format_name ?? '',
  };
}

// `at` (seconds) is for videos — a frame ~1 s in beats a black first frame.
// Seeking must be skipped for photos: ffmpeg outputs nothing for a JPEG.
async function thumbnail(path, at = 0) {
  const { stdout } = await run('ffmpeg', [
    '-v', 'error', ...(at ? ['-ss', String(at)] : []), '-i', path, '-frames:v', '1',
    '-vf', `scale=${THUMB_PX}:${THUMB_PX}:force_original_aspect_ratio=decrease,format=yuvj420p`,
    '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '5', 'pipe:1',
  ], { encoding: 'buffer', maxBuffer: 1024 * 1024 });
  if (!stdout.length) throw new Error('empty thumbnail');
  return stdout.toString('base64');
}

// Make a video WhatsApp-friendly. Returns the path of the final .mp4.
async function toMp4(src, dest) {
  const p = await probe(src);
  const compatible = p.videoCodec === 'h264' && (!p.audioCodec || p.audioCodec === 'aac') && /mp4|mov/.test(p.container);
  const args = compatible
    ? ['-c', 'copy']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
       // keep the long side ≤ 1280 px (WhatsApp recompresses bigger anyway)
       '-vf', "scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(1280,ih))'",
       '-c:a', 'aac', '-b:a', '128k'];
  await run('ffmpeg', ['-v', 'error', '-y', '-i', src, ...args, '-movflags', '+faststart', dest], {
    timeout: 10 * 60 * 1000,
  });
}

export function createMedia({ dir, keep = () => new Set() }) {
  const mediaDir = join(dir, 'media');
  const uploads = new Map(); // id → stored info, until it's posted or queued

  async function prune() {
    const owned = keep();
    const files = await readdir(mediaDir).catch(() => []);
    for (const f of files) {
      if (owned.has(f) || [...uploads.values()].some((u) => u.file === f && Date.now() - u.at < STALE_MS)) continue;
      const s = await stat(join(mediaDir, f)).catch(() => null);
      if (s && Date.now() - s.mtimeMs > STALE_MS) await rm(join(mediaDir, f), { force: true });
    }
    for (const [id, u] of uploads) if (Date.now() - u.at > STALE_MS) uploads.delete(id);
  }

  return {
    dir: mediaDir,

    // Stream a raw upload (request body) to disk and process it.
    async store(req) {
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const kind = kindOf(type);
      if (!kind) throw err('Only photos (JPEG, PNG, WebP) and videos can be added', 415);
      const limit = LIMITS[kind];
      if (Number(req.headers['content-length']) > limit) {
        throw err(`${kind === 'video' ? 'Video' : 'Photo'} is too big (max ${limit / 1024 / 1024} MB)`, 413);
      }

      await mkdir(mediaDir, { recursive: true });
      const id = randomUUID();
      const raw = join(mediaDir, `${id}.upload`);
      let size = 0;
      try {
        await pipeline(
          req,
          async function* (source) {
            for await (const chunk of source) {
              size += chunk.length;
              if (size > limit) throw err(`${kind === 'video' ? 'Video' : 'Photo'} is too big (max ${limit / 1024 / 1024} MB)`, 413);
              yield chunk;
            }
          },
          createWriteStream(raw),
        );

        let file;
        let mimetype;
        if (kind === 'video') {
          file = `${id}.mp4`;
          mimetype = 'video/mp4';
          try {
            await toMp4(raw, join(mediaDir, file));
          } catch (e) {
            throw err(`Couldn't read that video (${e.code === 'ENOENT' ? 'ffmpeg is not installed' : 'unsupported or damaged file'})`, 422);
          }
          await rm(raw, { force: true });
        } else {
          file = `${id}.${IMAGE_TYPES[type]}`;
          mimetype = type;
          await rename(raw, join(mediaDir, file));
        }

        const info = { file, kind, mimetype, size };
        try {
          const p = await probe(join(mediaDir, file));
          Object.assign(info, { width: p.width, height: p.height }, kind === 'video' ? { seconds: p.seconds } : {});
          info.thumb = await thumbnail(join(mediaDir, file), kind === 'video' ? Math.min(1, p.seconds / 2) : 0);
        } catch (e) {
          if (kind === 'video') throw err('Could not read the converted video', 422);
          console.warn(`No size/thumbnail for photo (${e.code === 'ENOENT' ? 'ffmpeg not installed' : e.message})`);
        }

        uploads.set(id, { ...info, at: Date.now() });
        prune().catch(() => {});
        return { id, ...info, thumb: undefined };
      } catch (e) {
        await rm(raw, { force: true });
        throw e;
      }
    },

    // Hand an upload over to a post; it's no longer "pending".
    take(id) {
      const u = uploads.get(id);
      if (!u) throw err('That photo/video upload expired — add it again', 410);
      uploads.delete(id);
      const { at, ...info } = u;
      return info;
    },

    // For "post now": what deliver() needs, from a taken upload.
    toDeliverable: (info) => ({
      kind: info.kind,
      mimetype: info.mimetype,
      path: join(mediaDir, info.file),
      width: info.width,
      height: info.height,
      seconds: info.seconds,
      thumbnail: info.thumb ? Buffer.from(info.thumb, 'base64') : undefined,
    }),

    remove: (info) => rm(join(mediaDir, info.file), { force: true }),
  };
}
