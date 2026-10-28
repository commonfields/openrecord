# Connect your local AI subscriptions

Use Settings → Agent to connect Codex, Claude Code, OpenCode, or Cursor installed on your computer, or a CLIProxyAPI server running there. Keep that computer and the bridge running while you chat.

## On your own computer: nothing to set up

When OpenRecord runs on the computer you use (the desktop app, or a local
server started with `OPENRECORD_LOCAL_BRIDGE=1`, which `scripts/dev-up.sh`
sets), it starts the bridge itself as soon as you sign in. There is no
download and no pairing code. Settings → Agent shows it as **This computer**.

- Every installed provider that is signed in and lists models turns on by
  itself: Codex, Claude Code, OpenCode, Cursor and CLIProxyAPI.
- A provider you turn off stays off; one you sign in to later turns on at the
  next discovery, within 30 seconds.
- CLIProxyAPI needs no environment variable: when `CLIPROXY_API_KEY` is not
  set, the bridge reads the first `access.api-keys` entry from CLIProxyAPI's
  `config.yaml` (`CLIPROXY_CONFIG`, `~/.cli-proxy-api/config.yaml`, Homebrew's
  `cliproxyapi.conf`, or `~/CLIProxyAPI/config.yaml`), and only ever sends it to
  this computer.
- **Disconnect** stops it until you select **Connect** again.
- The bridge keeps its own configuration in `~/.openrecord/app/<user>`, apart
  from a bridge you paired by hand. It gets only system paths and the CLIs'
  sign-in directories from the server, never the server's secrets or API keys,
  so a hosted-model key cannot make a CLI bill it instead of your subscription.

Never set `OPENRECORD_LOCAL_BRIDGE` on a shared or hosted server: the bridge
runs the provider CLIs with that machine's sign-ins for whoever is signed in.

## Connect another computer

1. Install Node 24 and the provider's official CLI on your computer.
2. Sign in through the provider's official CLI. OpenRecord does not collect subscription passwords or tokens.
3. Open Settings → Agent in OpenRecord.
4. Download `openrecord-bridge.mjs` and keep it in a folder you control.
5. Enter a computer name and select **Get pairing code**.
6. Run the displayed pairing command from the folder containing the download. Do not share the command or code.
7. Keep the terminal open. Provider cards appear after discovery. Settings refreshes every five seconds.
8. Enable the provider you want to use.
9. Select its model in the chat composer and send a message.

Pairing codes expire after ten minutes and work once. A new pairing replaces the bridge's local configuration. Stop the old bridge and revoke its connection in Settings before pairing again.

If a provider needs sign-in, run the command on its card in another terminal. The command selects that specific local account instance. Discovery repeats within 30 seconds while the bridge is idle.

## Restart or update the bridge

From the download folder, run:

```sh
node openrecord-bridge.mjs run
```

To update, stop the bridge, download the script again, and run it again. The private configuration remains in `~/.openrecord/bridge.json`.

After a crash, confirm that no bridge process remains before removing only `~/.openrecord/bridge.lock`. Never delete the configuration to clear a lock.

## Add another account

Stop the bridge before changing its configuration. For providers that support a separate credential directory, add a named instance with that directory:

```sh
node openrecord-bridge.mjs add --driver codex --name "Work Codex" --home /absolute/path/to/work-codex
```

The bridge does not copy credentials. Run `node openrecord-bridge.mjs run`, then use the new card's sign-in command. Codex uses `CODEX_HOME`, Claude Code uses `CLAUDE_CONFIG_DIR`, and OpenCode uses `OPENCODE_CONFIG_DIR`. Cursor uses its CLI's existing account configuration and does not support a separate account directory through this bridge.

Use `--binary /absolute/path/to/cli` when adding an instance that needs a particular installed executable.

## Use CLIProxyAPI

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) serves your Claude, Codex, Gemini and other subscriptions as one OpenAI-compatible API on your computer. The bridge calls it with native tool calling instead of starting a CLI for every model step, so turns and helper sessions run faster.

1. Install and start CLIProxyAPI, and sign in to the providers you want with its own login flags, for example `./CLIProxyAPI --claude-login` or `./CLIProxyAPI --codex-login`.
2. Put a client key in its `access.api-keys` list, and export the same key as `CLIPROXY_API_KEY` in the terminal that runs the bridge.
3. Bridges paired after this version discover it at `http://127.0.0.1:8317` automatically. For an older bridge, or another address, stop the bridge and add it:

```sh
node openrecord-bridge.mjs add --driver cliproxy --url http://127.0.0.1:8317 --api-key-env CLIPROXY_API_KEY
```

4. Restart the bridge, enable **CLIProxyAPI** in Settings → Agent and pick one of its models in the composer.

Plain HTTP is accepted only on `127.0.0.1` or `localhost`; any other address must use HTTPS. The key stays on your computer. If the card says **Not running**, CLIProxyAPI is not reachable from the bridge; if it says **Authentication failed**, the key does not match one of its `access.api-keys`.

## Stop or disconnect

Use **Stop** in chat to cancel the active conversation turn and every helper session it started. An interrupted provider request may still count against the provider's usage limit.

Disable a provider to block new turns and cancel its active jobs. Revoke a bridge in Settings to disconnect that computer. Revocation does not sign you out of the provider's CLI.

## Resolve unavailable providers

If a card says **Offline**, restart the bridge and check the computer's connection. If the CLI is missing, install it through the provider's official instructions.

An unknown sign-in state means the provider's discovery protocol did not confirm authentication. It does not mean that sign-in succeeded. A model catalog also does not prove that your subscription permits generation.

If a turn reaches a usage limit, select another enabled model yourself or wait for the provider's limit to reset. OpenRecord never silently changes providers. Existing API-key environment variables or CLI billing settings may select paid API usage instead of a subscription. Check the provider's own configuration before sending a turn.

For deployment boundaries and current limits, read [Local provider runtime](../engineering/harness-runtime-v1.md).
