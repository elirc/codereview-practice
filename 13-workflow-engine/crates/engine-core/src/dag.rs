//! Workflow definitions: step validation, graph checks and step readiness.

use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::names::{is_kind, is_queue_name, is_step_key};
use crate::state::StepState;

/// Largest number of steps in one definition.
pub const MAX_STEPS: usize = 50;

fn empty_object() -> Value {
    json!({})
}

/// One step of a workflow definition.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StepDef {
    pub key: String,
    pub kind: String,
    pub queue: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default = "empty_object")]
    pub params: Value,
    pub max_attempts: Option<i32>,
    pub lease_seconds: Option<i32>,
    pub priority: Option<i32>,
}

/// One reason a definition is invalid.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Problem {
    pub code: String,
    pub step: Option<String>,
    pub message: String,
}

impl Problem {
    fn new(code: &str, step: Option<&str>, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            step: step.map(str::to_string),
            message: message.into(),
        }
    }
}

fn check_range(
    problems: &mut Vec<Problem>,
    step: &StepDef,
    value: Option<i32>,
    min: i32,
    max: i32,
    field: &str,
) {
    if let Some(v) = value {
        if !(min..=max).contains(&v) {
            problems.push(Problem::new(
                "invalid_limit",
                Some(&step.key),
                format!("{field} must be between {min} and {max}"),
            ));
        }
    }
}

/// Checks a definition's steps and returns every problem found. `known_queues` holds the
/// queues that exist.
pub fn validate_definition(steps: &[StepDef], known_queues: &HashSet<String>) -> Vec<Problem> {
    let mut problems = Vec::new();
    if steps.is_empty() {
        problems.push(Problem::new("no_steps", None, "a workflow needs at least one step"));
    }
    if steps.len() > MAX_STEPS {
        problems.push(Problem::new(
            "too_many_steps",
            None,
            format!("a workflow has at most {MAX_STEPS} steps"),
        ));
    }

    let mut seen: HashSet<&str> = HashSet::new();
    for step in steps {
        if !is_step_key(&step.key) {
            problems.push(Problem::new(
                "invalid_key",
                Some(&step.key),
                "step keys must match [a-z0-9_]{1,40}",
            ));
        }
        if !seen.insert(step.key.as_str()) {
            problems.push(Problem::new(
                "duplicate_key",
                Some(&step.key),
                format!("step key {} is used more than once", step.key),
            ));
        }
        if !is_kind(&step.kind) {
            problems.push(Problem::new(
                "invalid_kind",
                Some(&step.key),
                "kinds must match [a-z0-9_.]{1,64}",
            ));
        }
        if !is_queue_name(&step.queue) || !known_queues.contains(&step.queue) {
            problems.push(Problem::new(
                "unknown_queue",
                Some(&step.key),
                format!("queue {} does not exist", step.queue),
            ));
        }
        check_range(&mut problems, step, step.max_attempts, 1, 50, "max_attempts");
        check_range(&mut problems, step, step.lease_seconds, 5, 3600, "lease_seconds");
        check_range(&mut problems, step, step.priority, 0, 9, "priority");
    }

    let keys: HashSet<&str> = steps.iter().map(|s| s.key.as_str()).collect();
    for step in steps {
        for dep in &step.depends_on {
            if dep == &step.key {
                problems.push(Problem::new(
                    "self_dependency",
                    Some(&step.key),
                    "a step cannot depend on itself",
                ));
            } else if !keys.contains(dep.as_str()) {
                problems.push(Problem::new(
                    "unknown_dependency",
                    Some(&step.key),
                    format!("depends on unknown step {dep}"),
                ));
            }
        }
    }

    let in_cycle = steps_in_cycles(steps);
    if !in_cycle.is_empty() {
        let listed: Vec<&str> = in_cycle.iter().map(String::as_str).collect();
        problems.push(Problem::new(
            "cycle",
            None,
            format!("steps form a cycle: {}", listed.join(", ")),
        ));
    }
    problems
}

/// Returns the keys of steps that lie on or behind a dependency cycle, in sorted order.
/// Self-dependencies and unknown dependencies are ignored here.
fn steps_in_cycles(steps: &[StepDef]) -> BTreeSet<String> {
    let mut indegree: HashMap<&str, usize> = HashMap::new();
    let mut dependents: HashMap<&str, Vec<&str>> = HashMap::new();
    for step in steps {
        indegree.entry(step.key.as_str()).or_insert(0);
    }
    for step in steps {
        let deps: BTreeSet<&str> = step
            .depends_on
            .iter()
            .map(String::as_str)
            .filter(|d| *d != step.key && indegree.contains_key(d))
            .collect();
        for dep in deps {
            *indegree.entry(step.key.as_str()).or_insert(0) += 1;
            dependents.entry(dep).or_default().push(step.key.as_str());
        }
    }
    let mut ready: VecDeque<&str> = indegree
        .iter()
        .filter(|(_, d)| **d == 0)
        .map(|(k, _)| *k)
        .collect();
    while let Some(key) = ready.pop_front() {
        if let Some(children) = dependents.get(key) {
            for child in children {
                if let Some(d) = indegree.get_mut(child) {
                    *d -= 1;
                    if *d == 0 {
                        ready.push_back(*child);
                    }
                }
            }
        }
    }
    indegree
        .into_iter()
        .filter(|(_, d)| *d > 0)
        .map(|(k, _)| k.to_string())
        .collect()
}

/// Returns the steps without dependencies, in definition order.
pub fn roots(steps: &[StepDef]) -> Vec<&StepDef> {
    steps.iter().filter(|s| s.depends_on.is_empty()).collect()
}

/// Returns the `blocked` steps whose dependencies have all succeeded, in definition order.
pub fn ready_steps<'a>(
    steps: &'a [StepDef],
    states: &HashMap<String, StepState>,
) -> Vec<&'a StepDef> {
    steps
        .iter()
        .filter(|s| states.get(&s.key) == Some(&StepState::Blocked))
        .filter(|s| {
            s.depends_on
                .iter()
                .all(|d| states.get(d) == Some(&StepState::Succeeded))
        })
        .collect()
}

/// Builds the payload of a step's job from the run input and the outputs of its parents.
pub fn step_payload(step: &StepDef, input: &Value, outputs: &HashMap<String, Value>) -> Value {
    let parents: serde_json::Map<String, Value> = step
        .depends_on
        .iter()
        .map(|d| (d.clone(), outputs.get(d).cloned().unwrap_or(Value::Null)))
        .collect();
    json!({
        "input": input,
        "params": step.params,
        "parents": Value::Object(parents),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(key: &str, deps: &[&str]) -> StepDef {
        StepDef {
            key: key.to_string(),
            kind: "noop".to_string(),
            queue: "q".to_string(),
            depends_on: deps.iter().map(|d| d.to_string()).collect(),
            params: json!({}),
            max_attempts: None,
            lease_seconds: None,
            priority: None,
        }
    }

    fn queues() -> HashSet<String> {
        ["q".to_string()].into_iter().collect()
    }

    fn codes(problems: &[Problem]) -> Vec<&str> {
        problems.iter().map(|p| p.code.as_str()).collect()
    }

    #[test]
    fn a_diamond_is_valid() {
        let steps = vec![
            step("a", &[]),
            step("b", &["a"]),
            step("c", &["a"]),
            step("d", &["b", "c"]),
        ];
        assert!(validate_definition(&steps, &queues()).is_empty());
    }

    #[test]
    fn empty_and_oversized_definitions() {
        assert_eq!(codes(&validate_definition(&[], &queues())), vec!["no_steps"]);
        let many: Vec<StepDef> = (0..51).map(|i| step(&format!("s{i}"), &[])).collect();
        assert_eq!(
            codes(&validate_definition(&many, &queues())),
            vec!["too_many_steps"]
        );
    }

    #[test]
    fn every_problem_is_reported() {
        let mut bad_queue = step("e", &[]);
        bad_queue.queue = "nowhere".to_string();
        let mut bad_limits = step("f", &[]);
        bad_limits.max_attempts = Some(0);
        bad_limits.priority = Some(10);
        let mut bad_kind = step("g", &[]);
        bad_kind.kind = "Bad-Kind".to_string();
        let steps = vec![
            step("a", &["b"]),
            step("b", &["a"]),
            step("a", &[]),
            step("c", &["missing"]),
            step("d", &["d"]),
            bad_queue,
            bad_limits,
            bad_kind,
            step("Bad Key", &[]),
        ];
        let problems = validate_definition(&steps, &queues());
        let found = codes(&problems);
        for expected in [
            "duplicate_key",
            "unknown_dependency",
            "self_dependency",
            "cycle",
            "unknown_queue",
            "invalid_limit",
            "invalid_kind",
            "invalid_key",
        ] {
            assert!(found.contains(&expected), "missing {expected} in {found:?}");
        }
        assert_eq!(found.iter().filter(|c| **c == "invalid_limit").count(), 2);
    }

    #[test]
    fn cycles_name_the_steps_involved() {
        let steps = vec![
            step("a", &[]),
            step("b", &["a", "d"]),
            step("c", &["b"]),
            step("d", &["c"]),
        ];
        let problems = validate_definition(&steps, &queues());
        assert_eq!(codes(&problems), vec!["cycle"]);
        assert!(problems[0].message.ends_with("b, c, d"));
    }

    #[test]
    fn readiness_of_a_diamond() {
        let steps = vec![
            step("a", &[]),
            step("b", &["a"]),
            step("c", &["a"]),
            step("d", &["b", "c"]),
        ];
        assert_eq!(
            roots(&steps).iter().map(|s| s.key.as_str()).collect::<Vec<_>>(),
            vec!["a"]
        );
        let mut states: HashMap<String, StepState> = [
            ("a", StepState::Succeeded),
            ("b", StepState::Blocked),
            ("c", StepState::Blocked),
            ("d", StepState::Blocked),
        ]
        .into_iter()
        .map(|(k, s)| (k.to_string(), s))
        .collect();
        let ready: Vec<&str> = ready_steps(&steps, &states)
            .iter()
            .map(|s| s.key.as_str())
            .collect();
        assert_eq!(ready, vec!["b", "c"]);

        states.insert("b".to_string(), StepState::Succeeded);
        states.insert("c".to_string(), StepState::Queued);
        assert!(ready_steps(&steps, &states).is_empty());
        states.insert("c".to_string(), StepState::Succeeded);
        let ready: Vec<&str> = ready_steps(&steps, &states)
            .iter()
            .map(|s| s.key.as_str())
            .collect();
        assert_eq!(ready, vec!["d"]);
    }

    #[test]
    fn readiness_of_a_chain_and_of_all_roots() {
        let chain = vec![step("a", &[]), step("b", &["a"]), step("c", &["b"])];
        let states: HashMap<String, StepState> = [
            ("a", StepState::Succeeded),
            ("b", StepState::Blocked),
            ("c", StepState::Blocked),
        ]
        .into_iter()
        .map(|(k, s)| (k.to_string(), s))
        .collect();
        let ready: Vec<&str> = ready_steps(&chain, &states)
            .iter()
            .map(|s| s.key.as_str())
            .collect();
        assert_eq!(ready, vec!["b"]);

        let flat = vec![step("x", &[]), step("y", &[]), step("z", &[])];
        assert_eq!(roots(&flat).len(), 3);
    }

    #[test]
    fn payload_carries_input_params_and_parent_outputs() {
        let mut d = step("d", &["b", "c"]);
        d.params = json!({ "mode": "merge" });
        let outputs: HashMap<String, Value> = [
            ("b".to_string(), json!(1)),
            ("c".to_string(), json!({ "x": 2 })),
        ]
        .into_iter()
        .collect();
        let payload = step_payload(&d, &json!({ "order": 7 }), &outputs);
        assert_eq!(
            payload,
            json!({
                "input": { "order": 7 },
                "params": { "mode": "merge" },
                "parents": { "b": 1, "c": { "x": 2 } },
            })
        );
    }

    #[test]
    fn step_definitions_reject_unknown_fields() {
        let parsed: Result<StepDef, _> = serde_json::from_value(json!({
            "key": "a", "kind": "noop", "queue": "q", "retries": 3
        }));
        assert!(parsed.is_err());
        let parsed: StepDef =
            serde_json::from_value(json!({ "key": "a", "kind": "noop", "queue": "q" })).unwrap();
        assert!(parsed.depends_on.is_empty());
        assert_eq!(parsed.params, json!({}));
    }
}
