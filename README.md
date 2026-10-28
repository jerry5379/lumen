# Lumen

An open-source, Cursor-style desktop code editor for macOS with Claude built in. It can work across your whole Mac, not just one project folder.

Sign in with your **claude.ai** account (Pro or Max) and Lumen runs Claude Code on your machine through the official [Claude Agent SDK](https://docs.claude.com/en/docs/agent-sdk/overview). If you'd rather pay per use, connect an Anthropic Console account or API key instead.

## What it's for

- **Ask about any code on your Mac.** "Where do I configure the database in my side project?", "Which of my repos still use React 17?" Claude searches and reads the files it needs. Nothing is uploaded up front.
- **Edit with review.** Ask for a change and Claude proposes it as a diff. You accept or reject every edit and every shell command before it runs.
- **Inline rewrites.** Select code, press ⌘K, describe the change and review the diff.
- **Drag in context.** Drop files or folders from the explorer, the tabs or Finder onto the chat. Small text files are attached in full; larger files and folders are passed as paths for Claude to explore.
- **System chores.** "Free up space in my Downloads", "Why does `npm start` fail in ~/work/api?" Commands always ask for approval first.
- **Light, dark or system theme**, switchable from the title bar.

## Requirements

- macOS on Apple silicon (other platforms are untested)
- Node.js 20 or newer
- For the subscription engine, [Claude Code](https://docs.claude.com/en/docs/claude-code) installed (`npm i -g @anthropic-ai/claude-code`)

## Run from source

```sh
git clone https://github.com/jerry5379/lumen.git
cd lumen
npm install
npm start
```

Open **Settings** (the gear icon) and pick how to connect:

| Engine | Sign in | Billing |
|---|---|---|
| Claude subscription (default) | **Sign in with Claude** opens claude.ai | Your Pro or Max plan |
| Anthropic API | Console sign-in through the `ant` CLI, or an API key (stored encrypted with Electron `safeStorage`) | Pay per use |

If `npm start` says Electron failed to install, run `node node_modules/electron/install.js`.

## Build a Mac app

```sh
npm run dist
cp -R dist/Lumen-darwin-arm64/Lumen.app /Applications/
```

The app is unsigned. On first launch, right-click it and choose **Open**. For Claude to read protected folders such as Desktop, Documents and Downloads without repeated prompts, add Lumen under System Settings → Privacy & Security → Full Disk Access.

## How Claude gets system-wide context

Claude uses tools when your question needs them. With the API engine, Lumen provides these tools:

| Tool | What it does | Needs approval |
|---|---|---|
| list_directory | List any folder, up to 4 levels deep | No |
| find_files | Find files by name (ripgrep) | No |
| search_text | Search file contents with a regex (ripgrep) | No |
| read_file | Read any text file | No |
| edit_file / write_file | Change or create files, shown as a diff first | Yes |
| run_command | Run a zsh command (120 s timeout) | Yes |

With the subscription engine, Claude Code's own tools are used (Read, Grep, Glob, Edit, Write, Bash and others). Read-only tools run freely. Edits and commands go through Lumen's approval card. Claude Code auto-approves a small set of harmless read-only shell commands, such as `ls` and `pwd`.

"Always allow" applies only to the current chat.

## Shortcuts

| Keys | Action |
|---|---|
| ⌘L | Ask Claude (your selection is included as context) |
| ⌘K | Rewrite the selection, or the whole file, inline |
| ⌘P | Go to a file in the workspace |
| ⌘O | Open another folder |
| ⌘S | Save |
| ⌘↵ / Esc | Accept / reject a diff |

## Project layout

- `main.js`: Electron main process, settings, file access and IPC
- `claudecode.js`: subscription engine (Claude Agent SDK and your local Claude Code)
- `agent.js`: API engine (Anthropic SDK tool loop)
- `preload.js`: the bridge between the window and the main process
- `renderer/`: the editor UI (plain HTML, CSS and JS, with no framework or build step)

## Security note

Lumen gives an AI model read access to your files and, with your approval, the ability to change them and run commands. Review each diff and command before you approve it. Don't run Lumen against untrusted repositories with "Always allow" turned on.

## License

[MIT](LICENSE)

Lumen is an independent project. It isn't affiliated with or endorsed by Anthropic or Cursor.
