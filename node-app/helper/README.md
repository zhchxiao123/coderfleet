# coderfleet-helper

A small program for the machine that has the hardware (a Mac with a board on
USB, a Linux box with a serial adapter). Tasks that hold a token can run the
commands its rules list, in their project directory, and nothing else. It is a
separate program from CoderFleet: CoderFleet installs it, starts it and hands
each task a token; the helper decides what runs.

Design: `docs/plans/mac-channel-design.md` (§17 lists what was built and what
differs). Needs Node 22.18 or newer; no dependencies.

## By hand

```bash
node src/main.ts serve --port 8790        # MCP at /mcp, management at /control/…
node src/main.ts status
node src/main.ts policy set idf.py allow build size
node src/main.ts policy set esptool confirm write-flash
node src/main.ts token --root ~/code/firmware   # a token for one directory
node src/main.ts audit -n 20
node src/main.ts stop
```

Files live in `~/.coderfleet-helper` (`CODERFLEET_HELPER_HOME` to move them):
`secret` (the master secret; whoever reads it controls the helper),
`policy.json`, `audit/`, `run.json`. A command's full output goes to
`.coderfleet-tasks/helper/<call>.log` in the project directory.

## What a task can do

Tools: `machine_info`, `run_command(argv, cwd, timeout_s)`,
`list_serial_ports`, `read_serial`.

- A command runs only when a rule allows it; `confirm` rules wait for a person
  (CoderFleet shows a card), and what no rule lists is refused.
- Some things are refused whatever the rules say (`sudo`, burning efuses, paths
  into the helper's own directory, …): `policy show` prints the list.
- Programs are named without a path and looked up in the rules file's `path`
  directories only; that list is edited by hand, not through the API.
- The working directory stays inside the token's directory; the environment is
  a fixed small set; a timeout or a revoked token kills the whole process group.
- Every call is one line in `audit/`; when that line cannot be written, the
  command does not run.

## Tests

```bash
npm test                      # the helper alone
bash scripts/claude-check.sh  # a real Claude Code connects over MCP (needs a signed-in `claude`)
```

The CoderFleet side (forwarded port, per-project switch, tokens, confirmation
cards, stop = revoke, UI and command line) is `docs/plans/machine-helper/coderfleet-side.patch`;
`docs/plans/machine-helper/verify.sh` applies it to a copy of the app and runs everything.
