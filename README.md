# app-douglas

Normal Framework driver for **Douglas Dialog** lighting (WLC-3150 LCUs behind a
Global Web Server), using the GWS's internal JSON endpoint.

Registers relay, dimmer and photocell points into the NF layer `hpl:douglas`.

---

## Protocol notes

The GWS is IIS on Windows Server 2016. Everything the web UI does goes through
one ISAPI extension:

```
POST http://<gws>/globalweb/W3000%20ISAPI%20Extension.DLL
Content-Type: application/x-www-form-urlencoded   (body is raw JSON regardless)
Cookie: UserPermissionToken=<guid>; csrf=<token>

{"webapp":{"method":"<Method>","LCUNum":<int>,
           "param":[{"token":"<guid>"}, ...]}}
```

The token goes in **both** the cookie and the body. An expired session comes
back as `200 OK` with a `redirectURL` pointing at the login page, not a 401.

### Methods in use

| Method | LCUNum | Params | Returns |
|---|---|---|---|
| `ValidateLoginPassword` | `0` | `{userPassword}` | `responseToken` in `parameters[0]` |
| `RequestLoginRedirect` | `0` | `{token}` | `redirectURL` in `parameters[0]` |
| `LCUListOutlook` | `"0"` | `{token}` | LCU list and online/desync state |
| `LoadOutputs` | LCU | `{token}`, `{start}`, `{rowNum}`, `{total}` | Full output list: names, addressing, live state |
| `LoadPartialOutputs` | LCU | `{token}`, `{page}`, `{rowNum}` | State only, whole LCU in one response |
| `RelayControl` | LCU | `{token}`, `{command}`, `{dval}`, `{outputs}` | Sends ON / OFF / DVAL |

The two login methods return their fields inside `parameters[0]`; the data
calls put `responseMessage`/`redirectURL` on the envelope itself. Don't assume
one shape.

Both load calls reply with `method: "LoadOutputsResponse"`, but they page
differently. `LoadOutputs` takes `start`/`rowNum`/`total` and returns
`records` = the grand total for the LCU, so you page until you've accumulated
that many (the UI requests 64 at a time). `LoadPartialOutputs` takes
`page`/`rowNum` and returns the whole LCU at once, ~17 kB for 512 rows. The UI
polls it every 3 s.

### Commands

```json
{"webapp":{"method":"RelayControl","LCUNum":1,
  "param":[{"token":"..."},{"command":"ON"},{"dval":""},
           {"outputs":[{"FastId":"73"},{"FastId":"74"}]}]}}
```

- `command` is `ON`, `OFF` or `DVAL`.
- `dval` is 0-100 as a **string**, and is sent as `""` (not omitted) for ON/OFF.
- The outputs array uses capital-F **`FastId`**, while every response returns
  lowercase `fastId`. Easy to get wrong.
- Commands are batched — one call can carry many outputs on the same LCU.

### Authentication

Password only — no username, 32 characters max, posted in cleartext over HTTP.
There is no per-user identity, so nothing the driver does is attributable.

The browser flow (visible in the login page source) is: `ValidateLoginPassword`
returns a token, the *client* writes it into the `UserPermissionToken` cookie,
then `RequestLoginRedirect` is called and the browser follows `redirectURL`.
`login()` reproduces this, including the second call, since the server appears
to treat it as session activation.

The login page only ever writes `UserPermissionToken`. A `csrf` cookie seen
next to it in a browser most likely belongs to a different app on the same host
— in the environment this was captured from, a Niagara station was also on
`localhost`. `csrf` is therefore not needed.

`token` and `csrf` were originally exposed as app options, but NF 3.10.7
rejects a secret option that is left empty — it fails validation with
"invalid value type for option" and silently drops the option from the stored
config. Both were removed from the manifest; `GwsClient` still accepts them
programmatically.

### Data model

- `fastId` is the primary key, scoped per LCU.
- **`dimmer fastId = relay fastId + 500`**, exactly. `18.1r`=73 / `18.1d`=573,
  `9.1r`=37 / `9.1d`=537, `14.1r`=57 / `14.1d`=557. So `18.1r` and `18.1d` are
  two aspects of the same physical circuit: relay switches it, 0-10V sets the
  level. Both points carry `douglas/channel` (`18.1`) so they can be rejoined.
- DRC panels expose 6 relays but only 4 dimming channels, so the dimmer block
  is shorter than the relay block.
- Relays report `onOff` (`On`/`Off`/`Unknown`); dimmers report `DVAL` 0-100 and
  `dimmerStatus`. `Unknown` means the LCU can't reach the panel — the driver
  writes nothing rather than recording a false Off.
- **`areaDescription` falls back to the outputId when a circuit was never
  named.** A description of `"18.2r"` means unnamed. Handled in
  `realDescription()`.
- Unassigned channels arrive with no `panel` and `onOff: "Unknown"`. Skipped on
  import.
- `photoSensorStatus` is `NotInPhotoMode` or `InActivatedPhotoMode`. The latter
  means a photocell is actively controlling the circuit — worth trending on
  exterior lighting. A separate point is created only for circuits found in
  photo mode at import time.

### LCU numbering

`LCUNum` is **zero-based**. `outputsList.htm` builds its caption as
`parseInt(lcu_number,10)+1`, which is why `LCUNum: 1` displays as "LCU 2" and
corresponds to **LCU-02** in the dropdown. `lcuLabel()` does the conversion.

---

## Configuration

| Option | Notes |
|---|---|
| `baseUrl` | e.g. `http://10.x.x.x` (no trailing slash, no `/globalweb`) |
| `password` | GWS login password. The driver logs in and re-auths on its own |
| `lcuNums` | Comma-separated, zero-based, e.g. `0,1,2` |
| `command` | `write-outputs` only: `ON`, `OFF` or `DVAL` |
| `targets` | `write-outputs` only: comma-separated outputIds (`18.1r,11.2r`) or fastIds |
| `dval` | `write-outputs` only: 0-100, required for `DVAL` |
| `maintain` | `sync-levels` only: `true` to re-assert setpoints against local control |
| `deadband` | `sync-levels` only: percent tolerance when maintaining, default 1 |

## Hooks

| Hook | Schedule | Description |
|---|---|---|
| `import-points` | Manual / on demand | Discovers outputs and registers points in `hpl:douglas` |
| `poll-values` | Every 1 minute | One `LoadPartialOutputs` per LCU, fanned out by fastId |
| `write-outputs` | On request | Sends a batched `RelayControl`, refusing non-writable targets |

### Trending

`poll-values` is bound to points with a `period` of 1 or more, matching the
pattern in Normal's own `app-desigocc`. Import the points, then enable trending
per circuit in the Object Explorer — only those get polled. For a system with a
lot of Spare circuits this keeps the load on the GWS well down.

### Writable dimmers (parked)

> **Status:** parked in `parked/`, not installed. The hook definition needs a
> `groups` / `groupVariables` structure that we could not determine from error
> messages alone: `groups` is a field of the point-query message, but rejects
> both an array and a string, so it is a nested message of unknown shape. The
> protobuf schema (`buf.build/normalframework/nf`) or a grouped hook built in
> the NF console will settle it. Until then, set levels with `write-outputs`.



NF has no native write path for a driver-defined layer, so `point.write()` on
an `hpl:douglas` point would go nowhere. Instead `sync-levels` gives each
dimmer a hook **variable** named `levelSetpoint` — a point in the `automation`
layer, which *is* writable — and pushes changes in it down to the lighting
system.

That makes the variable the real setpoint: an NF Schedule can target it, it can
be exposed over BACnet, and it can be written from the UI or the command API.
The hook is grouped by `douglas/outputId`, so there is one variable per dimmer,
and runs in `MODE_ON_DATA` so a write takes effect immediately. The default
value is `-1`, meaning "no command", so a fresh install doesn't drive every
dimmer to 0.

**Who wins, Normal or Douglas?** By default a level is sent only when the
setpoint changes, so the Douglas system's own schedules, presets and photocells
remain free to move the circuit afterwards. Setting `maintain` to `true` makes
the hook re-assert the setpoint whenever the actual level drifts more than
`deadband` (default 1%) away from it. That makes Normal the authority and *will*
fight local control — don't enable it without deciding that's what you want.

The UI polls every 3 s; the hook is set to 1 minute to stay light on the GWS.
Adjust the rrule in `hooks-update/poll-values.json` if you need faster.

## Installation on a Normal Framework gateway

1. Push this repo to Git and note the URL.
2. In the NF gateway UI go to **Applications → Add Application** and set the
   Git URL.
3. After install, confirm the `hooks/` folder shows in the Git tab and the
   three hooks appear in the Hooks tab.
4. Configure `baseUrl`, `password` and `lcuNums`, then invoke `import-points`.

## Runtime notes

### Never pass `sdk.logEvent` as a bare reference

`sdk.logEvent` is a prototype method that calls `this._eventEmitter.emit(...)`
internally. Storing it as a plain reference —

```js
const log = sdk.logEvent;        // WRONG
this.log = logEvent;             // WRONG
```

— loses `this`, and every call then throws

```
Cannot read properties of undefined (reading 'emit')
```

This is worth spelling out because the error is thoroughly misleading. It
mentions `emit`, so it reads like a stream or socket failure, and it surfaces
at whatever line happens to log next — which made it look in turn like an axios
bug, a `fetch` bug, and a sandbox networking restriction. It was none of those.
Outbound HTTP from the sandbox works fine, via axios, `fetch`, Node's `http`
module and `sdk.http` alike.

Use `bindLogger(logEvent, sdk)` in `gws.js`, or call `sdk.logEvent(...)`
directly as a method. Logging is also wrapped in a try/catch so a logging
failure can never take down real work again.

### Transports

`GwsClient` tries `sdk.http`, then Node's `http`/`https`, then global `fetch`,
logs which one works and reuses it. All three are functional; the fallback
chain is belt-and-braces, and the combined error message names each one's
failure reason if they all fail, which distinguishes a sandbox problem from an
unreachable GWS.

The only runtime dependencies are the SDK and `uuid`.

## Repo structure

```
app-douglas/
├── app.json                     # NF app manifest
├── package.json
├── .gitignore                   # note: package-lock.json IS committed
├── README.md
├── hooks/
│   ├── gws.js                   # Shared GWS client and parsing helpers
│   ├── import-points.js         # Point discovery
│   ├── poll-values.js           # Value polling
│   └── write-outputs.js         # ON / OFF / DVAL commands
└── hooks-update/
    ├── import-points.json       # Hook registration (manual)
    ├── poll-values.json         # Hook registration (1-min schedule)
    └── write-outputs.json       # Hook registration (on request)
    
parked/                          # not installed - see "Writable dimmers"
├── sync-levels.js
└── sync-levels.json
```

### Setting a dimmer level

`write-outputs` runs in `MODE_ON_REQUEST` and reads its parameters from the
invocation `args`, so no config editing is needed:

```json
{ "command": "DVAL", "targets": "11.1d,9.1d", "dval": 35 }
```

`targets` accepts a comma-separated string or an array, and matches either
outputIds (`11.1d`) or fastIds (`545`). `command` may also be `ON` or `OFF`,
where `dval` is ignored. If `args` are absent the hook falls back to the
`command`/`targets`/`dval` app config options, which is handy for testing from
the settings page.

Targets are resolved against imported points *before* anything is sent, so a
typo, an emergency circuit, or a `DVAL` aimed at a relay aborts the whole
command rather than half-applying it. Targets on the same LCU are batched into
one `RelayControl` call; across LCUs it splits per controller.

Hooks are bound to points by the query in their `hooks-update` JSON — the
runtime injects them as the `points` parameter. There is no API for a hook to
fetch points itself.

---

## Still to do

1. **Writes are not implemented.** Capture an ON/OFF command and a dim-level
   set, then add a `write` hook. Anything that commands the system must honour
   `douglas/writable`, which is `false` on emergency circuits.
2. **Device health.** `LCUListOutlook` returns the LCU list with online/desync
   state — LCU-01 was showing red with a desync marker when this was written.
   Capture its response to add per-LCU health points.
3. **Fault states are not yet modelled.** Relays can report `onOff: "Error"`
   and dimmers `dimmerStatus: "Fault"`; `photoSensorStatus` has a third value,
   `InDeactivatedPhotoMode`. The poll hook currently skips these rather than
   recording them. Worth a per-circuit status point.
4. The GWS is only reachable on `localhost` in the current setup — check what
   IIS is bound to before pointing a gateway at it, and keep it behind the
   Layer 7 firewall Universal Douglas requires.

## Safety

Emergency circuits (`Lobby Em. Lts.`, `Multipurpose Rm. Em.`,
`Flex Classroom Em. L`, `Ramp Em. Lts.`) are detected by description, tagged
`douglas/emergency=true`, and marked non-writable. Do not command life-safety
lighting from an analytics platform.
