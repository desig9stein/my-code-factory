#!/usr/bin/env node
// Software factory CLI: tracks an issue from intake to a PR with recorded proof.
// Usage: factory <command> [args]   (run "help" for the list)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { proposeForProject } from '../lib/assets.mjs';
import { hookSettings, installAgentFiles, installHooks } from '../lib/hooks.mjs';
import { addProject, discoverProjects, initialize, preflight } from '../lib/setup.mjs';
import { applyImport, exportConfig, planImport } from '../lib/share.mjs';
import { writeBoard } from '../lib/board.mjs';
import { checkCommits, checkPrBody, commitsOnBranch, mergeBase, prBodyPath } from '../lib/checks.mjs';
import { addManual, addVerdict, fileSha256, listEvidence, runRecorded, verifyChain } from '../lib/evidence.mjs';
import { factoryRoot, issueDir, workspace, worktreesDir } from '../lib/paths.mjs';
import { getRepo, loadRegistry, parseRef } from '../lib/registry.mjs';
import { regress } from '../lib/regress.mjs';
import { boardPort, startServer } from '../lib/server.mjs';
import { git, run, tryGit } from '../lib/sh.mjs';
import { advance, approve, archive, gateStatus, inspect, recordPosted, recordPr, regressStatus, reviewBody, reviewPath, reviewVerdict } from '../lib/stages.mjs';
import { formatTokens, issueTokens } from '../lib/tokens.mjs';
import { brokenReferences, formatBrief, resolveWorkflow, stageBrief } from '../lib/workflow.mjs';
import { exists, head, isDirty, listStates, loadState, move, saveState, sync } from '../lib/state.mjs';

const HELP = `Software factory

  setup [--workspace <directory>] [--yes]             Check the tools, initialize, and register every repo in the workspace
  setup --from <file> [--workspace <directory>]       Set up from a configuration a teammate exported
  export <file>                                       Write the shareable configuration: projects, gates, workflow
  import <file> [--yes]                               Apply a shared configuration after showing what it changes
  init --workspace <directory>                        Initialize local configuration (never overwrites it)
  add <key> <directory> [--verify <command>]           Register a project; --remote, --base, --install optional

  new <repo>#<n> [--branch <name>] [--type fix|feat]   Take in an issue: snapshot, branch, worktree
  review <repo>#<pr>                                   Take in a pull request to review: snapshot, worktree at its head
  refresh <id>                                         Review only: move the worktree to the PR's newest commit
  posted <id>                                          Review only: record that the approved review was posted
  status [<id>]                                        Table of issues, or one issue in detail
  run <id> <gate> [--as verifier]                      Run a registry gate and record the evidence
  run <id> <step>                                      Run the check command of a step you added to the workflow
  run <id> install                                     Install dependencies in the worktree
  run <id> reproduce --expect-fail -- <command>        Record a command that shows the bug
  run <id> extra:<label> -- <command>                  Record any other check, such as another browser
  note <id> reproduce|regress <text>                   Record a manual check where no command can
  regress <id> --tests <a,b> [--as verifier] -- <cmd>  Prove the test fails on base and passes on the fix
  check <id>                                           Check the commits and pr-body.md
  verdict <id> pass|fail --report <file>               Verifier only: record the verdict and report
  next <id>                                            Print the brief of the current stage: what to do, which skill and agent to use
  advance <id>                                         Check the stage exit rule and move on
  block <id> <reason> | unblock <id>                   Park an issue, or resume it
  approve <id>                                         the user only, in a terminal: allow the push
  pr <id> <url>                                        Record the opened PR
  archive <id> [--delete-branch]                       Hide a finished issue and remove its worktree
  board [--no-open] [--static] [--stop]                Open the kanban board (local server on 127.0.0.1)
  hooks [--install] [--settings <file>]                Print the Claude Code hook settings, or install them with the factory skill and verifier agent
  assets <project>                                     List the skills, agents and instruction files a project has, with proposals
  doctor                                               Compare the registry with the repos
`;

function parseArgs(argv) {
  const out = { _: [], rest: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out.rest = argv.slice(i + 1).join(' ');
      break;
    }
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
      else {
        out[a.slice(2)] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

const slugify = (title) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 5)
    .join('-')
    .slice(0, 40)
    .replace(/-+$/, '');

function fetchIssue(repo, number) {
  const r = run('gh', ['issue', 'view', String(number), '-R', repo.remote, '--json', 'number,title,body,labels,author,url,state,comments']);
  if (r.status !== 0) throw new Error(`gh issue view ${number} -R ${repo.remote} failed: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout);
}

function fetchPr(repo, number, fromFile) {
  if (fromFile) return JSON.parse(fs.readFileSync(fromFile, 'utf8'));
  const fields = 'number,title,body,author,url,state,isDraft,baseRefName,headRefName,headRefOid,labels,files,comments,reviews,additions,deletions';
  const r = run('gh', ['pr', 'view', String(number), '-R', repo.remote, '--json', fields]);
  if (r.status !== 0) throw new Error(`gh pr view ${number} -R ${repo.remote} failed: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout);
}

function prMarkdown(pr) {
  const labels = (pr.labels || []).map((l) => l.name).join(', ') || 'none';
  const files = (pr.files || []).map((f) => `- ${f.path} (+${f.additions} -${f.deletions})`).join('\n');
  const talk = [...(pr.reviews || []).map((r) => ({ ...r, kind: `review ${r.state}` })), ...(pr.comments || []).map((c) => ({ ...c, kind: 'comment' }))]
    .filter((c) => c.body)
    .map((c) => `### ${c.author?.login || 'unknown'} (${c.kind})\n\n${c.body}`)
    .join('\n\n');
  return `# PR #${pr.number} ${pr.title}\n\n- URL: ${pr.url}\n- Author: ${pr.author?.login}\n- State: ${pr.state}${pr.isDraft ? ' (draft)' : ''}\n- Head: ${pr.headRefName} at ${pr.headRefOid}\n- Base: ${pr.baseRefName}\n- Size: +${pr.additions} -${pr.deletions} in ${(pr.files || []).length} files\n- Labels: ${labels}\n- Snapshot: ${new Date().toISOString()}\n\n## Description\n\n${pr.body || ''}\n\n## Files\n\n${files}\n\n## Reviews and comments so far\n\n${talk || 'None.'}\n`;
}

function issueMarkdown(issue) {
  const labels = (issue.labels || []).map((l) => l.name).join(', ') || 'none';
  const comments = (issue.comments || [])
    .map((c) => `### ${c.author?.login || 'unknown'} on ${c.createdAt}\n\n${c.body}`)
    .join('\n\n');
  return `# #${issue.number} ${issue.title}\n\n- URL: ${issue.url || 'n/a'}\n- State: ${issue.state || 'n/a'}\n- Author: ${issue.author?.login || 'n/a'}\n- Labels: ${labels}\n- Snapshot: ${new Date().toISOString()}\n\n## Body\n\n${issue.body || ''}\n\n## Comments\n\n${comments || 'None.'}\n`;
}

function openBrowser(target) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  spawnSync(command, [target], { stdio: 'ignore' });
}

const commands = {
  init(args) {
    const result = initialize(args.workspace || process.cwd());
    console.log(`Configuration: ${result.root}\nWorkspace: ${result.workspace}\nNext: factory add <key> <project-directory> --verify "npm run verify"`);
  },
  async setup(args) {
    const checks = preflight();
    for (const c of checks) console.log(`${c.ok ? 'ok  ' : c.required ? 'FAIL' : 'warn'}  ${c.name}${c.ok ? ` (${c.detail})` : `: ${c.fix}`}`);
    if (checks.some((c) => !c.ok && c.required)) throw new Error('A required tool is missing. Fix the FAIL lines above, then run setup again.');
    const result = initialize(typeof args.workspace === 'string' ? args.workspace : process.cwd());
    console.log(`\nConfiguration: ${result.root}\nWorkspace: ${result.workspace}`);
    if (typeof args.from === 'string') {
      await commands.import({ ...args, _: [args.from] });
      return console.log('\nNext:\n  factory board             Open the board\n  factory hooks --install   Add the Claude Code guard hooks, the factory skill and the verifier agent');
    }
    const found = discoverProjects();
    if (!found.length) console.log('\nNo unregistered GitHub repositories found directly inside the workspace.');
    else {
      console.log(`\n${found.length} repositories found:\n`);
      table(['KEY', 'REMOTE', 'BASE', 'INSTALL', 'GATE'], found.map((p) => [p.key, p.remote, p.baseBranch, p.install || '-', p.gates[0]?.cmd || 'none']));
      let yes = args.yes === true;
      if (!yes && process.stdin.isTTY) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        yes = !/^n/i.test((await rl.question(`\nRegister these ${found.length} projects? [Y/n] `)).trim());
        rl.close();
      } else if (!yes) console.log('\nNothing registered: there is no terminal to ask in. Run "factory setup --yes" to register them all.');
      if (yes) {
        for (const p of found) {
          try {
            addProject(p.key, p.dir, { base: p.baseBranch, install: p.install, gates: p.gates });
            console.log(`Registered ${p.key}${p.gates.length ? '' : ' without a gate; add one on the Projects page'}.`);
          } catch (err) {
            console.log(`Skipped ${p.key}: ${err.message}`);
          }
        }
      }
    }
    console.log('\nNext:\n  factory board             Open the board; change base branches and gates on its Projects page\n  factory hooks --install   Add the Claude Code guard hooks to your settings');
  },
  export(args) {
    const text = `${JSON.stringify(exportConfig(), null, 2)}\n`;
    if (!args._[0]) return process.stdout.write(text);
    fs.writeFileSync(path.resolve(args._[0]), text);
    console.log(`Wrote ${path.resolve(args._[0])}. It holds projects, gates and workflow, and no paths or task data. Share it, or commit it to a team repository.`);
  },

  async import(args) {
    if (!args._[0] || !fs.existsSync(args._[0])) throw new Error('import needs the path of a file written by "factory export <file>".');
    let data;
    try {
      data = JSON.parse(fs.readFileSync(args._[0], 'utf8'));
    } catch {
      throw new Error(`${args._[0]} is not JSON.`);
    }
    const plan = planImport(data);
    const changing = plan.projects.filter((p) => p.status === 'add' || p.status === 'update');
    console.log(`\n${plan.projects.length} projects in the file:\n`);
    table(['STATUS', 'KEY', 'REMOTE', 'BASE', 'FOLDER'], plan.projects.map((p) => [p.status, p.key, p.remote, p.entry.baseBranch, p.dir ? path.relative(workspace(), p.dir) || '.' : `not cloned (expected ${p.folder})`]));
    const missing = plan.projects.filter((p) => p.status === 'missing');
    if (missing.length) console.log(`\nNot cloned, so not registered. Clone them into ${workspace()} and run the import again:\n${missing.map((p) => `  git clone git@github.com:${p.remote}.git ${p.folder}`).join('\n')}`);
    // Imported commands run in a shell later, so every one is shown before it is accepted.
    if (changing.length) {
      console.log('\nCommands this file registers. They run on your machine when a task uses them:\n');
      for (const p of changing) {
        if (p.entry.install) console.log(`  ${p.key} install: ${p.entry.install}`);
        for (const g of p.entry.gates) console.log(`  ${p.key} gate ${g.name}: ${g.cmd}`);
      }
    }
    let yes = args.yes === true;
    if (!yes && process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      yes = !/^n/i.test((await rl.question(`\nApply: ${changing.length} project(s) added or updated, plus the shared defaults and workflow? [Y/n] `)).trim());
      rl.close();
    } else if (!yes) return console.log('\nNothing applied: there is no terminal to ask in. Read the commands above, then run the import again with --yes.');
    if (!yes) return console.log('Nothing applied.');
    applyImport(plan);
    console.log(`Applied. ${changing.length} project(s) added or updated; ${plan.projects.filter((p) => p.status === 'same').length} already matched.`);
  },

  add(args) {
    const result = addProject(args._[0], args._[1], args);
    console.log(`Registered ${args._[0]} (${result.remote}, base ${result.baseBranch}).`);
    if (result.gates.length) console.log(`Gate "${result.gates[0].name}": ${result.gates[0].cmd}`);
    else console.log('No verification command configured. Add a gate on the Projects page of the board before using this project.');
  },
  new(args) {
    const { repo: key, issue: number } = parseRef(args._[0]);
    const repo = getRepo(key);
    const id = `${key}-${number}`;
    if (exists(id)) throw new Error(`${id} already exists at stage "${loadState(id).stage}".`);
    if (!fs.existsSync(repo.dir)) throw new Error(`Repo folder ${repo.dir} does not exist.`);

    const issue = args.title ? { number, title: args.title, body: args.body || '', labels: [] } : fetchIssue(repo, number);
    const labels = (issue.labels || []).map((l) => l.name.toLowerCase()).join(' ');
    const type = args.type || (/(feature|enhancement)/.test(labels) ? 'feat' : 'fix');

    tryGit(repo.dir, 'fetch', 'origin', repo.baseBranch);
    const baseSha = git(repo.dir, 'rev-parse', `origin/${repo.baseBranch}`);
    const branch =
      args.branch ||
      repo.branchPattern.replace('{type}', type).replace('{n}', number).replace('{slug}', slugify(issue.title));
    const worktree = path.join(worktreesDir(), id);
    fs.mkdirSync(worktreesDir(), { recursive: true });
    // No upstream, so a bare "git push" cannot target the base branch.
    git(repo.dir, 'worktree', 'add', '--no-track', '-b', branch, worktree, `origin/${repo.baseBranch}`);

    fs.mkdirSync(issueDir(id), { recursive: true });
    fs.writeFileSync(path.join(issueDir(id), 'issue.md'), issueMarkdown(issue));
    const state = {
      id,
      repo: key,
      issue: number,
      title: issue.title,
      url: issue.url || `https://github.com/${repo.remote}/issues/${number}`,
      type: null,
      branch,
      base: repo.baseBranch,
      baseSha,
      worktree,
      createdAt: new Date().toISOString(),
      history: [],
      blocked: null,
      gatesSha: null,
      approvedSha: null,
      prUrl: null,
    };
    move(state, 'intake', 'Issue snapshot, branch and worktree created.');
    saveState(state);
    console.log(`Created ${id}\n  branch   ${branch} (off origin/${repo.baseBranch} at ${baseSha.slice(0, 8)})\n  worktree ${worktree}\n  issue    ${path.join(issueDir(id), 'issue.md')}`);
    if (repo.install) console.log(`Next: factory run ${id} install`);
  },

  review(args) {
    const { repo: key, issue: number } = parseRef(args._[0]);
    const repo = getRepo(key);
    const id = `${key}-pr-${number}`;
    if (exists(id)) throw new Error(`${id} already exists at stage "${loadState(id).stage}". Use "factory refresh ${id}" after new pushes.`);
    const pr = fetchPr(repo, number, args.from);
    git(repo.dir, 'fetch', 'origin', pr.baseRefName, `pull/${number}/head`);
    const headSha = git(repo.dir, 'rev-parse', 'FETCH_HEAD');
    const worktree = path.join(worktreesDir(), id);
    fs.mkdirSync(worktreesDir(), { recursive: true });
    // Detached, so the review never owns a branch it could push.
    git(repo.dir, 'worktree', 'add', '--detach', worktree, pr.headRefOid);
    fs.mkdirSync(issueDir(id), { recursive: true });
    fs.writeFileSync(path.join(issueDir(id), 'pr.md'), prMarkdown(pr));
    fs.writeFileSync(prBodyPath(id), pr.body || '');
    const state = {
      id,
      kind: 'review',
      repo: key,
      issue: number,
      title: pr.title,
      url: pr.url,
      type: null,
      author: pr.author?.login || null,
      branch: pr.headRefName,
      base: pr.baseRefName,
      baseSha: git(worktree, 'merge-base', 'HEAD', `origin/${pr.baseRefName}`),
      worktree,
      createdAt: new Date().toISOString(),
      history: [],
      blocked: null,
      gatesSha: null,
      approvedSha: null,
      prUrl: pr.url,
    };
    move(state, 'intake', `PR snapshot and worktree at ${pr.headRefOid.slice(0, 8)}.`);
    saveState(state);
    writeBoard();
    console.log(`Created ${id}\n  PR       #${number} by ${state.author}: ${pr.title}\n  head     ${pr.headRefName} at ${pr.headRefOid.slice(0, 8)} (fetched ${headSha.slice(0, 8)}), base origin/${pr.baseRefName}\n  worktree ${worktree}\n  snapshot ${path.join(issueDir(id), 'pr.md')}`);
  },

  refresh(args) {
    const state = loadState(args._[0]);
    if (state.kind !== 'review') throw new Error('refresh applies to reviews only.');
    const repo = getRepo(state.repo);
    const pr = fetchPr(repo, state.issue, args.from);
    git(repo.dir, 'fetch', 'origin', pr.baseRefName, `pull/${state.issue}/head`);
    const before = head(state);
    fs.writeFileSync(path.join(issueDir(state.id), 'pr.md'), prMarkdown(pr));
    fs.writeFileSync(prBodyPath(state.id), pr.body || '');
    if (before !== pr.headRefOid) git(state.worktree, 'checkout', '--detach', pr.headRefOid);
    sync(state);
    writeBoard();
    console.log(before === pr.headRefOid ? `${state.id}: no new commits (${before.slice(0, 8)}); snapshot updated.` : `${state.id}: PR head moved ${before.slice(0, 8)} -> ${pr.headRefOid.slice(0, 8)}; now at "${state.stage}".`);
  },

  posted(args) {
    const state = loadState(args._[0]);
    recordPosted(state, getRepo(state.repo));
    writeBoard();
    console.log(`${state.id}: review recorded as posted, WORK_LOG.md updated.`);
  },

  status(args) {
    if (args._[0]) return statusOne(loadState(args._[0]));
    const states = listStates();
    if (!states.length) return console.log('No issues in flight.');
    const registry = loadRegistry();
    const rows = states.map((s) => {
      const repo = getRepo(s.repo, registry);
      const gates = gateStatus(s, repo);
      const passed = gates.filter((g) => g.status === 'passed').length;
      const last = listEvidence(s.id).at(-1);
      return [
        s.id,
        s.blocked ? 'BLOCKED' : s.stage,
        age(s.stageSince),
        `${passed}/${gates.length}`,
        last ? `${last.name} ${last.ok ? 'ok' : 'FAILED'}` : '-',
        s.branch,
      ];
    });
    table(['ISSUE', 'STAGE', 'IN STAGE', 'GATES', 'LAST EVIDENCE', 'BRANCH'], rows);
  },

  run(args) {
    const [id, name] = args._;
    const state = sync(loadState(id));
    const repo = getRepo(state.repo);
    const actor = ['verifier', 'reviewer'].includes(args.as) ? args.as : state.kind === 'review' ? 'reviewer' : 'implementer';
    let spec;
    if (name === 'install') spec = { name, kind: 'setup', cmd: repo.install, cwd: state.worktree };
    else if (name === 'reproduce') {
      if (!args.rest) throw new Error('reproduce needs the command after "--".');
      spec = { name, kind: 'run', cmd: args.rest, cwd: path.join(state.worktree, args.cwd || ''), expect: args['expect-fail'] ? 'fail' : 'pass' };
    } else if (/^extra:[\w.-]+$/.test(name || '')) {
      if (!args.rest) throw new Error('An extra run needs the command after "--".');
      spec = { name, kind: 'run', cmd: args.rest, cwd: path.join(state.worktree, args.cwd || '') };
    } else if (state.kind !== 'review' && resolveWorkflow(repo.key).customStages.some((step) => step.id === name && step.check.kind === 'command')) {
      if (args.rest) throw new Error('A step check always runs the command configured on the Workflow page; remove the text after "--".');
      spec = { name, kind: 'step', cmd: resolveWorkflow(repo.key).customStages.find((step) => step.id === name).check.cmd, cwd: state.worktree };
    } else {
      const gate = repo.gates.find((g) => g.name === name);
      if (!gate) throw new Error(`"${name}" is not a gate of ${repo.key}. Gates: ${repo.gates.map((g) => g.name).join(', ')}. Other checks use the name extra:<label>.`);
      if (args.rest) throw new Error('A gate always runs the registry command; remove the text after "--".');
      spec = { name, kind: 'gate', cmd: gate.cmd, cwd: path.join(state.worktree, gate.cwd || '') };
    }
    if (!spec.cmd) throw new Error(`${repo.key} has no ${name} command in the registry.`);
    console.log(`$ ${spec.cmd}   (in ${spec.cwd})`);
    const record = runRecorded(state, { ...spec, actor });
    printRecord(state, record);
    writeBoard();
    if (!record.ok) process.exitCode = 1;
  },

  note(args) {
    const [id, name, ...words] = args._;
    if (!['reproduce', 'regress'].includes(name)) throw new Error(`note takes "reproduce" or "regress", got "${name}".`);
    const text = words.join(' ').trim();
    if (text.length < 20) throw new Error('Say what was checked and what was seen, in at least 20 characters.');
    const record = addManual(sync(loadState(id)), { name, text });
    console.log(`Recorded manual ${name} as record ${record.seq}. The board marks it as manual.`);
    writeBoard();
  },

  regress(args) {
    const state = sync(loadState(args._[0]));
    const repo = getRepo(state.repo);
    const tests = String(args.tests || '').split(',').map((t) => t.trim()).filter(Boolean);
    const actor = args.as === 'verifier' ? 'verifier' : 'implementer';
    const result = regress(state, repo, { tests, cmd: args.rest, subdir: args.cwd || '', actor });
    console.log(`Base ${result.baseSha.slice(0, 8)} with the new tests: exit ${result.base.exitCode} (${result.base.ok ? 'fails as required' : 'PASSES, so the test does not cover the fix'})`);
    console.log(`Fix  ${head(state).slice(0, 8)}: exit ${result.fix.exitCode} (${result.fix.ok ? 'passes' : 'FAILS'})`);
    writeBoard();
    if (!result.base.ok || !result.fix.ok) process.exitCode = 1;
  },

  check(args) {
    const state = sync(loadState(args._[0]));
    const repo = getRepo(state.repo);
    const problems = [...checkCommits(state, repo), ...checkPrBody(state, repo)];
    if (!problems.length) return console.log('Commits and pr-body.md pass.');
    for (const p of problems) console.log(`- ${p}`);
    process.exitCode = 1;
  },

  verdict(args) {
    const [id, verdict] = args._;
    if (!['pass', 'fail'].includes(verdict)) throw new Error(`verdict takes pass or fail, got "${verdict}".`);
    if (!args.report || !fs.existsSync(args.report)) throw new Error('verdict needs --report <file> with the per-claim findings.');
    const state = sync(loadState(id));
    const report = fs.readFileSync(args.report, 'utf8');
    if (report.trim().length < 200) throw new Error('The report is too short. List each claim with the command that checked it and the result.');
    const body = prBodyPath(id);
    const record = addVerdict(state, { verdict, report, prBodySha256: fs.existsSync(body) ? fileSha256(body) : null });
    fs.writeFileSync(path.join(issueDir(id), 'verify.md'), `Verdict: ${verdict}\nSHA: ${record.sha}\nRecorded: ${record.startedAt}\n\n${report}`);
    console.log(`Recorded verdict "${verdict}" at ${record.sha.slice(0, 8)} as record ${record.seq}.`);
    writeBoard();
  },

  advance(args) {
    const state = loadState(args._[0]);
    const before = state.stage;
    const result = advance(state, getRepo(state.repo));
    writeBoard();
    if (result.moved) return console.log(`${state.id}: ${before} -> ${result.stage}`);
    console.log(`${state.id} stays at "${result.stage}":`);
    for (const p of result.problems) console.log(`- ${p}`);
    process.exitCode = 1;
  },

  block(args) {
    const [id, ...words] = args._;
    const state = loadState(id);
    const reason = words.join(' ').trim();
    if (!reason) throw new Error('block needs a reason.');
    state.blocked = { reason, at: new Date().toISOString() };
    state.history.push({ stage: 'blocked', at: state.blocked.at, note: reason });
    saveState(state);
    writeBoard();
    console.log(`${id} is blocked: ${reason}`);
  },

  unblock(args) {
    const state = loadState(args._[0]);
    state.blocked = null;
    state.history.push({ stage: state.stage, at: new Date().toISOString(), note: 'Unblocked.' });
    saveState(state);
    writeBoard();
    console.log(`${state.id} resumes at "${state.stage}".`);
  },

  async approve(args) {
    // Agent shells have no terminal and set CLAUDECODE, so only a person can approve.
    if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.CLAUDECODE) {
      throw new Error('approve runs only in an interactive terminal outside Claude Code. Open a terminal and run it there.');
    }
    const state = sync(loadState(args._[0]));
    const repo = getRepo(state.repo);
    statusOne(state);
    const stat = tryGit(state.worktree, 'diff', '--stat', `${mergeBase(state)}..HEAD`);
    console.log(`\nDiff against origin/${state.base}:\n${stat}\n`);
    if (state.kind === 'review') console.log(`Review draft (${reviewVerdict(state.id)}): ${reviewPath(state.id)}\n\n${reviewBody(state.id)}`);
    else console.log(`PR body: ${prBodyPath(state.id)}`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const what = state.kind === 'review' ? `posting this review of ${head(state).slice(0, 8)}` : `the push of ${head(state).slice(0, 8)}`;
    const answer = await rl.question(`\nType "${state.id}" to approve ${what}: `);
    rl.close();
    if (answer.trim() !== state.id) throw new Error('Not approved: the text did not match.');
    approve(state);
    writeBoard();
    console.log(state.kind === 'review' ? `Approved. The agent may now post this exact draft to ${repo.remote}#${state.issue}.` : `Approved. The agent may now push ${state.branch} and open the PR for ${repo.remote}.`);
  },

  pr(args) {
    const state = loadState(args._[0]);
    recordPr(state, getRepo(state.repo), args._[1] || '');
    writeBoard();
    console.log(`${state.id}: PR recorded, WORK_LOG.md updated.`);
  },

  archive(args) {
    const state = loadState(args._[0]);
    const deleteBranch = args['delete-branch'] === true;
    archive(state, getRepo(state.repo), { deleteBranch });
    writeBoard();
    console.log(`${state.id} archived. The local branch ${state.branch} is ${deleteBranch ? 'deleted' : 'kept'}.`);
  },

  async board(args) {
    const file = writeBoard();
    const pidFile = path.join(factoryRoot(), `.board-${boardPort()}.pid`);
    const url = `http://127.0.0.1:${boardPort()}/`;
    // Resolves to the factory root the server on this port serves, or null when nothing answers.
    const servedRoot = () => fetch(`${url}api/ping`).then((r) => r.json()).then((j) => j.root || 'other').catch(() => null);
    const up = async () => (await servedRoot()) === factoryRoot();
    if (args.stop) {
      if (fs.existsSync(pidFile)) {
        try {
          process.kill(Number(fs.readFileSync(pidFile, 'utf8')));
        } catch {}
        fs.rmSync(pidFile);
      }
      return console.log('Board server stopped.');
    }
    if (args.static) {
      console.log(file);
      if (!args['no-open']) openBrowser(file);
      return;
    }
    const running = await servedRoot();
    if (running && running !== factoryRoot()) {
      throw new Error(`Port ${boardPort()} serves another board (${running}). Stop it, or set FACTORY_PORT to a free port.`);
    }
    if (!running) {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], { detached: true, stdio: 'ignore' });
      child.unref();
      for (let i = 0; i < 40 && !(await up()); i++) await new Promise((r) => setTimeout(r, 100));
      if (!(await up())) throw new Error(`The board server did not start on port ${boardPort()}. Set FACTORY_PORT to a free port, or use "board --static".`);
    }
    console.log(url);
    if (!args['no-open']) openBrowser(url);
  },

  async serve() {
    fs.mkdirSync(factoryRoot(), { recursive: true });
    loadRegistry();
    await startServer();
    fs.writeFileSync(path.join(factoryRoot(), `.board-${boardPort()}.pid`), String(process.pid));
    console.log(`Board at http://127.0.0.1:${boardPort()}/`);
  },

  doctor() {
    const registry = loadRegistry();
    const problems = [];
    for (const key of Object.keys(registry.repos)) {
      const repo = getRepo(key, registry);
      const say = (msg) => problems.push(`${key}: ${msg}`);
      if (!fs.existsSync(repo.dir)) {
        say(`folder ${repo.dir} is missing.`);
        continue;
      }
      const url = tryGit(repo.dir, 'remote', 'get-url', 'origin') || '';
      if (!url.toLowerCase().includes(repo.remote.toLowerCase())) say(`origin is ${url}, registry says ${repo.remote}.`);
      const originHead = (tryGit(repo.dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD') || '').replace('origin/', '');
      if (originHead !== repo.baseBranch && !repo.allowBaseMismatch) say(`baseBranch is ${repo.baseBranch}, origin/HEAD is ${originHead || 'unset'}.`);
      if (!tryGit(repo.dir, 'rev-parse', '--verify', `origin/${repo.baseBranch}`)) say(`origin/${repo.baseBranch} does not exist locally.`);
      if (repo.prTemplate && !fs.existsSync(path.join(repo.dir, repo.prTemplate))) say(`prTemplate ${repo.prTemplate} is missing.`);
      for (const broken of brokenReferences(key, registry)) say(`workflow ${broken} does not exist in ${repo.dir}. Remove it on the Workflow page of the board.`);
      for (const g of repo.gates) {
        const m = /^(?:npm run|yarn)\s+([\w:.-]+)|^npm (test)\b/.exec(g.cmd);
        if (!m) continue;
        const pkgFile = path.join(repo.dir, g.cwd || '', 'package.json');
        const scripts = fs.existsSync(pkgFile) ? JSON.parse(fs.readFileSync(pkgFile, 'utf8')).scripts || {} : {};
        const script = m[1] || m[2];
        if (!scripts[script]) say(`gate "${g.name}" runs script "${script}", which ${path.relative(repo.dir, pkgFile)} does not define.`);
      }
    }
    if (!problems.length) return console.log(`${Object.keys(registry.repos).length} repos checked, 0 drift.`);
    for (const p of problems) console.log(`- ${p}`);
    process.exitCode = 1;
  },

  next(args) {
    const state = sync(loadState(args._[0]));
    const repo = getRepo(state.repo);
    process.stdout.write(formatBrief(stageBrief(state, repo), inspect(state, repo)));
  },

  hooks(args) {
    if (!args.install) return console.log(JSON.stringify(hookSettings(), null, 2));
    const result = installHooks(typeof args.settings === 'string' ? path.resolve(args.settings) : undefined);
    console.log(result.changed ? `Hooks merged into ${result.file}.${result.backup ? ` Previous version: ${result.backup}.` : ''} Restart Claude Code sessions to load them.` : `Hooks in ${result.file} are already current.`);
    for (const file of installAgentFiles(path.dirname(result.file))) console.log(file.changed ? `Wrote ${file.file}.${file.backup ? ` Previous version: ${file.backup}.` : ''}` : `${file.file} is already current.`);
  },

  assets(args) {
    const { assets, proposals } = proposeForProject(args._[0]);
    const show = (title, items) => {
      console.log(`\n${title} (${items.length})`);
      for (const a of items) console.log(`  ${a.name.padEnd(36)} ${a.path}${a.differs ? '   [copies differ]' : ''}`);
    };
    show('Agents', assets.agents);
    show('Contributor skills', assets.skills);
    show('Product skills, not used for work on the repo', assets.products);
    console.log(`\nInstruction files: ${assets.instructions.join(', ') || 'none'}\nPR template: ${assets.prTemplate || 'none'}`);
    console.log(`\nProposals (${proposals.length}); accept them on the Workflow page of the board:`);
    for (const p of proposals) console.log(`  - ${p.title}`);
  },

  help() {
    console.log(HELP);
  },
};

function age(iso) {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 60) return `${min}m`;
  if (min < 48 * 60) return `${Math.floor(min / 60)}h`;
  return `${Math.floor(min / 1440)}d`;
}

function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd();
  console.log(line(headers));
  for (const r of rows) console.log(line(r));
}

function printRecord(state, record) {
  const logFile = path.join(issueDir(state.id), 'evidence', record.log);
  const tail = fs.readFileSync(logFile, 'utf8').trimEnd().split('\n').slice(-40).join('\n');
  console.log(tail);
  const verdict = record.ok ? 'ok' : 'FAILED';
  console.log(`\n[${verdict}] ${record.name}: exit ${record.exitCode} in ${(record.durationMs / 1000).toFixed(1)}s at ${String(record.sha).slice(0, 8)}${record.dirty ? ' (dirty tree, not valid as gate proof)' : ''}\nlog: ${logFile}`);
}

function statusOne(state) {
  sync(state);
  const repo = getRepo(state.repo);
  console.log(`${state.id}  ${state.title}\n  stage    ${state.blocked ? `BLOCKED (${state.blocked.reason})` : state.stage}, ${age(state.stageSince)} in stage\n  branch   ${state.branch} at ${(head(state) || 'missing').slice(0, 8)}, base origin/${state.base}\n  tree     ${isDirty(state) ? 'DIRTY (uncommitted changes)' : 'clean'}\n  worktree ${state.worktree}\n  commits  ${commitsOnBranch(state).length}\n  PR       ${state.prUrl || 'none'}`);
  const t = issueTokens(state, { force: true });
  console.log(`  tokens   ${t.sessions ? `${formatTokens(t.fresh)} new (${formatTokens(t.output)} output, ${formatTokens(t.cacheWrite)} cache write, ${formatTokens(t.input)} input) plus ${formatTokens(t.cacheRead)} cache read, in ${t.messages} model calls that acted on it` : 'no session linked yet'}`);
  if (state.kind === 'review') {
    console.log('\nGates at the PR head:');
    for (const g of gateStatus(state, repo)) console.log(`  ${g.name.padEnd(22)} ${g.status}`);
  } else {
    console.log('\nGates at HEAD (implementer / verifier):');
    const verifier = gateStatus(state, repo, { actor: 'verifier' });
    gateStatus(state, repo, { actor: 'implementer' }).forEach((g, i) => console.log(`  ${g.name.padEnd(22)} ${g.status.padEnd(8)} / ${verifier[i].status}`));
  }
  if (state.type === 'bug' || regressStatus(state) !== 'missing') console.log(`  ${'regression proof'.padEnd(22)} ${regressStatus(state)}`);
  if (state.kind === 'review') console.log(`  ${'review draft'.padEnd(22)} ${reviewVerdict(state.id) || 'not written'}`);
  console.log('\nEvidence:');
  for (const r of listEvidence(state.id)) {
    const what = r.kind === 'manual' ? `MANUAL: ${r.text}` : r.kind === 'verdict' ? `verdict ${r.verdict}` : `exit ${r.exitCode}, expected ${r.expect}`;
    console.log(`  ${String(r.seq).padStart(3)} ${r.ok ? 'ok    ' : 'FAILED'} ${r.name.padEnd(16)} ${r.actor.padEnd(11)} ${String(r.sha).slice(0, 8)} ${what}`);
  }
  console.log(`\nNext step: factory next ${state.id}`);
  const tampered = verifyChain(state.id);
  console.log(tampered.length ? `\nEVIDENCE TAMPERED:\n${tampered.map((p) => `  - ${p}`).join('\n')}` : '\nEvidence chain intact.');
  console.log('\nHistory:');
  for (const h of state.history) console.log(`  ${h.at.slice(0, 16).replace('T', ' ')}  ${h.stage.padEnd(10)} ${h.note || ''}`);
}

const [command = 'help', ...rest] = process.argv.slice(2);
try {
  if (!commands[command]) throw new Error(`Unknown command "${command}". Run "factory help" for the list.`);
  await commands[command](parseArgs(rest));
} catch (err) {
  console.error(`factory: ${err.message}`);
  process.exit(1);
}
