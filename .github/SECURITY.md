# Security policy

## Supported versions

Security fixes ship as a new version on the current release line. `package.json` and the newest GitHub release identify that line. Older releases receive no fixes.

## Reporting

Reports go through the private vulnerability reporting form linked from the repository's Security tab. Public issues must not contain exploit details, reproduction steps for an unfixed weakness, credentials, or private host information.

A report names the affected version, the affected component, the observed behavior, and the steps that reproduce it.

## Scope

Command execution outside the file sandbox, parent-environment scrubbing, process-tree termination, and timeout handling belong to this repository. Weaknesses in the host application or in a third-party dependency belong to that project's reporting channel.

## Handling

Maintainers acknowledge reports through the private report, assess each finding against the current release line, and record a confirmed fix in the release notes of the version that ships it. Report details stay in the private report until that release is published.
