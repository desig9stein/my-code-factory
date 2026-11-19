// Describes how the registered projects depend on each other, and what a change in one of them reaches.
import fs from 'node:fs';
import path from 'node:path';
import { namesId, workspace } from './paths.mjs';

const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Accepts "key" or { project, label } entries.
function declared(entry) {
  return (Array.isArray(entry?.dependsOn) ? entry.dependsOn : []).map((d) =>
    typeof d === 'string' ? { key: d, label: '' } : { key: String(d?.project ?? d?.key ?? ''), label: text(d?.label, 40) },
  );
}

/**
 * Builds the project graph from the registry's "dependsOn" lists.
 * Returns { nodes, problems }; an edge that names an unknown project or closes a cycle is reported and left out.
 */
export function buildGraph(registry) {
  const keys = Object.keys(registry.repos || {});
  const problems = [];
  const deps = new Map(keys.map((k) => [k, []]));
  for (const key of keys) {
    for (const d of declared(registry.repos[key])) {
      if (!d.key) problems.push(`${key}: dependsOn has an entry that is neither a project key nor { "project": "<key>" }.`);
      else if (!keys.includes(d.key)) problems.push(`${key}: dependsOn names "${d.key}", which is not a registered project.`);
      else if (d.key === key) problems.push(`${key}: a project cannot depend on itself.`);
      else if (!deps.get(key).some((x) => x.key === d.key)) deps.get(key).push(d);
    }
  }
  // Drops the edge that closes a cycle, so the layers below are well defined.
  const state = new Map();
  const visit = (key, trail) => {
    state.set(key, 'open');
    for (const d of [...deps.get(key)]) {
      if (state.get(d.key) === 'open') {
        problems.push(`Cycle: ${[...trail, key, d.key].slice(trail.indexOf(d.key) === -1 ? 0 : trail.indexOf(d.key)).join(' -> ')}. The link ${key} -> ${d.key} is ignored.`);
        deps.set(key, deps.get(key).filter((x) => x !== d));
      } else if (!state.has(d.key)) visit(d.key, [...trail, key]);
    }
    state.set(key, 'done');
  };
  for (const key of keys) if (!state.has(key)) visit(key, []);

  const layers = new Map();
  const layer = (key) => {
    if (!layers.has(key)) layers.set(key, deps.get(key).length ? 1 + Math.max(...deps.get(key).map((d) => layer(d.key))) : 0);
    return layers.get(key);
  };
  const nodes = keys.map((key) => {
    const entry = registry.repos[key] || {};
    const words = (value, max) => (typeof value === 'string' ? text(value, max) : '');
    return {
      key,
      remote: words(entry.remote, 120),
      description: words(entry.description, 200),
      owns: words(entry.owns, 240),
      layer: layer(key),
      dependsOn: deps.get(key).map((d) => ({ ...d })),
      usedBy: keys.filter((k) => deps.get(k).some((d) => d.key === key)),
    };
  });
  return { nodes, problems };
}

/**
 * Lists every project a change in `key` reaches, nearest first.
 * depth 1 is a direct user; `via` is the project the change arrives through.
 */
export function reach(graph, key) {
  const node = (k) => graph.nodes.find((n) => n.key === k);
  // Everything downstream, each project visited once however many paths lead to it.
  const downstream = new Set();
  const queue = [key];
  while (queue.length) {
    for (const user of node(queue.shift())?.usedBy || []) {
      if (user === key || downstream.has(user)) continue;
      downstream.add(user);
      queue.push(user);
    }
  }
  // Depth is the longest path from the changed project, so a project comes after everything it waits for.
  const depths = new Map([[key, { depth: 0, via: null }]]);
  const depthOf = (k) => {
    if (!depths.has(k)) {
      depths.set(k, { depth: 1, via: key });
      let best = { depth: 0, via: key };
      for (const d of node(k).dependsOn) {
        if (d.key !== key && !downstream.has(d.key)) continue;
        const through = depthOf(d.key).depth + 1;
        if (through > best.depth) best = { depth: through, via: d.key };
      }
      depths.set(k, best);
    }
    return depths.get(k);
  };
  return [...downstream].map((k) => ({ key: k, ...depthOf(k) })).sort((x, y) => x.depth - y.depth || x.key.localeCompare(y.key));
}

/** Marks which reached projects the given text (a plan's "Consumer impact") names, by key or repository name. */
export function coverage(graph, key, impactText) {
  return reach(graph, key).map((r) => {
    const repoName = graph.nodes.find((n) => n.key === r.key)?.remote.split('/').pop() || '';
    return { ...r, mentioned: namesId(impactText, r.key) || (Boolean(repoName) && namesId(impactText, repoName)) };
  });
}

// Reads the package manifests of a project: its root, its direct folders, and folders under packages/, projects/ and libs/.
// Folders that are another registered project are skipped, so a project at the workspace root does not claim them.
function manifests(dir, others) {
  const found = [];
  const read = (folder) => {
    try {
      found.push(JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8')));
    } catch {
      // A folder without a readable manifest contributes nothing.
    }
  };
  const children = (folder) => {
    try {
      return fs.readdirSync(folder, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').map((e) => path.join(folder, e.name)).filter((child) => !others.has(child));
    } catch {
      return [];
    }
  };
  read(dir);
  for (const child of children(dir)) {
    read(child);
    if (['packages', 'projects', 'libs'].includes(path.basename(child))) children(child).forEach(read);
  }
  return found;
}

/**
 * Finds links the package manifests show: project A lists a package that project B publishes.
 * Returns [{ from, to, package, range, version }]; only npm manifests are read, so other links must be declared.
 */
export function detectLinks(registry) {
  const dirOf = (key) => path.resolve(workspace(), typeof registry.repos[key]?.dir === 'string' ? registry.repos[key].dir : key);
  const keys = Object.keys(registry.repos || {});
  const byProject = keys.map((key) => ({ key, files: manifests(dirOf(key), new Set(keys.filter((k) => k !== key).map(dirOf))) }));
  const owner = new Map();
  for (const p of byProject) for (const m of p.files) if (typeof m.name === 'string' && !owner.has(m.name)) owner.set(m.name, { key: p.key, version: text(m.version, 40) });
  const links = new Map();
  for (const p of byProject) {
    for (const m of p.files) {
      for (const field of ['dependencies', 'peerDependencies', 'devDependencies', 'optionalDependencies']) {
        for (const [name, range] of Object.entries(m[field] || {})) {
          const to = owner.get(name);
          if (!to || to.key === p.key || links.has(`${p.key}>${to.key}`)) continue;
          links.set(`${p.key}>${to.key}`, { from: p.key, to: to.key, package: text(name, 120), range: text(range, 60), version: to.version });
        }
      }
    }
  }
  return [...links.values()];
}

let cached = null;
/** Returns detectLinks, read at most once a minute; the board asks often and manifests change rarely. */
export function detectedLinks(registry) {
  const stamp = JSON.stringify(Object.entries(registry.repos || {}).map(([k, e]) => [k, e.dir]));
  if (!cached || cached.stamp !== stamp || Date.now() - cached.at > 60_000) cached = { stamp, at: Date.now(), links: detectLinks(registry) };
  return cached.links;
}

/** Returns the graph with pinned versions on its links and the detected links nobody declared. */
export function workspaceGraph(registry) {
  const graph = buildGraph(registry);
  let links = [];
  try {
    links = detectedLinks(registry);
  } catch {
    links = [];
  }
  for (const node of graph.nodes) {
    for (const d of node.dependsOn) {
      const link = links.find((l) => l.from === node.key && l.to === d.key);
      if (link) Object.assign(d, { package: link.package, range: link.range, version: link.version });
    }
    node.reach = reach(graph, node.key);
  }
  const undeclared = links.filter((l) => !graph.nodes.find((n) => n.key === l.from)?.dependsOn.some((d) => d.key === l.to));
  return { ...graph, undeclared };
}
