//! OpenCode agent/model discovery, validation, and bundled-agent ownership.

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    env, fs,
    io::{self, BufRead, IsTerminal, Write},
    path::{Path, PathBuf},
};

use crate::model::ExecutionMode;
use crate::{picker, process::opencode_text_in};

/// Effective babysitter model. An override is only meaningful when the
/// optional babysitter session will be created; attempts without one keep no
/// babysitter model at all.
pub(crate) fn resolve_babysitter_model(babysitter: bool, configured: Option<String>) -> String {
    if !babysitter {
        return String::new();
    }
    configured
        .filter(|model| !model.is_empty())
        .unwrap_or_else(|| BABYSITTER_MODEL.to_owned())
}
/// Effective worktree coordinator model. Only worktree-mode dispatches create
/// an orchestrator; every other topology keeps the worker as its root session.
pub(crate) fn resolve_orchestrator_model(
    mode: ExecutionMode,
    configured: Option<String>,
) -> String {
    if mode != ExecutionMode::Worktrees {
        return String::new();
    }
    configured
        .filter(|model| !model.is_empty())
        .unwrap_or_else(|| ORCHESTRATOR_MODEL.to_owned())
}
pub(crate) fn model_ref(model: Option<&str>) -> Result<Value> {
    let Some(model) = model.filter(|model| !model.is_empty()) else {
        return Ok(Value::Null);
    };
    let (provider_id, model) = model
        .split_once('/')
        .context("--model must use provider/model form")?;
    if provider_id.is_empty() || model.is_empty() || model.contains('/') {
        bail!("--model must use provider/model form");
    }
    let (id, variant) = match model.split_once('#') {
        Some((id, variant)) if !id.is_empty() && !variant.is_empty() => (id, Some(variant)),
        Some(_) => bail!("--model variant must follow model as provider/model#variant"),
        None => (model, None),
    };
    let mut value = json!({"providerID": provider_id, "id": id});
    if let Some(variant) = variant {
        value["variant"] = Value::String(variant.to_owned());
    }
    Ok(value)
}
pub(crate) const BABYSITTER_AGENT: &str = include_str!("../agents/babysitter.md");
pub(crate) const ORCHESTRATOR_AGENT: &str = include_str!("../agents/orchestrator.md");
pub(crate) const BABYSITTER_AGENT_ID: &str = "aven-babysitter";
pub(crate) const ORCHESTRATOR_AGENT_ID: &str = "aven-orchestrator";
pub(crate) const BABYSITTER_MODEL: &str = "github-copilot/gpt-6-luna";
pub(crate) const ORCHESTRATOR_MODEL: &str = "github-copilot/gpt-6-luna";
const MODEL_CHOICES: &[(&str, &str)] = &[
    ("Latest Sol", "github-copilot/gpt-6.1-sol"),
    ("Latest Terra", "github-copilot/gpt-6.1-terra"),
    ("Latest GPT", "github-copilot/gpt-5.5"),
    ("GPT Astra", "github-copilot/gpt-6-astra"),
    ("GPT Luna", "github-copilot/gpt-6-luna"),
    ("Claude Opus", "github-copilot/claude-opus-5.5"),
    ("Claude Sonnet", "github-copilot/claude-sonnet-5.5"),
    ("Claude Haiku", "github-copilot/claude-haiku-5.5"),
];

#[derive(Debug, Clone)]
pub(crate) struct PrimaryAgent {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) model: Option<String>,
}
pub(crate) fn is_legacy_dispatcher_agent(agent_id: &str) -> bool {
    // The `aven-*` profiles are installed globally and must stay visible so an
    // attached OpenCode TUI adopts the session agent instead of falling back to
    // `build`, which would switch the session on the next prompt. They remain
    // dispatcher-owned, so they are still excluded from the agent picker.
    matches!(
        agent_id,
        "babysitter" | "orchestrator" | BABYSITTER_AGENT_ID | ORCHESTRATOR_AGENT_ID
    )
}

fn global_opencode_agents_dir() -> Result<PathBuf> {
    let config_dir = env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        .context("cannot resolve XDG_CONFIG_HOME or HOME for global OpenCode agents")?;
    Ok(config_dir.join("opencode/agents"))
}
/// Older bundled profiles marked the dispatcher agents `hidden: true`. OpenCode's
/// TUI cannot adopt a hidden session agent, so an attached terminal falls back
/// to `build` and switches the session on the next prompt. Recognize that exact
/// prior bundled form so upgrades replace it; any genuine edit still blocks.
fn is_previous_bundled_agent(existing: &str, bundled: &str) -> bool {
    existing.replace("hidden: true\n", "") == bundled
}
pub(crate) fn install_agent_definition(
    directory: &Path,
    agent_id: &str,
    contents: &str,
) -> Result<PathBuf> {
    let destination = directory.join(format!("{agent_id}.md"));
    if destination.exists() {
        let existing = fs::read_to_string(&destination)?;
        if existing != contents {
            if !is_previous_bundled_agent(&existing, contents) {
                bail!(
                    "global OpenCode agent {} already exists with different contents; refusing to overwrite user configuration",
                    destination.display()
                );
            }
            fs::write(&destination, contents).with_context(|| {
                format!("upgrade bundled OpenCode agent {}", destination.display())
            })?;
        }
        return Ok(destination);
    }
    fs::create_dir_all(directory).with_context(|| {
        format!(
            "create global OpenCode agent directory {}",
            directory.display()
        )
    })?;
    fs::write(&destination, contents)
        .with_context(|| format!("write bundled OpenCode agent {}", destination.display()))?;
    Ok(destination)
}
/// Install plugin-owned agents once in OpenCode's global agent directory. The
/// stable `aven-*` IDs work from every temporary dispatch worktree, avoiding
/// per-worktree configuration caches and preserving project configuration.
pub(crate) fn install_global_agent(agent_id: &str, contents: &str) -> Result<PathBuf> {
    install_agent_definition(&global_opencode_agents_dir()?, agent_id, contents)
}

fn available_primary_agents(worktree: &str) -> Result<Vec<PrimaryAgent>> {
    let output = opencode_text_in("GET", "/api/agent", None, Some(Path::new(worktree)))?;
    let response: Value = serde_json::from_str(&output).context("OpenCode agent list response")?;
    let agents = response
        .pointer("/data")
        .and_then(Value::as_array)
        .context("/data")?;
    Ok(agents
        .iter()
        .filter(|agent| agent.pointer("/mode").and_then(Value::as_str) == Some("primary"))
        .filter(|agent| agent.pointer("/hidden").and_then(Value::as_bool) != Some(true))
        .filter(|agent| {
            agent
                .pointer("/id")
                .and_then(Value::as_str)
                .is_none_or(|id| !is_legacy_dispatcher_agent(id))
        })
        .filter_map(|agent| {
            let id = agent.pointer("/id").and_then(Value::as_str)?;
            let name = agent.pointer("/name").and_then(Value::as_str).unwrap_or(id);
            let provider = agent.pointer("/model/providerID").and_then(Value::as_str);
            let model = agent.pointer("/model/id").and_then(Value::as_str);
            Some(PrimaryAgent {
                id: id.to_owned(),
                name: name.to_owned(),
                model: provider
                    .zip(model)
                    .map(|(provider, model)| format!("{provider}/{model}")),
            })
        })
        .collect())
}

/// Every chat model from every currently configured provider. The API is
/// scoped to the worktree so provider configuration merged for that location
/// is included, exactly as session creation will resolve it.
pub(crate) fn available_models(worktree: &str) -> Result<Vec<(String, String)>> {
    let output = opencode_text_in("GET", "/api/model", None, Some(Path::new(worktree)))?;
    let response: Value = serde_json::from_str(&output).context("OpenCode model list response")?;
    let models = response
        .pointer("/data")
        .and_then(Value::as_array)
        .context("/data")?;
    let mut choices = Vec::new();
    for model in models {
        // The endpoint defaults to chat models; an explicit decision or image
        // model can never serve a session.
        if model
            .pointer("/type")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind != "chat")
        {
            continue;
        }
        if model.pointer("/enabled").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        let Some(provider) = model.pointer("/providerID").and_then(Value::as_str) else {
            continue;
        };
        let Some(id) = model
            .pointer("/id")
            .and_then(Value::as_str)
            .or_else(|| model.pointer("/modelID").and_then(Value::as_str))
        else {
            continue;
        };
        let name = model.pointer("/name").and_then(Value::as_str).unwrap_or(id);
        let reference = format!("{provider}/{id}");
        if choices.iter().any(|(_, candidate)| candidate == &reference) {
            continue;
        }
        choices.push((name.to_owned(), reference));
    }
    Ok(choices)
}
pub(crate) fn choose_agent(
    agents: &[PrimaryAgent],
    input: &mut impl BufRead,
    output: &mut impl Write,
    interactive: bool,
) -> Result<String> {
    let choices = agents
        .iter()
        .map(|agent| (agent.name.clone(), agent.id.clone()))
        .collect::<Vec<_>>();
    picker::choose_from(
        "Select an OpenCode agent:",
        &choices,
        input,
        output,
        interactive,
    )?
    .context("OpenCode agent selection was canceled")
}

fn model_name<'a>(model: &str, available: &'a [(String, String)]) -> Option<&'a str> {
    available
        .iter()
        .find(|(_, candidate)| candidate == model)
        .map(|(name, _)| name.as_str())
        .or_else(|| {
            MODEL_CHOICES
                .iter()
                .find(|(_, candidate)| *candidate == model)
                .map(|(name, _)| *name)
        })
}

pub(crate) fn model_choices(
    configured: Option<&str>,
    preferred: Option<&str>,
    available: &[(String, String)],
) -> Vec<(String, String)> {
    let mut choices = Vec::new();
    if let Some(model) = preferred.filter(|model| !model.is_empty()) {
        let name = model_name(model, available).unwrap_or(model);
        choices.push((format!("Preferred ({name})"), model.to_owned()));
    }
    if let Some(model) = configured.filter(|model| !model.is_empty())
        && !choices.iter().any(|(_, choice)| choice == model)
    {
        choices.push((format!("Agent default ({model})"), model.to_owned()));
    }
    // All configured providers come from the API. The curated list is only a
    // fallback for an older server or a transient listing failure.
    let source = if available.is_empty() {
        MODEL_CHOICES
            .iter()
            .map(|(name, model)| ((*name).to_owned(), (*model).to_owned()))
            .collect::<Vec<_>>()
    } else {
        available.to_vec()
    };
    for (name, model) in source {
        if !choices.iter().any(|(_, choice)| *choice == model) {
            choices.push((name, model));
        }
    }
    choices
}

pub(crate) fn choose_model(
    choices: &[(String, String)],
    input: &mut impl BufRead,
    output: &mut impl Write,
    interactive: bool,
) -> Result<String> {
    picker::choose_from(
        "Select an OpenCode model:",
        choices,
        input,
        output,
        interactive,
    )?
    .context("OpenCode model selection was canceled")
}
pub(crate) fn select_model(choices: &[(String, String)], store_path: &Path) -> Result<String> {
    if env::var_os("AVEN_COMMAND_CONTEXT").is_some() {
        if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
            bail!("Aven terminal dispatch requires an interactive terminal");
        }
        return choose_model(
            choices,
            &mut io::stdin().lock(),
            &mut io::stdout().lock(),
            true,
        );
    }
    let choices = choices
        .iter()
        .map(|(name, model)| (name.clone(), model.clone()))
        .collect::<Vec<_>>();
    picker::spawn_picker("model", &choices, store_path)
}

pub(crate) fn select_agent(
    worktree: &str,
    store_path: &Path,
    existing: Option<&str>,
    preferred: Option<&str>,
) -> Result<String> {
    let mut agents = available_primary_agents(worktree)?;
    if let Some(existing) = existing {
        // Re-dispatch confirms the existing session, never silently swaps its
        // agent or admits another prompt. It must still display the picker.
        let name = agents
            .iter()
            .find(|agent| agent.id == existing)
            .map(|agent| agent.name.as_str())
            .unwrap_or(existing);
        agents = vec![PrimaryAgent {
            id: existing.to_owned(),
            name: format!("{name} — reopen existing session"),
            model: None,
        }];
    } else if let Some(preferred) = preferred.filter(|agent| !agent.is_empty())
        && let Some(index) = agents.iter().position(|agent| agent.id == preferred)
    {
        let preferred = agents.remove(index);
        agents.insert(0, preferred);
    }
    if agents.is_empty() {
        bail!(
            "OpenCode has no visible primary agents in {}; configure one and retry",
            worktree
        );
    }

    // Aven's terminal execution mode lends us the existing terminal and
    // supplies JSON via AVEN_COMMAND_CONTEXT. Open the picker inline there;
    // elsewhere it gets its own dedicated herdr-core terminal.
    if env::var_os("AVEN_COMMAND_CONTEXT").is_some() {
        if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
            bail!("Aven terminal dispatch requires an interactive terminal");
        }
        return choose_agent(
            &agents,
            &mut io::stdin().lock(),
            &mut io::stdout().lock(),
            true,
        );
    }
    let choices = agents
        .iter()
        .map(|agent| (agent.name.clone(), agent.id.clone()))
        .collect::<Vec<_>>();
    picker::spawn_picker("agent", &choices, store_path)
}

pub(crate) fn configured_agent_model(worktree: &str, agent_id: &str) -> Result<Option<String>> {
    Ok(available_primary_agents(worktree)?
        .into_iter()
        .find(|agent| agent.id == agent_id)
        .and_then(|agent| agent.model))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::picker::{PickerState, fuzzy_matches};
    use std::{fs, io};
    #[test]
    fn single_agent_still_requires_a_choice() {
        let agents = vec![PrimaryAgent {
            id: "build".into(),
            name: "Build".into(),
            model: Some("github-copilot/gpt-6.1-terra".into()),
        }];
        let mut output = Vec::new();
        assert!(choose_agent(&agents, &mut io::Cursor::new(""), &mut output, false).is_err());
        assert!(
            String::from_utf8(output)
                .unwrap()
                .contains("1. Build (build)")
        );
        assert_eq!(
            choose_agent(
                &agents,
                &mut io::Cursor::new("0\n2\n1\n"),
                &mut Vec::new(),
                false
            )
            .unwrap(),
            "build"
        );
        assert!(
            choose_agent(&agents, &mut io::Cursor::new("q\n"), &mut Vec::new(), false).is_err()
        );
    }
    #[test]
    fn configured_model_is_first_and_model_choice_requires_input() {
        let choices = model_choices(Some("github-copilot/gpt-6.1-terra"), None, &[]);
        assert_eq!(
            choices.first(),
            Some(&(
                "Agent default (github-copilot/gpt-6.1-terra)".into(),
                "github-copilot/gpt-6.1-terra".into()
            ))
        );
        assert_eq!(
            choose_model(
                &choices,
                &mut io::Cursor::new("0\n2\n"),
                &mut Vec::new(),
                false
            )
            .unwrap(),
            "github-copilot/gpt-6.1-sol"
        );
        assert!(
            choose_model(
                &choices,
                &mut io::Cursor::new("q\n"),
                &mut Vec::new(),
                false
            )
            .is_err()
        );
    }
    #[test]
    fn preferred_model_precedes_the_agent_default() {
        let choices = model_choices(
            Some("github-copilot/gpt-6.1-terra"),
            Some("github-copilot/gpt-6.1-sol"),
            &[],
        );
        assert_eq!(choices[0].1, "github-copilot/gpt-6.1-sol");
        assert_eq!(choices[1].1, "github-copilot/gpt-6.1-terra");
    }
    #[test]
    fn configured_provider_models_are_all_available() {
        let available = vec![
            (
                "GPT-6.1 Terra".into(),
                "github-copilot/gpt-6.1-terra".into(),
            ),
            (
                "DeepSeek V4.1 Flash".into(),
                "opencode-go/deepseek-v4.1-flash".into(),
            ),
        ];
        let choices = model_choices(Some("github-copilot/gpt-6.1-terra"), None, &available);
        assert_eq!(choices[0].1, "github-copilot/gpt-6.1-terra");
        assert!(
            choices
                .iter()
                .any(|(_, model)| model == "opencode-go/deepseek-v4.1-flash")
        );
        assert_eq!(
            choose_model(
                &choices,
                &mut io::Cursor::new("/flash\n1\n"),
                &mut Vec::new(),
                false
            )
            .unwrap(),
            "opencode-go/deepseek-v4.1-flash"
        );
    }
    #[test]
    fn fuzzy_search_filters_and_ranks_choices() {
        let choices = vec![
            (
                "GPT-6.1 Sol".to_owned(),
                "github-copilot/gpt-6.1-sol".to_owned(),
            ),
            (
                "Claude Sonnet".to_owned(),
                "github-copilot/claude-sonnet-5.5".to_owned(),
            ),
            (
                "DeepSeek V4.1 Flash".to_owned(),
                "opencode-go/deepseek-v4.1-flash".to_owned(),
            ),
        ];
        let matches = fuzzy_matches(&choices, "dsf");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].1, "opencode-go/deepseek-v4.1-flash");
        assert_eq!(fuzzy_matches(&choices, "clsn")[0].0, "Claude Sonnet");
        assert!(fuzzy_matches(&choices, "zzz").is_empty());
        assert_eq!(
            choose_model(
                &choices,
                &mut io::Cursor::new("/sol\n1\n"),
                &mut Vec::new(),
                false
            )
            .unwrap(),
            "github-copilot/gpt-6.1-sol"
        );
    }
    #[test]
    fn picker_state_filters_live_and_navigates() {
        let choices = vec![
            (
                "GPT-6.1 Sol".to_owned(),
                "github-copilot/gpt-6.1-sol".to_owned(),
            ),
            (
                "Claude Sonnet".to_owned(),
                "github-copilot/claude-sonnet-5.5".to_owned(),
            ),
            (
                "DeepSeek V4.1 Flash".to_owned(),
                "opencode-go/deepseek-v4.1-flash".to_owned(),
            ),
        ];
        let mut state = PickerState {
            searching: true,
            ..PickerState::default()
        };
        for character in "flash".chars() {
            state.type_character(character);
        }
        let visible = state.visible(&choices);
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].1, "opencode-go/deepseek-v4.1-flash");
        for _ in 0.."flash".len() {
            state.backspace();
        }
        assert_eq!(state.visible(&choices).len(), choices.len());
        state.down(3);
        assert_eq!(state.selected, 1);
        state.up(3);
        assert_eq!(state.selected, 0);
        state.up(3);
        assert_eq!(state.selected, 2);
    }
    #[test]
    fn model_option_becomes_an_opencode_model_ref() {
        assert_eq!(
            model_ref(Some("provider/model#fast")).unwrap(),
            json!({"providerID": "provider", "id": "model", "variant": "fast"})
        );
        assert!(model_ref(Some("missing-provider")).is_err());
        assert!(model_ref(Some("provider/")).is_err());
        assert!(model_ref(Some("provider/model#")).is_err());
    }
    #[test]
    fn babysitter_model_resolves_luna_only_for_enabled_attempts() {
        assert_eq!(
            resolve_babysitter_model(true, None),
            "github-copilot/gpt-6-luna"
        );
        assert_eq!(
            resolve_babysitter_model(true, Some("provider/supervisor".into())),
            "provider/supervisor"
        );
        assert_eq!(resolve_babysitter_model(false, None), "");
        assert_eq!(
            resolve_babysitter_model(false, Some("provider/supervisor".into())),
            ""
        );
    }
    #[test]
    fn orchestrator_model_resolves_luna_only_for_worktree_mode() {
        assert_eq!(
            resolve_orchestrator_model(ExecutionMode::Worktrees, None),
            "github-copilot/gpt-6-luna"
        );
        assert_eq!(
            resolve_orchestrator_model(
                ExecutionMode::Worktrees,
                Some("provider/coordinator".into())
            ),
            "provider/coordinator"
        );
        assert_eq!(
            resolve_orchestrator_model(ExecutionMode::SingleSession, None),
            ""
        );
        assert_eq!(
            resolve_orchestrator_model(
                ExecutionMode::Subsessions,
                Some("provider/coordinator".into())
            ),
            ""
        );
    }
    #[test]
    fn bundled_agent_definition_is_written_to_a_named_global_agent_path() {
        let root = tempfile::tempdir().unwrap();
        let agents = root.path().join("opencode/agents");
        let destination =
            install_agent_definition(&agents, BABYSITTER_AGENT_ID, BABYSITTER_AGENT).unwrap();
        assert_eq!(fs::read_to_string(&destination).unwrap(), BABYSITTER_AGENT);
        assert_eq!(destination, agents.join("aven-babysitter.md"));
    }
    #[test]
    fn previous_bundled_agent_is_upgraded_in_place() {
        let root = tempfile::tempdir().unwrap();
        let agents = root.path().join("opencode/agents");
        fs::create_dir_all(&agents).unwrap();
        let destination = agents.join("aven-babysitter.md");
        let previous = BABYSITTER_AGENT.replace("mode: primary\n", "mode: primary\nhidden: true\n");
        fs::write(&destination, &previous).unwrap();
        install_agent_definition(&agents, BABYSITTER_AGENT_ID, BABYSITTER_AGENT).unwrap();
        assert_eq!(fs::read_to_string(&destination).unwrap(), BABYSITTER_AGENT);
    }
    #[test]
    fn differing_user_agent_is_never_overwritten() {
        let root = tempfile::tempdir().unwrap();
        let agents = root.path().join("opencode/agents");
        fs::create_dir_all(&agents).unwrap();
        let destination = agents.join("aven-babysitter.md");
        fs::write(&destination, "user edit").unwrap();
        let error = install_agent_definition(&agents, BABYSITTER_AGENT_ID, BABYSITTER_AGENT)
            .unwrap_err()
            .to_string();
        assert!(error.contains("refusing to overwrite user configuration"));
        assert_eq!(fs::read_to_string(&destination).unwrap(), "user edit");
    }
    #[test]
    fn orchestrator_definition_monitors_every_phase_and_defers_final_integration() {
        assert!(ORCHESTRATOR_AGENT.starts_with(
            "---\ndescription: Autonomously coordinate an approved Aven epic through cumulative worktrees\nmode: primary\nmodel: github-copilot/gpt-6-luna\nsteps: 1000\n---"
        ));
        assert!(!ORCHESTRATOR_AGENT.contains("fixed Luna"));
        assert!(ORCHESTRATOR_AGENT.contains(
            "your own coordinator\nagent and model come from the dispatch configuration"
        ));
        assert!(ORCHESTRATOR_AGENT.contains("do not stop after the first worker"));
        assert!(ORCHESTRATOR_AGENT.contains("Prefer event- and wait-driven supervision"));
        assert!(ORCHESTRATOR_AGENT.contains("hc wait <address> --timeout 180"));
        assert!(ORCHESTRATOR_AGENT.contains("aven-dispatch reconcile\n<root-ref>"));
        assert!(ORCHESTRATOR_AGENT.contains(
            "every phase is\nintegrated, every accepted code result has verified delivery"
        ));
        assert!(ORCHESTRATOR_AGENT.contains("aven-dispatch closeout"));
        assert!(ORCHESTRATOR_AGENT.contains("creating a pull\nrequest as the preferred option"));
        assert!(ORCHESTRATOR_AGENT.contains("Wait for explicit approval"));
        assert!(ORCHESTRATOR_AGENT.contains("Never create a pull request, push, merge"));
    }
    #[test]
    fn agent_list_keeps_visible_primary_agents_only() {
        let response = json!({"data": [
            {"id": "build", "name": "Build", "mode": "primary", "hidden": false},
            {"id": "hidden", "mode": "primary", "hidden": true},
            {"id": "subagent", "mode": "subagent", "hidden": false}
        ]});
        let agents = response["data"].as_array().unwrap();
        let selected: Vec<_> = agents
            .iter()
            .filter(|agent| agent.pointer("/mode").and_then(Value::as_str) == Some("primary"))
            .filter(|agent| agent.pointer("/hidden").and_then(Value::as_bool) != Some(true))
            .filter_map(|agent| agent.pointer("/id").and_then(Value::as_str))
            .collect();
        assert_eq!(selected, vec!["build"]);
    }
    #[test]
    fn legacy_dispatcher_agent_ids_are_not_selectable() {
        assert!(is_legacy_dispatcher_agent("babysitter"));
        assert!(is_legacy_dispatcher_agent("orchestrator"));
        assert!(is_legacy_dispatcher_agent("aven-babysitter"));
        assert!(is_legacy_dispatcher_agent("aven-orchestrator"));
        assert!(!is_legacy_dispatcher_agent("build"));
    }
}

#[cfg(test)]
mod moved_owner_tests {
    use super::*;
    use crate::model::Attempt;

    #[test]
    fn attempts_without_a_babysitter_model_keep_the_legacy_fallback() {
        let attempt: Attempt = serde_json::from_value(serde_json::json!({
            "task_id":"task", "task_ref":"APP-TASK", "workflow":"implementation",
            "attempt_id":"att", "branch":"branch", "worktree":"/tmp", "session_id":"ses",
            "prompt_id":"msg", "state":"running", "aven":{}, "created_at":0
        }))
        .unwrap();
        let mut value = serde_json::to_value(&attempt).unwrap();
        value.as_object_mut().unwrap().remove("babysitter_model");
        let decoded: Attempt = serde_json::from_value(value).unwrap();
        assert!(decoded.babysitter_model.is_empty());
        assert_eq!(
            resolve_babysitter_model(true, Some(decoded.babysitter_model)),
            "github-copilot/gpt-6-luna"
        );
    }
}
