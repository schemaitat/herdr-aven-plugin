//! Reconcile a provider-verified PR without mutating Git or granting approval.
use anyhow::{Context, Result, bail};
use serde_json::Value;
use std::{path::PathBuf, process::Command};
use url::Url;

use super::{
    approval::{self, Approval},
    closeout::{self, CloseoutOutcome},
    integration::RepositoryGuard,
};
use crate::{core, store::LockedStore, worktrees};

#[derive(Debug, PartialEq, Eq)]
struct PullRequest {
    url: String,
    repository: String,
    number: u64,
}

fn parse_pr(input: &str) -> Result<PullRequest> {
    let url = Url::parse(input).context("supply a full GitHub PR URL")?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("PR must be a canonical https://github.com/OWNER/REPO/pull/NUMBER URL");
    }
    let parts: Vec<_> = url.path_segments().context("invalid PR URL")?.collect();
    if parts.len() != 4
        || parts[0].is_empty()
        || parts[1].is_empty()
        || parts[2] != "pull"
        || !parts[0]
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        || !parts[1]
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
    {
        bail!("invalid GitHub PR URL");
    }
    let number: u64 = parts[3].parse().context("invalid PR number")?;
    if number == 0 {
        bail!("invalid PR number");
    }
    Ok(PullRequest {
        url: format!("https://github.com/{}/{}/pull/{number}", parts[0], parts[1]),
        repository: format!("{}/{}", parts[0], parts[1]),
        number,
    })
}

pub(crate) fn origin_repository(origin: &str) -> Result<String> {
    let path = if let Some(path) = origin.strip_prefix("git@github.com:") {
        path
    } else if let Some(path) = origin.strip_prefix("https://github.com/") {
        path
    } else if let Some(path) = origin.strip_prefix("ssh://git@github.com/") {
        path
    } else {
        bail!("origin must identify a GitHub.com repository over HTTPS or SSH");
    };
    let path = path.strip_suffix(".git").unwrap_or(path);
    let pr = parse_pr(&format!("https://github.com/{path}/pull/1"))?;
    Ok(pr.repository)
}

#[derive(Debug, PartialEq, Eq)]
struct Evidence {
    head: String,
    merged: String,
    target_commit: String,
}

fn sha(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

fn provider(pr: &PullRequest, target: &str, approval: &Approval) -> Result<(String, String)> {
    let output = Command::new("gh")
        .args([
            "api",
            "--hostname",
            "github.com",
            &format!("repos/{}/pulls/{}", pr.repository, pr.number),
        ])
        .output()
        .context("cannot run gh; install and authenticate GitHub CLI")?;
    if !output.status.success() {
        bail!(
            "GitHub PR lookup failed; check gh authentication and repository access: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let data: Value =
        serde_json::from_slice(&output.stdout).context("GitHub returned invalid PR data")?;
    let get = |path: &str| {
        data.pointer(path)
            .and_then(Value::as_str)
            .unwrap_or_default()
    };
    if data.get("number").and_then(Value::as_u64) != Some(pr.number)
        || !get("/html_url").eq_ignore_ascii_case(&pr.url)
        || !get("/base/repo/full_name").eq_ignore_ascii_case(&pr.repository)
        || get("/base/ref") != target
    {
        bail!("PR identity, repository or target does not match");
    }
    if get("/state") != "closed" || get("/merged_at").is_empty() {
        bail!("PR is not merged; open or closed-unmerged PRs cannot settle delivery");
    }
    let head = get("/head/sha");
    let merged = get("/merge_commit_sha");
    if !sha(head) || !sha(merged) {
        bail!("GitHub did not provide verifiable full commit identities");
    }
    if head != approval.commit {
        bail!(
            "PR head {head} differs from approved commit {}; review and rerun /approve on the exact final PR head",
            approval.commit
        );
    }
    Ok((head.to_owned(), merged.to_owned()))
}

fn ancestor(cwd: &str, source: &str, target: &str) -> Result<()> {
    let (ok, _, err) = core::git_status(
        cwd,
        &[
            "merge-base".into(),
            "--is-ancestor".into(),
            source.into(),
            target.into(),
        ],
    )?;
    if !ok {
        bail!(
            "commit {source} is not verifiably contained in {target}: {err}; fetch/update the local target or inspect the evidence"
        );
    }
    Ok(())
}

fn verify(pr: &PullRequest, target: &str, approval: &Approval) -> Result<Evidence> {
    let cwd = &approval.worktree;
    if target != "main" {
        bail!("approval is bound to the configured target main; use --target main");
    }
    if approval.github_repository.is_empty() {
        bail!(
            "approval did not capture a GitHub origin; restore the correct origin and rerun /approve"
        );
    }
    if !approval
        .github_repository
        .eq_ignore_ascii_case(&pr.repository)
    {
        bail!("PR repository does not match the repository captured by approval");
    }
    approval::git(cwd, &["check-ref-format", "--branch", target])
        .context("invalid target branch")?;
    let origin = approval::git(cwd, &["remote", "get-url", "origin"])
        .context("repository needs a GitHub origin")?;
    if !origin_repository(&origin)?.eq_ignore_ascii_case(&pr.repository) {
        bail!("PR repository does not match the approved repository's origin");
    }
    let trees = worktrees::list(cwd)?;
    let matching: Vec<_> = trees
        .iter()
        .filter(|tree| tree.branch_name() == Some(target))
        .collect();
    let [tree] = matching.as_slice() else {
        bail!("exactly one checkout of target {target} is required");
    };
    approval::require_clean(&tree.path)?;
    if approval::repository(&tree.path)? != approval.repository {
        bail!("target checkout belongs to another repository");
    }
    let target_commit = approval::git(&tree.path, &["rev-parse", "HEAD"])?;
    let (head, merged) = provider(pr, target, approval)?;
    ancestor(cwd, &merged, &target_commit)?;
    for child in &approval.children {
        if child.status == "done" && !child.aggregate && child.disposition.is_empty() {
            ancestor(cwd, &child.commit, &approval.commit).with_context(|| {
                format!(
                    "approved child {} is not covered by the PR head",
                    child.reference
                )
            })?;
        }
    }
    Ok(Evidence {
        head,
        merged,
        target_commit,
    })
}

pub(crate) fn run(
    path: PathBuf,
    task: &str,
    url: &str,
    target: &str,
    apply: bool,
    workspace: Option<String>,
) -> Result<()> {
    let pr = parse_pr(url)?;
    let cwd = std::env::current_dir()?.to_string_lossy().into_owned();
    let repository = approval::repository(&cwd)?;
    let _guard = RepositoryGuard::acquire(&repository)?;
    let store = LockedStore::open(path.clone())?;
    let invocation = closeout::invocation(workspace);
    let approval = approval::load(&store, &invocation, task).context(
        "current complete approval required; review and rerun /approve if the source changed",
    )?;
    if approval.repository != repository {
        bail!("approval belongs to a different local repository");
    }
    let evidence = verify(&pr, target, &approval)?;
    println!(
        "verified {} head={} merged={} target={} at={} approval={}{}",
        pr.url,
        evidence.head,
        evidence.merged,
        target,
        evidence.target_commit,
        approval.id,
        if apply { "" } else { " (dry run)" }
    );
    if !apply {
        return Ok(());
    }
    let mut targets: Vec<_> = approval
        .children
        .iter()
        .filter(|c| c.status == "done" && c.disposition.is_empty())
        .map(|c| (c.reference.as_str(), c.commit.as_str(), c.aggregate))
        .collect();
    targets.push((
        &approval.task_ref,
        &approval.commit,
        !approval.children.is_empty(),
    ));
    for (reference, commit, aggregate) in targets {
        if approval::load(&store, &invocation, task)? != approval
            || verify(&pr, target, &approval)? != evidence
        {
            bail!("approval, PR or target changed during reconciliation; retry after review");
        }
        if aggregate {
            let mut args = approval::closeout_args(&approval, reference, commit);
            args.target = target.into();
            // Dry-run rechecks every child even when a prior attempt recorded the aggregate.
            args.apply = false;
            closeout::run(path.clone(), args)?;
            let current = super::aven::refresh_task_by_ref(&invocation, reference)?;
            if closeout::delivery_state(&current).as_deref() != Some("not-applicable")
                || current
                    .pointer("/metadata/delivery.provenance")
                    .and_then(Value::as_str)
                    != Some("aggregate-child-obligations")
            {
                let mut args = approval::closeout_args(&approval, reference, commit);
                args.target = target.into();
                closeout::run(path.clone(), args)?;
            }
            let current = super::aven::refresh_task_by_ref(&invocation, reference)?;
            if closeout::delivery_state(&current).as_deref() != Some("not-applicable")
                || current
                    .pointer("/metadata/delivery.provenance")
                    .and_then(Value::as_str)
                    != Some("aggregate-child-obligations")
            {
                bail!("aggregate delivery read-back failed for {reference}");
            }
        } else {
            closeout::record_pr_delivery(
                &invocation,
                &approval.project,
                &CloseoutOutcome {
                    task: reference.into(),
                    accepted: true,
                    dry_run: false,
                    state: "merged".into(),
                    commit: commit.into(),
                    branch: approval.branch.clone(),
                    repository: approval.repository.clone(),
                    target: target.into(),
                    target_commit: evidence.target_commit.clone(),
                    merged: evidence.merged.clone(),
                    provenance: "github-verified-merged-pr".into(),
                    pr: pr.url.clone(),
                    pr_head: evidence.head.clone(),
                    approval_id: approval.id.clone(),
                    provider_repository: pr.repository.clone(),
                    obligation: String::new(),
                    unresolved: Vec::new(),
                    notes: Vec::new(),
                },
            )?;
        }
    }
    println!("delivery reconciled child-first for {}", approval.task_ref);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pr_urls_and_origins_are_strict_and_do_not_accept_credentials() {
        let pr = parse_pr("https://github.com/Owner/repo-name/pull/42").unwrap();
        assert_eq!(pr.repository, "Owner/repo-name");
        for value in [
            "http://github.com/Owner/repo/pull/42",
            "https://github.com.evil.test/Owner/repo/pull/42",
            "https://token@github.com/Owner/repo/pull/42",
            "https://github.com/Owner/repo/pull/42?x=1",
            "https://github.com/Owner/repo/pull/0",
            "https://github.com/Owner/repo/pull/42/files",
        ] {
            assert!(parse_pr(value).is_err(), "{value}");
        }
        assert_eq!(
            origin_repository("git@github.com:Owner/repo.git").unwrap(),
            "Owner/repo"
        );
        assert!(origin_repository("https://secret@github.com/Owner/repo.git").is_err());
        assert!(origin_repository("https://github.com.evil.test/Owner/repo.git").is_err());
    }
}
