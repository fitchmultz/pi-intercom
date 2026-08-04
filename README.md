# Pi Intercom

> [!IMPORTANT]
> This standalone package is retired. Intercom is now bundled into [`pi-subagents`](https://github.com/fitchmultz/pi-subagents) so the broker, extension, child bridge, skills, and updates ship from one package.

## Migrate

Run `pi list` to find the standalone source and scope, remove that exact entry, install or update `pi-subagents`, then restart or reload Pi.

For a user-scoped Git install:

```bash
pi remove git:github.com/fitchmultz/pi-intercom
pi install git:github.com/fitchmultz/pi-subagents
```

For the project-local checkout previously documented here, use its absolute path and the same local scope:

```bash
pi remove /absolute/path/to/pi-intercom --local
pi install git:github.com/fitchmultz/pi-subagents
```

If `pi-subagents` is already installed, run `pi update --extensions` instead of installing it again. Do not keep both packages enabled. They register the same intercom tools, command, shortcut, and broker connection.

The active intercom documentation now lives in the [`pi-subagents` intercom guide](https://github.com/fitchmultz/pi-subagents/blob/main/docs/intercom.md). This repository remains available as implementation history and for compatibility with existing installations, but it will not receive standalone releases.
