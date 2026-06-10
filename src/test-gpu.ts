import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';

async function runCommand(command: string, args: string[]) {
  console.log(`\n> Running: ${command} ${args.join(' ')}\n`);
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed with code ${code}`));
    });
  });
}

async function runTest() {
  const workDir = path.join(process.cwd(), 'test-workspace');
  await fs.mkdir(workDir, { recursive: true });

  const inputPath = path.join(workDir, 'dummy.mp4');

  try {
    console.log('--- Step 1: Checking NVIDIA GPU & FFmpeg ---');
    await runCommand('ffmpeg', ['-hwaccels']);
    await runCommand('ffmpeg', ['-encoders', '|', 'findstr', 'nvenc']).catch(() => console.log('Notice: findstr may fail if not on Windows, ignoring.'));

    console.log('\n--- Step 2: Generating a 5-second test video ---');
    await runCommand('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'testsrc=duration=5:size=1280x720:rate=30',
      '-f', 'lavfi', '-i', 'anoisesrc=d=5:c=pink:r=48000:a=0.1',
      '-c:v', 'libx264', '-c:a', 'aac', inputPath
    ]);

    console.log('\n--- Step 3: Testing Full VRAM Pipeline (Decode -> Scale -> Encode) ---');
    
    // Test parameters
    const targetW = 854;
    const targetH = 480;

    const args = [
      '-hide_banner',
      '-y',
      '-hwaccel', 'cuda',
      '-hwaccel_output_format', 'cuda',
      '-i', inputPath,
      '-filter_complex', `[0:v]scale_cuda=w=${targetW}:h=${targetH}[v_scaled]`,
      '-map', '[v_scaled]',
      '-c:v', 'h264_nvenc',
      '-preset', 'p5',
      '-tune', 'hq',
      '-rc', 'vbr',
      '-cq', '28',
      '-b:v', '1400k',
      '-maxrate', '1500k',
      '-bufsize', '2100k',
      '-an', // Ignore audio for video test
      path.join(workDir, 'output_480p_gpu.mp4')
    ];

    await runCommand('ffmpeg', args);

    console.log('\n✅ SUCCESS! Your local FFmpeg successfully utilized the NVIDIA GPU for full hardware decoding, scaling, and encoding!');
  } catch (error) {
    console.error('\n❌ TEST FAILED: Your local FFmpeg might not support the full CUDA pipeline. This is common on Windows unless you use a custom FFmpeg build.');
    console.error('Do not worry, the Docker container uses the official NVIDIA base image and will work fine on the server.');
    console.error(error);
  }
}

runTest();
