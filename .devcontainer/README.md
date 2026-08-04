# Devcontainer

A ready-made environment for the tutorial, so participants don't have to install
Node, npm 11 and Pi themselves. Docker and VS Code remain optional — the tutorial
runs fine on a host that already meets the prerequisites in the top-level
[README](../README.md).

## What is in the image

| Piece | Version | Why |
| --- | --- | --- |
| Node.js | 22.22.3 | `package.json` requires `>=22.19.0` |
| npm | 11.19.0 | Node 22 bundles npm 10, which strips the lockfile's `libc` field |
| Pi CLI | 0.83.0 | The tutor engine's SDK and the factory doer the lessons call as `pi -p` |

Nothing else. No Python, no Bun, no second coding agent — the tutorial needs none
of them.

## Using it

Open the repository in VS Code and choose **Dev Containers: Reopen in Container**,
or `devcontainer up --workspace-folder .` with the CLI. `post-create.sh` runs
`npm install` once the container exists, so the first lesson doesn't wait on it.

Then authenticate Pi and start the tutor:

```sh
pi          # enter /login and choose a provider
npm run setup
npm run tutorial -- --port 4310
```

If the host already exports `OPENCODE_API_KEY`, skip the `pi` step — see
[Bringing a key from the host](#bringing-a-key-from-the-host) below.

Port 4310 is forwarded and configured to open a browser on the host. VS Code also
exports `BROWSER`, pointing at a helper that opens a URL on the host, and the
tutor prefers it over `xdg-open` — which the image does not carry — so any port
opens a tab, not just the forwarded one. The tutor binds to loopback by default;
inside a container that is loopback *in the container*, which VS Code's port
forwarding reaches. Add `--host 0.0.0.0` only
when something outside the forwarding mechanism needs to reach it — the tutor has
no authentication and edits the working tree.

## Credentials survive a rebuild

`PI_CODING_AGENT_DIR` points at a named volume mounted on
`/home/vscode/.tutorial-state`, so `Dev Containers: Rebuild Container` does not
force a re-login. Nothing in this repository stores those credentials.

## Bringing a key from the host

`remoteEnv` forwards the host's `OPENCODE_API_KEY` into the container, so a host
that already has an OpenCode Zen key gets an authenticated tutor with no `/login`
at all:

```sh
export OPENCODE_API_KEY=...   # on the host, before launching the container
```

Two properties of this to know:

- **Unset is harmless.** Without the variable on the host, `${localEnv:...}`
  expands to an empty string, and Pi reads an empty key as no key. Participants
  who use `/login` are unaffected.
- **`auth.json` wins.** Pi resolves credentials in the order `--api-key`,
  `auth.json`, then environment. A provider stored by a previous `/login` takes
  precedence over this variable, so remove it with `/logout` if you want the
  host key to take over.

The value is read from the host at attach time, so rotating it needs only
**Dev Containers: Reopen in Container**, not a rebuild. It reaches processes VS
Code starts — terminals, tasks, `postAttachCommand` — but not a bare
`docker exec` from outside; pass `-e OPENCODE_API_KEY` yourself there.

The variable is still a secret. It is forwarded, never written into the image,
the lockfile, or the state volume, and nothing in this repository persists it.

## Bumping versions

The pins are deliberate — they are the versions participants get, which is also
why the image sets `NPM_CONFIG_UPDATE_NOTIFIER=false`: npm would otherwise nudge
every `npm install` towards a version this image did not choose. Change the
`ARG` values in the `Dockerfile`. The Node tarball is sha256-verified, so a
version bump also needs the new checksums:

```sh
curl -fsSL https://nodejs.org/dist/vNEW/SHASUMS256.txt | grep -E 'linux-(x64|arm64)\.tar\.xz'
```
