# App Test Harness

A local test harness for using open-source desktop apps in the built-in browsers in **Codex** and **Claude Code**. Use the app yourself, ask the agent to run one of its tools, or send the agent a request from the same browser. The harness works with the public apps listed below and loads their built files from your own installation.

## Run locally

You need Node.js 22.13 or later and built apps. On macOS, the folder in the example comes from an existing desktop install. On other setups, point `appsRoot` at a folder containing each built app's `plugin.json` and its static entry point. The source repositories are linked below. The harness uses the builds you provide, so source checkouts need to be built upstream first. To use an alternate build of one app, set `builds` to an object mapping its folder ID to the absolute directory containing its built `index.html`. The manifest still comes from `appsRoot`.

Clone this repository and create a `harness.config.json` in its root. The app IDs select folders and the labels only change the launcher.

```json
{
  "appsRoot": "/Applications/PureDesktop.app/Contents/Resources/apps",
  "sourceBase": "https://github.com/puredesktop",
  "apps": [
    "pure3d", "purecalendar", "purechart", "purecut",
    "puregames", "puregantt", "puregraph", "pureinvoicing",
    "pureknowledge", "puremail", "purepeople", "pureprojects",
    "puresheets", "puresite", "pureslides", "puretasks",
    "purewhiteboard"
  ],
  "labels": {
    "pure3d": ["3D Studio", "Model objects, materials, and keyframe animations."],
    "purecalendar": ["Calendar", "Schedule events across day, week, month, and agenda views."],
    "purechart": ["Charts", "Turn pasted tables or data files into charts."],
    "purecut": ["Video Editor", "Edit local video on a timeline."],
    "puregames": ["Games", "Play a library of small games."],
    "puregantt": ["Gantt Planner", "Plan dates, dependencies, owners, and progress."],
    "puregraph": ["Graph Editor", "Create and explore network diagrams."],
    "pureinvoicing": ["Invoices", "Prepare invoices and keep track of payments."],
    "pureknowledge": ["Knowledge", "Capture notes and curate a wiki."],
    "puremail": ["Mail", "Organize threads, follow-ups, and mail tasks."],
    "purepeople": ["Contacts", "Manage people, organizations, and contact lists."],
    "pureprojects": ["Projects", "Track deliverables, owners, and next actions."],
    "puresheets": ["Spreadsheets", "Edit workbooks, formulas, and tables."],
    "puresite": ["Site Editor", "Build and preview static websites."],
    "pureslides": ["Slides", "Write and present HTML decks."],
    "puretasks": ["Tasks", "Organize work on boards and review queues."],
    "purewhiteboard": ["Whiteboard", "Sketch ideas and draw diagrams."]
  }
}
```

Start the local server.

```sh
node cli.mjs start
```

Open the printed address, usually `http://127.0.0.1:54916/`. Use **Workspace files** inside an open app to import and download test files. Documents, preferences, and activity live in the harness's own SQLite workspace under `.state/`. Set `HARNESS_STATE` before starting both the server and the agent to use a different workspace.

The harness applies a compact light theme through the app bridge and uses one neutral header above the app’s own controls. If you have a local app theme export, set `themePath` to its JSON file in your config. The harness passes the export's `light` theme to the app through its host bridge.

## Open it in your agent

- **Codex Desktop.** Open this checkout as a trusted local project. Ask `@Browser` to open the address above or enter it in the built-in browser. The project's `.codex/config.toml` declares the `harness` MCP server. Start a new chat in this project if you just added it. [Codex browser and computer use](https://developers.openai.com/training/walkthroughs/using-your-computer-and-browser) · [Codex MCP setup](https://developers.openai.com/codex/mcp/)
- **Claude Code Desktop.** Open a local session in this checkout. Use **Browser** in the toolbar and enter the same address, or choose **App Test Harness** from the development servers to start it from the included launch configuration. Approve the project-scoped `harness` MCP server when Claude Code asks. [Claude Code Desktop](https://code.claude.com/docs/en/desktop)

## Work in both directions

1. Open an app. Use **Focus app** to give it the entire harness pane. Ask your agent to run `harness_tools` to discover the tools available in the current screen. It can call them through `harness_call`. A tool flagged for approval prompts in the browser before running. The original app shows the result.
2. Open **Agent activity** beside the app. Use **Send** to queue a request for your agent. Requests sent from a supported app’s own agent controls, app saves, context updates, and tool completions also appear here. The feed captures events the app reports through the bridge. For a click or other UI change that produces no event, the agent can inspect the browser.
3. Ask your agent to watch the activity feed. It reads `harness_activity`, passes `nextCursor` back as `after`, and can wait up to 20 seconds for new activity in each call. It can send a response through `harness_reply`. Requests remain available in the browser's recent log if the agent stops watching. Sending a request does not start an idle chat or wake a closed agent.
4. If both desktop browsers are open, use the **Browser connection** ID from the intended tab. The app, activity, and reply go to that tab.

Try this in your agent after opening Tasks.

> Use the harness to inspect the Tasks board in my browser. Then watch Agent activity for my next request and reply there.

The same commands are available without MCP.

```sh
node cli.mjs status
node cli.mjs tools tasks --browser BROWSER_ID
node cli.mjs call tasks getTasksContext '{}' --browser BROWSER_ID
node cli.mjs activity 0 20 --browser BROWSER_ID
```

## How it works

A Node server binds to loopback, reads the configured app manifests, and serves each original build on its own loopback origin. The launcher frames that build and answers the host bridge messages the app already sends. It provides a separate workspace for files, local data, and settings. It routes declared, registered tools to the same frame the person is using and collects the result. A cursor-based activity log carries app events and explicit user requests back to the agent. App-originated requests are labelled separately from messages typed into the harness. When an agent replies to an app request by ID, the reply also goes into that app’s local conversation.

The harness does not include app source, build artifacts, or desktop stylesheets. Native credentials, hosted accounts, and OS-specific services are outside the local bridge. Apps that need them can open with reduced functionality. Use trusted builds and keep the server on loopback.

## Review changes with Markback

Markback can review the harness or the app it is showing. Ask your agent to push a screenshot of the running harness to Markback, draw on the screenshot, and press **Send** to give the agent something to improve. This uses Markback's existing screenshot review workflow alongside the live harness. [Markback](https://pure.science/markback) · [Markback source](https://github.com/esetera/markback)

## App sources

The launcher names below link to their upstream open-source repositories. [PureDesktop](https://puredesktop.ai/) · [Pure Science](https://pure.science/)

- [3D Studio](https://github.com/puredesktop/pure3d)
- [Calendar](https://github.com/puredesktop/purecalendar)
- [Charts](https://github.com/puredesktop/purechart)
- [Video Editor](https://github.com/puredesktop/purecut)
- [Games](https://github.com/puredesktop/puregames)
- [Gantt Planner](https://github.com/puredesktop/puregantt)
- [Graph Editor](https://github.com/puredesktop/puregraph)
- [Invoices](https://github.com/puredesktop/pureinvoicing)
- [Knowledge](https://github.com/puredesktop/pureknowledge)
- [Mail](https://github.com/puredesktop/puremail)
- [Contacts](https://github.com/puredesktop/purepeople)
- [Projects](https://github.com/puredesktop/pureprojects)
- [Spreadsheets](https://github.com/puredesktop/puresheets)
- [Site Editor](https://github.com/puredesktop/puresite)
- [Slides](https://github.com/puredesktop/pureslides)
- [Tasks](https://github.com/puredesktop/puretasks)
- [Whiteboard](https://github.com/puredesktop/purewhiteboard)

## Development

`npm test` verifies the workspace and browser bridge with an original test fixture. See [LICENSE](LICENSE) for the MIT license covering this harness.
