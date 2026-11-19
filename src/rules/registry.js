// Rule registry: loads rules/*.json, validates every rule, and resolves a
// rule's value for a context (e.g. { goal: 'vetverlies' }).
//
// Every number the plan generator produces is stamped with the rule that
// produced it ({ ruleId, ruleVersion, verified }) and the registry version,
// so a plan can always be traced back to the evidence (Butters University)
// and to the exact rule text at the time it was generated.
'use strict';

const fs = require('fs');
const path = require('path');
const { validateBu, summarize } = require('./butters');

const RULES_DIR = path.join(__dirname, '..', '..', 'rules');
const DOMAINS = new Set(['nutrition', 'training', 'recovery', 'safety', 'package', 'coaching']);
const ID_RE = /^[a-z]+(\.[a-z0-9_]+)+$/;

function validateRule(rule) {
  const errors = [];
  const where = rule && rule.id ? rule.id : JSON.stringify(rule).slice(0, 60);
  if (!rule || typeof rule !== 'object') return [`not an object: ${where}`];
  if (typeof rule.id !== 'string' || !ID_RE.test(rule.id)) errors.push(`${where}: id must look like "domain.name"`);
  if (!Number.isInteger(rule.version) || rule.version < 1) errors.push(`${where}: version must be a positive integer`);
  if (!DOMAINS.has(rule.domain)) errors.push(`${where}: unknown domain "${rule.domain}"`);
  if (typeof rule.statement !== 'string' || !rule.statement.trim()) errors.push(`${where}: statement is required`);
  if (!rule.params || typeof rule.params !== 'object') errors.push(`${where}: params must be an object`);
  if (typeof rule.evidenceGrade !== 'string') errors.push(`${where}: evidenceGrade is required (use "unrated" until graded)`);
  if (!Array.isArray(rule.sources)) errors.push(`${where}: sources must be an array`);
  if (typeof rule.verified !== 'boolean') errors.push(`${where}: verified must be true or false`);
  const p = rule.params || {};
  if (['min', 'default', 'max'].every(k => typeof p[k] === 'number') && !(p.min <= p.default && p.default <= p.max)) {
    errors.push(`${where}: params need min <= default <= max`);
  }
  if (rule.role !== undefined && rule.role !== 'comparison') errors.push(`${where}: role must be "comparison" when set`);
  if (p.conditions !== undefined && !Array.isArray(p.conditions)) errors.push(`${where}: params.conditions must be an array`);
  errors.push(...validateBu(rule));
  return errors;
}

function loadRegistry(dir = RULES_DIR) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'), 'utf8'));
  const rules = new Map();
  const errors = [];
  for (const file of meta.files) {
    const list = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    for (const rule of list) {
      errors.push(...validateRule(rule).map(e => `${file}: ${e}`));
      if (rules.has(rule.id)) errors.push(`${file}: duplicate rule id ${rule.id}`);
      rules.set(rule.id, rule);
    }
  }
  if (errors.length) throw new Error(`Invalid rule registry:\n${errors.join('\n')}`);
  return { version: meta.version, butters: meta.buttersUniversity || null, rules };
}

function matches(when, context) {
  return Object.entries(when || {}).every(([k, v]) => context[k] === v);
}

function createRegistry(loaded = loadRegistry()) {
  const { version, butters = null, rules } = loaded;

  function get(id) {
    const rule = rules.get(id);
    if (!rule) throw new Error(`Unknown rule: ${id}`);
    return rule;
  }

  // The params that apply in this context: the first matching condition's
  // fields layered over the rule's own params.
  function params(id, context = {}) {
    const rule = get(id);
    const { conditions, ...base } = rule.params;
    const hit = (conditions || []).find(c => matches(c.when, context));
    if (!hit) return base;
    const { when, ...override } = hit;
    return { ...base, ...override };
  }

  // Provenance stamp for a value taken from a rule.
  function cite(id, value) {
    const rule = get(id);
    return { value, ruleId: rule.id, ruleVersion: rule.version, verified: rule.verified };
  }

  // { value, ruleId, ruleVersion, verified } for rules with a `default`.
  function resolve(id, context = {}) {
    const p = params(id, context);
    if (p.default === undefined) throw new Error(`Rule ${id} has no default to resolve`);
    return cite(id, p.default);
  }

  // Where the rules stand against Butters University: the pinned BU source
  // plus rule ids grouped by status (match, partial, conflict, ...).
  function buttersSummary() {
    return { source: butters, ...summarize([...rules.values()]) };
  }

  return { version, butters, get, params, resolve, cite, buttersSummary, all: () => [...rules.values()] };
}

module.exports = { loadRegistry, createRegistry, validateRule, RULES_DIR };
