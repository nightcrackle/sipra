import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  meetsMinimumPython,
  parsePythonVersion,
  type ProcessRunner,
  PYTHON_VERSION,
  type RunOptions,
  type RunResult,
  RuntimeManager,
  torchRequirementsFile,
  uvBinaryName,
  venvPythonPath,
} from '../electron/services/runtime';

/**
 * A scripted stand-in for the real process runner.
 *
 * Every step of setup goes through this interface precisely so the whole
 * state machine — including the failure paths people actually hit — can be
 * tested without downloading two gigabytes of PyTorch.
 */
class FakeRunner implements ProcessRunner {
  readonly calls: Array<{ command: string; args: string[] }> = [];
  existing = new Set<string>();
  onPath = new Map<string, string>();
  responses: Array<{ match: RegExp; result: Partial<RunResult> }> = [];
  defaultResult: RunResult = { code: 0, stdout: '', stderr: '' };

  async run(command: string, args: string[], _options?: RunOptions): Promise<RunResult> {
    this.calls.push({ command, args });
    const line = `${command} ${args.join(' ')}`;
    for (const response of this.responses) {
      if (response.match.test(line)) {
        return { code: 0, stdout: '', stderr: '', ...response.result };
      }
    }
    return this.defaultResult;
  }

  async exists(filePath: string): Promise<boolean> {
    return this.existing.has(filePath);
  }

  async which(command: string): Promise<string | null> {
    return this.onPath.get(command) ?? null;
  }

  called(pattern: RegExp): boolean {
    return this.calls.some((call) => pattern.test(`${call.command} ${call.args.join(' ')}`));
  }
}

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sipra-runtime-'));
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

function makeManager(runner: FakeRunner, forceCpu = true): RuntimeManager {
  return new RuntimeManager({
    runtimeDir: path.join(directory, 'runtime'),
    corePath: path.join(directory, 'python'),
    binDir: path.join(directory, 'bin'),
    requirementsDir: path.join(directory, 'python', 'requirements'),
    runner,
    forceCpu,
  });
}

describe('version helpers', () => {
  it.each([
    ['Python 3.11.9', [3, 11, 9]],
    ['Python 3.12', [3, 12, 0]],
    ['python 3.10.14\n', [3, 10, 14]],
  ])('parses %s', (output, expected) => {
    expect(parsePythonVersion(output)).toEqual(expected);
  });

  it('returns null for unparseable output', () => {
    expect(parsePythonVersion('command not found')).toBeNull();
    expect(parsePythonVersion('')).toBeNull();
  });

  it.each([
    [[3, 11, 0], true],
    [[3, 10, 0], true],
    [[3, 12, 5], true],
    [[4, 0, 0], true],
    [[3, 9, 18], false],
    [[2, 7, 18], false],
  ])('decides whether %j meets the minimum', (version, expected) => {
    expect(meetsMinimumPython(version)).toBe(expected);
  });

  it('rejects a missing version', () => {
    expect(meetsMinimumPython(null)).toBe(false);
    expect(meetsMinimumPython([3])).toBe(false);
  });
});

describe('path helpers', () => {
  it('puts the venv interpreter in the right place per platform', () => {
    expect(venvPythonPath('/rt', 'win32')).toBe(path.join('/rt', 'venv', 'Scripts', 'python.exe'));
    expect(venvPythonPath('/rt', 'linux')).toBe(path.join('/rt', 'venv', 'bin', 'python'));
  });

  it('names the uv binary per platform', () => {
    expect(uvBinaryName('win32')).toBe('uv.exe');
    expect(uvBinaryName('linux')).toBe('uv');
  });

  it('picks the CPU wheels unless a GPU was found', () => {
    // The CUDA wheels are several times larger and useless without one.
    expect(torchRequirementsFile(false)).toBe('torch-cpu.txt');
    expect(torchRequirementsFile(true)).toBe('torch-cuda.txt');
  });
});

describe('detect', () => {
  it('reports that setup is needed when no environment exists', async () => {
    const status = await makeManager(new FakeRunner()).detect();
    expect(status.stage).toBe('idle');
    expect(status.pythonPath).toBeNull();
  });

  it('reports ready when the environment exists and runs', async () => {
    const runner = new FakeRunner();
    const python = venvPythonPath(path.join(directory, 'runtime'));
    runner.existing.add(python);
    runner.responses.push({ match: /sipra_core --version/, result: { stdout: 'sipra-core 0.9.0' } });

    const status = await makeManager(runner).detect();
    expect(status.stage).toBe('ready');
    expect(status.pythonPath).toBe(python);
  });

  it('reports setup needed when the interpreter exists but does not work', async () => {
    // A half-finished install is worse than none; better to redo it.
    const runner = new FakeRunner();
    runner.existing.add(venvPythonPath(path.join(directory, 'runtime')));
    runner.defaultResult = { code: 1, stdout: '', stderr: 'ModuleNotFoundError' };

    expect((await makeManager(runner).detect()).stage).toBe('idle');
  });
});

describe('install', () => {
  it('creates the environment with a bundled uv when one is present', async () => {
    const runner = new FakeRunner();
    const uv = path.join(directory, 'bin', uvBinaryName());
    runner.existing.add(uv);
    runner.responses.push({ match: /sipra_core --version/, result: { stdout: 'sipra-core 0.9.0' } });

    const status = await makeManager(runner).install();
    expect(status.stage).toBe('ready');
    expect(runner.called(new RegExp(`venv --python ${PYTHON_VERSION}`))).toBe(true);
  });

  it('falls back to a system Python when uv is unavailable', async () => {
    const runner = new FakeRunner();
    runner.onPath.set('python3', '/usr/bin/python3');
    runner.onPath.set('python', '/usr/bin/python');
    runner.responses.push({ match: /--version/, result: { stdout: 'Python 3.11.9' } });
    runner.responses.push({ match: /sipra_core --version/, result: { stdout: 'sipra-core 0.9.0' } });

    const status = await makeManager(runner).install();
    expect(status.stage).toBe('ready');
    expect(runner.called(/-m venv/)).toBe(true);
  });

  it('refuses a system Python that is too old', async () => {
    const runner = new FakeRunner();
    runner.onPath.set('python3', '/usr/bin/python3');
    runner.responses.push({ match: /--version/, result: { stdout: 'Python 3.8.10' } });

    const status = await makeManager(runner).install();
    expect(status.stage).toBe('failed');
    expect(status.error?.message).toMatch(/python\.org/i);
  });

  it('explains a failed package download in plain language', async () => {
    const runner = new FakeRunner();
    runner.existing.add(path.join(directory, 'bin', uvBinaryName()));
    runner.responses.push({
      match: /pip install/,
      result: { code: 1, stderr: 'Could not resolve host: pypi.org' },
    });

    const status = await makeManager(runner).install();
    expect(status.stage).toBe('failed');
    expect(status.error?.message).toMatch(/internet connection/i);
    expect(status.error?.details?.stderr).toContain('pypi.org');
  });

  it('fails when the installed runtime cannot be verified', async () => {
    const runner = new FakeRunner();
    runner.existing.add(path.join(directory, 'bin', uvBinaryName()));
    runner.responses.push({
      match: /sipra_core --version/,
      result: { code: 1, stderr: 'ImportError: numpy' },
    });

    const status = await makeManager(runner).install();
    expect(status.stage).toBe('failed');
    expect(status.error?.code).toBe('RUNTIME_VERIFY_FAILED');
  });

  it('reports progress that only ever moves forward', async () => {
    const runner = new FakeRunner();
    runner.existing.add(path.join(directory, 'bin', uvBinaryName()));
    runner.responses.push({ match: /sipra_core --version/, result: { stdout: 'sipra-core 0.9.0' } });

    const manager = makeManager(runner);
    const fractions: number[] = [];
    manager.on('changed', (status) => fractions.push(status.fraction));
    await manager.install();

    expect(fractions.at(-1)).toBe(1);
    expect(fractions.every((value) => value >= 0 && value <= 1)).toBe(true);
  });

  it('runs only one install at a time', async () => {
    // Two concurrent installs writing the same venv would corrupt it.
    const runner = new FakeRunner();
    runner.existing.add(path.join(directory, 'bin', uvBinaryName()));
    runner.responses.push({ match: /sipra_core --version/, result: { stdout: 'sipra-core 0.9.0' } });

    const manager = makeManager(runner);
    const [first, second] = await Promise.all([manager.install(), manager.install()]);
    expect(first).toEqual(second);
    expect(runner.calls.filter((call) => call.args.includes('venv'))).toHaveLength(1);
  });

  it('skips creating an environment that already exists', async () => {
    const runner = new FakeRunner();
    runner.existing.add(venvPythonPath(path.join(directory, 'runtime')));
    runner.responses.push({ match: /sipra_core --version/, result: { stdout: 'sipra-core 0.9.0' } });

    await makeManager(runner).install();
    expect(runner.called(/venv --python/)).toBe(false);
    expect(runner.called(/pip install/)).toBe(true);
  });
});

describe('GPU detection', () => {
  it('reports a GPU when nvidia-smi answers', async () => {
    const runner = new FakeRunner();
    runner.responses.push({
      match: /nvidia-smi/,
      result: { code: 0, stdout: 'NVIDIA GeForce RTX 4070\n' },
    });
    expect(await makeManager(runner, false).detectCuda()).toBe(true);
  });

  it('reports no GPU when nvidia-smi is missing or silent', async () => {
    const missing = new FakeRunner();
    missing.defaultResult = { code: 127, stdout: '', stderr: 'not found' };
    expect(await makeManager(missing, false).detectCuda()).toBe(false);

    const silent = new FakeRunner();
    silent.responses.push({ match: /nvidia-smi/, result: { code: 0, stdout: '   \n' } });
    expect(await makeManager(silent, false).detectCuda()).toBe(false);
  });

  it('reports no GPU when the probe throws', async () => {
    const runner = new FakeRunner();
    runner.run = vi.fn().mockRejectedValue(new Error('spawn ENOENT'));
    expect(await makeManager(runner, false).detectCuda()).toBe(false);
  });

  it('installs the CUDA wheels only when a GPU was found', async () => {
    const runner = new FakeRunner();
    runner.existing.add(path.join(directory, 'bin', uvBinaryName()));
    runner.responses.push({
      match: /nvidia-smi/,
      result: { code: 0, stdout: 'NVIDIA GeForce RTX 4070\n' },
    });
    runner.responses.push({ match: /sipra_core --version/, result: { stdout: 'sipra-core 0.9.0' } });

    await makeManager(runner, false).install();
    expect(runner.called(/torch-cuda\.txt/)).toBe(true);
    expect(runner.called(/torch-cpu\.txt/)).toBe(false);
  });
});
