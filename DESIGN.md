---
name: Codeignite
description: A compact dark review desk for work that AI agents bring to a human for approval.
colors:
  lamp-sand: "#c3aa7c"
  paper-sand: "#d1c6af"
  paper-sand-hover: "#e4dac5"
  ink-on-sand: "#191a18"
  your-turn-tint: "#211f19"
  your-turn-edge: "#6b5f45"
  sage: "#a4ba99"
  clay: "#e39484"
  desk: "#141515"
  rail: "#111212"
  panel: "#191a1a"
  card: "#1a1b1b"
  card-hover: "#202222"
  well: "#101212"
  control: "#222424"
  line: "#303232"
  edge: "#3a3d3b"
  boundary: "#6b6f6a"
  text: "#e1e1dc"
  text-muted: "#a1a49f"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "23px"
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: "-0.7px"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.55
    letterSpacing: "-0.2px"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.55
  ui:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "ui-monospace, SFMono-Regular, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0.6px"
rounded:
  xs: "3px"
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "10px"
  pill: "999px"
spacing:
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "23px"
components:
  button:
    backgroundColor: "{colors.control}"
    textColor: "{colors.text}"
    typography: "{typography.ui}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "34px"
  button-primary:
    backgroundColor: "{colors.paper-sand}"
    textColor: "{colors.ink-on-sand}"
    typography: "{typography.ui}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "34px"
  button-primary-hover:
    backgroundColor: "{colors.paper-sand-hover}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.md}"
  input:
    backgroundColor: "{colors.well}"
    textColor: "{colors.text}"
    typography: "{typography.ui}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "40px"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.text}"
    rounded: "{rounded.xl}"
    padding: "16px"
  now-panel-you:
    backgroundColor: "{colors.your-turn-tint}"
    textColor: "{colors.text}"
    rounded: "{rounded.xl}"
    padding: "16px 18px"
  chip-filter:
    backgroundColor: "{colors.card}"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.pill}"
    padding: "5px 12px"
  chip-filter-pressed:
    backgroundColor: "{colors.paper-sand}"
    textColor: "{colors.ink-on-sand}"
  dialog:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "24px"
    width: "540px"
---

# Design System: Codeignite

## Overview

**Creative North Star: "The Review Desk"**

Codeignite looks like a quiet desk where work arrives with its evidence and a person signs it off. The surface is near-black and flat. Type is the system font at small sizes, with monospace for everything that is a record: repository names, branches, counts, step trails. One warm colour, Lamp Sand, marks what waits for the person at the desk.

The components feel like calm paperwork. Panels read top to bottom, each control has a caption that says what it does, and the reader decides only after reading. Nothing is decorative, and nothing moves except a border on hover.

The interface is compact and dark by commitment. No light theme exists.

**Key Characteristics:**
- Near-black, flat surfaces separated by hairlines.
- One warm accent on a field of neutral greys.
- System sans for prose, monospace for records.
- Dense: most interface text is 12px to 14px.
- Status is always written in words, with colour as a second signal.

## Colors

A neutral near-black field with one warm accent and two status colours.

### Primary
- **Lamp Sand** (`lamp-sand`): the accent. It marks "your turn", the selected tab, row and card, and warnings that need the user. Links, labels and notices do not use it.
- **Paper Sand** (`paper-sand`): the fill of primary buttons, pressed filter chips and the "you" actor badge, with **Ink on Sand** (`ink-on-sand`) text. **Paper Sand Hover** is its hover state.
- **Your-turn Tint** and **Your-turn Edge** (`your-turn-tint`, `your-turn-edge`): the background and border of the panel and column that wait for the user.

### Secondary
- **Sage** (`sage`): passed, done, and an agent working now.
- **Clay** (`clay`): failed checks and error text.

### Neutral
- **Desk** (`desk`): the page background.
- **Rail** (`rail`): the top bar, navigation rail and bottom bar.
- **Panel** and **Card** (`panel`, `card`): dialogs, panels, cards. **Card Hover** is the row and card hover state.
- **Well** (`well`): inputs, code and log blocks, which sit darker than the page.
- **Control** (`control`): the default button fill.
- **Line** (`line`): hairline dividers and panel borders. **Edge** (`edge`) is the stronger border on hover and on board cards.
- **Boundary** (`boundary`): the border of buttons and fields, which reads at 3:1 against the page.
- **Text** and **Text Muted** (`text`, `text-muted`): body text, and captions and metadata.

### Named Rules
**The One Lamp Rule.** Lamp Sand is the only accent hue. Sage means passed or live and Clay means failed; no other hue is used.

**The Words First Rule.** A status is written out ("Your turn · answer the agent", "(done)"). Colour repeats the word and never replaces it.

## Typography

**Body Font:** the system sans stack (-apple-system, BlinkMacSystemFont, "Segoe UI")
**Label/Mono Font:** the system monospace stack (ui-monospace, SFMono-Regular)

**Character:** no web fonts. The pairing is the operating system's own text face with its own monospace, so the board reads like a native tool.

### Hierarchy
- **Headline** (500, 23px, 1.25, -0.7px): the task title and page titles. 21px at 680px and below, 20px in the drawer and side panel.
- **Title** (600, 18px, -0.2px): the heading of the "now" panel. Dialog titles are 20px.
- **Body** (400, 16px, 1.55): text inside the task body. Descriptions cap at 62ch and panel text at 86ch.
- **UI** (400 to 500, 14px): buttons, tabs, navigation, fields, cards. Captions are 13px in Text Muted.
- **Label** (mono, 12px to 13px, 0.6px to 1px tracking, uppercase for group names): repository and branch names, step trails, badges, group headers.

### Named Rules
**The Mono Is A Record Rule.** Monospace is for things the system recorded: names, paths, counts, steps, logs. Sentences are never set in mono.

## Layout

A fixed shell: a top bar, a 176px navigation rail on the left, the working area, and a bottom bar. The Work queue is either a board of up to five columns (240px to 380px each, only the columns that hold tasks are drawn) with a 440px drawer, or a 280px list beside the task detail. Other pages are a single column capped at 780px, or 1180px for wide pages.

Controls in a row share one height of 40px. Buttons are 34px. Page gutters are 23px, panel padding is 16px, and gaps between controls are 8px to 14px.

- At 880px and below the rail narrows to 118px and the list to 185px.
- At 680px and below the rail becomes a wrapped row of buttons, the list and detail show one at a time, the board becomes one column, and the map graph is replaced by an indented list.
- On touch pointers every button is at least 44px tall and fields use 16px text.
- At 1500px and above the list widens to 340px.

## Elevation & Depth

The system is flat. Depth comes from tone: Rail is darkest, Desk is the page, Card sits one step lighter, and Well sits darker than the page for anything typed or logged. Hairlines separate regions.

### Shadow Vocabulary
- **Floating list** (`box-shadow: 0 12px 32px #000a`): the open combo-box list.
- **Save bar** (`box-shadow: 0 8px 24px #0008`): the sticky unsaved-changes bar on the Workflow page.
- **Live pulse** (`box-shadow: 0 0 0 4px #a4ba9933`): the ring around the dot of an agent working now.

### Named Rules
**The Flat Desk Rule.** Nothing at rest has a shadow. A shadow means the element floats above the page.

## Shapes

Corners are small and borders are 1px. The radii in use are 3px (navigation items, inline code), 4px (dialogs, board columns and board cards, keys), 6px (buttons and fields), 8px (stat tiles, switches, log blocks), 10px (panels, cards, the "now" panel) and full pills for badges and filter chips. Metrics tiles and diff blocks are square.

Board cards (4px) and page cards (10px) differ today. New work on a page uses 10px for a container and 6px for a control.

Dashed borders mark something that does not exist yet: an empty state, an "add" card, a removed step.

## Components

### Buttons
Calm paperwork: a button states its action in words and sits at one height.
- **Shape:** gently rounded (6px), 34px tall, 12px side padding, 1px Boundary border.
- **Default:** Control fill, Text colour.
- **Primary:** Paper Sand fill with Ink on Sand text, weight 500. One per panel or dialog.
- **Ghost:** no border or fill, Text Muted, for secondary actions in a row.
- **Link and link button:** Text colour with a Text Muted underline, offset 3px. The underline turns Text colour on hover.
- **Hover / Focus:** hover lightens the fill. Focus is a 2px Lamp Sand outline, inset 2px on buttons and offset 3px elsewhere. A Paper Sand control (primary button, pressed chip) takes a 2px Text outline offset 2px instead.

### Chips
- **Filter chip:** pill, Card fill, Line border, Text Muted. Pressed: Paper Sand fill with Ink on Sand text.
- **Badge:** pill outline in mono 12px. Warn is Lamp Sand, ok is Sage.
- **Activity chip:** mono 12px outline pill that names a tool, skill, agent or MCP server.

### Cards / Containers
- **Corner Style:** 10px for panels and page cards, 4px for board columns and board cards.
- **Background:** Card on Desk.
- **Shadow Strategy:** none; see the Flat Desk Rule.
- **Border:** 1px Line, Edge on hover.
- **Internal Padding:** 16px. Cards in a grid share header, content and footer rows so footers line up.

### Inputs / Fields
- **Style:** Well fill, 1px Boundary border, 6px radius, 40px tall, 14px text. A label sits above every field and a caption below where the effect needs explaining.
- **Focus:** 2px Lamp Sand outline and a Lamp Sand border.
- **Error:** a Clay line of text under the form with `role="alert"`.

### Navigation
- **Rail:** grouped under mono uppercase labels (WORK, LOOK BACK, SET UP). Items are 14px Text Muted; the current page has a lighter fill and Text colour.
- **Tabs:** 14px Text Muted with a 1px Lamp Sand underline on the selected tab.
- **Switch:** a segmented control on a Well fill for List and Board.

### The "Now" Panel
The signature component. It sits at the top of every task and says who acts, what the situation is and what the person can do. A mono uppercase line names the actor, an 18px title names the situation, then prose and the action buttons. When it is the user's turn the panel takes the Your-turn Tint and Edge. When the task is done its border turns Sage.

### The Decision Bar
A bar pinned to the bottom of the task page while the task waits for approval. It holds Approve and Send back with the commit in mono on the right, on the Your-turn Tint with a Your-turn Edge top border. It is the only place a task is approved.

### Step Trail
A mono 12px row of step names joined by "›". Done steps are Sage, the current step is Text with a 2px Lamp Sand underline, skipped steps are Text Muted.

### Diff and Log Blocks
Well fill, mono 13px. Added lines are a dark green tint, removed lines a dark red tint, hunk headers Lamp Sand. Each file and each run is a `<details>` row at least 44px tall.

## Do's and Don'ts

### Do:
- **Do** write a status in words and let colour repeat it.
- **Do** keep controls in one row at 40px, and buttons at 34px.
- **Do** put a label above each field and a caption below a control whose effect is not obvious.
- **Do** use Well for anything typed, logged or diffed, and Card for anything read.
- **Do** use monospace for recorded facts and the system sans for sentences.
- **Do** keep one primary button per panel or dialog.
- **Do** name the action on a confirm button ("Approve commit 1a2b3c4d5e6f", "Archive task").

### Don't:
- **Don't** add a second accent hue. Lamp Sand, Sage and Clay are the whole set.
- **Don't** add a shadow to anything that does not float.
- **Don't** add a light theme.
- **Don't** load a web font.
- **Don't** set sentences in monospace.
- **Don't** colour a link, a label or a notice with Lamp Sand.
- **Don't** offer Approve where the changes, the evidence and the description are not on screen.
