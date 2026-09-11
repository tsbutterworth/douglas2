const NormalSdk = require("@normalframework/applications-sdk");
const { GwsClient, lcuLabel } = require("./gws");

const LAYER = "hpl:douglas";

/**
 * Send a command to Douglas outputs.
 *
 * Invoked manually with three config options:
 *
 *   command  ON | OFF | DVAL
 *   targets  comma-separated outputIds ("18.1r,11.2r") or fastIds ("73,46")
 *   dval     0-100, required when command is DVAL
 *
 * Targets are resolved against imported points, which is what makes the
 * emergency guard possible — a raw fastId that doesn't match a known point is
 * rejected rather than passed through blind.
 *
 * Commands are batched: all targets on one LCU go out in a single
 * RelayControl call, the same way the web UI sends a multi-row selection.
 *
 * @param {NormalSdk.InvokeParams} params
 * @returns {NormalSdk.InvokeResult}
 */
module.exports = async ({ points, sdk, config, args }) => {
  if (!config.baseUrl) {
    return NormalSdk.InvokeError("missing baseUrl");
  }
  if (!config.token && !config.password) {
    return NormalSdk.InvokeError("set either a password or an existing token");
  }

  // Invoke-time args win over static config, so a caller can send a level
  // without editing the application configuration. Falling back to config
  // keeps the hook usable straight from the app settings page.
  const a = args || {};
  const command = String(a.command || config.command || "").toUpperCase();
  if (!["ON", "OFF", "DVAL"].includes(command)) {
    return NormalSdk.InvokeError("command must be ON, OFF or DVAL");
  }

  let dval = "";
  if (command === "DVAL") {
    dval = parseInt(a.dval !== undefined ? a.dval : config.dval, 10);
    if (isNaN(dval) || dval < 0 || dval > 100) {
      return NormalSdk.InvokeError("DVAL requires dval between 0 and 100");
    }
  }

  const rawTargets = a.targets !== undefined ? a.targets : config.targets;
  const targets = (Array.isArray(rawTargets) ? rawTargets.join(",") : String(rawTargets || ""))
    .split(/[,\s]+/)
    .filter(Boolean);
  if (targets.length === 0) {
    return NormalSdk.InvokeError("no targets given");
  }

  // `points` is injected, bound by the query in hooks-update/write-outputs.json
  if (!points || points.length === 0) {
    return NormalSdk.InvokeError("no points bound, run import-points first");
  }

  const byOutputId = {};
  const byFastId = {};
  for (const p of points) {
    if (p.point_type === "DEVICE") continue;
    const a = p.attrs || {};
    if (a["douglas/outputType"] === "photoSensor") continue;
    if (a["douglas/outputId"]) byOutputId[a["douglas/outputId"]] = p;
    if (a["douglas/fastId"]) byFastId[a["douglas/fastId"]] = p;
  }

  // Resolve every target before sending anything, so a bad or blocked target
  // aborts the whole command rather than half-applying it.
  const resolved = [];
  const problems = [];

  for (const t of targets) {
    const point = byOutputId[t] || byFastId[t];
    if (!point) {
      problems.push(`${t}: no imported point matches`);
      continue;
    }
    const a = point.attrs;
    if (a["douglas/writable"] === "false") {
      problems.push(`${t}: ${point.name} is not writable (emergency circuit)`);
      continue;
    }
    const isDimmer = a["douglas/outputType"] === "dimmer";
    if (command === "DVAL" && !isDimmer) {
      problems.push(`${t}: ${point.name} is a relay, DVAL does not apply`);
      continue;
    }
    if (command !== "DVAL" && isDimmer) {
      problems.push(`${t}: ${point.name} is a dimmer, use DVAL`);
      continue;
    }
    resolved.push(point);
  }

  if (problems.length > 0) {
    for (const p of problems) sdk.logEvent(`[douglas] refused - ${p}`);
    return NormalSdk.InvokeError(
      `${problems.length} target(s) rejected, no command sent`
    );
  }

  const gws = new GwsClient(config, sdk.logEvent);
  try {
    await gws.ensureSession();
  } catch (err) {
    return NormalSdk.InvokeError(`login failed: ${err.message}`);
  }

  // One RelayControl call per LCU.
  const byLcu = {};
  for (const p of resolved) {
    const lcu = p.attrs["douglas/lcuNum"];
    byLcu[lcu] = byLcu[lcu] || [];
    byLcu[lcu].push(p);
  }

  let sent = 0;
  for (const [lcu, group] of Object.entries(byLcu)) {
    const fastIds = group.map((p) => p.attrs["douglas/fastId"]);
    const names = group.map((p) => p.attrs["douglas/outputId"]).join(", ");
    try {
      await gws.relayControl(parseInt(lcu, 10), command, fastIds, dval);
      sent += fastIds.length;
      sdk.logEvent(
        `[douglas] ${lcuLabel(lcu)}: ${command}${
          command === "DVAL" ? " " + dval : ""
        } -> ${names}`
      );
    } catch (err) {
      sdk.logEvent(`[douglas] ${lcuLabel(lcu)}: command failed - ${err.message}`);
    }
  }

  sdk.logEvent(`[douglas] commanded ${sent}/${resolved.length} output(s)`);
};
