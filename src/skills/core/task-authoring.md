---
name: task-authoring
description: How to create, schedule, run, batch, follow, and review tasks (unattended agent runs) with the tasks__* tools
metadata:
  nimblebrain:
    loading-strategy: dynamic
    priority: 50
    tool-affinity:
      - tasks__*
    triggers:
      - "task"
      - "schedule"
      - "every day"
      - "every weekday"
      - "every morning"
      - "every week"
      - "every hour"
      - "remind me"
      - "recurring"
      - "automate"
allowed-tools: tasks__create tasks__update tasks__list tasks__run tasks__run_result tasks__status tasks__runs
---

# Tasks

A task is saved agent work that runs unattended: a prompt (`body`), a
`manifest` (tools, schedule, limits), and runs that each leave a result.

**Say "scheduled task" to the person, never a bare "task"**, which means a to-do.
They are listed on the **Scheduled** page. Say "run" for one execution.

## Set one up

1. Check the tools the job needs exist (`nb__search`). If a connector is
   missing, say which one to install and stop.
2. Write `body` as the job: what to read, what to make, where to deliver it.
   Set `allowedTools` to one `<connector>__*` glob per connector it uses.
3. If the person has not said what it does or when, ask. Otherwise name it
   yourself and call `tasks__create` once, shaped like:
   `{"manifest": {"name": "Weekday file summary", "schedule": {"cron": "0 8 * * 1-5"}, "allowedTools": ["files__*"]}, "body": "Summarize my files in one line."}`
4. Say in a sentence what it does and when it runs next, and offer a test run.

## Change, run, or check one

- **Change an existing task with `tasks__update {taskId, manifest}`, never
  `tasks__create` again.** Find its id with `tasks__list`. "Move it to 9am" is
  an update of `schedule`.
- **Run now:** `tasks__run {taskId}`. A `dispatched` or `queued` answer has a
  `runId`: follow it with `tasks__run_result {runId}` until `ended`. Never call
  `tasks__run` again for a run you are following.
- **Status and next run:** `tasks__status {taskId}`.
- Say it is done only after the tool's answer shows it.

## Schedules

Give exactly one of:

- `cron` with `timezone` when known: `{"cron": "0 8 * * 1-5"}` is weekdays at 8.
  "every morning at 8" `0 8 * * *`; "Mondays" `0 9 * * 1`; "every hour" `0 * * * *`.
- `intervalMs` (at least 60000): `{"intervalMs": 1800000}` is every 30 minutes.
- `at`, an ISO time with an offset, for one run at a set time. Never a cron with
  a fixed date: it recurs yearly.
- `match` to run on a connector's events; nothing arrives until an admin routes
  them to the task.

No schedule: it runs only when asked. `enabled: false` pauses the schedule.
`null` in an update clears a field.

## More

- **Many inputs:** create the task with an `inputSchema`, test one item with
  `tasks__run {taskId, input}`, then `tasks__run_batch` with a `budgetUsd`.
- **Judged results:** `criteria` need a judge server (`tasks__judges`). Review
  with `tasks__runs {label: "Needs review"}` and `tasks__assess`.
- **A one-off:** `tasks__run {definition: {body, manifest: {name}}}`.
- **Something went wrong:** `tasks__status` shows `disabledReason`; a failed
  run's `error` and `activityLog` are in `tasks__run_result`. Fix the cause with
  `tasks__update` before re-enabling.
