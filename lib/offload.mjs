// Runs the board's slow work on other threads, so the server keeps answering while git or gh takes its time.
// The server thread only routes requests, reads agent output and pushes change notices.
//
// There are three lanes, each one thread that takes its jobs in order: "local" for work on this machine
// (building the board, reading a diff, changing a task), "net" for work that waits on the network
// (GitHub, the login check) and "long" for work that runs a project's own command, which may take minutes
// (archiving a task runs its teardown). A slow answer from GitHub or a slow teardown never delays the board itself.
import { SHARE_ENV, Worker } from 'node:worker_threads';

// How long one job may take, counted from when its turn comes. A long job's command has its own, shorter limit.
const LIMITS = { local: 150_000, net: 150_000, long: 45 * 60_000 };
const LANES = Object.keys(LIMITS);

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
    // The thread takes its jobs in order, so only the first one waiting is at work: the clock runs for that one.
    lane.clock = () => {
      const first = lane.waiting.entries().next().value;
      if (!first || first[1].timer) return;
      const [id, job] = first;
      job.timer = setTimeout(() => {
        lane.waiting.delete(id);
        job.reject(new Error(`"${job.name}" did not finish within ${LIMITS[name] / 1000} seconds and was stopped. Try again.`));
        // Its thread is replaced; what waited behind it never started and says so.
        for (const other of lane.waiting.values()) other.reject(new Error(`"${other.name}" did not start: the work before it took too long. Try again.`));
        lane.waiting.clear();
        if (lanes.get(name) === lane) lanes.delete(name);
        worker.terminate();
      }, LIMITS[name]);
      job.timer.unref();
    };
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
      lane.clock();
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
        // A job that never returns would hold every job behind it; lane.clock replaces its thread.
        lane.waiting.set(id, { resolve, reject, timer: null, name: job });
        lane.clock();
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
