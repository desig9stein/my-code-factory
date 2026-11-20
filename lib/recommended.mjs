// Names third-party skills that fit the workflow's steps. They are detected and suggested, not bundled.
export const RECOMMENDED = {
  id: 'mattpocock-skills',
  name: "Matt Pocock's engineering skills",
  author: 'Matt Pocock',
  license: 'MIT',
  url: 'https://github.com/mattpocock/skills',
  install: 'claude plugin install mattpocock-skills@claude-plugins-official',
  // A skill installed as loose files carries no plugin prefix; this one marks that the set is present.
  marker: 'setup-matt-pocock-skills',
  items: [
    { skill: 'diagnosing-bugs', pipeline: 'stages', stage: 'reproduce', types: ['bug'], why: 'Builds a pass/fail signal for the bug before anything else, then narrows it down phase by phase.' },
    { skill: 'tdd', pipeline: 'stages', stage: 'implement', why: 'Failing test first, then only the code that passes it, one slice at a time, with guidance on which tests are worth keeping.' },
    { skill: 'research', pipeline: 'stages', stage: 'plan', why: 'Gathers facts from primary sources into a file when a plan depends on them.' },
    { skill: 'code-review', pipeline: 'stages', stage: 'verify', why: "Reviews the diff on two separate axes, the repository's standards and what the issue asked for, each in a fresh context." },
    { skill: 'pr', pipeline: 'stages', stage: 'verify', why: 'Shapes the PR description: a visual summary, before and after evidence, and the merge risk.', note: "Its template has its own section names. Where a project requires the sections of its PR template, those still apply." },
    { skill: 'code-review', pipeline: 'review', stage: 'draft', why: "Reviews the pull request on two separate axes, the repository's standards and what the change set out to do." },
  ],
};
