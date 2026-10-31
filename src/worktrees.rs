//! Git worktree management through herdr-core.
//!
//! herdr-core has no worktree command. Every discovery, creation, cleanliness,
//! integration, and removal operation in this module is executed through
//! `hc exec --cwd <repo> git ...`, never a direct Git subprocess.

use anyhow::{Context, Result, bail};
use std::{
    env,
    path::{Path, PathBuf},
};

use crate::core;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Worktree {
    pub(crate) path: String,
    pub(crate) head: String,
    pub(crate) branch: String,
    pub(crate) bare: bool,
    pub(crate) detached: bool,
}
impl Worktree {
    pub(crate) fn branch_name(&self) -> Option<&str> {
        self.branch
            .strip_prefix("refs/heads/")
            .or_else(|| (!self.branch.is_empty()).then_some(self.branch.as_str()))
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct WorktreeResource {
    pub(crate) path: String,
    pub(crate) created_by_attempt: bool,
}

pub(crate) fn repository_root(directory: &str) -> Result<String> {
    let root = core::git(directory, &["rev-parse".into(), "--show-toplevel".into()])?;
    if root.is_empty() {
        bail!("Git did not return a repository root for {directory}");
    }
    Ok(root)
}

pub(crate) fn primary_checkout(directory: &str) -> Result<String> {
    let listing = core::git(
        directory,
        &["worktree".into(), "list".into(), "--porcelain".into()],
    )?;
    Ok(parse_listing(&listing)
        .first()
        .map(|tree| tree.path.clone())
        .unwrap_or_else(|| directory.to_owned()))
}

pub(crate) fn parse_listing(text: &str) -> Vec<Worktree> {
    text.split("\n\n")
        .filter(|entry| !entry.trim().is_empty())
        .map(|entry| {
            let mut tree = Worktree::default();
            for line in entry.lines() {
                if let Some(path) = line.strip_prefix("worktree ") {
                    tree.path = path.to_owned();
                } else if let Some(head) = line.strip_prefix("HEAD ") {
                    tree.head = head.to_owned();
                } else if let Some(branch) = line.strip_prefix("branch ") {
                    tree.branch = branch.to_owned();
                } else if line == "bare" {
                    tree.bare = true;
                } else if line == "detached" {
                    tree.detached = true;
                }
            }
            tree
        })
        .collect()
}

pub(crate) fn list(directory: &str) -> Result<Vec<Worktree>> {
    Ok(parse_listing(&core::git(
        directory,
        &["worktree".into(), "list".into(), "--porcelain".into()],
    )?))
}

/// The default checkout layout is shared with Herdr's own worktree mod:
/// `~/.herdr/worktrees/<repo>/<repo>-<branch with / replaced>`.
pub(crate) fn root() -> PathBuf {
    if let Some(root) = env::var_os("AVEN_WORKTREE_ROOT").filter(|value| !value.is_empty()) {
        return PathBuf::from(root);
    }
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".herdr/worktrees")
}

pub(crate) fn worktree_path(primary: &str, branch: &str) -> Result<PathBuf> {
    let repo = Path::new(primary)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .context("repository root has no directory name")?;
    let slug = branch.replace('/', "-");
    Ok(root().join(repo).join(slug))
}

fn branch_exists(primary: &str, branch: &str) -> Result<bool> {
    let (success, _, _) = core::git_status(
        primary,
        &[
            "show-ref".into(),
            "--verify".into(),
            "--quiet".into(),
            format!("refs/heads/{branch}"),
        ],
    )?;
    Ok(success)
}

/// Reuse an existing checkout for the branch, otherwise create one.
///
/// A timeout is inherently ambiguous. Instead of repeating the operation, this
/// inspects the worktree inventory and adopts a checkout only when the exact
/// branch is registered at the expected path.
pub(crate) fn create(origin: &str, branch: &str, base: Option<&str>) -> Result<WorktreeResource> {
    let origin = repository_root(origin)?;
    let primary = primary_checkout(&origin)?;
    let expected = worktree_path(&primary, branch)?;
    if let Some(existing) = list(&primary)?
        .into_iter()
        .find(|tree| tree.branch_name() == Some(branch))
    {
        return Ok(WorktreeResource {
            path: existing.path,
            created_by_attempt: false,
        });
    }
    if expected.exists() {
        bail!(
            "{} exists but is not a registered checkout of {branch}; inspect it before retrying",
            expected.display()
        );
    }
    let path = expected.to_string_lossy().to_string();
    let mut args = vec!["worktree".into(), "add".into(), path.clone()];
    if branch_exists(&primary, branch)? {
        args.push(branch.into());
    } else {
        args.extend(["-b".into(), branch.into()]);
        if let Some(base) = base.filter(|base| !base.is_empty()) {
            args.push(base.into());
        }
    }
    match core::git(&primary, &args) {
        Ok(_) => {}
        Err(error) => {
            // Inspect only; never repeat an ambiguous create.
            if let Some(existing) = list(&primary)?
                .into_iter()
                .find(|tree| tree.branch_name() == Some(branch) && tree.path == path)
            {
                return Ok(WorktreeResource {
                    path: existing.path,
                    created_by_attempt: true,
                });
            }
            return Err(error).context("create worktree through hc exec");
        }
    }
    Ok(WorktreeResource {
        path,
        created_by_attempt: true,
    })
}

pub(crate) fn clean(directory: &Path) -> Result<bool> {
    let directory = directory.to_string_lossy().to_string();
    Ok(
        core::git(&directory, &["status".into(), "--porcelain".into()])?
            .lines()
            .all(|line| line.trim().is_empty()),
    )
}

/// Remove only a checkout this exact attempt created, and only when it is
/// clean. Dirty worktrees, reused checkouts, and user-owned resources are
/// preserved with a clear message.
pub(crate) fn remove_owned(path: &str, created_by_attempt: bool) {
    if !created_by_attempt {
        eprintln!("preserved reused worktree {path}; it was not created by this dispatch attempt");
        return;
    }
    if path.is_empty() || !Path::new(path).exists() {
        return;
    }
    match clean(Path::new(path)) {
        Ok(true) => {}
        Ok(false) => {
            eprintln!("preserved dirty worktree {path}; commit or discard its changes first");
            return;
        }
        Err(error) => {
            eprintln!("preserved worktree {path}; cleanliness could not be proven: {error:#}");
            return;
        }
    }
    let primary = match primary_checkout(path) {
        Ok(primary) => primary,
        Err(error) => {
            eprintln!(
                "preserved worktree {path}; its primary checkout could not be resolved: {error:#}"
            );
            return;
        }
    };
    if let Err(error) = core::git(&primary, &["worktree".into(), "remove".into(), path.into()]) {
        eprintln!("preserved worktree {path}; safe removal failed: {error:#}");
    }
}

pub(crate) fn head(directory: &Path) -> Result<String> {
    let directory = directory.to_string_lossy().to_string();
    core::git(&directory, &["rev-parse".into(), "HEAD".into()])
}

pub(crate) fn merge_ff(directory: &Path, branch: &str) -> Result<()> {
    let directory = directory.to_string_lossy().to_string();
    core::git(
        &directory,
        &["merge".into(), "--ff-only".into(), branch.into()],
    )?;
    Ok(())
}
