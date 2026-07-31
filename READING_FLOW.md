# Paper Reading Flow

This is a local customization of
[Paper Reading Agent](https://github.com/xiaoxuanli-a/zotero_agent_reader_plugin)
for interruption-light, question-driven reading.

## Added workflow

- **Continuous deep dialogue** is the default. There is no quick/deep switch.
- **Thought map** keeps several independent lines of inquiry inside one paper.
  Select a node to restore only that branch's transcript and AI session.
- **Branch from here** is available on the current checkpoint and on historical
  messages. A child branch inherits the exact branch point and ancestry but does
  not mix in sibling conversations.
- **Re-entry checkpoint** stores the most recent question, answer preview, and
  first verified PDF citation. Returning after a long interval shows where the
  branch stopped and lets the reader jump back to the source passage.
- **Pause** removes a branch from the immediate reading flow without deleting
  it. It remains available in the thought map.
- **Question parking lot** still separates “ask after this section” questions
  from exploratory side branches. Restoring a parked branch reconnects it to
  the thought chain from which it arose.

All reading state is stored in the existing per-attachment conversation JSON
under Zotero's data directory. No additional server or database is used.

## Install

Requirements:

- Zotero 9 desktop
- Codex CLI or Claude Code installed and logged in
- Poppler (`choco install poppler` on Windows)

In Zotero, open **Tools → Plugins → gear icon → Install Plugin From File** and
select `paper-reading-flow.xpi`, then restart Zotero. Open
**Settings → Paper Reading Flow**, select a backend, and run **Test connection**.

The fork uses the local add-on ID `paper-reading-flow@local` and has no automatic
update channel, so an upstream release cannot silently replace these workflow
changes.

## Known limitations

- The anchor is learned from the first verified citation in the AI answer. The
  current version does not capture arbitrary PDF text selection before sending.
- The parking lot stores text questions, not image attachments.
- Branch summaries are compact checkpoints derived from the latest answer, not
  full AI-generated chapter summaries.

## Verification

- 85 unit tests pass.
- Production build and TypeScript checking pass.
- Prettier and ESLint checks pass.

The upstream project and this derivative are distributed under AGPL-3.0-or-later.
