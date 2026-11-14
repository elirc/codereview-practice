import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHILD_SCRIPT = fileURLToPath(new URL('./child.ts', import.meta.url));

interface Child {
	ready: Promise<void>;
	result: Promise<unknown>;
	go(): void;
}

function start(args: string[]): Child {
	const child = spawn(process.execPath, ['--import', 'tsx', CHILD_SCRIPT, ...args], {
		stdio: ['pipe', 'pipe', 'pipe']
	});
	let stdout = '';
	let stderr = '';
	let markReady: () => void = () => undefined;
	const readySignal = new Promise<void>((resolve) => {
		markReady = resolve;
	});
	child.stdout.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => {
		stdout += chunk;
		if (stdout.includes('ready\n')) markReady();
	});
	child.stderr.setEncoding('utf8');
	child.stderr.on('data', (chunk: string) => {
		stderr += chunk;
	});
	const result = new Promise<unknown>((resolve, reject) => {
		child.on('error', reject);
		child.on('close', (code) => {
			if (code !== 0) {
				reject(new Error(`child exited with code ${code}: ${stderr}`));
				return;
			}
			const lines = stdout.trim().split('\n');
			resolve(JSON.parse(lines[lines.length - 1]));
		});
	});
	return {
		ready: Promise.race([readySignal, result.then(() => undefined)]),
		result,
		go: () => child.stdin.end('go\n')
	};
}

/**
 * Starts one child process per argument list, waits until every child has
 * opened the database, then releases them together and collects the results.
 */
export async function runConcurrently(argLists: string[][]): Promise<unknown[]> {
	const children = argLists.map(start);
	await Promise.all(children.map((child) => child.ready));
	for (const child of children) child.go();
	return Promise.all(children.map((child) => child.result));
}
