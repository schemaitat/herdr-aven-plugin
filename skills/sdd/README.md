# Bundled SDD skills

These are the spec-kit Spec-Driven Development command files, vendored so the
plugin can insert a skill into an agent prompt without installing spec-kit or
running the `specify` binary.

- Source: https://github.com/github/spec-kit
- Path: `templates/commands/` (specify, plan, tasks, implement)
- Commit: `03de661789b74405ae93b8b532d52d2cf8af422e`
- License: MIT (see the spec-kit repository)

`bin/dispatch.sh` reads a file here when `AVEN_DISPATCH_SKILL` names it, drops
the YAML front matter, rewrites the `__SPECKIT_COMMAND_<NAME>__` placeholders to
their `/speckit-<name>` form, and fills `$ARGUMENTS` from the selected task. The
file is used verbatim otherwise; update it by re-copying from the source above.
