//! Scope selection and bounded repository/project resolution.

use anyhow::{Context, Result, bail};
use std::{env, fs, path::Path, time::Duration};

use super::Options;
use crate::{
    inspect::model::{SOURCE_OUTPUT_LIMIT, SOURCE_TIMEOUT_MS, Scope, sanitize, valid_identifier},
    process::run_bounded,
};

pub(super) fn configured_secrets() -> Vec<String> {
    [
        "AVEN_DISPATCH_OPENCODE_AUTHORIZATION",
        "AVEN_DISPATCH_OPENCODE_TOKEN",
        "AVEN_DISPATCH_OPENCODE_PASSWORD",
    ]
    .into_iter()
    .filter_map(|name| env::var(name).ok())
    .filter(|value| !value.is_empty())
    .collect()
}

pub(super) fn source_error(error: &anyhow::Error, secrets: &[String]) -> String {
    sanitize(&format!("{error:#}"), 240, secrets)
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

pub(super) fn resolve_scope(options: &Options, secrets: &[String]) -> Result<Scope> {
    let workspace = options
        .workspace
        .clone()
        .or_else(|| env::var("AVEN_WORKSPACE").ok())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "default".into());
    if !valid_identifier(&workspace) {
        bail!("invalid workspace key {workspace:?}");
    }
    let cwd = fs::canonicalize(&options.cwd)
        .unwrap_or_else(|_| options.cwd.clone())
        .display()
        .to_string();
    let repository = repository_root(&options.cwd, secrets).unwrap_or_else(|| cwd.clone());
    let (project, project_source) = match options.project.as_deref() {
        Some(project) => {
            if !valid_identifier(project) {
                bail!("invalid project key {project:?}");
            }
            (project.to_owned(), "explicit".into())
        }
        None => (
            infer_project(&repository, &workspace, &options.cwd, secrets)?,
            "inferred".into(),
        ),
    };
    let project = validate_project(&project, &workspace, &options.cwd, secrets)?;
    let core_session = env::var("HC_SESSION")
        .or_else(|_| env::var("HC_BIN"))
        .unwrap_or_else(|_| "hc".into());
    Ok(Scope {
        project,
        workspace,
        repository,
        cwd,
        project_source,
        workspace_source: if options.workspace.is_some() {
            "explicit".into()
        } else if env::var("AVEN_WORKSPACE").is_ok_and(|value| !value.is_empty()) {
            "environment".into()
        } else {
            "default".into()
        },
        core_session,
    })
}

fn repository_root(cwd: &Path, secrets: &[String]) -> Option<String> {
    let output = run_bounded(
        "git",
        &[
            "-C".into(),
            cwd.display().to_string(),
            "rev-parse".into(),
            "--show-toplevel".into(),
        ],
        Some(cwd),
        Duration::from_millis(SOURCE_TIMEOUT_MS),
        SOURCE_OUTPUT_LIMIT,
    )
    .ok()?;
    if output.is_empty() {
        None
    } else {
        Some(sanitize(&output, 4096, secrets))
    }
}

fn infer_project(
    repository: &str,
    workspace: &str,
    cwd: &Path,
    secrets: &[String],
) -> Result<String> {
    let basename = Path::new(repository)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if !valid_identifier(basename) {
        bail!(
            "cannot infer an Aven project from {}; pass --project",
            Path::new(repository).display()
        );
    }
    let projects = super::aven::project_list(workspace, cwd, secrets)?;
    if let Some(project) = projects.iter().find(|project| project.key == basename) {
        return Ok(project.key.clone());
    }
    let matches = projects
        .iter()
        .filter(|project| project.name == basename)
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [project] => Ok(project.key.clone()),
        [] => bail!(
            "cannot infer an Aven project for {basename:?}; pass --project (scope was not widened)"
        ),
        _ => bail!("project name {basename:?} is ambiguous; pass --project"),
    }
}

fn validate_project(
    requested: &str,
    workspace: &str,
    cwd: &Path,
    secrets: &[String],
) -> Result<String> {
    let projects = super::aven::project_list(workspace, cwd, secrets)?;
    projects
        .iter()
        .find(|project| project.key == requested || project.name == requested)
        .map(|project| project.key.clone())
        .with_context(|| {
            format!("Aven project {requested:?} was not found in workspace {workspace:?}")
        })
}
