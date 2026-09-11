const NormalSdk = require("@normalframework/applications-sdk");
const { GwsClient, parseLcuNums } = require("./gws");

const LAYER = "hpl:douglas";

/**
 * One LoadPartialOutputs call per LCU per cycle, fanned out to points by
 * fastId. Gentle on the GWS, which is a locked-down Server 2016 appliance.
 *
 * @param {NormalSdk.InvokeParams} params
 * @returns {NormalSdk.InvokeResult}
 */
module.exports = async ({ points, sdk, config }) => {
  if (!config.baseUrl) {
    return NormalSdk.InvokeError("missing baseUrl");
  }
  if (!config.token && !config.password) {
    return NormalSdk.InvokeError("set either a password or an existing token");
  }

  const gws = new GwsClient(config, sdk.logEvent, sdk);
  try {
    await gws.ensureSession();
  } catch (err) {
    return NormalSdk.InvokeError(`login failed: ${err.message}`);
  }
  // `points` is injected by the runtime, bound by the query in
  // hooks-update/poll-values.json.
  if (!points || points.length === 0) {
    sdk.logEvent("[douglas] no points registered, run import-points first");
    return;
  }

  // Group by LCU, index by fastId. Photocell points share a fastId with their
  // circuit, so each bucket is a list.
  const byLcu = {};
  for (const p of points) {
    if (p.point_type === "DEVICE") continue;
    const lcu = p.attrs && p.attrs["douglas/lcuNum"];
    const fastId = p.attrs && p.attrs["douglas/fastId"];
    if (!lcu || !fastId) continue;
    byLcu[lcu] = byLcu[lcu] || {};
    byLcu[lcu][fastId] = byLcu[lcu][fastId] || [];
    byLcu[lcu][fastId].push(p);
  }

  // Poll any LCU that has points, plus anything explicitly configured.
  const lcuNums = new Set([
    ...Object.keys(byLcu).map(Number),
    ...parseLcuNums(config.lcuNums),
  ]);

  const ts = new Date().toISOString();
  let updates = 0;

  for (const lcuNum of lcuNums) {
    const index = byLcu[String(lcuNum)];
    if (!index) continue;

    let rows;
    try {
      rows = await gws.loadPartialOutputs(lcuNum);
    } catch (err) {
      sdk.logEvent(`[douglas] LCU ${lcuNum}: poll failed - ${err.message}`);
      continue;
    }

    for (const row of rows) {
      const matches = index[String(row.fastId)];
      if (!matches) continue;

      for (const point of matches) {
        const type = point.attrs["douglas/outputType"];
        let value;

        if (type === "dimmer") {
          if (row.DVAL === undefined) continue;
          value = parseFloat(row.DVAL);
        } else if (type === "photoSensor") {
          if (!row.photoSensorStatus) continue;
          // 1 when the photocell is actively holding the circuit
          value = row.photoSensorStatus === "InActivatedPhotoMode" ? 1 : 0;
        } else {
          // relay. "Unknown" means the LCU could not reach the panel, so
          // write nothing rather than guessing Off.
          if (row.onOff === "On") value = 1;
          else if (row.onOff === "Off") value = 0;
          else continue;
        }

        if (isNaN(value)) continue;

        try {
          const res = await fetch(
            `http://${process.env.NFURL}/api/v1/point/data`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                uuid: point.uuid,
                layer: LAYER,
                values: [{ ts, real: value }],
              }),
            }
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          updates++;
        } catch (err) {
          sdk.logEvent(`[douglas] write failed for ${point.name}: ${err.message}`);
        }
      }
    }
  }

  sdk.logEvent(`[douglas] polled ${updates} values across ${lcuNums.size} LCU(s)`);
};
