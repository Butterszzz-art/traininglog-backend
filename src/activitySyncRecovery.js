// Daily resting heart rate and heart rate variability from the Google Health
// API (data types daily-resting-heart-rate and daily-heart-rate-variability,
// scope googlehealth.health_metrics_and_measurements.readonly). Field names
// follow Google's v4 reference: DailyRestingHeartRate.beatsPerMinute (int64,
// sent as a string) and DailyHeartRateVariability.averageHeartRateVariabilityMilliseconds.

const HEALTH_METRICS_SCOPE = 'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly';

const RECOVERY_TYPES = [
  {
    dataType: 'daily-resting-heart-rate',
    // Google's data-types table names the filter field in snake_case; the
    // list reference's example uses camelCase. Try both.
    filterNames: ['daily_resting_heart_rate', 'dailyRestingHeartRate'],
    unionKey: 'dailyRestingHeartRate',
    read: (v) => ({ restingHeartRate: toPositive(v?.beatsPerMinute) })
  },
  {
    dataType: 'daily-heart-rate-variability',
    filterNames: ['daily_heart_rate_variability', 'dailyHeartRateVariability'],
    unionKey: 'dailyHeartRateVariability',
    read: (v) => ({ hrvMs: toPositive(v?.averageHeartRateVariabilityMilliseconds, 1) })
  }
];

function toPositive(value, decimals = 0) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function dateKey(d) {
  if (!d?.year || !d?.month || !d?.day) return null;
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

// Google filter for daily summaries on local dates start..endInclusive.
function recoveryFilter(filterName, start, endExclusive) {
  return `${filterName}.date >= "${start}" AND ${filterName}.date < "${endExclusive}"`;
}

// Merges list responses for both data types into one row per date:
// { date, restingHeartRate, hrvMs } (either value may be null).
function mergeRecoveryPoints(pointsByType) {
  const byDate = {};
  RECOVERY_TYPES.forEach((type) => {
    (pointsByType[type.dataType] || []).forEach((point) => {
      const value = point?.[type.unionKey];
      const date = dateKey(value?.date);
      if (!date) return;
      const row = byDate[date] || (byDate[date] = { date, restingHeartRate: null, hrvMs: null });
      Object.entries(type.read(value)).forEach(([k, v]) => { if (v != null) row[k] = v; });
    });
  });
  return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
}

function hasHealthMetricsScope(scopeString) {
  return String(scopeString || '').split(/\s+/).includes(HEALTH_METRICS_SCOPE);
}

module.exports = {
  HEALTH_METRICS_SCOPE,
  RECOVERY_TYPES,
  recoveryFilter,
  mergeRecoveryPoints,
  hasHealthMetricsScope
};
