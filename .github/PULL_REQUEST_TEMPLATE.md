<!--
Thanks for the PR! Keep it focused on one logical change.
Do NOT include real vault content, real paths, secrets, or private repo URLs.
Security fixes for undisclosed vulnerabilities should follow SECURITY.md, not a
public PR.
-->

## Summary

<!-- What does this change and why? Link any related issue: Closes #123 -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Docs / chore
- [ ] Security-boundary change (path containment, frontmatter allowlist, HTTP auth, OAuth, two-step writes)

## Checklist

- [ ] `pnpm run lint:ox && pnpm run format:check && pnpm run lint` pass
- [ ] `pnpm run typecheck && pnpm run build` pass
- [ ] `pnpm test` passes
- [ ] Tests added/updated for the change (security behavior is pinned by tests)
- [ ] No real vault content, paths, or secrets are committed
- [ ] User-facing changes noted in `CHANGELOG.md` under `[Unreleased]`

## Notes for reviewers

<!-- Anything that needs extra attention, trade-offs, or follow-ups. -->
