// Runs the board's slow work on other threads, so the server keeps answering while git or gh takes its time.
// The server thread only routes requests, reads agent output and pushes change notices.
//
// There are two lanes, each one thread that takes its jobs in order: "local" for work on this machine
// (building the board, reading a diff, changing a task) and "net" for work that waits on the network
// (GitHub, the login check). A slow answer from GitHub therefore never delays the board itself.
import { SHARE_ENV, Worker } from 'node:worker_threads';

const JOB_TIMEOUT_MS = 150_000;
const LANES = ['local', 'net'];

/** Returns { run(lane, name, args), close() }. `run` resolves with the job's result or rejects with its error. */
export function createLanes() {
  const lanes = new Map();
  let count = 0;
  let closed = false;

  function open(name) {
    const worker = new Worker(new URL('./jobs.mjs', import.meta.url), { env: SHARE_ENV });
    // A waiting thread must not keep a finished process alive.
    worker.unref();
    const lane = { worker, waiting: new Map() };
    const fail = (reason) => {
      for (const job of lane.waiting.values()) {
        clearTimeout(job.timer);
        job.reject(new Error(reason));
      }
      lane.waiting.clear();
      if (lanes.get(name) === lane) lanes.delete(name);
    };
    worker.on('message', ({ id, ok, result, error }) => {
      const job = lane.waiting.get(id);
      if (!job) return;
      lane.waiting.delete(id);
      clearTimeout(job.timer);
      if (ok) job.resolve(result);
      else job.reject(new Error(error));
    });
    worker.on('error', (err) => fail(`The board's worker stopped: ${err.message}. Try again.`));
    worker.on('exit', () => fail('The board\'s worker stopped. Try again.'));
    lanes.set(name, lane);
    return lane;
  }

  return {
    run(name, job, args = {}) {
      if (closed) return Promise.reject(new Error('The board is stopping.'));
      if (!LANES.includes(name)) return Promise.reject(new Error(`Unknown lane "${name}".`));
      const lane = lanes.get(name) || open(name);
      return new Promise((resolve, reject) => {
        const id = ++count;
        // A job that never returns would hold every job behind it; its thread is replaced.
        const timer = setTimeout(() => {
          lane.waiting.delete(id);
          reject(new Error(`"${job}" did not finish within ${JOB_TIMEOUT_MS / 1000} seconds and was stopped. Try again.`));
          lanes.delete(name);
          lane.worker.terminate();
        }, JOB_TIMEOUT_MS);
        timer.unref();
        lane.waiting.set(id, { resolve, reject, timer });
        lane.worker.postMessage({ id, job, args });
      });
    },
    close() {
      closed = true;
      for (const lane of lanes.values()) lane.worker.terminate();
      lanes.clear();
    },
  };
}
