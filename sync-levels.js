const NormalSdk = require("@normalframework/applications-sdk");
const { getClient, lcuLabel } = require("./gws");

/**
 * Makes each Douglas dimmer settable from Normal.
 *
 * NF cannot write to the hpl:douglas layer directly — there is no native write
 * path for a driver-defined layer, so `point.write()` on a Douglas point would
 * go nowhere. Instead each dimmer gets a hook *variable* (a point in the
 * `automation` layer, which is writable), and this hook pushes changes in that
 * variable down to the lighting system as a RelayControl DVAL.
 *
 * That makes the variable the real setpoint: NF Schedules can target it, it can
 * be exposed over BACnet, and it can be written from the UI or the command API.
 *
 * Hook configuration (see hooks-update/sync-levels.json):
 *   - bound to hpl:douglas points, grouped by douglas/outputId, so each group
 *     is a single dimmer with its own setpoint variable
 *   - MODE_ON_DATA, so a write to the variable invokes the hook immediately
 *   - group variable `levelSetpoint`, default -1 meaning "no command"
 *
 * By default a level is sent only when the setpoint itself changes, which
 * leaves the Douglas system's own schedules, presets and photocells free to
 * move the circuit afterwards. Set the `maintain` option to instead re-assert
 * the setpoint whenever the actual level drifts away from it — note that this
 * will fight local control, and should not be enabled without deciding that
 * Normal is the authority for these circuits.
 *
 * @param {NormalSdk.InvokeParams} params
 * @returns {NormalSdk.InvokeResult}
 */
module.exports = async ({ points, groupVariables, sdk, config }) => {
  if (!config.baseUrl) {
    return NormalSdk.InvokeError("missing baseUrl");
  }
  if (!config.token && !config.password) {
    return NormalSdk.InvokeError("set either a password or an existing token");
  }

  // One dimmer per group. Relays and photocell points are filtered out here
  // rather than in the binding query, so the layer query stays simple.
  const dimmer = points
    .where((p) => p.attrs && p.attrs["douglas/outputType"] === "dimmer")
    .first();
  if (!dimmer) return;

  if (dimmer.attrs["douglas/writable"] === "false") {
    // Emergency circuits are imported read-only and never commanded.
    return;
  }

  const setpoint = groupVariables.byLabel("levelSetpoint");
  if (!setpoint) {
    sdk.logEvent(`[douglas] ${dimmer.name}: no levelSetpoint variable`);
    return;
  }

  const target = await readValue(setpoint);
  // -1 is the "unset" sentinel written when the variable is created, so a
  // fresh install doesn't command every dimmer to 0.
  if (target === null || target < 0) return;
  if (target > 100) {
    sdk.logEvent(`[douglas] ${dimmer.name}: setpoint ${target} out of range`);
    return;
  }

  const level = Math.round(target);
  const actual = await readValue(dimmer);
  const maintain = String(config.maintain || "").toLowerCase() === "true";

  if (maintain) {
    // Re-assert whenever the real level has drifted off the setpoint.
    const deadband = parseFloat(config.deadband) || 1;
    if (actual !== null && Math.abs(actual - level) <= deadband) return;
  } else {
    // Only act when the setpoint itself moved. isChanged() may be absent on
    // older SDK versions, in which case fall back to comparing against actual.
    const changed =
      typeof setpoint.isChanged === "function"
        ? setpoint.isChanged()
        : actual === null || actual !== level;
    if (!changed) return;
  }

  const lcuNum = parseInt(dimmer.attrs["douglas/lcuNum"], 10);
  const fastId = dimmer.attrs["douglas/fastId"];
  const gws = getClient(config, sdk.logEvent);

  try {
    await gws.ensureSession();
    await gws.relayControl(lcuNum, "DVAL", [fastId], level);
    sdk.logEvent(
      `[douglas] ${lcuLabel(lcuNum)} ${dimmer.attrs["douglas/outputId"]} ` +
        `(${dimmer.name}): ${actual === null ? "?" : actual}% -> ${level}%`
    );
  } catch (err) {
    return NormalSdk.InvokeError(`${dimmer.name}: ${err.message}`);
  }
};

/**
 * Read a numeric value from a point or variable. Prefers the cached
 * latestValue and falls back to a command read.
 */
async function readValue(point) {
  const cached = point.latestValue && point.latestValue.value;
  const fromCache = coerce(cached);
  if (fromCache !== null) return fromCache;

  if (typeof point.read !== "function") return null;
  try {
    const [value] = await point.read();
    return coerce(value && (value.value !== undefined ? value.value : value));
  } catch (e) {
    return null;
  }
}

function coerce(v) {
  if (v === undefined || v === null) return null;
  // Values may arrive as a scalar or wrapped as {real: n}
  const n = typeof v === "object" ? v.real : v;
  const f = parseFloat(n);
  return isNaN(f) ? null : f;
}
