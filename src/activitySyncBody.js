// Body analysis data from the Google Health API: daily vitals and smart-scale
// weigh-ins. Field names follow Google's v4 reference (users.dataTypes.dataPoints):
//   DailyRestingHeartRate.beatsPerMinute (int64 → string)
//   DailyHeartRateVariability.averageHeartRateVariabilityMilliseconds
//   DailyOxygenSaturation.averagePercentage
//   DailyRespiratoryRate.breathsPerMinute
//   DailySleepTemperatureDerivations.nightlyTemperatureCelsius / baselineTemperatureCelsius
//   DailyVO2Max.vo2Max
//   Weight.weightGrams, BodyFat.percentage (both with sampleTime)
// Scopes: health_metrics_and_measurements.readonly (all but VO2 max) and
// activity_and_fitness.readonly (VO2 max), both already requested on connect.

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals) {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function positive(value, decimals = 0) {
  const n = toNumber(value);
  return n != null && n > 0 ? round(n, decimals) : null;
}

function dateKey(d) {
  if (!d?.year || !d?.month || !d?.day) return null;
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

// The union value inside a DataPoint: try the expected field names, then the
// first object that carries a date/sampleTime (guards against naming drift).
function unionValue(point, keys) {
  for (const k of keys) if (point?.[k] && typeof point[k] === 'object') return point[k];
  return Object.values(point || {}).find(
    (v) => v && typeof v === 'object' && (v.date || v.sampleTime)
  ) || null;
}

// Google's data-types table gives snake_case filter names; the list reference
// shows camelCase in one example. Callers try them in order.
const DAILY_VITALS = [
  {
    dataType: 'daily-resting-heart-rate',
    filterNames: ['daily_resting_heart_rate', 'dailyRestingHeartRate'],
    unionKeys: ['dailyRestingHeartRate'],
    read: (v) => ({ restingHeartRate: positive(v.beatsPerMinute) })
  },
  {
    dataType: 'daily-heart-rate-variability',
    filterNames: ['daily_heart_rate_variability', 'dailyHeartRateVariability'],
    unionKeys: ['dailyHeartRateVariability'],
    read: (v) => ({ hrvMs: positive(v.averageHeartRateVariabilityMilliseconds, 1) })
  },
  {
    dataType: 'daily-oxygen-saturation',
    filterNames: ['daily_oxygen_saturation', 'dailyOxygenSaturation'],
    unionKeys: ['dailyOxygenSaturation'],
    read: (v) => ({ spo2: positive(v.averagePercentage, 1) })
  },
  {
    dataType: 'daily-respiratory-rate',
    filterNames: ['daily_respiratory_rate', 'dailyRespiratoryRate'],
    unionKeys: ['dailyRespiratoryRate'],
    read: (v) => ({ respiratoryRate: positive(v.breathsPerMinute, 1) })
  },
  {
    dataType: 'daily-sleep-temperature-derivations',
    filterNames: ['daily_sleep_temperature_derivations', 'dailySleepTemperatureDerivations'],
    unionKeys: ['dailySleepTemperatureDerivations'],
    // Change from the user's own baseline (°C); can be negative.
    read: (v) => {
      const nightly = toNumber(v.nightlyTemperatureCelsius);
      const baseline = toNumber(v.baselineTemperatureCelsius);
      return { skinTempDelta: nightly != null && baseline != null ? round(nightly - baseline, 2) : null };
    }
  },
  {
    dataType: 'daily-vo2-max',
    filterNames: ['daily_vo2_max', 'dailyVo2Max'],
    unionKeys: ['dailyVo2Max', 'dailyVO2Max'],
    read: (v) => ({ vo2Max: positive(v.vo2Max, 1) })
  }
];

const SCALE_SAMPLES = [
  {
    dataType: 'weight',
    filterNames: ['weight'],
    unionKeys: ['weight'],
    read: (v) => ({ weightKg: positive(toNumber(v.weightGrams) / 1000, 2) })
  },
  {
    dataType: 'body-fat',
    filterNames: ['body_fat', 'bodyFat'],
    unionKeys: ['bodyFat'],
    read: (v) => ({ bodyFatPercent: positive(v.percentage, 1) })
  }
];

function dailyFilter(filterName, start, endExclusive) {
  return `${filterName}.date >= "${start}" AND ${filterName}.date < "${endExclusive}"`;
}

function sampleFilter(filterName, start, endExclusive) {
  return `${filterName}.sample_time.civil_time >= "${start}" AND ${filterName}.sample_time.civil_time < "${endExclusive}"`;
}

// { [dataType]: DataPoint[] } → [{ date, restingHeartRate, hrvMs, spo2,
// respiratoryRate, skinTempDelta, vo2Max }] sorted by date (nulls when missing).
function mergeDailyVitals(pointsByType) {
  const byDate = {};
  DAILY_VITALS.forEach((type) => {
    (pointsByType[type.dataType] || []).forEach((point) => {
      const value = unionValue(point, type.unionKeys);
      const date = dateKey(value?.date);
      if (!date) return;
      const row = byDate[date] || (byDate[date] = {
        date, restingHeartRate: null, hrvMs: null, spo2: null,
        respiratoryRate: null, skinTempDelta: null, vo2Max: null
      });
      Object.entries(type.read(value)).forEach(([k, v]) => { if (v != null) row[k] = v; });
    });
  });
  return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
}

function sampleDateAndTime(sampleTime) {
  const civil = sampleTime?.civilTime;
  const date = dateKey(civil?.date)
    || (typeof sampleTime?.physicalTime === 'string' ? sampleTime.physicalTime.slice(0, 10) : null);
  return { date, time: sampleTime?.physicalTime || '' };
}

// Weight + body-fat samples → one weigh-in per local date, using the day's
// first reading of each (morning weigh-ins are the most consistent):
// [{ date, weightKg, bodyFatPercent }].
function mergeWeighIns(pointsByType) {
  const byDate = {};
  SCALE_SAMPLES.forEach((type) => {
    (pointsByType[type.dataType] || []).forEach((point) => {
      const value = unionValue(point, type.unionKeys);
      const { date, time } = sampleDateAndTime(value?.sampleTime);
      if (!date) return;
      const row = byDate[date] || (byDate[date] = { date, weightKg: null, bodyFatPercent: null, _t: {} });
      Object.entries(type.read(value)).forEach(([k, v]) => {
        if (v == null) return;
        if (row[k] == null || time < row._t[k]) {
          row[k] = v;
          row._t[k] = time;
        }
      });
    });
  });
  return Object.values(byDate)
    .map(({ _t, ...row }) => row)
    .sort((a, b) => a.date.localeCompare(b.date));
}

module.exports = {
  DAILY_VITALS,
  SCALE_SAMPLES,
  dailyFilter,
  sampleFilter,
  mergeDailyVitals,
  mergeWeighIns
};
